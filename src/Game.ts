import {
  ACESFilmicToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { Input } from './core/Input.js';
import { DustMotes } from './fx/DustMotes.js';
import { ImpactEffects } from './fx/ImpactEffects.js';
import { Player } from './player/Player.js';
import { HIP_FOV, Weapon } from './player/Weapon.js';
import { DepthCapture, SunDepthMap } from './render/DepthCapture.js';
import { createLightingEnvironment, SUN_DIRECTION, type LightingEnvironment } from './render/Environment.js';
import { PostProcessing } from './render/PostProcessing.js';
import { includeNonOccluding } from './render/RenderLayers.js';
import { Hud } from './ui/Hud.js';
import { createMaterials, type MaterialSet, type ProgressReporter } from './world/MaterialLibrary.js';
import { createLevel, ROOM_BOUNDS, SHAFT_FOCUS, type Level } from './world/Level.js';

/**
 * The game: composition root and frame loop.
 *
 * Construction order below is dependency order and is not interchangeable. The
 * renderer must exist before anything queries GPU capabilities (the texture
 * synthesiser needs the anisotropy limit); the level must exist before the sun
 * depth map, which captures it; and the depth map must exist before the
 * volumetric pass and the dust, both of which read it.
 *
 * The frame order has one subtlety worth stating plainly: the passes that read
 * depth as *geometry* — the volumetric march and GTAO — must not see the
 * additive sprite effects, which an override material would turn into solid
 * squares. That exclusion is expressed once, as a layer, rather than as a
 * sequence of things to remember to hide; see `RenderLayers`.
 */

/** Largest frame delta fed to simulation, in seconds. */
const MAX_DELTA = 0.05;

/** Resolution of the sun's depth map. */
const SUN_MAP_RESOLUTION = 2048;

export class Game {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly input: Input;
  private readonly hud: Hud;

  private environment!: LightingEnvironment;
  private materials!: MaterialSet;
  private level!: Level;
  private player!: Player;
  private weapon!: Weapon;
  private effects!: ImpactEffects;
  private dust!: DustMotes;
  private sunDepth!: SunDepthMap;
  private sceneDepth!: DepthCapture;
  private post!: PostProcessing;

  private previousTimestamp = 0;
  private elapsed = 0;
  private running = false;
  private frameHandle = 0;
  private currentFov = HIP_FOV;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    hudRoot: HTMLElement,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      // Antialiasing is handled by SMAA at the end of the chain. Asking for an
      // MSAA default framebuffer as well would cost memory and bandwidth for a
      // buffer the composer never presents from.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });

    if (!this.renderer.capabilities.isWebGL2) {
      throw new Error('This demo requires WebGL2.');
    }

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        // Near and far are chosen together. A viewmodel forty centimetres from the
    // eye tempts a very small near plane, but depth precision is governed by
    // the *ratio* of the two, and GTAO reconstructs world positions from that
    // depth — at 6000:1 its output degrades into blocks. The weapon is placed
    // far enough forward that 0.1 clears it.
    this.camera = new PerspectiveCamera(HIP_FOV, 1, 0.1, 90);
    // The beauty pass draws everything; only the depth-only captures narrow it.
    includeNonOccluding(this.camera);
    this.scene.add(this.camera);

    this.input = new Input(canvas);
    this.hud = new Hud(hudRoot);
  }

  /** Maximum anisotropy the GPU supports, for texture synthesis. */
  public get anisotropy(): number {
    return Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
  }

  /**
   * Builds the world. Long-running: reports progress as it goes.
   *
   * @param report - Progress callback driving the loading screen.
   */
  public async load(report: ProgressReporter): Promise<void> {
    this.environment = createLightingEnvironment(this.renderer, 1);
    this.scene.background = this.environment.background;
    this.scene.environment = this.environment.environment;
    // Scene-wide control over how strongly image-based lighting contributes,
    // which is the main dial for the interior's overall mood.
    this.scene.environmentIntensity = 0.52;

    this.materials = await createMaterials(this.anisotropy, report);

    this.level = createLevel(this.materials);
    this.scene.add(this.level.group);

    // Captured once: the level is static, so re-rendering the sun's view every
    // frame would be pure waste. It must happen before the viewmodel exists, or
    // the weapon would be baked into the shadow of the shaft.
    this.sunDepth = new SunDepthMap(SUN_MAP_RESOLUTION, SUN_DIRECTION, SHAFT_FOCUS);
    this.sunDepth.render(this.renderer, this.scene);

    this.player = new Player(this.level.colliders);
    this.effects = new ImpactEffects();
    this.effects.attachTo(this.scene);

    this.weapon = new Weapon(
      this.camera,
      this.materials,
      this.level.group,
      (impact) => {
        this.effects.spawn(impact.point, impact.normal);
      },
      () => {
        this.hud.kick();
      },
    );

    this.dust = new DustMotes(
      {
        minX: -ROOM_BOUNDS.halfWidth,
        minY: 0,
        minZ: -ROOM_BOUNDS.halfDepth,
        sizeX: ROOM_BOUNDS.halfWidth * 2,
        sizeY: ROOM_BOUNDS.height,
        sizeZ: ROOM_BOUNDS.halfDepth * 2,
      },
      this.sunDepth.texture,
      this.sunDepth.matrix,
    );
    this.dust.attachTo(this.scene);

    const size = this.getDrawingBufferSize();
    this.sceneDepth = new DepthCapture(size.width, size.height);
    this.post = new PostProcessing({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      sceneDepth: this.sceneDepth.texture,
      sunDepth: this.sunDepth.texture,
      sunMatrix: this.sunDepth.matrix,
      sunDirection: SUN_DIRECTION,
      width: size.width,
      height: size.height,
    });

    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  /** Starts the frame loop. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.previousTimestamp = performance.now();
    this.frameHandle = requestAnimationFrame(this.onFrame);
  }

  public stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  /**
   * Reports which formats and effects the render chain settled on.
   *
   * Kept because the chain makes real decisions at runtime — the HDR buffer
   * format is measured, not assumed — and a user reporting a visual fault
   * needs a way to say which branch they got.
   */
  public getDiagnostics(): Record<string, unknown> {
    return this.post.getDiagnostics();
  }

  /** Captures the pointer. Must be called from a user gesture. */
  public capturePointer(): void {
    this.input.requestLock();
  }

  /** Whether the pointer is captured. */
  public get isPointerLocked(): boolean {
    return this.input.isLocked;
  }

  public dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.weapon?.dispose();
    this.dust?.dispose();
    this.effects?.dispose();
    this.level?.dispose();
    this.materials?.dispose();
    this.environment?.dispose();
    this.sunDepth?.dispose();
    this.sceneDepth?.dispose();
    this.post?.dispose();
    this.renderer.dispose();
  }

  private getDrawingBufferSize(): { width: number; height: number } {
    const ratio = this.renderer.getPixelRatio();
    return {
      width: Math.max(1, Math.floor(this.canvas.clientWidth * ratio)),
      height: Math.max(1, Math.floor(this.canvas.clientHeight * ratio)),
    };
  }

  private readonly onResize = (): void => {
    this.resize();
  };

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const buffer = this.getDrawingBufferSize();
    this.sceneDepth.setSize(buffer.width, buffer.height);
    this.post.setSize(buffer.width, buffer.height);
  }

  private readonly onFrame = (timestamp: number): void => {
    if (!this.running) {
      return;
    }
    this.frameHandle = requestAnimationFrame(this.onFrame);

    const delta = Math.min((timestamp - this.previousTimestamp) / 1000, MAX_DELTA);
    this.previousTimestamp = timestamp;
    this.elapsed += delta;

    this.update(delta);
    this.render(delta);

    // Input deltas are consumed last, after every reader has run.
    this.input.endFrame();
  };

  private update(delta: number): void {
    this.player.update(this.input, delta);

    this.weapon.update(
      this.input,
      this.camera,
      delta,
      this.player.horizontalSpeed,
      this.player.isGrounded,
    );

    // Recoil is added on top of the player's aim rather than written into it,
    // so the view returns to where the player was pointing rather than drifting
    // upward over a sustained burst.
    this.player.applyToCamera(this.camera);
    this.camera.rotation.x += this.weapon.cameraPitchKick;
    this.camera.rotation.y += this.weapon.cameraYawKick;

    const fov = this.weapon.getFieldOfView();
    if (Math.abs(fov - this.currentFov) > 0.01) {
      this.currentFov = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // The artifact turns slowly and its light breathes, which keeps the frame
    // alive while the player is standing still looking at it.
    this.level.artifact.rotation.y += delta * 0.22;
    const pulse = 0.82 + Math.sin(this.elapsed * 1.6) * 0.12 + Math.sin(this.elapsed * 4.3) * 0.04;
    this.level.artifactLight.intensity = 6.5 * pulse;

    this.effects.update(delta);
    this.dust.update(this.elapsed);

    this.hud.update(
      delta,
      this.player.horizontalSpeed,
      this.weapon.aimFraction,
      this.weapon.ammo,
      this.weapon.magazineSize,
      this.weapon.isReloading,
    );
  }

  private render(delta: number): void {
    this.camera.updateMatrixWorld(true);

    this.sceneDepth.render(this.renderer, this.scene, this.camera);
    this.post.render(delta, this.elapsed);
  }
}
