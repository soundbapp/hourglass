import { ShaderMaterial, Vector2, Vector3 } from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Final photographic treatment.
 *
 * Everything in this pass is a property of a *camera*, not of a world, and that
 * is precisely why it matters. A render without these reads as a perfect,
 * impossible observation; a photograph always carries evidence of the lens and
 * sensor that made it. Supplying that evidence is most of what separates
 * "rendered" from "shot".
 *
 * Applied in the order a real imaging chain applies them:
 *
 * 1. **Chromatic aberration**, scaled with distance from the optical axis,
 *    because a lens cannot focus every wavelength to the same point and the
 *    error grows toward the edge of the frame.
 * 2. **Colour grading** — a lift/gamma/gain split pushing shadows cool and
 *    highlights warm. The single most recognisable element of a graded image.
 * 3. **Filmic contrast**, an S-curve that holds detail in both tails rather
 *    than clipping them.
 * 4. **Vignette**, from the lens barrel occluding oblique rays.
 * 5. **Grain**, weighted toward the shadows, where a real sensor's noise floor
 *    actually lives. Uniform grain reads as an overlay; shadow-weighted grain
 *    reads as exposure.
 *
 * This runs *after* tone mapping, in display space, because that is where a
 * colourist works and where these operations are defined.
 */

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;

  uniform sampler2D tDiffuse;
  uniform float uTime;

  uniform float uAberration;
  uniform float uVignetteStrength;
  uniform float uVignetteSoftness;
  uniform float uGrainStrength;
  uniform float uContrast;
  uniform float uSaturation;

  uniform vec3 uLift;
  uniform vec3 uGain;
  uniform float uGamma;

  /** Hash-based value noise, used for the grain field. */
  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  // Named to avoid colliding with the luminance() that three.js injects from
  // its own shader chunks, which redeclares it with different qualifiers.
  float relativeLuma(vec3 colour) {
    return dot(colour, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec2 centred = vUv - 0.5;
    float radius = length(centred);

    // --- Chromatic aberration -------------------------------------------------
    // Red and blue are displaced radially in opposite directions, by an amount
    // that grows with the square of the distance from the axis.
    vec2 displacement = centred * radius * radius * uAberration;
    vec3 colour;
    colour.r = texture2D(tDiffuse, vUv + displacement).r;
    colour.g = texture2D(tDiffuse, vUv).g;
    colour.b = texture2D(tDiffuse, vUv - displacement).b;

    // --- Colour grading -------------------------------------------------------
    colour = colour * uGain + uLift;
    colour = pow(max(colour, vec3(0.0)), vec3(uGamma));

    // --- Filmic contrast ------------------------------------------------------
    colour = mix(vec3(0.5), colour, uContrast);
    colour = clamp(colour, 0.0, 1.0);
    // Gentle shoulder and toe, applied symmetrically about mid grey.
    colour = colour * colour * (3.0 - 2.0 * colour) * 0.35 + colour * 0.65;

    // --- Saturation -----------------------------------------------------------
    float grey = relativeLuma(colour);
    colour = mix(vec3(grey), colour, uSaturation);

    // --- Vignette -------------------------------------------------------------
    float vignette = smoothstep(uVignetteSoftness, uVignetteSoftness - 0.45, radius);
    colour *= mix(1.0, vignette, uVignetteStrength);

    // --- Grain ----------------------------------------------------------------
    // Weighted toward the shadows: a sensor's read noise is constant in absolute
    // terms, so it is most visible where the signal is smallest.
    float noise = hash(gl_FragCoord.xy + fract(uTime) * 1000.0) - 0.5;
    float shadowWeight = 1.0 - smoothstep(0.0, 0.6, relativeLuma(colour));
    colour += noise * uGrainStrength * (0.35 + shadowWeight);

    gl_FragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
  }
`;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Tunables of the photographic treatment. */
export interface CinematicSettings {
  aberration: number;
  vignetteStrength: number;
  vignetteSoftness: number;
  grainStrength: number;
  contrast: number;
  saturation: number;
}

export class CinematicPass extends ShaderPass {
  public constructor(settings: Partial<CinematicSettings> = {}) {
    const material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uAberration: { value: settings.aberration ?? 0.0045 },
        uVignetteStrength: { value: settings.vignetteStrength ?? 0.46 },
        uVignetteSoftness: { value: settings.vignetteSoftness ?? 0.92 },
        uGrainStrength: { value: settings.grainStrength ?? 0.013 },
        uContrast: { value: settings.contrast ?? 1.08 },
        uSaturation: { value: settings.saturation ?? 1.04 },
        // Cool shadows, neutral mids, warm highlights: the standard grade for
        // an interior lit by a single warm source against daylight.
        uLift: { value: new Vector3(-0.004, 0.0, 0.012) },
        uGain: { value: new Vector3(1.03, 1.0, 0.965) },
        uGamma: { value: 0.98 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

    super(material);
    this.resolution = new Vector2(1, 1);
  }

  private resolution: Vector2;

  /** Advances the grain field. */
  public update(elapsedSeconds: number): void {
    this.uniforms['uTime'].value = elapsedSeconds;
  }

  public override setSize(width: number, height: number): void {
    this.resolution.set(width, height);
  }
}
