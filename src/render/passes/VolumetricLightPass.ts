import {
  Matrix4,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Raymarched volumetric light.
 *
 * The visual centrepiece of the level, and the one effect that most separates a
 * realtime image from a rendered one. Shafts of light are not a glow drawn
 * around a bright pixel; they are the accumulated light scattered toward the eye
 * by dust suspended in the air along the whole length of a view ray. This
 * computes that integral directly.
 *
 * For every pixel, the pass walks the ray from the eye to the first surface,
 * asks the sun's depth map at each step whether that point in *mid-air* is lit,
 * and accumulates scattering weighted by the Henyey–Greenstein phase function.
 * The result is a beam that correctly narrows through the breach it came
 * through, is occluded by the gantry crossing it, and brightens sharply when
 * you look toward the sun.
 *
 * Two details carry most of the quality:
 *
 * - **Dithered step offsets.** A fixed step length produces banding — concentric
 *   shells where the march happened to sample. Offsetting each pixel's start by
 *   a hash trades that structured artefact for unstructured noise, which the eye
 *   forgives and the bloom and grain then hide entirely.
 * - **Anisotropic scattering.** Real dust scatters strongly forward, so a beam
 *   seen nearly end-on is far brighter than the same beam seen from the side.
 *   Isotropic scattering looks like uniform fog and reads as a flat overlay.
 *
 * The pass runs in linear HDR, before tone mapping, so the shaft participates
 * in bloom and exposure exactly as a real highlight would.
 */

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;

  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform sampler2D tSunDepth;

  uniform mat4 uInverseProjection;
  uniform mat4 uCameraWorld;
  uniform mat4 uSunMatrix;

  uniform vec3 uCameraPosition;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColour;

  uniform float uDensity;
  uniform float uScatterAnisotropy;
  uniform float uMaxDistance;
  uniform float uFogFloor;
  uniform float uFogFalloff;
  uniform float uTime;
  uniform int   uStepCount;

  /** Reconstructs view-space position from a depth sample. */
  vec3 viewPositionFromDepth(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 view = uInverseProjection * clip;
    return view.xyz / view.w;
  }

  /**
   * Henyey-Greenstein phase function.
   *
   * Describes how much light scatters toward the viewer as a function of the
   * angle between the view ray and the light. Positive g biases forward, which
   * is what suspended dust and water droplets actually do.
   */
  float henyeyGreenstein(float cosAngle, float g) {
    float gg = g * g;
    float denominator = 1.0 + gg - 2.0 * g * cosAngle;
    return (1.0 - gg) / (4.0 * 3.14159265 * pow(max(denominator, 1e-4), 1.5));
  }

  /** Interleaved gradient noise: cheap, well-distributed, stable per pixel. */
  float dither(vec2 position) {
    return fract(52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715))));
  }

  /** Samples the sun's depth map; 1.0 where the point is lit. */
  float sunVisibility(vec3 worldPosition) {
    vec4 sunClip = uSunMatrix * vec4(worldPosition, 1.0);
    vec3 coord = sunClip.xyz / sunClip.w;

    // Outside the map entirely: treat as lit, so the beam does not end in a
    // hard rectangle at the edge of the shadow frustum.
    if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 || coord.z > 1.0) {
      return 1.0;
    }

    float occluderDepth = texture2D(tSunDepth, coord.xy).r;
    // A small bias keeps surfaces from shadowing the air immediately above them.
    return step(coord.z - 0.0018, occluderDepth);
  }

  void main() {
    vec4 source = texture2D(tDiffuse, vUv);
    float depth = texture2D(tDepth, vUv).x;

    vec3 viewPosition = viewPositionFromDepth(vUv, depth);
    vec3 worldPosition = (uCameraWorld * vec4(viewPosition, 1.0)).xyz;

    vec3 toSurface = worldPosition - uCameraPosition;
    float surfaceDistance = length(toSurface);
    vec3 rayDirection = surfaceDistance > 1e-4 ? toSurface / surfaceDistance : vec3(0.0, 0.0, -1.0);

    // Nothing behind the far plane, and never march past the useful range.
    float marchDistance = min(surfaceDistance, uMaxDistance);
    if (depth >= 1.0) {
      marchDistance = uMaxDistance;
    }

    float stepLength = marchDistance / float(uStepCount);

    // Offsetting each pixel's first step breaks the march's structured banding
    // into noise. Animating it very slowly lets temporal smoothing in the eye
    // (and in any TAA) average it away without visible crawling.
    float offset = dither(gl_FragCoord.xy + uTime * 13.0);

    float phase = henyeyGreenstein(dot(rayDirection, uSunDirection), uScatterAnisotropy);

    vec3 scattered = vec3(0.0);
    float transmittance = 1.0;

    for (int i = 0; i < 128; i++) {
      if (i >= uStepCount) { break; }

      float t = (float(i) + offset) * stepLength;
      vec3 samplePosition = uCameraPosition + rayDirection * t;

      // Airborne dust settles, so density falls off with height above the floor.
      float heightFade = exp(-max(samplePosition.y - uFogFloor, 0.0) * uFogFalloff);
      float density = uDensity * heightFade;
      if (density <= 0.0) { continue; }

      float visibility = sunVisibility(samplePosition);

      float stepDensity = density * stepLength;
      // Beer-Lambert extinction along the ray already travelled.
      scattered += uSunColour * visibility * phase * stepDensity * transmittance;
      transmittance *= exp(-stepDensity);
    }

    gl_FragColor = vec4(source.rgb + scattered, source.a);
  }
`;

/** Art-directable parameters of the medium. */
export interface VolumetricSettings {
  /** Scattering coefficient of the air. Higher is hazier. */
  density: number;
  /** Henyey-Greenstein `g`, in `(-1, 1)`. Positive scatters forward. */
  anisotropy: number;
  /** Radiance of the shaft, before tone mapping. */
  colour: Vector3;
  /** Ray length cap, in metres. */
  maxDistance: number;
  /** Height at which the medium is at full density, in metres. */
  floorHeight: number;
  /** Exponential falloff of density with height above the floor. */
  heightFalloff: number;
  /** Steps per ray. The dominant cost, and the dominant quality control. */
  stepCount: number;
}

export class VolumetricLightPass extends Pass {
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly inverseProjection = new Matrix4();

  public readonly settings: VolumetricSettings;

  public constructor(
    private readonly camera: PerspectiveCamera,
    sceneDepth: Texture,
    sunDepth: Texture,
    sunMatrix: Matrix4,
    sunDirection: Vector3,
    settings: Partial<VolumetricSettings> = {},
  ) {
    super();

    this.settings = {
      density: settings.density ?? 0.33,
      anisotropy: settings.anisotropy ?? 0.62,
      // Scaled to sun radiance, not to a unit colour. The phase function is
      // normalised so it integrates to 1 over the sphere, which puts its value
      // near 0.03 when the beam is viewed from the side — so the radiance
      // feeding it has to be in the tens to produce a visible shaft.
      colour: settings.colour ?? new Vector3(1.0, 0.86, 0.66).multiplyScalar(21),
      maxDistance: settings.maxDistance ?? 34,
      floorHeight: settings.floorHeight ?? 0,
      heightFalloff: settings.heightFalloff ?? 0.09,
      stepCount: settings.stepCount ?? 64,
    };

    this.material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: sceneDepth },
        tSunDepth: { value: sunDepth },
        uInverseProjection: { value: new Matrix4() },
        uCameraWorld: { value: new Matrix4() },
        uSunMatrix: { value: sunMatrix },
        uCameraPosition: { value: new Vector3() },
        // The direction light travels *toward* the viewer, for the phase term.
        uSunDirection: { value: sunDirection.clone().negate() },
        uSunColour: { value: this.settings.colour },
        uDensity: { value: this.settings.density },
        uScatterAnisotropy: { value: this.settings.anisotropy },
        uMaxDistance: { value: this.settings.maxDistance },
        uFogFloor: { value: this.settings.floorHeight },
        uFogFalloff: { value: this.settings.heightFalloff },
        uTime: { value: 0 },
        uStepCount: { value: this.settings.stepCount },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.material);
  }

  public override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    const uniforms = this.material.uniforms;

    this.inverseProjection.copy(this.camera.projectionMatrix).invert();
    uniforms['uInverseProjection'].value = this.inverseProjection;
    uniforms['uCameraWorld'].value = this.camera.matrixWorld;
    (uniforms['uCameraPosition'].value as Vector3).setFromMatrixPosition(this.camera.matrixWorld);

    uniforms['uDensity'].value = this.settings.density;
    uniforms['uScatterAnisotropy'].value = this.settings.anisotropy;
    uniforms['uMaxDistance'].value = this.settings.maxDistance;
    uniforms['uFogFloor'].value = this.settings.floorHeight;
    uniforms['uFogFalloff'].value = this.settings.heightFalloff;
    uniforms['uStepCount'].value = this.settings.stepCount;
    uniforms['uTime'].value = (uniforms['uTime'].value as number) + 0.0007;
    uniforms['tDiffuse'].value = readBuffer.texture;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) {
        renderer.clear();
      }
    }
    this.quad.render(renderer);
  }

  public override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
