import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Raycaster,
  Vector2,
  Vector3,
  type Material,
  type PerspectiveCamera,
} from 'three';
import { type Input } from '../core/Input.js';
import { markNonOccluding } from '../render/RenderLayers.js';
import { createBevelledBox } from '../world/Geometry.js';
import { TEXTURE_SCALE, type MaterialSet } from '../world/MaterialLibrary.js';

/**
 * The weapon viewmodel, and what happens when it is fired.
 *
 * The viewmodel is parented to the camera and lives in the main scene rather
 * than being rendered in a separate pass with its own lights. That is the less
 * conventional choice — most shooters isolate the viewmodel so they can light
 * it consistently — and it is made deliberately here: a weapon lit by the
 * actual shaft, picking up the actual bounce off the actual concrete, and
 * casting into the actual volumetrics, is dramatically more convincing than one
 * lit by a private three-point rig that never changes. In a level built around
 * one light, the weapon passing through that light is half the appeal.
 *
 * Feel comes from four layered motions, none of which is the gun "moving":
 *
 * - **Sway** — the weapon lags behind the view, because a held object has mass
 *   and the arms holding it are not rigid.
 * - **Bob** — a figure-eight tied to gait, so walking is felt rather than seen.
 * - **Recoil** — an impulse back and up that springs home, with the camera
 *   kicking slightly less than the weapon so the two separate briefly.
 * - **Aim** — the weapon rises to the eye line while the field of view narrows,
 *   which reads as magnification without any optic actually magnifying.
 */

/** Resting position of the weapon in camera space, in metres. */
const HIP_POSITION = new Vector3(0.17, -0.155, -0.56);
/** Position when aimed: centred on the optical axis. */
const AIM_POSITION = new Vector3(0, -0.079, -0.44);

/** Field of view when hip-firing and when aimed, in degrees. */
export const HIP_FOV = 74;
export const AIM_FOV = 48;

/** Seconds between shots. 0.085 is roughly 700 rounds per minute. */
const FIRE_INTERVAL = 0.085;

/** Magazine capacity and reload duration. */
const MAGAZINE_SIZE = 30;
const RELOAD_SECONDS = 1.45;

/** Recoil impulse per shot. */
const RECOIL_KICK = 0.028;
const RECOIL_PITCH = 0.021;
/** Fraction of the weapon's kick the camera inherits. */
const CAMERA_KICK_RATIO = 0.42;

/** Maximum engagement range, in metres. */
const MAX_RANGE = 60;

/** Reported when a shot connects with the level. */
export interface ImpactEvent {
  readonly point: Vector3;
  readonly normal: Vector3;
}

/** Builds the weapon mesh from primitives. */
function buildWeaponMesh(materials: MaterialSet, owned: Material[]): Group {
  const weapon = new Group();
  const metal = materials.gunmetal;
  const scale = TEXTURE_SCALE.gunmetal;

  const polymer = new MeshStandardMaterial({
    color: 0x0c0d0f,
    roughness: 0.62,
    metalness: 0,
    envMapIntensity: 1.1,
  });
  owned.push(polymer);

  const add = (
    geometry: Mesh['geometry'],
    material: Material,
    position: [number, number, number],
    rotation?: [number, number, number],
  ): Mesh => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(position[0], position[1], position[2]);
    if (rotation !== undefined) {
      mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    }
    // The viewmodel neither casts nor receives shadows: at this distance the
    // shadow map has no resolution to spare on it, and self-shadowing a model
    // this close produces acne that no bias setting fixes.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    weapon.add(mesh);
    return mesh;
  };

  // Receiver and upper rail.
  add(createBevelledBox(0.062, 0.078, 0.3, 0.006, scale), metal, [0, 0, 0]);
  add(createBevelledBox(0.05, 0.022, 0.26, 0.004, scale), metal, [0, 0.05, -0.01]);

  // Handguard, with cooling slots cut as negative-space gaps between ribs.
  for (let i = 0; i < 5; i++) {
    add(createBevelledBox(0.052, 0.046, 0.018, 0.004, scale), polymer, [0, 0.004, -0.19 - i * 0.032]);
  }

  // Barrel and muzzle device.
  const barrel = new CylinderGeometry(0.0115, 0.0115, 0.3, 14, 1);
  add(barrel, metal, [0, 0.012, -0.28], [Math.PI / 2, 0, 0]);
  add(new CylinderGeometry(0.019, 0.017, 0.05, 14, 1), metal, [0, 0.012, -0.44], [Math.PI / 2, 0, 0]);

  // Magazine, canted forward the way a curved magazine sits.
  add(createBevelledBox(0.042, 0.17, 0.07, 0.005, scale), polymer, [0, -0.13, 0.015], [0.14, 0, 0]);

  // Pistol grip.
  add(createBevelledBox(0.04, 0.125, 0.055, 0.008, scale), polymer, [0, -0.1, 0.115], [-0.34, 0, 0]);

  // Stock.
  add(createBevelledBox(0.045, 0.062, 0.14, 0.008, scale), polymer, [0, 0.004, 0.2]);
  add(createBevelledBox(0.052, 0.085, 0.03, 0.006, scale), polymer, [0, -0.005, 0.28]);

  // Optic: housing, and an emissive dot bright enough to bloom.
  add(createBevelledBox(0.038, 0.042, 0.075, 0.005, scale), metal, [0, 0.082, -0.03]);
  const reticle = new MeshStandardMaterial({
    color: 0x220000,
    emissive: 0xff2d10,
    emissiveIntensity: 14,
    roughness: 0.4,
  });
  owned.push(reticle);
  add(new CylinderGeometry(0.0035, 0.0035, 0.004, 10, 1), reticle, [0, 0.082, -0.062], [Math.PI / 2, 0, 0]);

  // Charging handle and ejection port, which break up the receiver's slab side.
  add(createBevelledBox(0.012, 0.016, 0.055, 0.003, scale), metal, [0.036, 0.03, 0.06]);
  add(createBevelledBox(0.004, 0.03, 0.07, 0.002, scale), metal, [0.032, 0.012, -0.04]);

  return weapon;
}

export class Weapon {
  private readonly group = new Group();
  private readonly mesh: Group;
  private readonly muzzleLight: PointLight;
  private readonly muzzleFlash: Mesh;
  private readonly ownedMaterials: Material[] = [];

  private readonly raycaster = new Raycaster();
  private readonly screenCentre = new Vector2(0, 0);
  private readonly muzzleWorld = new Vector3();

  private cooldown = 0;
  private reloadTimer = 0;
  private flashTimer = 0;
  private aimAmount = 0;

  private recoilOffset = 0;
  private recoilPitch = 0;
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;

  /** Rounds remaining in the magazine. */
  public ammo = MAGAZINE_SIZE;
  /** Pitch the camera has inherited from recoil, in radians. */
  public cameraPitchKick = 0;
  /** Yaw the camera has inherited from recoil, in radians. */
  public cameraYawKick = 0;

  public constructor(
    camera: PerspectiveCamera,
    materials: MaterialSet,
    private readonly target: Object3D,
    private readonly onImpact: (impact: ImpactEvent) => void,
    private readonly onFired: () => void,
  ) {
    this.mesh = buildWeaponMesh(materials, this.ownedMaterials);
    this.group.add(this.mesh);
    camera.add(this.group);

    // Muzzle flash: a brief, very bright point light plus a small emissive
    // card. The light is what matters — it is what throws the room into relief
    // for a frame and makes firing feel like it emits energy.
    this.muzzleLight = new PointLight(0xffd9a0, 0, 7, 2);
    this.muzzleLight.position.set(0, 0.012, -0.47);
    this.group.add(this.muzzleLight);

    const flashMaterial = new MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffc368,
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.ownedMaterials.push(flashMaterial);
    this.muzzleFlash = new Mesh(new CylinderGeometry(0.0, 0.055, 0.1, 10, 1), flashMaterial);
    this.muzzleFlash.position.set(0, 0.012, -0.5);
    this.muzzleFlash.rotation.x = Math.PI / 2;
    this.muzzleFlash.visible = false;
    this.group.add(this.muzzleFlash);

    // The weapon itself stays in the depth captures: it is solid, and a light
    // shaft seen *through* the receiver reads as a ghost rather than a gun.
    // The flash is the exception — an additive card that exists for two frames
    // and must not punch a hole in the depth buffer while it is up.
    markNonOccluding(this.muzzleFlash);

    this.raycaster.far = MAX_RANGE;
  }

  /** Magazine capacity, for the ammo readout. */
  public get magazineSize(): number {
    return MAGAZINE_SIZE;
  }

  /** Whether a reload is in progress. */
  public get isReloading(): boolean {
    return this.reloadTimer > 0;
  }

  /** How far the weapon is raised to the eye, in `[0, 1]`. */
  public get aimFraction(): number {
    return this.aimAmount;
  }

  /**
   * Advances the viewmodel and resolves firing.
   *
   * @param input - Device state.
   * @param camera - View camera, used for aiming the ray.
   * @param delta - Frame delta, in seconds.
   * @param moveSpeed - Horizontal player speed, which drives bob.
   * @param grounded - Whether the player is on the ground.
   */
  public update(
    input: Input,
    camera: PerspectiveCamera,
    delta: number,
    moveSpeed: number,
    grounded: boolean,
  ): void {
    this.cooldown = Math.max(0, this.cooldown - delta);

    if (this.reloadTimer > 0) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) {
        this.ammo = MAGAZINE_SIZE;
      }
    } else if (input.wasPressed('KeyR') && this.ammo < MAGAZINE_SIZE) {
      this.reloadTimer = RELOAD_SECONDS;
    }

    const aiming = input.isButtonDown(2) && !this.isReloading;
    // Raising to the eye is slightly faster than lowering, which is what makes
    // aiming feel responsive without making the weapon feel weightless.
    const aimRate = aiming ? 13 : 10;
    this.aimAmount += ((aiming ? 1 : 0) - this.aimAmount) * (1 - Math.exp(-aimRate * delta));

    if (input.isButtonDown(0) && input.isLocked) {
      this.tryFire(camera);
    }

    this.updateSway(input, delta);
    this.updateBob(delta, moveSpeed, grounded);
    this.updateRecoil(delta);
    this.updateFlash(delta);
    this.updateTransform();
  }

  /** Field of view for the current aim state, in degrees. */
  public getFieldOfView(): number {
    // Smoothstep rather than linear: a linear zoom reads as mechanical.
    const t = this.aimAmount * this.aimAmount * (3 - 2 * this.aimAmount);
    return HIP_FOV + (AIM_FOV - HIP_FOV) * t;
  }

  public dispose(): void {
    this.group.removeFromParent();
    this.mesh.traverse((node) => {
      const mesh = node as Partial<Mesh>;
      mesh.geometry?.dispose();
    });
    for (const material of this.ownedMaterials) {
      material.dispose();
    }
  }

  private tryFire(camera: PerspectiveCamera): void {
    if (this.cooldown > 0 || this.isReloading) {
      return;
    }
    if (this.ammo <= 0) {
      this.reloadTimer = RELOAD_SECONDS;
      return;
    }

    this.cooldown = FIRE_INTERVAL;
    this.ammo--;

    // The ray is cast from the screen centre, not the muzzle. Firing from the
    // muzzle is more faithful and worse: the weapon sits below and right of the
    // optical axis, so shots would not land where the crosshair is.
    this.raycaster.setFromCamera(this.screenCentre, camera);
    const hits = this.raycaster.intersectObject(this.target, true);
    const hit = hits.find((candidate) => candidate.face !== null && candidate.face !== undefined);

    if (hit?.face != null) {
      const normal = hit.face.normal.clone();
      // Face normals are in object space; the world transform matters for
      // anything the level builder rotated.
      normal.transformDirection(hit.object.matrixWorld);
      this.onImpact({ point: hit.point.clone(), normal });
    }

    // Recoil is partly random so a held burst walks unpredictably, which is
    // what stops sustained fire from feeling like a laser pointer.
    this.recoilOffset += RECOIL_KICK * (0.85 + Math.random() * 0.3);
    this.recoilPitch += RECOIL_PITCH * (0.8 + Math.random() * 0.4);
    this.cameraPitchKick += RECOIL_PITCH * CAMERA_KICK_RATIO * (0.8 + Math.random() * 0.4);
    this.cameraYawKick += (Math.random() - 0.5) * RECOIL_PITCH * 0.5;

    this.flashTimer = 0.045;
    this.onFired();
  }

  private updateSway(input: Input, delta: number): void {
    // The weapon trails the view. Scaled down hard when aiming, because a
    // shouldered weapon is braced against the body and barely moves.
    const swayScale = 0.00042 * (1 - this.aimAmount * 0.82);
    const targetX = Math.max(-0.035, Math.min(0.035, -input.lookX * swayScale));
    const targetY = Math.max(-0.03, Math.min(0.03, input.lookY * swayScale));

    const response = 1 - Math.exp(-9 * delta);
    this.swayX += (targetX - this.swayX) * response;
    this.swayY += (targetY - this.swayY) * response;

    // Decay toward rest so the weapon settles when the view stops moving.
    const settle = 1 - Math.exp(-4.5 * delta);
    this.swayX *= 1 - settle;
    this.swayY *= 1 - settle;
  }

  private updateBob(delta: number, moveSpeed: number, grounded: boolean): void {
    if (grounded && moveSpeed > 0.4) {
      this.bobPhase += delta * (4.4 + moveSpeed * 1.25);
    } else {
      this.bobPhase += delta * 1.1;
    }
  }

  private updateRecoil(delta: number): void {
    // Critically-damped-ish return: fast at first, settling without overshoot.
    const recovery = 1 - Math.exp(-14 * delta);
    this.recoilOffset -= this.recoilOffset * recovery;
    this.recoilPitch -= this.recoilPitch * recovery;

    const cameraRecovery = 1 - Math.exp(-7.5 * delta);
    this.cameraPitchKick -= this.cameraPitchKick * cameraRecovery;
    this.cameraYawKick -= this.cameraYawKick * cameraRecovery;
  }

  private updateFlash(delta: number): void {
    if (this.flashTimer > 0) {
      this.flashTimer -= delta;
      const intensity = Math.max(0, this.flashTimer / 0.045);
      this.muzzleLight.intensity = intensity * 26;
      this.muzzleFlash.visible = true;
      (this.muzzleFlash.material as MeshStandardMaterial).emissiveIntensity = intensity * 24;
      // Rolling the flash each shot stops repeated fire from looking stamped.
      this.muzzleFlash.rotation.z = Math.random() * Math.PI;
      this.muzzleFlash.scale.setScalar(0.75 + Math.random() * 0.5);
    } else if (this.muzzleLight.intensity !== 0) {
      this.muzzleLight.intensity = 0;
      this.muzzleFlash.visible = false;
    }
  }

  private updateTransform(): void {
    const aim = this.aimAmount * this.aimAmount * (3 - 2 * this.aimAmount);

    const bobX = Math.cos(this.bobPhase) * 0.009 * (1 - aim * 0.9);
    // Twice the horizontal frequency: the head dips on each footfall, the
    // weapon traces a figure eight.
    const bobY = Math.sin(this.bobPhase * 2) * 0.006 * (1 - aim * 0.9);

    this.group.position.set(
      HIP_POSITION.x + (AIM_POSITION.x - HIP_POSITION.x) * aim + this.swayX + bobX,
      HIP_POSITION.y + (AIM_POSITION.y - HIP_POSITION.y) * aim + this.swayY + bobY,
      HIP_POSITION.z + (AIM_POSITION.z - HIP_POSITION.z) * aim + this.recoilOffset,
    );

    this.group.rotation.set(
      this.recoilPitch + this.swayY * 2.2,
      this.swayX * -2.6 + (1 - aim) * 0.045,
      this.swayX * 1.8 + (1 - aim) * 0.02,
    );
  }

  /** World position of the muzzle, for spawning tracers and smoke. */
  public getMuzzlePosition(out: Vector3): Vector3 {
    this.muzzleFlash.getWorldPosition(this.muzzleWorld);
    return out.copy(this.muzzleWorld);
  }
}
