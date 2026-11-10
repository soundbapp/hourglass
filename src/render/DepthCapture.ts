import {
  DepthTexture,
  FloatType,
  Matrix4,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  RGBAFormat,
  UnsignedShortType,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { NON_OCCLUDING_LAYER } from './RenderLayers.js';

/**
 * Depth capture, from the camera and from the sun.
 *
 * The volumetric pass needs two things the main render does not hand it: the
 * scene's depth as a sampleable texture, and a depth map from the sun's point
 * of view to decide what is in shadow at each step along a ray.
 *
 * Both are rendered here rather than borrowed from the renderer's own shadow
 * plumbing. Three.js does maintain a shadow map, but its format, packing and
 * matrix conventions are internal and have changed repeatedly across versions;
 * depending on them would mean a silent visual break on the next upgrade. The
 * cost of owning it instead is two extra passes over a level of about thirty
 * meshes, which is far below measurement noise.
 */

/** Scales the ortho half-extent so the sun map comfortably covers the bay. */
const SUN_MAP_EXTENT = 15;

/** Depth range of the sun's orthographic frustum, in metres. */
const SUN_MAP_NEAR = 0.5;
const SUN_MAP_FAR = 60;

/**
 * Renders scene depth into a sampleable texture.
 *
 * The colour attachment is deliberately minimal and the scene is drawn with an
 * override material: nothing here cares about shading, only about how far away
 * the nearest surface is.
 */
export class DepthCapture {
  private readonly target: WebGLRenderTarget;
  private readonly overrideMaterial = new MeshBasicMaterial();

  public constructor(width: number, height: number, highPrecision = false) {
    const depthTexture = new DepthTexture(
      width,
      height,
      highPrecision ? FloatType : UnsignedShortType,
    );
    depthTexture.minFilter = NearestFilter;
    depthTexture.magFilter = NearestFilter;

    this.target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
  }

  /** The captured depth, for sampling in a shader. */
  public get texture(): Texture {
    const depth = this.target.depthTexture;
    if (depth === null) {
      throw new Error('depth capture target has no depth texture');
    }
    return depth;
  }

  /** Resizes the capture to match a new drawing buffer. */
  public setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  /**
   * Renders the scene's depth.
   *
   * The override material is opaque and writes depth, which is the point — but
   * it also replaces the materials of things that deliberately do not write
   * depth, turning additive sprites into solid squares in the buffer. Those
   * objects live on `NON_OCCLUDING_LAYER` and are switched off here; see
   * `RenderLayers`.
   *
   * @param renderer - Active renderer. Its state is restored on return.
   * @param scene - Scene to capture. Its override material is set and cleared.
   * @param camera - Viewpoint to capture from. Its layer mask is restored.
   */
  public render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;
    const previousLayers = camera.layers.mask;

    scene.overrideMaterial = this.overrideMaterial;
    camera.layers.disable(NON_OCCLUDING_LAYER);
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    camera.layers.mask = previousLayers;
    scene.overrideMaterial = previousOverride;
    renderer.setRenderTarget(previousTarget);
  }

  public dispose(): void {
    this.target.dispose();
    this.target.depthTexture?.dispose();
    this.overrideMaterial.dispose();
  }
}

/**
 * A depth map rendered from the sun, plus the matrix that samples it.
 *
 * This is what lets the volumetric pass answer "is this point in the shaft or
 * in shadow" for an arbitrary point in the air, which is a question the main
 * shadow pass never has to answer because it only ever shades surfaces.
 */
export class SunDepthMap {
  private readonly capture: DepthCapture;
  private readonly camera: OrthographicCamera;

  /** World space to shadow-map UV and depth. */
  public readonly matrix = new Matrix4();

  /**
   * @param resolution - Edge length of the map. 2048 resolves the edge of the
   *   shaft cleanly; below about 1024 the beam's border visibly stair-steps.
   * @param direction - Direction the light travels *from*, normalised.
   * @param target - Point the map is centred on.
   */
  public constructor(resolution: number, direction: Vector3, target: Vector3) {
    this.capture = new DepthCapture(resolution, resolution, true);
    this.camera = new OrthographicCamera(
      -SUN_MAP_EXTENT,
      SUN_MAP_EXTENT,
      SUN_MAP_EXTENT,
      -SUN_MAP_EXTENT,
      SUN_MAP_NEAR,
      SUN_MAP_FAR,
    );

    // Positioned back along the light direction far enough to contain the room.
    this.camera.position.copy(direction).multiplyScalar(30).add(target);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    this.updateMatrix();
  }

  /** The sun's depth buffer. */
  public get texture(): Texture {
    return this.capture.texture;
  }

  /** Captures the scene from the sun. Static geometry needs this only once. */
  public render(renderer: WebGLRenderer, scene: Scene): void {
    this.capture.render(renderer, scene, this.camera);
  }

  public dispose(): void {
    this.capture.dispose();
  }

  private updateMatrix(): void {
    // Remaps clip space [-1, 1] onto texture space [0, 1].
    const bias = new Matrix4().set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1,
    );
    this.matrix
      .copy(bias)
      .multiply(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse);
  }
}
