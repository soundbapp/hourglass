import {
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Runtime capability probes.
 *
 * The post-processing chain carries scene-referred radiance, so its buffers
 * must be floating point, and `RGBA16F` is the right choice nearly everywhere:
 * half the bandwidth of full float with ample range. But every blur in the
 * chain — bloom's mip pyramid above all — is built from bilinear taps, and a
 * driver that cannot filter half float **does not report an error**. It
 * silently samples nearest, and bloom becomes a grid of hard rectangles.
 *
 * Deciding this from extension strings does not work, and this was verified
 * rather than assumed: `OES_texture_half_float_linear` is a WebGL1 name, and a
 * driver that reports it absent may filter half float perfectly well through
 * the WebGL2 core path. SwiftShader is exactly such a case — it reports the
 * extension missing and then filters correctly. Trusting the string there would
 * have doubled the memory of every HDR buffer for no reason at all.
 *
 * So the capability is measured rather than inferred: upload a two-texel
 * half-float texture whose red channel runs 0 to 1, sample it exactly halfway
 * between the texel centres, and read the result back. Linear filtering returns
 * the midpoint; nearest returns an endpoint. One tiny draw at startup settles
 * it definitively.
 */

/** Half-float bit patterns for 0.0 and 1.0. */
const HALF_ZERO = 0x0000;
const HALF_ONE = 0x3c00;

/** A midpoint sample must land near 0.5; nearest filtering returns 0 or 1. */
const LINEAR_LOWER_BOUND = 0.25;
const LINEAR_UPPER_BOUND = 0.75;

const PROBE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PROBE_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tProbe;
  void main() {
    // Exactly between the two texel centres (0.25 and 0.75 in a 2x1 texture).
    gl_FragColor = vec4(vec3(texture2D(tProbe, vec2(0.5, 0.5)).r), 1.0);
  }
`;

/**
 * Measures whether the driver linearly filters half-float textures.
 *
 * @param renderer - Renderer whose context is probed.
 * @returns `true` when a midpoint sample interpolates.
 */
export function detectHalfFloatFiltering(renderer: WebGLRenderer): boolean {
  let texture: DataTexture | undefined;
  let target: WebGLRenderTarget | undefined;
  let quad: FullScreenQuad | undefined;
  const previousTarget = renderer.getRenderTarget();

  try {
    // Two texels, red running 0 then 1. Alpha is opaque so the read-back is
    // not modulated by anything.
    const data = new Uint16Array([
      HALF_ZERO, HALF_ZERO, HALF_ZERO, HALF_ONE,
      HALF_ONE, HALF_ZERO, HALF_ZERO, HALF_ONE,
    ]);

    texture = new DataTexture(data, 2, 1, RGBAFormat, HalfFloatType);
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    target = new WebGLRenderTarget(1, 1, {
      type: UnsignedByteType,
      format: RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });

    quad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: { tProbe: { value: texture } },
        vertexShader: PROBE_VERTEX_SHADER,
        fragmentShader: PROBE_FRAGMENT_SHADER,
        depthTest: false,
        depthWrite: false,
      }),
    );

    renderer.setRenderTarget(target);
    quad.render(renderer);

    const pixel = new Uint8Array(4);
    renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);

    const sampled = pixel[0] / 255;
    return sampled > LINEAR_LOWER_BOUND && sampled < LINEAR_UPPER_BOUND;
  } catch {
    // A driver that cannot even create the probe is certainly not one to trust
    // with a filtered half-float mip chain.
    return false;
  } finally {
    renderer.setRenderTarget(previousTarget);
    quad?.material.dispose();
    quad?.dispose();
    target?.dispose();
    texture?.dispose();
  }
}

/**
 * Chooses the HDR buffer format for the post chain.
 *
 * @param renderer - Renderer the chain will run on.
 * @returns `HalfFloatType` where it can be filtered, `FloatType` otherwise.
 */
export function selectHdrTextureType(renderer: WebGLRenderer): TextureDataType {
  return detectHalfFloatFiltering(renderer) ? HalfFloatType : FloatType;
}
