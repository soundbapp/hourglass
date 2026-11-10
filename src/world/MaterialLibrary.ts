import { MeshStandardMaterial, Vector2, type Texture } from 'three';
import {
  concreteRecipe,
  gunmetalRecipe,
  paintedPanelRecipe,
  rustedSteelRecipe,
} from './SurfaceRecipes.js';
import { synthesiseSurface, type SurfaceTextures } from './TextureFactory.js';

/**
 * Builds the level's materials from procedural recipes.
 *
 * Resolution is spent where the eye spends its time. Concrete covers every
 * surface of the room and is viewed from thirty centimetres to fifteen metres,
 * so it gets the largest maps; a crate seen from two metres does not benefit
 * from the same budget. The gunmetal is the exception at the other end — the
 * weapon sits closer to the camera than anything else in the level ever will,
 * so its detail has to resolve at a scale the architecture never needs.
 *
 * Generation is interleaved with the event loop so the loading screen can
 * actually paint. Synthesising several megatexels of PBR data blocks the main
 * thread for seconds, and a frozen tab with no feedback reads as a crash.
 */

/** World size, in metres, that one texture tile covers. */
export const TEXTURE_SCALE = {
  concrete: 2.4,
  metal: 1.2,
  panel: 1.0,
  gunmetal: 0.26,
} as const;

/** Every material the level and viewmodel draw with. */
export interface MaterialSet {
  readonly concreteWall: MeshStandardMaterial;
  readonly concreteFloor: MeshStandardMaterial;
  readonly rustedSteel: MeshStandardMaterial;
  readonly paintedPanel: MeshStandardMaterial;
  readonly gunmetal: MeshStandardMaterial;
  dispose(): void;
}

/** Reports synthesis progress so the loading screen can show it. */
export type ProgressReporter = (fraction: number, label: string) => void;

/** Yields to the event loop so a progress update can be painted. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function buildMaterial(
  textures: SurfaceTextures,
  normalScale: number,
  aoIntensity = 1,
  envIntensity = 1,
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: textures.albedo,
    normalMap: textures.normal,
    normalScale: new Vector2(normalScale, normalScale),
    // Occlusion, roughness and metalness share one texture in the glTF
    // convention: R, G and B respectively. One sampler, three inputs.
    aoMap: textures.orm,
    roughnessMap: textures.orm,
    metalnessMap: textures.orm,
    aoMapIntensity: aoIntensity,
    roughness: 1,
    metalness: 1,
    envMapIntensity: envIntensity,
  });
}

/**
 * Synthesises every material.
 *
 * @param anisotropy - Maximum anisotropic filtering the GPU supports. Floors
 *   seen at a grazing angle are the reason this is worth threading through.
 * @param report - Progress callback, called between materials.
 */
export async function createMaterials(
  anisotropy: number,
  report: ProgressReporter,
): Promise<MaterialSet> {
  const generated: SurfaceTextures[] = [];

  report(0.05, 'pouring concrete');
  await nextFrame();
  const wallTextures = synthesiseSurface(
    concreteRecipe(0.18, 1021, 0.245),
    { size: 1024, period: 6, normalStrength: 0.0024, occlusionStrength: 1.6 },
    anisotropy,
  );
  generated.push(wallTextures);

  report(0.3, 'flooding the floor');
  await nextFrame();
  const floorTextures = synthesiseSurface(
    // Far wetter: water has collected and never drained, which is what gives
    // the floor its reflections and most of the room's visual interest.
    concreteRecipe(1.0, 7717, 0.105),
    { size: 1024, period: 6, normalStrength: 0.0021, occlusionStrength: 1.5 },
    anisotropy,
  );
  generated.push(floorTextures);

  report(0.55, 'corroding steel');
  await nextFrame();
  const steelTextures = synthesiseSurface(
    rustedSteelRecipe(0.62, 3307),
    { size: 512, period: 4, normalStrength: 0.0032, occlusionStrength: 1.3 },
    anisotropy,
  );
  generated.push(steelTextures);

  report(0.72, 'chipping paint');
  await nextFrame();
  const panelTextures = synthesiseSurface(
    // Desaturated industrial teal: a colour chosen to sit opposite the warm
    // sunlight on the colour wheel, so the two read as separate light sources.
    paintedPanelRecipe({ r: 0.055, g: 0.115, b: 0.125 }, 0.55, 5501),
    { size: 512, period: 4, normalStrength: 0.0026, occlusionStrength: 1.2 },
    anisotropy,
  );
  generated.push(panelTextures);

  report(0.88, 'machining steel');
  await nextFrame();
  const gunTextures = synthesiseSurface(
    gunmetalRecipe(9173),
    { size: 512, period: 5, normalStrength: 0.0018, occlusionStrength: 1.0 },
    anisotropy,
  );
  generated.push(gunTextures);

  report(1, 'ready');
  await nextFrame();

  return {
    concreteWall: buildMaterial(wallTextures, 1.1, 1.0),
    concreteFloor: buildMaterial(floorTextures, 0.9, 1.0),
    rustedSteel: buildMaterial(steelTextures, 1.3, 0.9),
    paintedPanel: buildMaterial(panelTextures, 1.0, 0.9),
    // The environment probe is captured once, from the middle of the room. For
    // the architecture that is a good approximation; for an object held at the
    // camera it is not, because the probe cannot know the weapon is being
    // carried through the brightest part of the bay. The lift restores the
    // energy the single-probe approximation loses, and is the difference
    // between a viewmodel with form and a black cut-out.
    gunmetal: buildMaterial(gunTextures, 0.8, 0.8, 1.45),
    dispose(): void {
      for (const set of generated) {
        set.dispose();
      }
    },
  };
}

/** Narrow helper so callers can type a texture without importing three types. */
export type MaterialTexture = Texture;
