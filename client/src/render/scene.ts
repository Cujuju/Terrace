// This module and everything under render/ and input/ is plain imperative TS:
// it owns the canvas outright and Solid never re-renders it (design doc).
// The HUD talks to it only through explicit function calls.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
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
import type { SkyRigState } from '../plugins/types.ts';

/**
 * Exported so anything blending toward "the sky" derives it from here rather
 * than picking a second, driftable sky colour.
 *
 * Not the background (issue #326) — outside the map is the celestial void
 * (./celestialVoid.ts), water-coloured throughout.
 */
export const SKY_COLOR = 0x9fc7e8;
/**
 * Bounce from below, keeping shaded terrace faces off black. Lightened from
 * 0x5b5a4e (2026-08-14): the old charcoal gave a sky-averted face almost
 * nothing regardless of intensities above.
 *
 * Exported as the day/night plugin's noon anchor — see SUN_DIRECTION_NOON.
 */
export const GROUND_BOUNCE_COLOR = 0x9a948a;
/**
 * Key-to-fill balance, retuned 2026-08-14 (owner: sun "too much like a
 * spotlight", then "too dark"). The old 2.2 sun / 1.1 hemisphere swung faces
 * between blasted and murky; now fill leads and the sun models terraces by its
 * off-axis direction, not its intensity.
 *
 * Exported as the day/night plugin's noon anchor: that plugin derives its whole
 * sweep from these values, so its noon matches this file's. Core has no idea a
 * day/night cycle exists.
 */
export const HEMISPHERE_LIGHT_INTENSITY = 1.5;
/** Key light. Intensity is tuned against ACES tone mapping, below. */
export const SUN_LIGHT_INTENSITY = 1.2;

/**
 * The sun is directional and the hemisphere vertical-dependent, so without a
 * directionless floor a face turned away from both is dark from some angle
 * whatever their intensities (owner, 2026-08-14, third round).
 *
 * 0.9 gives the worst-oriented face roughly a third of full daylight. Exported
 * as a day/night noon anchor, like HEMISPHERE_LIGHT_INTENSITY.
 */
export const AMBIENT_FLOOR_INTENSITY = 0.9;
/**
 * Off-axis on all three axes so the four sides of a terrace step each catch a
 * different amount of light — axis-aligned would make opposite faces identical
 * and the steps stop reading as steps.
 *
 * A plain tuple: the day/night plugin's pure module must stay
 * import.meta.env-free to run under plain node, and its tests assert against
 * these raw numbers.
 *
 * Lowered 2026-08-14 (owner: sun "feels overhead and still harsh so the sides
 * of terrain appears dark"): y 0.7→0.45 takes elevation ~45°→~27°, so walls
 * catch real sun while treads stay brightest.
 */
export const SUN_DIRECTION_NOON: readonly [number, number, number] = [0.7, 0.45, 0.55];
/** Only direction matters. Exported so applySkyRig places a plugin-driven sun the same way. */
export const SUN_DISTANCE_WORLD_UNITS = 200;

/** Pixel-ratio cap: beyond 2x the fill cost buys nothing visible. */
const MAX_PIXEL_RATIO = 2;

/** See the assignment site next to renderer.toneMapping for the reasoning. */
const TONE_MAPPING_EXPOSURE = 1.25;

/** Initial orbit angles, before a world size is known. */
const INITIAL_AZIMUTH_DEGREES = 45;
const INITIAL_POLAR_DEGREES = 55;

/**
 * Deliberately just the three lights, nothing else of the scene: the capability
 * is "the shape of a sky", not a scene handle.
 */
export interface SkyLightingRig {
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  readonly ambient: AmbientLight;
}

/**
 * When in a frame a callback runs.
 *
 * 'pose' — this callback WRITES where things are drawn, and something else may
 *          ask about it this same frame (ClientPluginCtx.publishMovers).
 * 'draw' — everything else. The default; may read any pose published above.
 */
export type FramePhase = 'pose' | 'draw';

export interface Viewport {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  /** Everything sculptable lives here; the raycaster tests this group only. */
  readonly terrainGroup: Group;
  /**
   * Mutated by host.ts on behalf of the ONE plugin claiming setSkyRig. Nothing
   * else should reach in — a second mutator would race the first with no error.
   */
  readonly lighting: SkyLightingRig;
  /**
   * Painted at boot from the same noon constants as the lamps and repainted by
   * applySkyRig, so reflections and lamps never disagree.
   *
   * Not scene.environment — only assets loaded with loadRigAsset's
   * 'sky-environment' policy sample it.
   */
  readonly skyEnvironment: SkyEnvironment;
  /**
   * A stored pose for this server + world size wins if valid, so a reload
   * resumes the exact view; otherwise the world is framed from scratch. True
   * when a stored pose was restored.
   */
  restoreOrFocus(worldSize: number): boolean;
  /** The handler's argument is the frame delta in seconds, capped at FRAME_DELTA_CAP_S. */
  onFrame(handler: (dt: number) => void, phase?: FramePhase): () => void;
  /**
   * Null (the boot state) disables the floor — correct before a world exists.
   *
   * Core cannot build this itself: the height field belongs to world.ts and the
   * viewport deliberately knows nothing about terrain data; main.tsx is where
   * the two meet.
   */
  setGroundHeightSampler(sampler: GroundHeightSampler | null): void;
  start(): void;
  dispose(): void;
}

/**
 * A backgrounded tab stops receiving animation frames; without a cap, returning
 * would hand animations a multi-second step and teleport every creature. 100 ms
 * matches the server's tick period.
 */
const FRAME_DELTA_CAP_S = 0.1;

/** A holder, not a direct assignment, so the dev global exists from createViewport's first line. */
const scene0Holder: { scene: unknown } = { scene: null };

export function createViewport(canvas: HTMLCanvasElement): Viewport {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  // For the CDP perf drivers (scripts/gpu-bench.md). import.meta.env.DEV is
  // statically false in production, so the block is eliminated there (#309).
  if (import.meta.env.DEV) {
    (globalThis as unknown as { __terraceRenderer: unknown }).__terraceRenderer = renderer;
    (globalThis as unknown as { __terraceScene: unknown }).__terraceScene = scene0Holder;
  }
  // One query in flight, all WebGL2 allows.
  const gpuTimer = createGpuTimer(renderer.getContext());
  setGpuSampleSource(() => gpuTimer.drain());
  // Lives here because this file holds the renderer and frameStats deliberately
  // does not import three. Read once per window, not per frame.
  setFrameCounterSource(() => ({
    // The drawing buffer, not the CSS box — pixel ratio separates the two.
    pixelWidth: renderer.domElement.width,
    pixelHeight: renderer.domElement.height,
    cameraDistance: camera.position.distanceTo(controls.target),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? 0,
  }));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  // Per-material clipping planes are ignored until this is on. The brush preview
  // is the one user, cutting its outline at the world's edge (#281); a material
  // with no clippingPlanes pays nothing.
  renderer.localClippingEnabled = true;
  renderer.outputColorSpace = SRGBColorSpace;
  // ACES keeps the bright snow band and dark seabed both readable without
  // per-material tuning.
  renderer.toneMapping = ACESFilmicToneMapping;
  // Above the default 1: third dial of the 2026-08-14 daylight retune. Lifts
  // everything, shadow sides included; ACES soft-clips the top end.
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

  const scene = new Scene();
  scene0Holder.scene = scene;
  // NO scene.background: outside the map is the celestial void pass (#326), a
  // fullscreen mesh main.tsx adds. Staying null also keeps time of day off the
  // void, since ./skyRig.ts only writes a Color background.

  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    1, // corrected by the first resize, which runs before the first frame
    CAMERA_NEAR,
    CAMERA_FAR,
  );

  const hemisphere = new HemisphereLight(
    SKY_COLOR,
    GROUND_BOUNCE_COLOR,
    HEMISPHERE_LIGHT_INTENSITY,
  );
  scene.add(hemisphere);

  // The orientation-independent floor — see AMBIENT_FLOOR_INTENSITY.
  const ambient = new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY);
  scene.add(ambient);

  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.set(...SUN_DIRECTION_NOON).normalize().multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
  // No shadow map in Phase 1: a directional shadow over a 512-cell world
  // needs a large cascade to avoid acne, and the terraced silhouette already
  // reads without it.
  scene.add(sun);

  // The same noon the lamps were built from, so the boot-time reflection matches
  // the boot-time sky rather than a second opinion.
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
  // Owner, 2026-08-14: "zoom in to where the mouse is sitting". Trackpad pinch
  // keeps its own centre-anchored dolly — there the fingers are the anchor.
  controls.zoomToCursor = true;
  // input/cameraBindings.ts sets controls.mouseButtons per press, so the sculpt
  // brush and orbit controls never fight over a drag.

  const resize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  /**
   * A phase, not registration order (bug, 2026-08-24): a flame drawn on a
   * burning boat reads that boat's live pose within the same frame, and with one
   * callback list correctness depended on registry.ts's array order.
   *
   * The dependency is declared instead: pose-publishers run in 'pose', the rest
   * in 'draw', in that order.
   */
  const frameCallbacks = new Set<(dt: number) => void>();
  const poseFrameCallbacks = new Set<(dt: number) => void>();

  // Null until the world can answer where the ground is (main.tsx wires it),
  // and null again for any point with no ground — see GroundHeightSampler.
  let groundHeightSampler: GroundHeightSampler | null = null;

  /** A throwing callback throws every frame; this keeps the console off duplicate stacks. */
  const brokenFrameCallbacks = new WeakSet<(dt: number) => void>();

  /**
   * Without the isolation one throw skips every later subscriber AND the render,
   * freezing the canvas — which reads as "the world froze" rather than "one
   * plugin is broken".
   *
   * A throwing callback is NOT unsubscribed: some are waiting on data that has
   * not arrived yet and recover on their own.
   */
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
  const renderFrame = (): void => {
    frameHandle = requestAnimationFrame(renderFrame);
    const nowMs = performance.now();
    // Before any GL work this frame: the query spans mark to mark.
    gpuTimer.mark();
    // First frame has no predecessor; a zero step is correct for it.
    const dt =
      lastFrameMs === 0
        ? 0
        : Math.min((nowMs - lastFrameMs) / 1000, FRAME_DELTA_CAP_S);
    lastFrameMs = nowMs;
    // POSE FIRST, then everything that may read a pose.
    for (const cb of poseFrameCallbacks) runFrameCallback(cb, dt);
    for (const cb of frameCallbacks) runFrameCallback(cb, dt);
    // Damping needs a per-frame update; it also applies any pending camera input.
    controls.update();
    // After the update, never before — the update writes the camera
    // position, so an earlier floor would just be overwritten.
    if (groundHeightSampler !== null) {
      applyGroundClearance(camera.position, groundHeightSampler);
    }
    // Before the render: a repaint's own draws reset renderer.info, and the
    // draw-budget sampler (plugins/host.ts) reads that after this frame's render.
    skyEnvironment.flush(nowMs);
    // The frame's only two extra clock reads, bracketing `renderer.render` —
    // where the §7d decay lives. `nowMs` above is reused as the frame start.
    const renderStartMs = performance.now();
    renderer.render(scene, camera);
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

  // render/cameraPose.ts owns the pose format and the validity rules.

  /** Null until the world size — and so the storage key — is known. */
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

  /**
   * One save per burst, timed from its FIRST change: a deadline-resetting
   * debounce would write nothing during a long continuous gesture (wheel zoom,
   * damping decay) — the case 'end' does not cover.
   */
  const savePoseSoon = (): void => {
    if (poseStorageKey === null || poseSaveTimer !== null) return;
    poseSaveTimer = setTimeout(() => {
      poseSaveTimer = null;
      savePoseNow();
    }, CAMERA_POSE_SAVE_DEBOUNCE_MS);
  };

  // 'end' closes a completed gesture; 'change' catches streams that never emit
  // one. pagehide covers a reload inside the debounce window and, unlike
  // 'unload', does not disqualify the page from the bfcache.
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
    // Recomputes the controls' internal spherical; without it the next input
    // swings the camera back to the previous orbit angles.
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
    start(): void {
      if (frameHandle === 0) renderFrame();
    },
    dispose(): void {
      cancelAnimationFrame(frameHandle);
      frameHandle = 0;
      frameCallbacks.clear();
      poseFrameCallbacks.clear();
      resizeObserver.disconnect();
      // Last write wins: the pose on screen at teardown is the one remembered.
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
