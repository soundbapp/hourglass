import { cellular2, fbm2, lerp, ridged2, saturate, smoothBand, warpedFbm2 } from '../core/Noise.js';
import { type SurfaceRecipe, type SurfaceSample } from './TextureFactory.js';

/**
 * Surface recipes — the art direction of the level, expressed as functions.
 *
 * Each recipe layers weathering the way the real surface acquired it, in order:
 * the material, then what age did to it, then what water did, then what people
 * did. Layering in that order is why the result reads as a surface with a
 * history rather than as noise tinted a colour.
 *
 * Two rules every recipe here follows, because breaking either is what makes
 * rendered surfaces look synthetic:
 *
 * 1. **Albedo stays inside physical bounds.** Nothing is pure black or pure
 *    white; real reflectance runs about 0.03 to 0.8. Coal is 0.04, fresh snow
 *    is 0.8, and everything in a derelict bunker lives between.
 * 2. **Roughness is never constant.** It varies with wear, dust, moisture and
 *    handling at every scale, and that variation is what the eye reads as
 *    "real" long before it notices the colour.
 *
 * Metalness is kept binary. Intermediate values are physically meaningless for
 * anything but a transition texel, so rust drives metalness from 1 down to 0 as
 * steel oxidises into a dielectric, rather than tinting a metal brown.
 */

/** Reflectance of clean structural steel, used as its specular colour. */
const STEEL_F0 = { r: 0.56, g: 0.57, b: 0.58 };

/** Oxidised iron: a dielectric, not a metal. */
const RUST_DEEP = { r: 0.19, g: 0.075, b: 0.032 };
const RUST_BRIGHT = { r: 0.36, g: 0.16, b: 0.06 };

/**
 * Directional streak field, for scratches and water runs.
 *
 * Sampling fBm with one axis compressed produces strokes aligned to the other,
 * which is how brushed metal and gravity-driven staining actually look.
 */
function streaks(x: number, y: number, seed: number, stretch: number, period: number): number {
  return fbm2(x * stretch, y / stretch, seed, { octaves: 4, period: Math.max(1, period) });
}

/**
 * Poured concrete: aggregate, pitting, cracking and water staining.
 *
 * The dominant surface of the level, so it carries the most variation — large
 * blotches at the metre scale stop a six-metre wall from reading as one tile,
 * and aggregate at the millimetre scale keeps it from going flat up close.
 */
export function concreteRecipe(wetness: number, seed: number, baseTone = 0.255): SurfaceRecipe {
  return (x: number, y: number, out: SurfaceSample): void => {
    // Metre-scale tonal drift from the pour itself.
    const blotch = fbm2(x * 0.35, y * 0.35, seed, { octaves: 4, period: 3 });
    // Centimetre-scale surface noise.
    const grain = fbm2(x * 7, y * 7, seed + 17, { octaves: 5, period: 56 });

    // Exposed aggregate: stones in the mix, each with its own tone.
    const stones = cellular2(x * 11, y * 11, 88, seed + 51);
    const stoneMask = smoothBand(0.42, 0.14, stones.f1);
    const stoneTone = lerp(-0.045, 0.055, stones.cellValue);

    // Air-void pitting left by the pour.
    const pits = cellular2(x * 23, y * 23, 184, seed + 113);
    const pitMask = smoothBand(0.16, 0.03, pits.f1) * smoothBand(0.55, 0.8, pits.cellValue);

    // Cracking, following a warped ridge network so it meanders.
    const crackField = ridged2(x * 1.6, y * 1.6, seed + 211, { octaves: 4, period: 13 });
    const cracks = smoothBand(0.86, 0.97, crackField);

    let height = 0.5 + grain * 0.22 + stoneMask * 0.1 - pitMask * 0.55 - cracks * 0.4;
    height = saturate(height);

    // Base tone: neutral, faintly warm grey.
    let tone = baseTone + blotch * 0.055 + grain * 0.038 + stoneMask * stoneTone;

    // Water staining, falling under gravity down the surface.
    const runoff = streaks(x, y, seed + 307, 0.18, 10);
    const stainMask = saturate(smoothBand(0.1, 0.62, runoff) * (0.45 + blotch * 0.55));
    tone = lerp(tone, tone * 0.52, stainMask * 0.85);

    // Standing water, in broad smooth pools that follow the floor's low spots.
    // This is the single most valuable feature on a horizontal surface: a
    // puddle is a near-mirror, so it reproduces the shaft, the sky through the
    // breach and every light in the room, and it is the thing that most makes
    // a floor look photographed rather than painted.
    const pools = warpedFbm2(x * 0.75, y * 0.75, seed + 613, { octaves: 4, period: 6 }, 0.8);
    // Water settles into depressions, so the mask is biased by the height field.
    const poolMask = saturate(smoothBand(-0.08, 0.26, pools) * (1.35 - height));
    const puddle = saturate(poolMask * wetness);

    // Efflorescence: salts carried out of the concrete, pale and chalky. Washed
    // away wherever water actually stands.
    const bloom = warpedFbm2(x * 2.1, y * 2.1, seed + 419, { octaves: 3, period: 17 }, 0.6);
    const bloomMask = smoothBand(0.52, 0.86, bloom) * (1 - stainMask) * (1 - puddle) * 0.3;
    tone = lerp(tone, 0.40, bloomMask);

    // Cracks and pits read dark because they are in shadow at every scale below
    // the one the normal map can resolve.
    tone *= 1 - cracks * 0.55 - pitMask * 0.35;

    out.height = height;
    // Very slightly warm, and cooler where damp.
    out.red = tone * 1.015;
    out.green = tone;
    out.blue = tone * lerp(0.97, 1.03, stainMask);

    // Rough by default; polished where water has pooled and darkened it.
    let roughness = 0.93 - grain * 0.07 - stoneMask * 0.05 + cracks * 0.04;
    const damp = saturate(Math.max(puddle, stainMask * wetness * 0.45));

    // A water film is far smoother than anything beneath it, and the surface it
    // covers absorbs more light because rays refract into the pores instead of
    // scattering straight back out. Both effects are large.
    roughness = lerp(roughness, 0.045, puddle);
    roughness = lerp(roughness, 0.3, saturate(damp - puddle));
    out.roughness = saturate(roughness);

    if (damp > 0) {
      const darkening = lerp(1, 0.3, damp);
      out.red *= darkening;
      out.green *= darkening * 1.01;
      out.blue *= darkening * 1.05;
    }

    out.metalness = 0;
  };
}

/**
 * Structural steel that has been wet for a long time.
 *
 * Rust is modelled as a dielectric crust growing over metal, so the metalness
 * channel falls to zero exactly where the oxide is thick. Tinting a metal brown
 * instead is the usual shortcut and it always reads as painted metal, never as
 * corrosion.
 */
export function rustedSteelRecipe(corrosion: number, seed: number): SurfaceRecipe {
  return (x: number, y: number, out: SurfaceSample): void => {
    const mill = streaks(x, y, seed + 29, 5.5, 44);
    const grime = fbm2(x * 3.1, y * 3.1, seed + 61, { octaves: 4, period: 25 });

    // Corrosion spreads in blooms from pits and edges.
    const bloomCells = cellular2(x * 3.4, y * 3.4, 27, seed + 89);
    const bloomField = warpedFbm2(x * 2.2, y * 2.2, seed + 151, { octaves: 4, period: 18 }, 0.9);
    const rust = saturate(
      smoothBand(0.62 - corrosion * 0.5, 0.95 - corrosion * 0.45, bloomField) +
        smoothBand(0.5, 0.1, bloomCells.f1) * corrosion * 0.65,
    );

    // Flaking: the crust lifts and breaks into scales.
    const flakes = cellular2(x * 14, y * 14, 112, seed + 173);
    const flakeEdge = smoothBand(0.1, 0.0, flakes.f2 - flakes.f1) * rust;

    // Deep pitting, only where corrosion has had time to eat in.
    const pit = smoothBand(0.72, 0.95, bloomField) * corrosion;

    const height = saturate(
      0.5 + mill * 0.05 + rust * 0.16 + flakeEdge * -0.3 - pit * 0.5 + grime * 0.05,
    );

    // Bare steel: a bright, neutral specular colour.
    const polish = saturate(0.5 + mill * 0.5);
    let red = STEEL_F0.r * lerp(0.82, 1.08, polish);
    let green = STEEL_F0.g * lerp(0.82, 1.08, polish);
    let blue = STEEL_F0.b * lerp(0.84, 1.08, polish);
    let roughness = lerp(0.55, 0.36, polish);
    let metalness = 1;

    if (rust > 0) {
      // Oxide colour runs from dark iron oxide to bright fresh orange.
      const tint = saturate(bloomCells.cellValue * 0.7 + grime * 0.3 + 0.15);
      const rustRed = lerp(RUST_DEEP.r, RUST_BRIGHT.r, tint);
      const rustGreen = lerp(RUST_DEEP.g, RUST_BRIGHT.g, tint);
      const rustBlue = lerp(RUST_DEEP.b, RUST_BRIGHT.b, tint);

      red = lerp(red, rustRed, rust);
      green = lerp(green, rustGreen, rust);
      blue = lerp(blue, rustBlue, rust);
      roughness = lerp(roughness, 0.92 - flakeEdge * 0.1, rust);
      // The crust is no longer conductive.
      metalness = lerp(metalness, 0, saturate(rust * 1.15));
    }

    // Airborne dust settles on everything and flattens the specular response.
    const dust = smoothBand(0.35, 0.8, grime) * 0.3;
    roughness = saturate(roughness + dust * 0.25);

    out.height = height;
    out.red = red;
    out.green = green;
    out.blue = blue;
    out.roughness = roughness;
    out.metalness = metalness;
  };
}

/**
 * Industrial painted panel, with the paint failing.
 *
 * Three strata, revealed in order as damage deepens: topcoat, oxide primer,
 * bare metal. Chips expose primer first and metal only at their centres, which
 * is how paint actually fails and is the detail that sells the material.
 */
export function paintedPanelRecipe(
  colour: { r: number; g: number; b: number },
  wear: number,
  seed: number,
): SurfaceRecipe {
  return (x: number, y: number, out: SurfaceSample): void => {
    const orangePeel = fbm2(x * 9, y * 9, seed + 13, { octaves: 4, period: 72 });
    const grime = warpedFbm2(x * 1.8, y * 1.8, seed + 37, { octaves: 4, period: 14 }, 0.7);

    // Chipping clusters, strongest where the panel has been knocked.
    const chipCells = cellular2(x * 7.5, y * 7.5, 60, seed + 71);
    const chipField = fbm2(x * 4.2, y * 4.2, seed + 97, { octaves: 4, period: 34 });
    const chip = saturate(
      smoothBand(0.3, 0.06, chipCells.f1) * smoothBand(0.35, 0.75, chipField) * (0.4 + wear),
    );
    const chipCore = smoothBand(0.5, 0.95, chip);

    // Scratches from handling: thin, bright, and much smoother than the paint.
    const scratchField = streaks(x, y, seed + 139, 7, 52);
    const scratches = smoothBand(0.72, 0.93, scratchField) * (0.35 + wear * 0.8);

    const height = saturate(
      0.55 + orangePeel * 0.05 - chip * 0.35 - scratches * 0.12 - grime * 0.03,
    );

    // Topcoat, unevenly faded by light and age.
    const fade = 0.82 + grime * 0.18;
    let red = colour.r * fade;
    let green = colour.g * fade;
    let blue = colour.b * fade;
    let roughness = lerp(0.38, 0.52, saturate(orangePeel * 0.5 + 0.5));
    let metalness = 0;

    // Oxide primer beneath.
    const primer = saturate(chip - chipCore * 0.6);
    red = lerp(red, 0.26, primer);
    green = lerp(green, 0.12, primer);
    blue = lerp(blue, 0.07, primer);
    roughness = lerp(roughness, 0.88, primer);

    // Bare metal at the centre of deep chips and along scratches.
    const exposed = saturate(chipCore + scratches * 0.75);
    red = lerp(red, STEEL_F0.r, exposed);
    green = lerp(green, STEEL_F0.g, exposed);
    blue = lerp(blue, STEEL_F0.b, exposed);
    roughness = lerp(roughness, 0.3, exposed);
    metalness = lerp(metalness, 1, exposed);

    // Grime collects in the texture of the paint and kills its gloss.
    const dirt = smoothBand(0.3, 0.85, grime);
    red = lerp(red, red * 0.55, dirt * 0.55);
    green = lerp(green, green * 0.56, dirt * 0.55);
    blue = lerp(blue, blue * 0.52, dirt * 0.55);
    roughness = saturate(lerp(roughness, 0.9, dirt * 0.4));

    out.height = height;
    out.red = red;
    out.green = green;
    out.blue = blue;
    out.roughness = roughness;
    out.metalness = metalness;
  };
}

/**
 * Machined gunmetal, for the weapon.
 *
 * Far finer in scale than anything architectural: the viewmodel sits centimetres
 * from the camera, so its detail has to resolve at a scale the walls never need
 * to. Anodised finish, bead-blasted, with wear concentrated on the edges a hand
 * and a holster actually touch.
 */
export function gunmetalRecipe(seed: number): SurfaceRecipe {
  return (x: number, y: number, out: SurfaceSample): void => {
    // Bead-blasted micro-texture.
    const blast = fbm2(x * 26, y * 26, seed + 7, { octaves: 5, period: 208 });
    // Faint machining lines from the mill.
    const machining = streaks(x, y, seed + 41, 11, 88);
    const wearField = warpedFbm2(x * 3.6, y * 3.6, seed + 83, { octaves: 4, period: 29 }, 0.5);
    const wear = smoothBand(0.55, 0.85, wearField);

    const height = saturate(0.55 + blast * 0.08 + machining * 0.03 - wear * 0.05);

    // Dark anodised grey, polished bright where it has been handled.
    //
    // For a metal the albedo *is* the specular colour at normal incidence, so
    // this value decides whether the weapon has form in a dark room or reads as
    // a black cut-out. Black anodising over aluminium is dark but nowhere near
    // the 0.05 that an sRGB paint swatch suggests: the oxide is thin and the
    // metal underneath still reflects. Measured values sit near 0.16, which is
    // what gives a real rifle its visible edges indoors.
    const base = 0.158 + blast * 0.028;
    let red = base;
    let green = base * 1.01;
    let blue = base * 1.06;

    red = lerp(red, STEEL_F0.r * 0.85, wear);
    green = lerp(green, STEEL_F0.g * 0.85, wear);
    blue = lerp(blue, STEEL_F0.b * 0.86, wear);

    out.height = height;
    out.red = red;
    out.green = green;
    out.blue = blue;
    out.roughness = saturate(lerp(0.52 - blast * 0.08, 0.19, wear));
    // Anodising is a thin oxide over metal; it reads as metal at this scale.
    out.metalness = 1;
  };
}
