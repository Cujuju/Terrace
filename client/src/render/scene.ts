import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  PerspectiveCamera,
  PointLight,
  Scene,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu';
import { GatedPointLightNode } from './gatedPointLightNode.ts';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEGREES,
  CAMERA_INITIAL_DISTANCE,
  CAMERA_MAX_DISTANCE,
  CAMERA_MAX_POLAR_ANGLE_DEGREES,
  CAMERA_MIN_DISTANCE,
  CAMERA_NEAR,
  CELL_WORLD_SIZE,
  SERVER_URL,
} from '../config.ts';
import {
  CAMERA_POSE_SAVE_DEBOUNCE_MS,
  cameraPoseStorageKey,
  loadCameraPose,
  saveCameraPose,
  type CameraPose,
} from './cameraPose.ts';
import {
  applyGroundClearance,
  type GroundHeightSampler,
} from './cameraClearance.ts';
import { createSkyEnvironment, type SkyEnvironment } from './skyEnvironment.ts';
import { recordFrame, setFrameCounterSource, setGpuSampleSource } from './frameStats.ts';
import { createGpuTimer } from './gpuTimer.ts';
import { routeInstancesThroughAttributes } from './webglInstanceUpload.ts';
import type { SkyRigState } from '../plugins/types.ts';
import { BOOT_MARKS, markBoot } from '../bootMarks.ts';

export const SKY_COLOR = 0x9fc7e8;
export const GROUND_BOUNCE_COLOR = 0x9a948a;
export const HEMISPHERE_LIGHT_INTENSITY = 1.5;
export const SUN_LIGHT_INTENSITY = 1.2;

export const AMBIENT_FLOOR_INTENSITY = 0.9;
export const SUN_DIRECTION_NOON: readonly [number, number, number] = [0.7, 0.45, 0.55];
export const SUN_DISTANCE_WORLD_UNITS = 200;

const MAX_PIXEL_RATIO = 2;

const TONE_MAPPING_EXPOSURE = 1.25;

const INITIAL_AZIMUTH_DEGREES = 45;
const INITIAL_POLAR_DEGREES = 55;

export interface SkyLightingRig {
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  readonly ambient: AmbientLight;
}

export type FramePhase = 'pose' | 'draw';

export interface Viewport {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGPURenderer;
  readonly controls: OrbitControls;
  readonly terrainGroup: Group;
  readonly lighting: SkyLightingRig;
  readonly skyEnvironment: SkyEnvironment;
  restoreOrFocus(worldSize: number): boolean;
  onFrame(handler: (dt: number) => void, phase?: FramePhase): () => void;
  setGroundHeightSampler(sampler: GroundHeightSampler | null): void;
  setFrameRateTarget(fps: number | null): void;
  start(): void;
  dispose(): void;
}

const FRAME_DELTA_CAP_S = 0.1;
const MS_PER_S = 1000;

const scene0Holder: { scene: unknown } = { scene: null };

/** DEV `?antialias=0` renders without MSAA, so a mesher parity capture is judged on coverage. */
const ANTIALIAS_QUERY_FLAG = 'antialias';

function antialiasRequested(): boolean {
  if (!import.meta.env.DEV) return true;
  return new URLSearchParams(window.location.search).get(ANTIALIAS_QUERY_FLAG) !== '0';
}

export async function createViewport(canvas: HTMLCanvasElement): Promise<Viewport> {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: antialiasRequested(),
    trackTimestamp: true,
  });
  await renderer.init();
  // StandardNodeLibrary (three/src/renderers/webgpu/nodes/StandardNodeLibrary.js)
  // pre-registers PointLight in the constructor, and addLight() silently
  // no-ops on an already-registered class -- write the WeakMap directly.
  // Untyped: NodeLibrary.d.ts declares no members at all.
  (
    renderer.library as unknown as { lightNodes: WeakMap<typeof PointLight, unknown> }
  ).lightNodes.set(PointLight, GatedPointLightNode);
  routeInstancesThroughAttributes(renderer.backend);
  if (import.meta.env.DEV) {
    (globalThis as unknown as { __terraceRenderer: unknown }).__terraceRenderer = renderer;
    (globalThis as unknown as { __terraceScene: unknown }).__terraceScene = scene0Holder;
  }
  const gpuTimer = createGpuTimer(renderer);
  setGpuSampleSource(() => gpuTimer.drain());
  setFrameCounterSource(() => ({
    pixelWidth: renderer.domElement.width,
    pixelHeight: renderer.domElement.height,
    cameraDistance: camera.position.distanceTo(controls.target),
    drawCalls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.memory.programs,
  }));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

  const scene = new Scene();
  scene0Holder.scene = scene;

  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    1,
    CAMERA_NEAR,
    CAMERA_FAR,
  );

  const hemisphere = new HemisphereLight(
    SKY_COLOR,
    GROUND_BOUNCE_COLOR,
    HEMISPHERE_LIGHT_INTENSITY,
  );
  scene.add(hemisphere);

  const ambient = new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY);
  scene.add(ambient);

  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.set(...SUN_DIRECTION_NOON).normalize().multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
  scene.add(sun);

  const noonSky: SkyRigState = {
    sunDirection: {
      x: SUN_DIRECTION_NOON[0],
      y: SUN_DIRECTION_NOON[1],
      z: SUN_DIRECTION_NOON[2],
    },
    sunColor: 0xffffff,
    sunIntensity: SUN_LIGHT_INTENSITY,
    hemisphereSkyColor: SKY_COLOR,
    hemisphereGroundColor: GROUND_BOUNCE_COLOR,
    hemisphereIntensity: HEMISPHERE_LIGHT_INTENSITY,
    ambientColor: 0xffffff,
    ambientIntensity: AMBIENT_FLOOR_INTENSITY,
    backgroundColor: SKY_COLOR,
  };
  const skyEnvironment = createSkyEnvironment(renderer, noonSky, performance.now());

  const terrainGroup = new Group();
  scene.add(terrainGroup);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = CAMERA_MIN_DISTANCE;
  controls.maxDistance = CAMERA_MAX_DISTANCE;
  controls.maxPolarAngle = MathUtils.degToRad(CAMERA_MAX_POLAR_ANGLE_DEGREES);
  controls.zoomToCursor = true;

  const resize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  const frameCallbacks = new Set<(dt: number) => void>();
  const poseFrameCallbacks = new Set<(dt: number) => void>();

  let groundHeightSampler: GroundHeightSampler | null = null;

  const brokenFrameCallbacks = new WeakSet<(dt: number) => void>();

  const runFrameCallback = (cb: (dt: number) => void, dt: number): void => {
    try {
      cb(dt);
    } catch (error) {
      if (brokenFrameCallbacks.has(cb)) return;
      brokenFrameCallbacks.add(cb);
      console.error('[scene] a frame callback threw; the rest of the frame still ran', error);
    }
  };

  let frameHandle = 0;
  let lastFrameMs = 0;
  let frameIntervalMs: number | null = null;
  let nextDueMs = 0;
  let lastTickMs = 0;
  const shouldRenderTick = (nowMs: number): boolean => {
    const tickGapMs = lastTickMs === 0 ? 0 : nowMs - lastTickMs;
    lastTickMs = nowMs;
    if (frameIntervalMs === null) return true;
    if (nowMs + tickGapMs / 2 < nextDueMs) return false;
    nextDueMs = Math.max(nextDueMs + frameIntervalMs, nowMs);
    return true;
  };
  const renderFrame = (): void => {
    frameHandle = requestAnimationFrame(renderFrame);
    const nowMs = performance.now();
    if (!shouldRenderTick(nowMs)) return;
    gpuTimer.mark();
    const firstFrame = lastFrameMs === 0;
    const dt = firstFrame ? 0 : Math.min((nowMs - lastFrameMs) / 1000, FRAME_DELTA_CAP_S);
    lastFrameMs = nowMs;
    for (const cb of poseFrameCallbacks) runFrameCallback(cb, dt);
    for (const cb of frameCallbacks) runFrameCallback(cb, dt);
    controls.update();
    if (groundHeightSampler !== null) {
      applyGroundClearance(camera.position, groundHeightSampler);
    }
    skyEnvironment.flush(nowMs);
    const renderStartMs = performance.now();
    renderer.render(scene, camera);
    if (firstFrame) markBoot(BOOT_MARKS.firstFrame);
    recordFrame(nowMs, renderStartMs, performance.now());
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  const focusWorld = (worldSize: number): void => {
    const centre = ((worldSize - 1) * CELL_WORLD_SIZE) / 2;
    controls.target.set(centre, 0, centre);
    const azimuth = MathUtils.degToRad(INITIAL_AZIMUTH_DEGREES);
    const polar = MathUtils.degToRad(INITIAL_POLAR_DEGREES);
    const distance = CAMERA_INITIAL_DISTANCE;
    camera.position.set(
      centre + distance * Math.sin(polar) * Math.cos(azimuth),
      distance * Math.cos(polar),
      centre + distance * Math.sin(polar) * Math.sin(azimuth),
    );
    controls.update();
  };

  let poseStorageKey: string | null = null;
  let poseSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const currentPose = (): CameraPose => ({
    target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    position: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    },
  });

  const savePoseNow = (): void => {
    if (poseSaveTimer !== null) {
      clearTimeout(poseSaveTimer);
      poseSaveTimer = null;
    }
    if (poseStorageKey === null) return;
    saveCameraPose(poseStorageKey, currentPose());
  };

  const savePoseSoon = (): void => {
    if (poseStorageKey === null || poseSaveTimer !== null) return;
    poseSaveTimer = setTimeout(() => {
      poseSaveTimer = null;
      savePoseNow();
    }, CAMERA_POSE_SAVE_DEBOUNCE_MS);
  };

  controls.addEventListener('end', savePoseNow);
  controls.addEventListener('change', savePoseSoon);
  window.addEventListener('pagehide', savePoseNow);

  const restoreOrFocus = (worldSize: number): boolean => {
    poseStorageKey = cameraPoseStorageKey(SERVER_URL, worldSize);
    const stored = loadCameraPose(poseStorageKey, worldSize);
    if (stored === null) {
      focusWorld(worldSize);
      return false;
    }
    controls.target.set(stored.target.x, stored.target.y, stored.target.z);
    camera.position.set(
      stored.position.x,
      stored.position.y,
      stored.position.z,
    );
    controls.update();
    return true;
  };

  return {
    scene,
    camera,
    renderer,
    controls,
    terrainGroup,
    lighting: { sun, hemisphere, ambient },
    skyEnvironment,
    restoreOrFocus,
    onFrame(handler: (dt: number) => void, phase: FramePhase = 'draw'): () => void {
      const set = phase === 'pose' ? poseFrameCallbacks : frameCallbacks;
      set.add(handler);
      return () => set.delete(handler);
    },
    setGroundHeightSampler(sampler: GroundHeightSampler | null): void {
      groundHeightSampler = sampler;
    },
    setFrameRateTarget(fps: number | null): void {
      frameIntervalMs = fps === null || !(fps > 0) ? null : MS_PER_S / fps;
      nextDueMs = 0;
    },
    start(): void {
      if (frameHandle === 0) renderFrame();
    },
    dispose(): void {
      cancelAnimationFrame(frameHandle);
      frameHandle = 0;
      frameCallbacks.clear();
      poseFrameCallbacks.clear();
      resizeObserver.disconnect();
      savePoseNow();
      controls.removeEventListener('end', savePoseNow);
      controls.removeEventListener('change', savePoseSoon);
      window.removeEventListener('pagehide', savePoseNow);
      controls.dispose();
      skyEnvironment.dispose();
      renderer.dispose();
    },
  };
}
