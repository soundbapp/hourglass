import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import type { WebGLRenderer, WebGLRenderTarget } from 'three';
import { NON_OCCLUDING_LAYER } from '../RenderLayers.js';

/**
 * GTAO restricted to things that are actually geometry.
 *
 * Ground-truth ambient occlusion works from its own normal and depth prepass,
 * drawn with an override material. That override replaces the materials of
 * sprite effects which otherwise never write depth, so a dust field reaches the
 * occlusion solver as a few thousand solid screen-aligned squares and comes
 * back as rectangular blocks of shadow smeared across the image by the
 * denoiser.
 *
 * `DepthCapture` has the same problem and the same answer: hide the
 * non-occluding layer for the duration of the pass. Doing it here rather than
 * in the composer keeps the restriction attached to the pass that needs it,
 * and keeps the camera's mask untouched for everything else.
 */
export class GeometryGTAOPass extends GTAOPass {
  public override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const previousLayers = this.camera.layers.mask;
    this.camera.layers.disable(NON_OCCLUDING_LAYER);
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      this.camera.layers.mask = previousLayers;
    }
  }
}
