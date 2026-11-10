import {
  HalfFloatType,
  Vector2,
  WebGLRenderTarget,
  type Matrix4,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type Vector3,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { TextureDataType, WebGLRenderTarget as RenderTarget } from 'three';
import { selectHdrTextureType } from './Capabilities.js';
import { CinematicPass } from './passes/CinematicPass.js';
import { GeometryGTAOPass } from './passes/GeometryGTAOPass.js';
import { VolumetricLightPass } from './passes/VolumetricLightPass.js';

/**
 * The post-processing chain.
 *
 * Pass order here is not a preference — each stage has exactly one correct
 * position in the imaging pipeline, and getting it wrong produces artefacts
 * that no amount of parameter tuning recovers:
 *
 * 1. **Render** the scene into a half-float target. Half float, not 8-bit,
 *    because the sun is thirty times brighter than white and an integer target
 *    would clip that energy before anything downstream could use it.
 * 2. **GTAO**, while depth and normals still describe real geometry. Ambient
 *    occlusion darkens *ambient* light only, so it must land before anything
 *    adds light that did not come from the environment.
 * 3. **Volumetric shafts**, added in linear HDR. After AO — airborne light is
 *    not occluded by a crevice — and before bloom, so the beam blooms.
 * 4. **Bloom**, which must see linear HDR values to know what is genuinely
 *    brighter than the display can show. Bloom after tone mapping is the single
 *    most common mistake in this chain and produces the characteristic milky
 *    haze over everything.
 * 5. **Tone mapping and sRGB encode** (`OutputPass`), converting scene-referred
 *    radiance to display-referred pixels. Everything above this line is
 *    physical; everything below is photographic.
 * 6. **Grade, vignette, grain, aberration**, in display space, where a
 *    colourist works.
 * 7. **SMAA** last, on the final image, so it antialiases the edges the viewer
 *    actually sees rather than edges that later passes would alter.
 */

/** Everything the chain needs to build its passes. */
export interface PostProcessingInputs {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly sceneDepth: Texture;
  readonly sunDepth: Texture;
  readonly sunMatrix: Matrix4;
  readonly sunDirection: Vector3;
  readonly width: number;
  readonly height: number;
}

export class PostProcessing {
  private readonly composer: EffectComposer;
  private readonly gtao: GeometryGTAOPass;
  private readonly bloom: UnrealBloomPass;
  private readonly cinematic: CinematicPass;
  private readonly hdrType: TextureDataType;

  private readonly volumetrics: VolumetricLightPass;

  public constructor(inputs: PostProcessingInputs) {
    const { renderer, scene, camera, width, height } = inputs;

    const hdrType = selectHdrTextureType(renderer);
    this.hdrType = hdrType;

    // The chain carries scene-referred radiance, which is unbounded above 1.0,
    // until OutputPass maps it for the display — so the buffer must be floating
    // point. Which float depends on what the driver can *filter*; see
    // `selectHdrType`.
    const target = new WebGLRenderTarget(width, height, {
      type: hdrType,
      samples: 0,
      stencilBuffer: false,
    });

    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.gtao = new GeometryGTAOPass(scene, camera, width, height);
    // Radius in world units. About a third of a metre matches the scale of the
    // contact shadows in this room — under pipes, inside crate corners, where
    // the gantry meets the wall.
    this.gtao.updateGtaoMaterial({
      radius: 0.34,
      distanceExponent: 1.4,
      thickness: 0.45,
      scale: 1.1,
      samples: 16,
      screenSpaceRadius: false,
    });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 8 });
    // GTAO allocates half-float targets too, and its denoise is a guided blur
    // built from bilinear taps, so it needs the same treatment.
    this.retypeTargets(hdrType, [this.gtao.gtaoRenderTarget, this.gtao.pdRenderTarget]);
    this.composer.addPass(this.gtao);

    this.volumetrics = new VolumetricLightPass(
      camera,
      inputs.sceneDepth,
      inputs.sunDepth,
      inputs.sunMatrix,
      inputs.sunDirection,
    );
    this.composer.addPass(this.volumetrics);

    // Threshold just below 1.0: only genuinely over-bright values bloom, which
    // keeps the effect on light sources and the shaft instead of smearing the
    // whole image.
    this.bloom = new UnrealBloomPass(new Vector2(width, height), 0.42, 0.75, 0.92);
    // Bloom allocates its own mip chain and hardcodes half float. Its whole
    // operation is repeated bilinear downsampling, so it must use a format the
    // driver can filter.
    this.retypeTargets(hdrType, [
      this.bloom.renderTargetBright,
      ...this.bloom.renderTargetsHorizontal,
      ...this.bloom.renderTargetsVertical,
    ]);
    this.composer.addPass(this.bloom);

    this.composer.addPass(new OutputPass());

    this.cinematic = new CinematicPass();
    this.composer.addPass(this.cinematic);

    const smaa = new SMAAPass();
    this.composer.addPass(smaa);
  }

  /**
   * Forces a set of borrowed render targets onto the chosen HDR format.
   *
   * The stock passes hardcode half float for their internal buffers, which is
   * the right default and the wrong one on a driver that cannot filter it.
   * Rewriting the texture type before first use is enough: the target has not
   * allocated storage yet, so it simply allocates the format asked for.
   */
  private retypeTargets(hdrType: TextureDataType, targets: readonly RenderTarget[]): void {
    if (hdrType === HalfFloatType) {
      return;
    }
    for (const target of targets) {
      target.texture.type = hdrType;
    }
  }

  /** Reports the formats the chain selected, for diagnostics. */
  public getDiagnostics(): Record<string, unknown> {
    return {
      hdrType: this.hdrType === HalfFloatType ? 'half-float' : 'float',
      gtaoEnabled: this.gtao.enabled,
      bloomEnabled: this.bloom.enabled,
    };
  }

  public setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.gtao.setSize(width, height);
  }

  /**
   * Runs the chain.
   *
   * @param deltaSeconds - Frame delta, advancing the grain field.
   * @param elapsedSeconds - Total elapsed time.
   */
  public render(deltaSeconds: number, elapsedSeconds: number): void {
    this.cinematic.update(elapsedSeconds);
    this.composer.render(deltaSeconds);
  }

  public dispose(): void {
    this.composer.dispose();
  }
}
