import {
  DataTexture,
  LinearMipmapLinearFilter,
  LinearFilter,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from 'three';

/**
 * Procedural PBR texture synthesis.
 *
 * Every surface in the level is generated here at load time rather than shipped
 * as image files. That is partly practical — the build stays a single
 * self-contained document — but mostly it is what makes the detail *parametric*:
 * a wall's grime, its aggregate size and where its paint has failed are numbers,
 * not pixels, so a surface can be re-art-directed without a round trip through
 * a texturing tool.
 *
 * Each material produces the three maps a modern PBR shader actually consumes:
 *
 * - **Albedo**, in sRGB. Kept inside physically plausible reflectance bounds
 *   (roughly 0.03–0.8); fully black or fully white albedo does not exist in the
 *   real world and reads instantly as computer graphics.
 * - **Normal**, derived from the height field by Sobel differencing.
 * - **ORM**, packing ambient occlusion, roughness and metalness into R, G and B
 *   of one texture — the glTF convention, so one sampler feeds three inputs.
 *
 * The single most important of those is **roughness variation**. Uniform
 * roughness is the strongest tell of a synthetic image: real surfaces are
 * polished where they are touched, matte where they are dusty, and glossy where
 * they are wet, all within centimetres. Every recipe below varies it.
 */

/** Per-texel surface description a recipe fills in. */
export interface SurfaceSample {
  /** Displacement in `[0, 1]`; drives the normal and occlusion maps. */
  height: number;
  /** Linear albedo channels in `[0, 1]`. Encoded to sRGB on write. */
  red: number;
  green: number;
  blue: number;
  /** Perceptual roughness in `[0, 1]`. */
  roughness: number;
  /** Metalness in `[0, 1]`. Dielectric or metal — intermediate values are rare. */
  metalness: number;
}

/**
 * Fills a surface sample for one texel.
 *
 * @param x - Lattice coordinate, in the range `[0, period)`.
 * @param y - Lattice coordinate, in the range `[0, period)`.
 * @param out - Sample to write into. Reused across texels, so every field must
 *   be assigned rather than left from the previous call.
 */
export type SurfaceRecipe = (x: number, y: number, out: SurfaceSample) => void;

/** A generated material's texture set. */
export interface SurfaceTextures {
  /** Base colour, sRGB. */
  readonly albedo: Texture;
  /** Tangent-space normals, linear. */
  readonly normal: Texture;
  /** Occlusion in R, roughness in G, metalness in B; linear. */
  readonly orm: Texture;
  /** Releases every GPU resource in the set. */
  dispose(): void;
}

/** How a surface is synthesised. */
export interface SurfaceOptions {
  /** Edge length in texels. Powers of two only, so mipmaps are exact. */
  readonly size: number;
  /** Lattice period the recipe is sampled over. Larger means more variety. */
  readonly period: number;
  /**
   * Height-to-normal conversion strength. Expressed in height units per texel,
   * so changing resolution does not change how pronounced the relief looks.
   */
  readonly normalStrength: number;
  /** Strength of cavity occlusion derived from the height field. */
  readonly occlusionStrength?: number;
  /** Radius, in texels, of the blur that defines "cavity" for occlusion. */
  readonly occlusionRadius?: number;
}

/** Converts a linear channel to sRGB for storage in an 8-bit colour texture. */
function linearToSrgb(value: number): number {
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/** Quantises a unit float to a byte. */
function toByte(value: number): number {
  const scaled = Math.round(value * 255);
  return scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
}

/**
 * Separable box blur over a float field, wrapping at the edges.
 *
 * Wrapping rather than clamping matters: the field is tileable, and a clamped
 * blur would darken the borders and reintroduce the seam the noise was designed
 * to avoid.
 */
function blurWrapped(source: Float32Array, size: number, radius: number): Float32Array {
  const horizontal = new Float32Array(size * size);
  const result = new Float32Array(size * size);
  const window = radius * 2 + 1;

  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let total = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        total += source[row + ((x + offset + size) % size)];
      }
      horizontal[row + x] = total / window;
    }
  }

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      let total = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        total += horizontal[((y + offset + size) % size) * size + x];
      }
      result[y * size + x] = total / window;
    }
  }

  return result;
}

function createTexture(
  data: Uint8Array,
  size: number,
  colorSpace: typeof SRGBColorSpace | undefined,
  anisotropy: number,
): Texture {
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  if (colorSpace !== undefined) {
    texture.colorSpace = colorSpace;
  }
  texture.needsUpdate = true;
  return texture;
}

/**
 * Synthesises a complete texture set from a recipe.
 *
 * @param recipe - Fills one texel at a time.
 * @param options - Resolution and relief parameters.
 * @param anisotropy - Anisotropic filtering level, from renderer capabilities.
 *   Floors viewed at a grazing angle are the entire reason this is worth
 *   passing through: without it they blur to mush a few metres out.
 */
export function synthesiseSurface(
  recipe: SurfaceRecipe,
  options: SurfaceOptions,
  anisotropy: number,
): SurfaceTextures {
  const { size, period } = options;
  const texelCount = size * size;

  const height = new Float32Array(texelCount);
  const albedo = new Uint8Array(texelCount * 4);
  const orm = new Uint8Array(texelCount * 4);
  const normal = new Uint8Array(texelCount * 4);

  const sample: SurfaceSample = {
    height: 0,
    red: 0.5,
    green: 0.5,
    blue: 0.5,
    roughness: 0.5,
    metalness: 0,
  };

  const scale = period / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      recipe(x * scale, y * scale, sample);

      const index = y * size + x;
      height[index] = sample.height;

      const offset = index * 4;
      albedo[offset] = toByte(linearToSrgb(sample.red));
      albedo[offset + 1] = toByte(linearToSrgb(sample.green));
      albedo[offset + 2] = toByte(linearToSrgb(sample.blue));
      albedo[offset + 3] = 255;

      // R is filled once occlusion has been derived from the height field.
      orm[offset + 1] = toByte(sample.roughness);
      orm[offset + 2] = toByte(sample.metalness);
      orm[offset + 3] = 255;
    }
  }

  // Cavity occlusion: a texel sitting below its neighbourhood average is in a
  // recess and receives less ambient light. Cheap, and it is what stops crevices
  // from glowing with uniform environment light.
  const occlusionStrength = options.occlusionStrength ?? 1.4;
  const occlusionRadius = Math.max(1, options.occlusionRadius ?? Math.round(size / 128));
  const blurred = blurWrapped(height, size, occlusionRadius);

  for (let index = 0; index < texelCount; index++) {
    const cavity = blurred[index] - height[index];
    const occlusion = 1 - Math.max(0, cavity) * occlusionStrength;
    orm[index * 4] = toByte(occlusion < 0 ? 0 : occlusion);
  }

  // Sobel differencing of the height field. The texel step is folded into the
  // strength so relief is resolution-independent.
  const strength = options.normalStrength * size;
  for (let y = 0; y < size; y++) {
    const up = ((y - 1 + size) % size) * size;
    const mid = y * size;
    const down = ((y + 1) % size) * size;

    for (let x = 0; x < size; x++) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;

      const topLeft = height[up + left];
      const topCentre = height[up + x];
      const topRight = height[up + right];
      const midLeft = height[mid + left];
      const midRight = height[mid + right];
      const bottomLeft = height[down + left];
      const bottomCentre = height[down + x];
      const bottomRight = height[down + right];

      const dx =
        topLeft + 2 * midLeft + bottomLeft - (topRight + 2 * midRight + bottomRight);
      const dy =
        topLeft + 2 * topCentre + topRight - (bottomLeft + 2 * bottomCentre + bottomRight);

      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const inverseLength = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inverseLength;
      ny *= inverseLength;

      const offset = (mid + x) * 4;
      // Tangent-space normals are stored biased into [0, 1].
      normal[offset] = toByte(nx * 0.5 + 0.5);
      normal[offset + 1] = toByte(ny * 0.5 + 0.5);
      normal[offset + 2] = toByte(nz * inverseLength * 0.5 + 0.5);
      normal[offset + 3] = 255;
    }
  }

  const albedoTexture = createTexture(albedo, size, SRGBColorSpace, anisotropy);
  const normalTexture = createTexture(normal, size, undefined, anisotropy);
  const ormTexture = createTexture(orm, size, undefined, anisotropy);

  return {
    albedo: albedoTexture,
    normal: normalTexture,
    orm: ormTexture,
    dispose(): void {
      albedoTexture.dispose();
      normalTexture.dispose();
      ormTexture.dispose();
    },
  };
}
