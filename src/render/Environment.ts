import {
  BackSide,
  BoxGeometry,
  Color,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLCubeRenderTarget,
  CubeCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';

/**
 * Lighting environment: the visible sky, and the ambient light the room sits in.
 *
 * Image-based lighting is the single largest contributor to whether a rendered
 * surface looks photographed or computed. A analytic light alone gives a
 * surface one highlight and a flat ambient term; an environment gives it a
 * different reflection from every direction, which is what the eye actually
 * reads as material.
 *
 * Two separate products are built here, because the room needs different
 * answers to two different questions:
 *
 * - **Background** — a sky dome, rendered to a cube map. This is what you see
 *   through the breach in the ceiling, so it has to be a real image with a sun
 *   bright enough for the bloom to catch.
 * - **Environment** — a *purpose-built interior*, run through PMREM. Lighting a
 *   sealed concrete room with an open sky would flood it with blue fill from
 *   directions that are, in fact, walls. Instead the environment scene models
 *   the room's actual light transport: a bright warm patch where sunlight lands
 *   and bounces off the floor, a cool slot where sky is visible, and dim grey
 *   concrete everywhere else.
 *
 * That second decision is what makes the interior read as an interior.
 */

/** Direction the sun sits in. Shared with the directional light and the shafts. */
export const SUN_DIRECTION = new Vector3(-0.42, 0.78, 0.47).normalize();

/** Radiance of the sun disc in the sky image. Far above 1 so bloom responds. */
const SUN_DISC_RADIANCE = 34;

/** Cube face resolution for the visible sky. */
const SKY_CUBE_SIZE = 512;

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    // Object-space position is the view direction for a dome centred on the eye.
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vDirection;
  uniform vec3 uSunDirection;
  uniform float uSunRadiance;
  uniform float uExposure;

  // Analytic clear-sky gradient. Not a full atmospheric scattering integral —
  // at the solid angle actually visible through a hole in a ceiling, the extra
  // fidelity would not survive the first bounce.
  vec3 skyRadiance(vec3 direction, vec3 sunDirection) {
    float height = clamp(direction.y, -1.0, 1.0);
    float up = max(height, 0.0);

    // Rayleigh scattering reddens and brightens toward the horizon.
    vec3 zenith  = vec3(0.085, 0.195, 0.46);
    vec3 horizon = vec3(0.56, 0.66, 0.80);
    float gradient = pow(1.0 - up, 4.5);
    vec3 colour = mix(zenith, horizon, gradient);

    float cosAngle = dot(direction, sunDirection);

    // Mie forward scattering: the bright haze around the sun.
    float mie = pow(max(cosAngle, 0.0), 22.0) * 0.55
              + pow(max(cosAngle, 0.0), 5.0) * 0.12;
    colour += vec3(1.0, 0.86, 0.66) * mie;

    // The disc itself, with a soft limb so it does not alias into a square.
    float disc = smoothstep(0.99955, 0.99992, cosAngle);
    colour += vec3(1.0, 0.94, 0.84) * disc * uSunRadiance;

    // Below the horizon: dusty ground bounce, not sky.
    vec3 ground = vec3(0.14, 0.125, 0.11);
    colour = mix(colour, ground, smoothstep(0.0, -0.12, height));

    return colour;
  }

  void main() {
    vec3 direction = normalize(vDirection);
    gl_FragColor = vec4(skyRadiance(direction, normalize(uSunDirection)) * uExposure, 1.0);
  }
`;

/** Everything the environment owns, so it can be released in one call. */
export interface LightingEnvironment {
  /** Cube map of the sky, for `scene.background`. */
  readonly background: Texture;
  /** Prefiltered radiance for `scene.environment`. */
  readonly environment: Texture;
  dispose(): void;
}

/**
 * Renders the sky dome into a cube map.
 *
 * A half-float target, because the sun disc is thirty times brighter than the
 * sky around it and an 8-bit target would clip it to white and throw away
 * exactly the energy the bloom is supposed to find.
 */
function renderSkyCube(renderer: WebGLRenderer, exposure: number): WebGLCubeRenderTarget {
  const skyScene = new Scene();

  const material = new ShaderMaterial({
    uniforms: {
      uSunDirection: { value: SUN_DIRECTION.clone() },
      uSunRadiance: { value: SUN_DISC_RADIANCE },
      uExposure: { value: exposure },
    },
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });

  const dome = new Mesh(new SphereGeometry(100, 48, 32), material);
  skyScene.add(dome);

  const target = new WebGLCubeRenderTarget(SKY_CUBE_SIZE, { type: HalfFloatType });
  const camera = new CubeCamera(0.1, 1000, target);
  camera.update(renderer, skyScene);

  dome.geometry.dispose();
  material.dispose();

  return target;
}

/** Adds an emissive quad to the environment scene. */
function addEmitter(
  scene: Scene,
  colour: Color,
  size: [number, number, number],
  position: [number, number, number],
  rotationY = 0,
): void {
  const material = new MeshBasicMaterial({ color: colour, side: BackSide, toneMapped: false });
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.y = rotationY;
  scene.add(mesh);
}

/**
 * Builds the interior environment that actually lights the room.
 *
 * The geometry is a crude box standing in for the bay, with emitters placed
 * where light genuinely comes from. PMREM then integrates it into the
 * roughness-dependent radiance the standard material samples, so a polished
 * steel rail reflects a bright slot where the ceiling is open and dull concrete
 * where it is not — the behaviour that makes metal read as metal indoors.
 */
function buildInteriorEnvironment(): Scene {
  const scene = new Scene();

  // The shell: dim, cool concrete bounce. This value is the floor of the whole
  // image — nothing in the room is darker than what the shell returns — so it
  // is set by what a dark corner should look like rather than by any measured
  // albedo. Too low and the far walls are a featureless void that reads as a
  // missing texture; a little above that threshold and the same corner keeps
  // its aggregate and its silhouettes while still being plainly unlit.
  const shell = new Mesh(
    new BoxGeometry(26, 14, 26),
    new MeshBasicMaterial({ color: new Color(0.062, 0.069, 0.085), side: BackSide, toneMapped: false }),
  );
  scene.add(shell);

  // Floor bounce: warm, because sunlight lands on dusty concrete and the light
  // that leaves is the colour of what it hit.
  addEmitter(scene, new Color(0.26, 0.20, 0.135), [12, 0.1, 12], [0, -6.6, 0]);

  // The breach: a bright, cool slot of open sky overhead. This is what puts a
  // highlight along the top edge of every horizontal surface in the room.
  addEmitter(scene, new Color(1.35, 1.7, 2.3), [3.6, 0.1, 7.0], [-2.2, 6.6, 1.0]);

  // The shaft's footprint on the floor, far brighter than general bounce.
  addEmitter(scene, new Color(1.1, 0.88, 0.62), [3.4, 0.1, 6.2], [1.6, -6.5, 1.4]);

  // Emergency lighting: a weak warm source low on one wall, which separates the
  // far corners from pure black without flattening them.
  addEmitter(scene, new Color(0.55, 0.20, 0.10), [0.1, 1.2, 3.0], [-12.8, -3.0, -4.0]);

  return scene;
}

/**
 * Builds the sky and the interior lighting environment.
 *
 * @param renderer - Renderer used to run the cube and PMREM passes.
 * @param exposure - Scalar on sky radiance, for art-directing overall brightness.
 */
export function createLightingEnvironment(
  renderer: WebGLRenderer,
  exposure = 1,
): LightingEnvironment {
  const skyTarget = renderSkyCube(renderer, exposure);

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const interior = buildInteriorEnvironment();
  const environmentTarget = pmrem.fromScene(interior, 0.0, 0.1, 100);

  // The environment scene has served its purpose; its geometry is not drawn
  // again and holds GPU buffers that nothing else references.
  interior.traverse((node) => {
    const mesh = node as Partial<Mesh>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (material !== undefined && !Array.isArray(material)) {
      material.dispose();
    }
  });
  pmrem.dispose();

  return {
    background: skyTarget.texture,
    environment: environmentTarget.texture,
    dispose(): void {
      skyTarget.dispose();
      environmentTarget.dispose();
    },
  };
}
