import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  type Object3D,
} from 'three';
import { markNonOccluding } from '../render/RenderLayers.js';

/**
 * Impact response: the hole, the debris, and the light they throw.
 *
 * Shooting a wall and having nothing happen is the fastest way to break the
 * illusion that the wall is a wall. Three things land on every hit, each doing
 * a different job:
 *
 * - **A decal**, which is the permanent record — proof the world remembers
 *   being interacted with.
 * - **Sparks**, which are the instantaneous event, and carry the energy.
 * - **A brief light**, which is what makes the impact feel like it happened
 *   *in* the room rather than on top of it.
 *
 * Everything is pooled and preallocated. Spawning geometry per shot at seven
 * hundred rounds per minute would allocate several hundred objects a second,
 * and the resulting collection pauses would be felt exactly when the player is
 * doing the most interesting thing.
 */

/** Simultaneous decals retained before the oldest is recycled. */
const MAX_DECALS = 48;
/** Simultaneous spark particles. */
const MAX_SPARKS = 320;
/** Sparks emitted per impact. */
const SPARKS_PER_IMPACT = 14;
/** Decal size, in metres. */
const DECAL_SIZE = 0.13;

/**
 * Generates the bullet-hole texture.
 *
 * Built as three concentric zones, which is roughly what a projectile actually
 * leaves in concrete: a dark crater, a ring of pulverised material lighter than
 * the surrounding surface, and radial fracture lines fading outward.
 */
function createImpactTexture(size = 128): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      // Radial fractures: a handful of spokes, irregular in length.
      const spokes =
        Math.sin(angle * 7 + Math.cos(angle * 3) * 2) * 0.5 + 0.5;
      const fractureReach = 0.34 + spokes * 0.5;

      let alpha = 0;
      let luminance = 0;

      if (radius < 0.2) {
        // Crater: nearly opaque and very dark.
        alpha = 1;
        luminance = 0.06 + radius * 0.2;
      } else if (radius < 0.42) {
        // Pulverised rim, lighter than the host surface.
        const t = (radius - 0.2) / 0.22;
        alpha = 1 - t * 0.35;
        luminance = 0.3 + t * 0.35;
      } else if (radius < fractureReach) {
        // Fracture field, thinning with distance.
        const t = (radius - 0.42) / Math.max(0.001, fractureReach - 0.42);
        alpha = (1 - t) * 0.55 * spokes;
        luminance = 0.4;
      }

      // Break up the silhouette so repeated hits do not look stamped.
      const jitter = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      alpha *= 0.85 + Math.abs(jitter) * 0.15;
      alpha = Math.max(0, Math.min(1, alpha));

      const offset = (y * size + x) * 4;
      const byte = Math.round(luminance * 255);
      data[offset] = byte;
      data[offset + 1] = byte;
      data[offset + 2] = byte;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }

  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const SPARK_VERTEX_SHADER = /* glsl */ `
  attribute float aLife;
  attribute float aSeed;
  varying float vLife;
  varying float vSeed;
  uniform float uSize;

  void main() {
    vLife = aLife;
    vSeed = aSeed;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    // Perspective size attenuation, so distant sparks are correctly small.
    gl_PointSize = uSize * aLife / max(-viewPosition.z, 0.1);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const SPARK_FRAGMENT_SHADER = /* glsl */ `
  varying float vLife;
  varying float vSeed;

  void main() {
    vec2 offset = gl_PointCoord - 0.5;
    float falloff = 1.0 - smoothstep(0.0, 0.5, length(offset));
    if (falloff <= 0.0 || vLife <= 0.0) { discard; }

    // Cooling: white hot, through orange, to dull red as the particle dies.
    vec3 hot    = vec3(1.0, 0.95, 0.78);
    vec3 mid    = vec3(1.0, 0.55, 0.14);
    vec3 cold   = vec3(0.55, 0.11, 0.02);
    vec3 colour = mix(cold, mix(mid, hot, smoothstep(0.6, 1.0, vLife)), smoothstep(0.0, 0.6, vLife));

    float flicker = 0.75 + 0.25 * sin(vSeed * 40.0 + vLife * 30.0);
    gl_FragColor = vec4(colour * flicker * 2.4, falloff * vLife);
  }
`;

export class ImpactEffects {
  public readonly group = new Group();

  private readonly decals: Mesh[] = [];
  private readonly decalMaterial: MeshStandardMaterial;
  private readonly impactTexture: DataTexture;
  private nextDecal = 0;

  private readonly sparkGeometry = new BufferGeometry();
  private readonly sparkMaterial: ShaderMaterial;
  private readonly sparkPositions = new Float32Array(MAX_SPARKS * 3);
  private readonly sparkVelocities = new Float32Array(MAX_SPARKS * 3);
  private readonly sparkLife = new Float32Array(MAX_SPARKS);
  private readonly sparkSeed = new Float32Array(MAX_SPARKS);
  private nextSpark = 0;

  private readonly scratch = new Vector3();

  public constructor() {
    this.group.name = 'impact-effects';

    this.impactTexture = createImpactTexture();
    this.decalMaterial = new MeshStandardMaterial({
      map: this.impactTexture,
      transparent: true,
      // Depth writes off and a polygon offset toward the camera: a decal sits
      // in the same plane as the surface it marks, and without the offset the
      // two fight for the depth test and flicker.
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      roughness: 0.95,
      metalness: 0,
      side: DoubleSide,
    });

    const decalGeometry = new PlaneGeometry(DECAL_SIZE, DECAL_SIZE);
    for (let i = 0; i < MAX_DECALS; i++) {
      const decal = new Mesh(decalGeometry, this.decalMaterial);
      decal.visible = false;
      decal.castShadow = false;
      decal.receiveShadow = false;
      this.decals.push(decal);
      this.group.add(decal);
    }

    this.sparkGeometry.setAttribute('position', new BufferAttribute(this.sparkPositions, 3));
    this.sparkGeometry.setAttribute('aLife', new BufferAttribute(this.sparkLife, 1));
    this.sparkGeometry.setAttribute('aSeed', new BufferAttribute(this.sparkSeed, 1));
    this.sparkGeometry.setDrawRange(0, MAX_SPARKS);

    this.sparkMaterial = new ShaderMaterial({
      uniforms: { uSize: { value: 190 } },
      vertexShader: SPARK_VERTEX_SHADER,
      fragmentShader: SPARK_FRAGMENT_SHADER,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    const sparks = new Points(this.sparkGeometry, this.sparkMaterial);
    sparks.frustumCulled = false;
    this.group.add(sparks);

    // Sparks are additive points and decals lie flush against surfaces that are
    // captured anyway, so neither belongs in a depth-only pass. The pool is
    // allocated here in full, so marking the group once covers every member.
    markNonOccluding(this.group);
  }

  /**
   * Places a decal and emits sparks at an impact.
   *
   * @param point - World-space hit position.
   * @param normal - World-space surface normal at the hit.
   */
  public spawn(point: Vector3, normal: Vector3): void {
    const decal = this.decals[this.nextDecal];
    this.nextDecal = (this.nextDecal + 1) % MAX_DECALS;

    // Lifted along the normal so it clears the surface, and rolled randomly so
    // repeated hits in one spot do not align.
    decal.position.copy(point).addScaledVector(normal, 0.004);
    decal.lookAt(this.scratch.copy(point).add(normal));
    decal.rotateZ(Math.random() * Math.PI * 2);
    decal.scale.setScalar(0.75 + Math.random() * 0.6);
    decal.visible = true;

    for (let i = 0; i < SPARKS_PER_IMPACT; i++) {
      const index = this.nextSpark;
      this.nextSpark = (this.nextSpark + 1) % MAX_SPARKS;

      this.sparkPositions[index * 3] = point.x;
      this.sparkPositions[index * 3 + 1] = point.y;
      this.sparkPositions[index * 3 + 2] = point.z;

      // Scattered into the hemisphere around the surface normal, biased along
      // it: debris leaves the surface it came from.
      const spread = 2.6;
      const speed = 1.6 + Math.random() * 4.2;
      this.sparkVelocities[index * 3] =
        (normal.x + (Math.random() - 0.5) * spread) * speed;
      this.sparkVelocities[index * 3 + 1] =
        (normal.y + (Math.random() - 0.5) * spread) * speed + 1.1;
      this.sparkVelocities[index * 3 + 2] =
        (normal.z + (Math.random() - 0.5) * spread) * speed;

      this.sparkLife[index] = 0.55 + Math.random() * 0.5;
      this.sparkSeed[index] = Math.random();
    }
  }

  /**
   * Integrates the spark simulation.
   *
   * @param delta - Frame delta, in seconds.
   */
  public update(delta: number): void {
    let anyAlive = false;

    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sparkLife[i] <= 0) {
        continue;
      }
      anyAlive = true;

      // Ballistic, with drag — fragments this small decelerate noticeably.
      const drag = Math.exp(-2.4 * delta);
      this.sparkVelocities[i * 3] *= drag;
      this.sparkVelocities[i * 3 + 1] = this.sparkVelocities[i * 3 + 1] * drag - 11 * delta;
      this.sparkVelocities[i * 3 + 2] *= drag;

      this.sparkPositions[i * 3] += this.sparkVelocities[i * 3] * delta;
      this.sparkPositions[i * 3 + 1] += this.sparkVelocities[i * 3 + 1] * delta;
      this.sparkPositions[i * 3 + 2] += this.sparkVelocities[i * 3 + 2] * delta;

      this.sparkLife[i] = Math.max(0, this.sparkLife[i] - delta * 1.5);
    }

    if (anyAlive) {
      (this.sparkGeometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
      (this.sparkGeometry.getAttribute('aLife') as BufferAttribute).needsUpdate = true;
      (this.sparkGeometry.getAttribute('aSeed') as BufferAttribute).needsUpdate = true;
    }
  }

  /** Adds the effects to a scene. */
  public attachTo(parent: Object3D): void {
    parent.add(this.group);
  }

  public dispose(): void {
    this.decalMaterial.dispose();
    this.impactTexture.dispose();
    this.decals[0]?.geometry.dispose();
    this.sparkGeometry.dispose();
    this.sparkMaterial.dispose();
  }
}
