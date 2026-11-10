import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
  type Matrix4,
  type Object3D,
  type Texture,
} from 'three';
import { markNonOccluding } from '../render/RenderLayers.js';

/**
 * Airborne dust.
 *
 * The detail that most reliably convinces people a shaft of light is real.
 * Volumetric scattering gives the beam its body, but a beam with nothing
 * suspended in it is a perfectly smooth gradient, and nothing in a derelict
 * concrete room is perfectly smooth. Motes give the light something to catch.
 *
 * Each mote is lit by sampling the *same sun depth map the volumetric pass
 * uses*. That is the whole trick: a particle drifting into the beam brightens,
 * a particle passing behind the gantry goes dark, and the motes agree exactly
 * with the shaft they are floating in — because both are reading the same
 * answer to the same question. Lighting them by proximity to a hand-placed
 * cylinder, the usual shortcut, falls apart the moment anything casts a shadow.
 *
 * Motion is computed entirely in the vertex shader from a per-particle seed and
 * the clock, so animating a few thousand motes costs no CPU time at all and no
 * buffer uploads per frame.
 */

/** Number of motes. Cheap enough to be generous — they are two triangles each. */
const MOTE_COUNT = 2600;

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aOrigin;
  attribute float aSeed;
  attribute float aScale;

  uniform float uTime;
  uniform vec3 uBoundsMin;
  uniform vec3 uBoundsSize;
  uniform mat4 uSunMatrix;
  uniform sampler2D tSunDepth;
  uniform float uSize;

  varying float vBrightness;
  varying float vSeed;

  void main() {
    // Slow convective drift with a little turbulence. Dust in still air rises
    // on thermals far more than it falls, which is why the vertical term is
    // positive and the whole field wraps upward.
    float t = uTime * 0.045;
    vec3 drift = vec3(
      sin(t * 1.7 + aSeed * 6.283) * 0.55 + sin(t * 0.6 + aSeed * 12.1) * 0.3,
      mod(aSeed * 7.3 + uTime * 0.035, 1.0) * uBoundsSize.y,
      cos(t * 1.3 + aSeed * 9.42) * 0.55 + cos(t * 0.5 + aSeed * 3.7) * 0.3
    );

    vec3 world = aOrigin + vec3(drift.x, 0.0, drift.z);
    // Wrap height through the room so the field never empties out.
    world.y = uBoundsMin.y + mod(aOrigin.y - uBoundsMin.y + drift.y, uBoundsSize.y);

    // Lit exactly where the sun reaches, read from the same map the volumetric
    // pass marches through.
    vec4 sunClip = uSunMatrix * vec4(world, 1.0);
    vec3 sunCoord = sunClip.xyz / sunClip.w;

    float lit = 0.0;
    if (sunCoord.x > 0.0 && sunCoord.x < 1.0 && sunCoord.y > 0.0 && sunCoord.y < 1.0 && sunCoord.z < 1.0) {
      float occluder = texture2D(tSunDepth, sunCoord.xy).r;
      lit = step(sunCoord.z - 0.0022, occluder);
    }

    // A dim ambient term keeps motes outside the beam faintly present rather
    // than popping in at its edge.
    vBrightness = 0.03 + lit * 0.52;
    vSeed = aSeed;

    vec4 viewPosition = modelViewMatrix * vec4(world, 1.0);
    gl_PointSize = uSize * aScale / max(-viewPosition.z, 0.1);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying float vBrightness;
  varying float vSeed;
  uniform vec3 uColour;

  void main() {
    vec2 offset = gl_PointCoord - 0.5;
    float distance = length(offset);
    if (distance > 0.5) { discard; }

    // Soft, roughly Gaussian falloff. A hard-edged dot reads as a pixel
    // artefact; dust is out of focus at every distance the eye sees it.
    float falloff = exp(-distance * distance * 11.0);
    // Individual motes twinkle as they tumble and catch the light edge-on.
    float twinkle = 0.78 + 0.22 * sin(vSeed * 97.0);

    gl_FragColor = vec4(uColour * vBrightness * twinkle, falloff * vBrightness);
  }
`;

/** Volume the motes occupy. */
export interface DustBounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
}

export class DustMotes {
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly points: Points;

  public constructor(bounds: DustBounds, sunDepth: Texture, sunMatrix: Matrix4) {
    const origins = new Float32Array(MOTE_COUNT * 3);
    const seeds = new Float32Array(MOTE_COUNT);
    const scales = new Float32Array(MOTE_COUNT);

    for (let i = 0; i < MOTE_COUNT; i++) {
      origins[i * 3] = bounds.minX + Math.random() * bounds.sizeX;
      origins[i * 3 + 1] = bounds.minY + Math.random() * bounds.sizeY;
      origins[i * 3 + 2] = bounds.minZ + Math.random() * bounds.sizeZ;
      seeds[i] = Math.random();
      // A wide size range reads as a real particle-size distribution; a uniform
      // size reads as a regular grid of identical dots.
      scales[i] = 0.35 + Math.pow(Math.random(), 2.4) * 1.9;
    }

    // `position` is required by three even though the shader reads `aOrigin`;
    // it is what the frustum culler and draw range are built from.
    this.geometry.setAttribute('position', new BufferAttribute(origins, 3));
    this.geometry.setAttribute('aOrigin', new BufferAttribute(origins, 3));
    this.geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    this.geometry.setAttribute('aScale', new BufferAttribute(scales, 1));

    this.material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 8.5 },
        uColour: { value: { x: 1.0, y: 0.88, z: 0.72 } },
        uBoundsMin: { value: { x: bounds.minX, y: bounds.minY, z: bounds.minZ } },
        uBoundsSize: { value: { x: bounds.sizeX, y: bounds.sizeY, z: bounds.sizeZ } },
        uSunMatrix: { value: sunMatrix },
        tSunDepth: { value: sunDepth },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.name = 'dust-motes';
    // The field spans the whole room and its vertices move in the shader, so a
    // bounding volume computed from the static attribute would cull it wrongly.
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    // Motes are specks of light, not geometry. Without this they are drawn as
    // solid squares into every depth-only capture and cut the shaft they exist
    // to decorate into rectangles.
    markNonOccluding(this.points);
  }

  /** Advances the drift. */
  public update(elapsedSeconds: number): void {
    this.material.uniforms['uTime'].value = elapsedSeconds;
  }

  public attachTo(parent: Object3D): void {
    parent.add(this.points);
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
