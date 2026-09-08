import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from 'three';
import { createFloraModels, type TreePlacement } from '../../plugins/flora/client/models.ts';
import { SHIPPED_FLAMES } from '../../plugins/fire/client/flames/index.ts';
import { createFireSmoke } from '../../plugins/fire/client/smoke.ts';
import { createFireScar, type DrawnGroundAt } from '../../plugins/fire/client/scar.ts';
import { fireIntensity } from '../../plugins/fire/protocol.ts';
import type { FireInstance } from '../../plugins/fire/client/flames/types.ts';

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;
const MIN_CAMERA_FOV_DEGREES = 4;
const MAX_CAMERA_FOV_DEGREES = 100;

const BACKDROP_COLOR = 0x808080;
const STEP_TOP_COLOR_UPPER = 0x8fc25a;
const STEP_TOP_COLOR_LOWER = 0x69a244;
const STEP_SIDE_COLOR = 0x4d7a2f;
const TERRACE_BAND_HEIGHT = 1;
const GROUND_HALF_SPAN = 5;
const GROUND_SLAB_DEPTH = 2;

const CAMERA_FRAMING_PADDING = 1.34;
const FRAMING_HEADROOM = 1.0;
const CAMERA_DIRECTION = new Vector3(0.62, 0.58, 1.0);
const SETTLE_FRAME_COUNT = 3;

const ANIMATION_STEP_SECONDS = 1 / 60;
const MAX_PREVIEW_SECONDS = 90;
const MIN_CAMERA_DISTANCE_MULTIPLIER = 0.35;
const MAX_CAMERA_DISTANCE_MULTIPLIER = 20;

interface BurningTree {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly kind: 'conifer' | 'broadleaf';
  readonly scale: number;
  readonly yaw: number;
  readonly intensity: number;
  readonly seed: number;
}

const TREE_HEIGHT_AT_UNIT_SCALE = 1.5;

const SINGLE_SCENE: readonly BurningTree[] = [
  { x: 0, z: 0, groundY: 0, kind: 'conifer', scale: 1, yaw: 0.4, intensity: 1.0, seed: 0x5a17c3 },
];

const STAND_SCENE: readonly BurningTree[] = [
  { x: -1.5, z: 1.5, groundY: 0, kind: 'conifer', scale: 1.12, yaw: 0.2, intensity: 1.0, seed: 0x11f2a9 },
  { x: 0.2, z: 1.9, groundY: 0, kind: 'broadleaf', scale: 0.95, yaw: 1.7, intensity: 0.8, seed: 0x27bd41 },
  { x: 1.7, z: 1.1, groundY: 0, kind: 'conifer', scale: 0.86, yaw: 2.6, intensity: 0.55, seed: 0x3e0177 },
  { x: -0.9, z: -1.2, groundY: TERRACE_BAND_HEIGHT, kind: 'broadleaf', scale: 1.05, yaw: 4.1, intensity: 0.35, seed: 0x4c98e5 },
  { x: 1.2, z: -1.6, groundY: TERRACE_BAND_HEIGHT, kind: 'conifer', scale: 1.2, yaw: 5.3, intensity: 1.0, seed: 0x6ad30b },
];

const STAND_STEP_EDGE_Z = 0;

type SceneName = 'single' | 'stand';

function readIntensityOverride(params: URLSearchParams): number | null {
  const raw = params.get('i');
  if (raw === null) return null;
  const requested = Number.parseFloat(raw);
  if (!Number.isFinite(requested) || requested < 0 || requested > 1) return null;
  return requested;
}

function readBurnSeconds(params: URLSearchParams): number | null {
  const raw = params.get('burn');
  if (raw === null) return null;
  const requested = Number.parseFloat(raw);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  return requested;
}

function readOnlyIndex(params: URLSearchParams, treeCount: number): number | null {
  const raw = params.get('only');
  if (raw === null) return null;
  const requested = Number.parseInt(raw, 10);
  if (!Number.isFinite(requested) || requested < 1 || requested > treeCount) return null;
  return requested - 1;
}

function readFov(params: URLSearchParams): number {
  const requested = Number.parseFloat(params.get('fov') ?? '');
  if (!Number.isFinite(requested)) return CAMERA_FOV_DEGREES;
  return Math.min(Math.max(requested, MIN_CAMERA_FOV_DEGREES), MAX_CAMERA_FOV_DEGREES);
}

function readDistanceMultiplier(params: URLSearchParams): number {
  const requested = Number.parseFloat(params.get('dist') ?? '');
  if (!Number.isFinite(requested)) return 1;
  return Math.min(
    Math.max(requested, MIN_CAMERA_DISTANCE_MULTIPLIER),
    MAX_CAMERA_DISTANCE_MULTIPLIER,
  );
}

function readScene(params: URLSearchParams): SceneName {
  return params.get('scene') === 'stand' ? 'stand' : 'single';
}

function readTime(params: URLSearchParams): number {
  const requested = Number.parseFloat(params.get('t') ?? '');
  return Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_PREVIEW_SECONDS) : 0;
}

function lambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true });
}

function buildGround(
  scene: SceneName,
  geometries: BufferGeometry[],
  materials: Material[],
): Group {
  const ground = new Group();
  ground.name = 'preview:ground';

  const addSlab = (topY: number, zNear: number, zFar: number, topColor: number): void => {
    const depth = zFar - zNear;
    const geometry = new BoxGeometry(GROUND_HALF_SPAN * 2, GROUND_SLAB_DEPTH, depth);
    const top = lambert(topColor);
    const side = lambert(STEP_SIDE_COLOR);
    geometries.push(geometry);
    materials.push(top, side);
    const slab = new Mesh(geometry, [side, side, top, side, side, side]);
    slab.position.set(0, topY - GROUND_SLAB_DEPTH / 2, (zNear + zFar) / 2);
    ground.add(slab);
  };

  if (scene === 'single') {
    addSlab(0, -GROUND_HALF_SPAN, GROUND_HALF_SPAN, STEP_TOP_COLOR_LOWER);
  } else {
    addSlab(0, STAND_STEP_EDGE_Z, GROUND_HALF_SPAN, STEP_TOP_COLOR_LOWER);
    addSlab(TERRACE_BAND_HEIGHT, -GROUND_HALF_SPAN, STAND_STEP_EDGE_Z, STEP_TOP_COLOR_UPPER);
  }
  return ground;
}

function buildDrawnGroundAt(scene: SceneName): DrawnGroundAt {
  if (scene === 'single') return () => 0;
  return (_worldX: number, worldZ: number): number =>
    worldZ < STAND_STEP_EDGE_Z ? TERRACE_BAND_HEIGHT : 0;
}

function frameCameraOn(
  camera: PerspectiveCamera,
  box: Box3,
  distanceMultiplier: number,
): Vector3 {
  box.max.y += FRAMING_HEADROOM;
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance =
    ((radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2)) * distanceMultiplier;

  camera.position.copy(center).addScaledVector(CAMERA_DIRECTION.clone().normalize(), distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}

function main(): void {
  const params = new URLSearchParams(window.location.search);
  const sceneName = readScene(params);
  const intensityOverride = readIntensityOverride(params);
  const previewSeconds = readTime(params);
  const burnSeconds = readBurnSeconds(params);
  const distanceMultiplier = readDistanceMultiplier(params);
  const fovDegrees = readFov(params);

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const scene = new Scene();
  scene.background = new Color(BACKDROP_COLOR);

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  scene.add(buildGround(sceneName, geometries, materials));

  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
  scene.add(sun);

  const trees = sceneName === 'single' ? SINGLE_SCENE : STAND_SCENE;
  const onlyIndex = readOnlyIndex(params, trees.length);
  const flora = createFloraModels();
  const placements: TreePlacement[] = trees.map((tree) => ({
    x: tree.x,
    z: tree.z,
    groundY: tree.groundY,
    kind: tree.kind,
    scale: tree.scale,
    yaw: tree.yaw,
  }));
  flora.apply(placements);
  scene.add(flora.root);

  const fires: FireInstance[] = trees.map((tree, index) => ({
    key: index + 1,
    x: tree.x,
    z: tree.z,
    groundY: tree.groundY,
    fuelHeight: TREE_HEIGHT_AT_UNIT_SCALE * tree.scale,
    intensity: intensityOverride ?? tree.intensity,
    ageSeconds: 0,
    seed: tree.seed,
  }));

  const live: FireInstance[] = [];
  function burningAt(t: number): readonly FireInstance[] {
    live.length = 0;
    for (let index = 0; index < fires.length; index++) {
      if (onlyIndex !== null && index !== onlyIndex) continue;
      const fire = fires[index]!;
      const mutable = fire as { intensity: number; ageSeconds: number };
      mutable.ageSeconds = t;
      if (burnSeconds === null) {
        live.push(fire);
        continue;
      }
      if (t >= burnSeconds) continue;
      mutable.intensity = fireIntensity(t, burnSeconds);
      live.push(fire);
    }
    return live;
  }

  const flames = SHIPPED_FLAMES();
  const smoke = createFireSmoke();
  const scar = createFireScar();
  const drawnGroundAt = buildDrawnGroundAt(sceneName);
  document.title = `Fire preview — ${flames.name} — ${sceneName} — t=${previewSeconds}${intensityOverride === null ? '' : ` — i=${intensityOverride}`}${burnSeconds === null ? '' : ` — burn=${burnSeconds}`}${distanceMultiplier === 1 ? '' : ` — dist=${distanceMultiplier}`}${onlyIndex === null ? '' : ` — only=${onlyIndex + 1}`}${fovDegrees === CAMERA_FOV_DEGREES ? '' : ` — fov=${fovDegrees}`}`;
  scene.add(smoke.root);
  scene.add(scar.root);
  scene.add(flames.root);

  const camera = new PerspectiveCamera(
    fovDegrees,
    window.innerWidth / window.innerHeight,
    0.05,
    200,
  );
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  renderer.outputColorSpace = SRGBColorSpace;

  const cameraFocus = frameCameraOn(
    camera,
    new Box3().setFromObject(flora.root),
    distanceMultiplier,
  );

  const steps = Math.round(previewSeconds / ANIMATION_STEP_SECONDS);
  for (let step = 0; step <= steps; step++) {
    const t = step * ANIMATION_STEP_SECONDS;
    const burning = burningAt(t);
    flames.apply(burning);
    flames.update(ANIMATION_STEP_SECONDS, t);
    smoke.apply(burning);
    smoke.update(ANIMATION_STEP_SECONDS, t);
    scar.apply(burning, drawnGroundAt);
    scar.update(ANIMATION_STEP_SECONDS);
  }

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) {
      requestAnimationFrame(renderFrame);
    } else {
      (
        window as unknown as { __previewDrawCalls: number; __previewSmokeColumns: number }
      ).__previewDrawCalls = renderer.info.render.calls;
      (
        window as unknown as { __previewDrawCalls: number; __previewSmokeColumns: number }
      ).__previewSmokeColumns = smoke.drawnCount;
      (window as unknown as { __previewScarMarks: number }).__previewScarMarks = scar.drawnCount;
      (window as unknown as { __previewCameraDistance: number }).__previewCameraDistance =
        camera.position.distanceTo(cameraFocus);
      (window as unknown as { __previewReady: boolean }).__previewReady = true;
    }
  }
  requestAnimationFrame(renderFrame);

  window.addEventListener('pagehide', () => {
    flames.dispose();
    smoke.dispose();
    scar.dispose();
    flora.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  });
}

main();
