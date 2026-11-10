import {
  Box3,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { SUN_DIRECTION } from '../render/Environment.js';
import { createBevelledBox, createWorldUvBox } from './Geometry.js';
import { TEXTURE_SCALE, type MaterialSet } from './MaterialLibrary.js';

/**
 * "The Eye — Containment Bay": one room, built to be looked at closely.
 *
 * The level is deliberately tiny. A single sealed bay means every surface can
 * carry maximum texel density, every light can be placed by hand, and the
 * shadow map can cover the whole playable space at high resolution — none of
 * which survives contact with an open world. Scope spent on size is scope not
 * spent on fidelity, and the brief here was fidelity.
 *
 * The composition is built around one event: a shaft of sunlight entering
 * through a breach in the ceiling. Everything else is arranged to interact with
 * it. The gantry crosses it, so it casts a hard bar of shadow through the beam.
 * Severed rebar hangs into it, stippling the light. The artifact sits exactly
 * where the shaft lands, so the brightest thing in the room is also its focal
 * point. Volumetric light is only convincing when something interrupts it —
 * an unobstructed beam looks like a gradient.
 */

/** Interior half-extent along X, in metres. */
const ROOM_HALF_WIDTH = 8;
/** Interior half-extent along Z, in metres. */
const ROOM_HALF_DEPTH = 6;
/** Interior height, in metres. */
const ROOM_HEIGHT = 6.5;
/** Structural thickness, in metres. */
const WALL_THICKNESS = 0.6;

/** The breach in the ceiling, in metres. */
const BREACH = { minX: -4.1, maxX: -0.4, minZ: -2.0, maxZ: 3.4 } as const;

/** Where the shaft lands, derived from the sun direction and the breach. */
export const SHAFT_FOCUS = new Vector3(1.4, 0, -2.6);

/** Height of the gantry deck, in metres. */
const GANTRY_HEIGHT = 3.45;

/** A constructed level. */
export interface Level {
  readonly group: Group;
  /** Axis-aligned solids the player collides against. */
  readonly colliders: readonly Box3[];
  /** The sun. Shared with the volumetric pass so both agree on direction. */
  readonly sun: DirectionalLight;
  /** Animated emissive parts, updated each frame. */
  readonly artifact: Object3D;
  readonly artifactLight: PointLight;
  dispose(): void;
}

/** Accumulates geometry so the whole level can be disposed in one call. */
class LevelBuilder {
  public readonly group = new Group();
  public readonly colliders: Box3[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];

  /** Adds a mesh, optionally registering it as a solid. */
  public add(
    geometry: BufferGeometry,
    material: Material,
    position: Vector3,
    options: {
      solid?: boolean;
      castShadow?: boolean;
      receiveShadow?: boolean;
      rotation?: Vector3;
      name?: string;
    } = {},
  ): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    if (options.rotation !== undefined) {
      mesh.rotation.set(options.rotation.x, options.rotation.y, options.rotation.z);
    }
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    if (options.name !== undefined) {
      mesh.name = options.name;
    }

    this.group.add(mesh);
    this.geometries.push(geometry);

    if (options.solid === true) {
      mesh.updateMatrixWorld(true);
      this.colliders.push(new Box3().setFromObject(mesh));
    }
    return mesh;
  }

  /** Registers a material for disposal without attaching geometry. */
  public own(material: Material): Material {
    this.materials.push(material);
    return material;
  }

  public dispose(): void {
    for (const geometry of this.geometries) {
      geometry.dispose();
    }
    for (const material of this.materials) {
      material.dispose();
    }
  }
}

/** Deterministic sequence, so the debris lands identically every load. */
function createSequence(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state ^ (state >>> 15), 2246822507) + 1) >>> 0;
    return (state >>> 8) / 16777216;
  };
}

/** Builds the room shell: floor, walls, and a ceiling with a hole in it. */
function buildShell(builder: LevelBuilder, materials: MaterialSet): void {
  const wallScale = TEXTURE_SCALE.concrete;

  builder.add(
    createWorldUvBox(ROOM_HALF_WIDTH * 2, WALL_THICKNESS, ROOM_HALF_DEPTH * 2, wallScale),
    materials.concreteFloor,
    new Vector3(0, -WALL_THICKNESS / 2, 0),
    { solid: true, castShadow: false, name: 'floor' },
  );

  // Walls, inset so their inner faces bound the interior exactly.
  const wallSpecs: readonly {
    size: [number, number, number];
    position: [number, number, number];
  }[] = [
    {
      size: [WALL_THICKNESS, ROOM_HEIGHT, ROOM_HALF_DEPTH * 2 + WALL_THICKNESS * 2],
      position: [-ROOM_HALF_WIDTH - WALL_THICKNESS / 2, ROOM_HEIGHT / 2, 0],
    },
    {
      size: [WALL_THICKNESS, ROOM_HEIGHT, ROOM_HALF_DEPTH * 2 + WALL_THICKNESS * 2],
      position: [ROOM_HALF_WIDTH + WALL_THICKNESS / 2, ROOM_HEIGHT / 2, 0],
    },
    {
      size: [ROOM_HALF_WIDTH * 2, ROOM_HEIGHT, WALL_THICKNESS],
      position: [0, ROOM_HEIGHT / 2, -ROOM_HALF_DEPTH - WALL_THICKNESS / 2],
    },
    {
      size: [ROOM_HALF_WIDTH * 2, ROOM_HEIGHT, WALL_THICKNESS],
      position: [0, ROOM_HEIGHT / 2, ROOM_HALF_DEPTH + WALL_THICKNESS / 2],
    },
  ];

  for (const spec of wallSpecs) {
    builder.add(
      createWorldUvBox(spec.size[0], spec.size[1], spec.size[2], wallScale),
      materials.concreteWall,
      new Vector3(spec.position[0], spec.position[1], spec.position[2]),
      { solid: true },
    );
  }

  // Ceiling, as four slabs framing the breach. Building it as a frame rather
  // than cutting a hole keeps every piece a box, which keeps the collision
  // representation trivial and the shadow geometry cheap.
  const ceilingY = ROOM_HEIGHT + WALL_THICKNESS / 2;

  const addSlab = (minX: number, maxX: number, minZ: number, maxZ: number): void => {
    const width = maxX - minX;
    const depth = maxZ - minZ;
    if (width <= 0.001 || depth <= 0.001) {
      return;
    }
    builder.add(
      createWorldUvBox(width, WALL_THICKNESS, depth, wallScale),
      materials.concreteWall,
      new Vector3(minX + width / 2, ceilingY, minZ + depth / 2),
      { solid: true },
    );
  };

  const left = -ROOM_HALF_WIDTH;
  const right = ROOM_HALF_WIDTH;
  const back = -ROOM_HALF_DEPTH;
  const front = ROOM_HALF_DEPTH;

  addSlab(left, BREACH.minX, back, front);
  addSlab(BREACH.maxX, right, back, front);
  addSlab(BREACH.minX, BREACH.maxX, back, BREACH.minZ);
  addSlab(BREACH.minX, BREACH.maxX, BREACH.maxZ, front);
}

/** Hangs severed reinforcement bar into the breach. */
function buildRebar(builder: LevelBuilder, materials: MaterialSet): void {
  const random = createSequence(4211);
  const barGeometry = new CylinderGeometry(0.018, 0.018, 1, 6, 1);

  for (let i = 0; i < 14; i++) {
    const x = BREACH.minX + random() * (BREACH.maxX - BREACH.minX);
    const z = BREACH.minZ + random() * (BREACH.maxZ - BREACH.minZ);
    const length = 0.35 + random() * 1.5;

    const mesh = builder.add(
      barGeometry.clone(),
      materials.rustedSteel,
      new Vector3(x, ROOM_HEIGHT - length / 2 + 0.1, z),
      { castShadow: true, receiveShadow: false },
    );
    mesh.scale.y = length;
    // Bent out of true by whatever broke the slab.
    mesh.rotation.z = (random() - 0.5) * 0.7;
    mesh.rotation.x = (random() - 0.5) * 0.7;
  }
}

/** The gantry: a steel walkway that cuts the shaft in half. */
function buildGantry(builder: LevelBuilder, materials: MaterialSet): void {
  const deckWidth = 1.6;
  const deckLength = ROOM_HALF_DEPTH * 2;
  const deckX = ROOM_HALF_WIDTH - deckWidth / 2 - 0.1;

  builder.add(
    createWorldUvBox(deckWidth, 0.12, deckLength, TEXTURE_SCALE.metal),
    materials.rustedSteel,
    new Vector3(deckX, GANTRY_HEIGHT, 0),
    { solid: true, name: 'gantry-deck' },
  );

  // Kick plate and handrail along the open edge.
  const railX = deckX - deckWidth / 2 + 0.06;
  builder.add(
    createWorldUvBox(0.05, 0.22, deckLength, TEXTURE_SCALE.metal),
    materials.rustedSteel,
    new Vector3(railX, GANTRY_HEIGHT + 0.17, 0),
  );

  const railGeometry = new CylinderGeometry(0.035, 0.035, deckLength, 8, 1);
  for (const height of [1.05, 0.55]) {
    const rail = builder.add(
      railGeometry.clone(),
      materials.rustedSteel,
      new Vector3(railX, GANTRY_HEIGHT + height, 0),
      { receiveShadow: false },
    );
    rail.rotation.x = Math.PI / 2;
  }

  // Stanchions, and the brackets carrying the deck back to the wall.
  const postGeometry = new CylinderGeometry(0.045, 0.045, 1.1, 8, 1);
  for (let i = -2; i <= 2; i++) {
    const z = i * 2.4;
    builder.add(
      postGeometry.clone(),
      materials.rustedSteel,
      new Vector3(railX, GANTRY_HEIGHT + 0.55, z),
      { receiveShadow: false },
    );
    builder.add(
      createWorldUvBox(deckWidth * 0.9, 0.1, 0.12, TEXTURE_SCALE.metal),
      materials.rustedSteel,
      new Vector3(deckX + 0.05, GANTRY_HEIGHT - 0.2, z),
    );
  }
}

/** Overhead service pipes, which also break up the ceiling plane. */
function buildPipes(builder: LevelBuilder, materials: MaterialSet): void {
  const runLength = ROOM_HALF_WIDTH * 2;
  const specs: readonly { radius: number; y: number; z: number }[] = [
    { radius: 0.17, y: ROOM_HEIGHT - 0.45, z: -4.5 },
    { radius: 0.12, y: ROOM_HEIGHT - 0.42, z: -4.0 },
    { radius: 0.22, y: ROOM_HEIGHT - 0.55, z: 4.6 },
  ];

  for (const spec of specs) {
    const pipe = builder.add(
      new CylinderGeometry(spec.radius, spec.radius, runLength, 14, 1),
      materials.rustedSteel,
      new Vector3(0, spec.y, spec.z),
      { receiveShadow: false },
    );
    pipe.rotation.z = Math.PI / 2;

    // Collars, which read as joints and catch a highlight each.
    for (let i = -1; i <= 1; i++) {
      const collar = builder.add(
        new TorusGeometry(spec.radius * 1.18, spec.radius * 0.22, 8, 16),
        materials.rustedSteel,
        new Vector3(i * 3.4, spec.y, spec.z),
        { receiveShadow: false },
      );
      collar.rotation.y = Math.PI / 2;
    }
  }

  // A riser dropping down the back wall, tying the ceiling run to the floor.
  builder.add(
    new CylinderGeometry(0.17, 0.17, ROOM_HEIGHT - 0.5, 14, 1),
    materials.rustedSteel,
    new Vector3(-6.4, (ROOM_HEIGHT - 0.5) / 2, -ROOM_HALF_DEPTH + 0.45),
    { receiveShadow: false },
  );
}

/** Crates and drums: the clutter that gives the room scale and occlusion. */
function buildProps(builder: LevelBuilder, materials: MaterialSet): void {
  const crates: readonly {
    size: [number, number, number];
    position: [number, number, number];
    rotation: number;
  }[] = [
    { size: [1.1, 1.1, 1.1], position: [-6.6, 0.55, 3.1], rotation: 0.12 },
    { size: [1.1, 1.1, 1.1], position: [-6.5, 1.65, 3.2], rotation: -0.07 },
    { size: [1.3, 0.75, 0.95], position: [-5.2, 0.375, 4.2], rotation: 0.5 },
    { size: [0.9, 0.9, 0.9], position: [5.6, 0.45, -4.6], rotation: -0.3 },
    { size: [1.25, 0.8, 1.0], position: [6.4, 0.4, 2.4], rotation: 0.22 },
  ];

  for (const crate of crates) {
    const mesh = builder.add(
      createBevelledBox(crate.size[0], crate.size[1], crate.size[2], 0.035, TEXTURE_SCALE.panel),
      materials.paintedPanel,
      new Vector3(crate.position[0], crate.position[1], crate.position[2]),
      { solid: false },
    );
    mesh.rotation.y = crate.rotation;
    mesh.updateMatrixWorld(true);
    builder.colliders.push(new Box3().setFromObject(mesh));
  }

  const drumGeometry = new CylinderGeometry(0.33, 0.33, 0.92, 20, 1);
  const drums: readonly [number, number, number][] = [
    [-2.9, 0.46, 5.0],
    [-2.1, 0.46, 4.6],
    [6.6, 0.46, -1.2],
  ];

  for (const position of drums) {
    builder.add(
      drumGeometry.clone(),
      materials.rustedSteel,
      new Vector3(position[0], position[1], position[2]),
      { solid: true },
    );
    // Rolling ribs.
    for (const offset of [-0.22, 0.22]) {
      const rib = builder.add(
        new TorusGeometry(0.335, 0.03, 8, 20),
        materials.rustedSteel,
        new Vector3(position[0], position[1] + offset, position[2]),
        { receiveShadow: false },
      );
      rib.rotation.x = Math.PI / 2;
    }
  }
}

/** Rubble from the collapsed ceiling, directly beneath the breach. */
function buildDebris(builder: LevelBuilder, materials: MaterialSet): void {
  const random = createSequence(90210);

  for (let i = 0; i < 26; i++) {
    const size = 0.1 + random() * 0.34;
    const x = BREACH.minX - 1.2 + random() * (BREACH.maxX - BREACH.minX + 3.6);
    const z = BREACH.minZ - 1.4 + random() * (BREACH.maxZ - BREACH.minZ + 2.8);

    const chunk = builder.add(
      createBevelledBox(size, size * (0.4 + random() * 0.5), size * (0.7 + random() * 0.6), 0.015, TEXTURE_SCALE.concrete),
      materials.concreteWall,
      new Vector3(x, size * 0.22, z),
      { receiveShadow: true },
    );
    chunk.rotation.set(random() * 0.4, random() * Math.PI, random() * 0.4);
  }
}

/**
 * The artifact: an hourglass on a pedestal, standing in the shaft.
 *
 * It exists to give the composition a subject. A technically impressive room
 * with nothing in it is a tech demo; the same room with one thing worth walking
 * toward is a place. It is also the level's only animated light, which keeps
 * the image from being completely static while the player stands still.
 */
function buildArtifact(
  builder: LevelBuilder,
  materials: MaterialSet,
): { artifact: Object3D; light: PointLight } {
  const base = SHAFT_FOCUS;

  builder.add(
    createBevelledBox(1.5, 0.18, 1.5, 0.02, TEXTURE_SCALE.concrete),
    materials.concreteWall,
    new Vector3(base.x, 0.09, base.z),
    { solid: true },
  );
  builder.add(
    createBevelledBox(0.95, 0.72, 0.95, 0.03, TEXTURE_SCALE.concrete),
    materials.concreteWall,
    new Vector3(base.x, 0.54, base.z),
    { solid: true },
  );
  builder.add(
    createBevelledBox(1.15, 0.12, 1.15, 0.02, TEXTURE_SCALE.metal),
    materials.rustedSteel,
    new Vector3(base.x, 0.96, base.z),
    { solid: true },
  );

  const artifact = new Group();
  artifact.position.set(base.x, 1.72, base.z);

  // Two cones meeting at the waist. The emissive is strong enough to bloom and
  // to read as the light source it pretends to be.
  const glass = builder.own(
    new MeshStandardMaterial({
      color: 0x1a1410,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.22,
      envMapIntensity: 2.2,
    }),
  );

  const sandMaterial = builder.own(
    new MeshStandardMaterial({
      color: 0xffb257,
      emissive: 0xff9a3c,
      emissiveIntensity: 4.2,
      roughness: 0.55,
      metalness: 0,
    }),
  );

  for (const sign of [1, -1]) {
    const shell = new Mesh(new CylinderGeometry(0.3, 0.02, 0.38, 24, 1, true), glass);
    shell.position.y = sign * 0.19;
    shell.rotation.x = sign > 0 ? 0 : Math.PI;
    shell.castShadow = false;
    artifact.add(shell);

    const sand = new Mesh(new CylinderGeometry(0.2 * (sign > 0 ? 1 : 0.55), 0.015, 0.2, 20, 1), sandMaterial);
    sand.position.y = sign * 0.1;
    sand.rotation.x = sign > 0 ? 0 : Math.PI;
    sand.castShadow = false;
    artifact.add(sand);
  }

  // Brass caps and the bead of falling sand.
  const capMaterial = builder.own(
    new MeshStandardMaterial({ color: 0x8a6a35, roughness: 0.28, metalness: 1 }),
  );
  for (const y of [0.4, -0.4]) {
    const cap = new Mesh(new CylinderGeometry(0.33, 0.33, 0.05, 24, 1), capMaterial);
    cap.position.y = y;
    cap.castShadow = true;
    artifact.add(cap);
  }

  const stream = new Mesh(new CylinderGeometry(0.012, 0.012, 0.3, 8, 1), sandMaterial);
  stream.castShadow = false;
  artifact.add(stream);

  builder.group.add(artifact);

  const light = new PointLight(0xffa851, 6.5, 7.5, 2);
  light.position.copy(artifact.position);
  light.castShadow = false;
  builder.group.add(light);

  return { artifact, light };
}

/** Builds the complete level. */
export function createLevel(materials: MaterialSet): Level {
  const builder = new LevelBuilder();
  builder.group.name = 'containment-bay';

  buildShell(builder, materials);
  buildRebar(builder, materials);
  buildGantry(builder, materials);
  buildPipes(builder, materials);
  buildProps(builder, materials);
  buildDebris(builder, materials);
  const { artifact, light } = buildArtifact(builder, materials);

  // The sun. Its shadow camera is sized to the room rather than left at the
  // default, which is the difference between crisp contact shadows and the
  // blocky approximation a too-large frustum produces.
  const sun = new DirectionalLight(0xfff0d8, 6.8);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(28);
  sun.target.position.copy(SHAFT_FOCUS);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  sun.shadow.camera.left = -14;
  sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 14;
  sun.shadow.camera.bottom = -14;
  // Normal bias scales with surface angle, which handles grazing light far
  // better than a constant depth bias and avoids peter-panning on the floor.
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  builder.group.add(sun, sun.target);

  // A failing emergency fitting, low on the far wall. Its only job is to keep
  // the corners the sun never reaches from collapsing to black.
  const emergency = new PointLight(0xff5a28, 5.5, 10, 2);
  emergency.position.set(-ROOM_HALF_WIDTH + 0.6, 2.7, -4.2);
  builder.group.add(emergency);

  const fitting = builder.own(
    new MeshStandardMaterial({
      color: 0x120808,
      emissive: 0xff5520,
      emissiveIntensity: 3.0,
      roughness: 0.6,
      metalness: 0,
    }),
  );
  builder.add(
    createBevelledBox(0.12, 0.26, 0.4, 0.02, TEXTURE_SCALE.panel),
    fitting,
    new Vector3(-ROOM_HALF_WIDTH + 0.36, 2.7, -4.2),
    { castShadow: false },
  );

  return {
    group: builder.group,
    colliders: builder.colliders,
    sun,
    artifact,
    artifactLight: light,
    dispose(): void {
      builder.dispose();
    },
  };
}

/** Interior bounds, for clamping the player and sizing effects. */
export const ROOM_BOUNDS = {
  halfWidth: ROOM_HALF_WIDTH,
  halfDepth: ROOM_HALF_DEPTH,
  height: ROOM_HEIGHT,
} as const;
