import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { type Input } from '../core/Input.js';

/**
 * First-person movement.
 *
 * Modelled on the acceleration/friction scheme that arena shooters settled on,
 * because it is the one that *feels* right rather than the one that is most
 * physically faithful. Real human locomotion has far more inertia than a player
 * will tolerate: the control has to answer instantly while still carrying
 * enough momentum that movement reads as weight rather than as a cursor.
 *
 * Collision is swept per axis against axis-aligned boxes. For a level built
 * from boxes this is exact, needs no broadphase at thirty-odd colliders, and —
 * most importantly — resolving one axis at a time is what lets the player slide
 * along a wall instead of stopping dead against it.
 *
 * The camera work matters as much as the movement. Head bob, landing
 * compression and a slight roll into strafes are what make the viewpoint read
 * as carried by a body. Without them the camera reads as a floating tripod, no
 * matter how good the movement underneath it is.
 */

/** Horizontal radius of the player's collision box, in metres. */
const PLAYER_RADIUS = 0.34;
/** Standing height, in metres. */
const STANDING_HEIGHT = 1.78;
/** Crouched height, in metres. */
const CROUCH_HEIGHT = 1.12;
/** Eye height below the top of the collider, in metres. */
const EYE_OFFSET = 0.14;

/** Ground acceleration, in metres per second squared. */
const GROUND_ACCELERATION = 72;
/** Air acceleration. Low enough that air control assists rather than replaces. */
const AIR_ACCELERATION = 14;
/** Ground friction coefficient. */
const GROUND_FRICTION = 11;

const WALK_SPEED = 3.5;
const SPRINT_SPEED = 6.1;
const CROUCH_SPEED = 1.7;

const GRAVITY = 20.5;
const JUMP_VELOCITY = 6.4;

/** Vertical travel of the head bob, in metres. */
const BOB_AMPLITUDE = 0.045;
/** Roll into a strafe, in radians. */
const STRAFE_ROLL = 0.023;

/** Radians of view rotation per pixel of pointer movement. */
const DEFAULT_SENSITIVITY = 0.0022;

/** Pitch limit, just short of vertical. */
const MAX_PITCH = Math.PI / 2 - 0.02;

/** Scratch vectors, reused so the per-frame path allocates nothing. */
const scratchForward = new Vector3();
const scratchRight = new Vector3();
const scratchWish = new Vector3();
const playerBox = new Box3();

export class Player {
  /** Feet position, in world space. */
  public readonly position = new Vector3(6.2, 0, 4.7);
  public readonly velocity = new Vector3();

  // Facing the artifact and the shaft from the near corner of the bay, which
  // is the composition the level was built around.
  public yaw = 0.575;
  public pitch = -0.02;

  /** Look sensitivity, in radians per pixel. */
  public sensitivity = DEFAULT_SENSITIVITY;

  private height = STANDING_HEIGHT;
  private targetHeight = STANDING_HEIGHT;
  private grounded = false;
  private bobPhase = 0;
  private bobOffset = 0;
  private landingDip = 0;
  private rollAngle = 0;
  private previousVerticalVelocity = 0;

  public constructor(private readonly colliders: readonly Box3[]) {}

  /** Whether the player is standing on something. */
  public get isGrounded(): boolean {
    return this.grounded;
  }

  /** Horizontal speed, in metres per second. Drives bob and weapon sway. */
  public get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Whether the player is crouching. */
  public get isCrouched(): boolean {
    return this.targetHeight < STANDING_HEIGHT;
  }

  /** Current eye height above the feet, including bob and crouch. */
  public get eyeHeight(): number {
    return this.height - EYE_OFFSET + this.bobOffset - this.landingDip;
  }

  /**
   * Advances the player.
   *
   * @param input - Device state for this frame.
   * @param delta - Frame delta, in seconds. Clamped by the caller.
   */
  public update(input: Input, delta: number): void {
    this.applyLook(input);
    this.applyCrouch(input, delta);

    const wish = this.resolveWishDirection(input);
    const sprinting = input.isDown('ShiftLeft') && !this.isCrouched && wish.lengthSq() > 0;
    const targetSpeed = this.isCrouched
      ? CROUCH_SPEED
      : sprinting
        ? SPRINT_SPEED
        : WALK_SPEED;

    if (this.grounded) {
      this.applyFriction(delta);
    }
    this.accelerate(wish, targetSpeed, this.grounded ? GROUND_ACCELERATION : AIR_ACCELERATION, delta);

    if (this.grounded && input.isDown('Space')) {
      this.velocity.y = JUMP_VELOCITY;
      this.grounded = false;
    }

    this.velocity.y -= GRAVITY * delta;

    this.previousVerticalVelocity = this.velocity.y;
    this.moveWithCollisions(delta);
    this.updateViewEffects(delta, sprinting);
  }

  /**
   * Writes the player's view into a camera.
   *
   * @param camera - Camera to position and orient.
   */
  public applyToCamera(camera: PerspectiveCamera): void {
    camera.position.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
    // Yaw then pitch, with roll applied last so it rotates about the view axis.
    camera.rotation.set(0, 0, 0);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw;
    camera.rotation.x = this.pitch;
    camera.rotation.z = this.rollAngle;
  }

  /** Unit vector the player is looking along. */
  public getLookDirection(out: Vector3): Vector3 {
    const cosPitch = Math.cos(this.pitch);
    return out
      .set(-Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch)
      .normalize();
  }

  private applyLook(input: Input): void {
    if (!input.isLocked) {
      return;
    }
    this.yaw -= input.lookX * this.sensitivity;
    this.pitch -= input.lookY * this.sensitivity;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
  }

  private applyCrouch(input: Input, delta: number): void {
    const wantsCrouch = input.isDown('ControlLeft') || input.isDown('KeyC');

    // Standing up is refused if there is something directly overhead, which
    // stops the player from clipping into the gantry they crouched under.
    if (!wantsCrouch && this.targetHeight === CROUCH_HEIGHT && !this.hasHeadroom(STANDING_HEIGHT)) {
      return;
    }
    this.targetHeight = wantsCrouch ? CROUCH_HEIGHT : STANDING_HEIGHT;

    // Exponential approach, framed per second so it is frame-rate independent.
    const rate = 1 - Math.pow(0.0001, delta);
    this.height += (this.targetHeight - this.height) * rate;
  }

  private resolveWishDirection(input: Input): Vector3 {
    const forward = Number(input.isDown('KeyW')) - Number(input.isDown('KeyS'));
    const strafe = Number(input.isDown('KeyD')) - Number(input.isDown('KeyA'));

    scratchForward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    scratchRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    scratchWish
      .set(0, 0, 0)
      .addScaledVector(scratchForward, forward)
      .addScaledVector(scratchRight, strafe);

    if (scratchWish.lengthSq() > 1) {
      scratchWish.normalize();
    }
    return scratchWish;
  }

  private applyFriction(delta: number): void {
    const speed = this.horizontalSpeed;
    if (speed < 0.01) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    const drop = speed * GROUND_FRICTION * delta;
    const scale = Math.max(0, speed - drop) / speed;
    this.velocity.x *= scale;
    this.velocity.z *= scale;
  }

  /**
   * Accelerates toward the wish direction.
   *
   * Only the component of velocity *along* the wish direction is capped, which
   * is what allows direction changes to feel immediate while still bounding
   * straight-line speed.
   */
  private accelerate(wish: Vector3, targetSpeed: number, acceleration: number, delta: number): void {
    if (wish.lengthSq() < 1e-6) {
      return;
    }
    const current = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const add = targetSpeed - current;
    if (add <= 0) {
      return;
    }
    const step = Math.min(acceleration * delta * targetSpeed, add);
    this.velocity.x += wish.x * step;
    this.velocity.z += wish.z * step;
  }

  /** Builds the collider box for a candidate feet position. */
  private boxAt(x: number, y: number, z: number, height: number, out: Box3): Box3 {
    out.min.set(x - PLAYER_RADIUS, y, z - PLAYER_RADIUS);
    out.max.set(x + PLAYER_RADIUS, y + height, z + PLAYER_RADIUS);
    return out;
  }

  private intersectsLevel(box: Box3): boolean {
    for (let i = 0; i < this.colliders.length; i++) {
      if (this.colliders[i].intersectsBox(box)) {
        return true;
      }
    }
    return false;
  }

  private hasHeadroom(height: number): boolean {
    return !this.intersectsLevel(
      this.boxAt(this.position.x, this.position.y, this.position.z, height, playerBox),
    );
  }

  /**
   * Integrates position, resolving each axis independently.
   *
   * Resolving separately is what produces sliding: a move blocked on X can
   * still proceed on Z, so running into a wall at an angle slides along it
   * rather than stopping.
   */
  private moveWithCollisions(delta: number): void {
    const step = new Vector3(
      this.velocity.x * delta,
      this.velocity.y * delta,
      this.velocity.z * delta,
    );

    // X
    if (step.x !== 0) {
      const candidate = this.boxAt(
        this.position.x + step.x,
        this.position.y,
        this.position.z,
        this.height,
        playerBox,
      );
      if (this.intersectsLevel(candidate)) {
        this.velocity.x = 0;
      } else {
        this.position.x += step.x;
      }
    }

    // Z
    if (step.z !== 0) {
      const candidate = this.boxAt(
        this.position.x,
        this.position.y,
        this.position.z + step.z,
        this.height,
        playerBox,
      );
      if (this.intersectsLevel(candidate)) {
        this.velocity.z = 0;
      } else {
        this.position.z += step.z;
      }
    }

    // Y, which also determines whether the player is grounded.
    this.grounded = false;
    if (step.y !== 0) {
      const candidate = this.boxAt(
        this.position.x,
        this.position.y + step.y,
        this.position.z,
        this.height,
        playerBox,
      );
      if (this.intersectsLevel(candidate)) {
        if (step.y < 0) {
          this.grounded = true;
          this.onLanded();
        }
        this.velocity.y = 0;
      } else {
        this.position.y += step.y;
      }
    }

    // A short probe below the feet keeps `grounded` true while walking, which
    // otherwise flickers off on the frames gravity has not yet pulled the
    // collider back into contact.
    if (!this.grounded && this.velocity.y <= 0) {
      const probe = this.boxAt(
        this.position.x,
        this.position.y - 0.04,
        this.position.z,
        this.height,
        playerBox,
      );
      if (this.intersectsLevel(probe)) {
        this.grounded = true;
      }
    }
  }

  /** Compresses the view on impact, proportional to the landing speed. */
  private onLanded(): void {
    const impact = Math.min(Math.abs(this.previousVerticalVelocity), 14);
    if (impact > 3) {
      this.landingDip = Math.min(0.18, impact * 0.013);
    }
  }

  private updateViewEffects(delta: number, sprinting: boolean): void {
    const speed = this.horizontalSpeed;

    if (this.grounded && speed > 0.4) {
      // Bob frequency follows gait; the vertical oscillation is twice the
      // stride frequency because both footfalls dip the head.
      this.bobPhase += delta * (sprinting ? 13.5 : 9.4);
      const amplitude = BOB_AMPLITUDE * Math.min(1, speed / WALK_SPEED) * (sprinting ? 1.5 : 1);
      this.bobOffset = Math.sin(this.bobPhase * 2) * amplitude;
    } else {
      this.bobPhase = 0;
      this.bobOffset += (0 - this.bobOffset) * (1 - Math.pow(0.001, delta));
    }

    // Landing compression springs back rather than cutting.
    this.landingDip += (0 - this.landingDip) * (1 - Math.pow(0.0005, delta));

    // Roll into lateral movement, proportional to sideways velocity.
    const lateral = this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw);
    const targetRoll = -lateral * STRAFE_ROLL;
    this.rollAngle += (targetRoll - this.rollAngle) * (1 - Math.pow(0.0005, delta));
  }
}
