// Three.js scene, camera, orbit controls and the render loop.
//
// This module and everything under render/ and input/ is plain imperative TS:
// it owns the canvas outright and Solid never re-renders it (design doc §3.1).
// The HUD talks to it only through explicit function calls.

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
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

/** Sky/background, and the hemisphere light's sky colour. */
const SKY_COLOR = 0x9fc7e8;
/**
 * Bounce colour from below — keeps shaded terrace faces from going black.
 * Lightened from 0x5b5a4e with the 2026-08-14 rebalance: the old bounce was
 * charcoal, so a face tilted away from the sky received almost nothing and
 * read as a black cut whatever the intensities above said.
 */
const GROUND_BOUNCE_COLOR = 0x9a948a;
/**
 * Key-to-fill balance, retuned 2026-08-14 (owner: "the sun is too harsh. It
 * acts too much like a spotlight", then "too much shadow. The world is too
 * dark"). The original 2.2 sun over 1.1 hemisphere put two thirds of a lit
 * face's light in the directional term, so faces swung hard between blasted
 * and murky as they turned. Now the FILL leads (1.9) and the sun (1.5) only
 * models the terraces — its off-axis direction does that work, not raw
 * intensity — so no face of a step is ever far from daylight.
 */
const HEMISPHERE_LIGHT_INTENSITY = 2.1;
/** Key light. Intensity is tuned against ACES tone mapping, below. */
const SUN_LIGHT_INTENSITY = 1.5;
/**
 * Sun direction as a unit-ish vector. Deliberately off-axis on all three axes
 * so that the four sides of a terrace step each catch a different amount of
 * light — an axis-aligned sun makes opposite faces identical and the steps
 * stop reading as steps.
 */
// LOWERED 2026-08-14 (owner: the light "feels like it's overhead and still
// harsh so the sides of terrain appears dark"): y dropped 0.7 → 0.45 takes
// the sun from ~45° to ~27° elevation, so terrace WALLS now catch real sun
// while treads keep enough of it to stay the brightest surfaces. Still
// off-axis on all three axes for the reasons above.
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
/** Distance to place the (directional) sun at; only its direction matters. */
const SUN_DISTANCE_CELLS = 200;

/** Pixel-ratio cap: beyond 2x the fill cost buys nothing visible. */
const MAX_PIXEL_RATIO = 2;

/** See the assignment site next to renderer.toneMapping for the reasoning. */
const TONE_MAPPING_EXPOSURE = 1.25;

/** Initial orbit angles, before a world size is known. */
const INITIAL_AZIMUTH_DEGREES = 45;
const INITIAL_POLAR_DEGREES = 55;

export interface Viewport {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  /** Everything sculptable lives here; the raycaster tests this group only. */
  readonly terrainGroup: Group;
  /**
   * Points the camera at a world of this size, once that size is known, and
   * arms pose persistence for it (nothing can be stored before the world's
   * identity — and therefore its storage key — exists).
   *
   * The stored pose for this server + world size wins if there is a valid one,
   * so a reload resumes the exact view it left; otherwise the world is framed
   * from scratch. Returns true when a stored pose was restored.
   */
  restoreOrFocus(worldSize: number): boolean;
  /**
   * Registers a per-frame callback, called before each render with the frame
   * delta in seconds (capped — see FRAME_DELTA_CAP_S). Returns an unregister
   * function. This is how plugin layers animate without owning a loop.
   */
  onFrame(handler: (dt: number) => void): () => void;
  start(): void;
  dispose(): void;
}

/**
 * Upper bound on the dt handed to frame callbacks, in seconds. A backgrounded
 * tab stops receiving animation frames; without the cap, returning to the tab
 * would hand animations one multi-second step and every wandering creature
 * would teleport. 100 ms = the server's tick period: a plausible worst normal
 * frame, and far below anything that reads as a jump.
 */
const FRAME_DELTA_CAP_S = 0.1;

export function createViewport(canvas: HTMLCanvasElement): Viewport {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.outputColorSpace = SRGBColorSpace;
  // ACES keeps the bright snow band and the dark seabed both readable without
  // per-material tuning.
  renderer.toneMapping = ACESFilmicToneMapping;
  // Above the default 1: the third dial of the 2026-08-14 daylight retune
  // (with the key/fill balance and the lowered sun above). Exposure lifts
  // EVERYTHING — including the shadow sides the owner reported as too dark —
  // where intensity changes shift the key/fill balance; ACES soft-clips the
  // top end so treads and snow do not blow out.
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

  const scene = new Scene();
  scene.background = new Color(SKY_COLOR);

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

  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).normalize().multiplyScalar(SUN_DISTANCE_CELLS);
  // No shadow map in Phase 1: a directional shadow covering a 512-cell world
  // needs a large cascade to avoid acne, and the terraced silhouette already
  // reads without it. Revisit with the Phase 2 look pass.
  scene.add(sun);

  const terrainGroup = new Group();
  scene.add(terrainGroup);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = CAMERA_MIN_DISTANCE;
  controls.maxDistance = CAMERA_MAX_DISTANCE;
  controls.maxPolarAngle = MathUtils.degToRad(CAMERA_MAX_POLAR_ANGLE_DEGREES);
  // Wheel zoom dollies toward the point under the POINTER, not the orbit
  // target (owner, 2026-08-14: "it should zoom in to the location where the
  // mouse is currently sitting"). OrbitControls' native implementation — it
  // re-anchors controls.target as it dollies, so the orbit centre lands where
  // the player was looking. Trackpad pinch (wheelCamera.ts) keeps its own
  // centre-anchored dolly: there the fingers are the gesture's own anchor.
  controls.zoomToCursor = true;
  // Which mouse button drives which camera verb is user-configurable and is
  // owned by input/cameraBindings.ts (wired in main.tsx): it sets
  // controls.mouseButtons per press so buttons claimed by the sculpt brush are
  // null here and the two input owners never fight over a drag.

  const resize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  const frameCallbacks = new Set<(dt: number) => void>();

  let frameHandle = 0;
  let lastFrameMs = 0;
  const renderFrame = (): void => {
    frameHandle = requestAnimationFrame(renderFrame);
    const nowMs = performance.now();
    // First frame has no predecessor; a zero step is correct for it.
    const dt =
      lastFrameMs === 0
        ? 0
        : Math.min((nowMs - lastFrameMs) / 1000, FRAME_DELTA_CAP_S);
    lastFrameMs = nowMs;
    for (const cb of frameCallbacks) cb(dt);
    // Damping needs a per-frame update; it is also what applies any pending
    // camera input.
    controls.update();
    renderer.render(scene, camera);
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

  // -------------------------------------------------------------------------
  // Camera-pose persistence (render/cameraPose.ts owns the format and rules).
  // -------------------------------------------------------------------------

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

  /** Writes the live pose immediately, cancelling any pending debounced save. */
  const savePoseNow = (): void => {
    if (poseSaveTimer !== null) {
      clearTimeout(poseSaveTimer);
      poseSaveTimer = null;
    }
    if (poseStorageKey === null) return;
    saveCameraPose(poseStorageKey, currentPose());
  };

  /**
   * Schedules ONE save CAMERA_POSE_SAVE_DEBOUNCE_MS from the first change of a
   * burst; further changes inside that window ride along rather than pushing
   * the deadline out. A deadline-resetting debounce would write nothing at all
   * during a long continuous gesture (wheel zoom, damping decay), which is
   * precisely the case 'end' does not cover.
   */
  const savePoseSoon = (): void => {
    if (poseStorageKey === null || poseSaveTimer !== null) return;
    poseSaveTimer = setTimeout(() => {
      poseSaveTimer = null;
      savePoseNow();
    }, CAMERA_POSE_SAVE_DEBOUNCE_MS);
  };

  // 'end' closes a completed gesture; 'change' catches the streams that never
  // emit one. pagehide covers the reload that lands inside the debounce window
  // — it fires on both navigation and bfcache suspension, where 'unload' does
  // not (and 'unload' would disqualify the page from the bfcache).
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
    // Recomputes the controls' internal spherical from the pose we just set;
    // without it the next input would swing the camera back to the previous
    // orbit angles.
    controls.update();
    return true;
  };

  return {
    scene,
    camera,
    renderer,
    controls,
    terrainGroup,
    restoreOrFocus,
    onFrame(handler: (dt: number) => void): () => void {
      frameCallbacks.add(handler);
      return () => frameCallbacks.delete(handler);
    },
    start(): void {
      if (frameHandle === 0) renderFrame();
    },
    dispose(): void {
      cancelAnimationFrame(frameHandle);
      frameHandle = 0;
      frameCallbacks.clear();
      resizeObserver.disconnect();
      // Last write wins: the pose on screen at teardown is the one remembered.
      savePoseNow();
      controls.removeEventListener('end', savePoseNow);
      controls.removeEventListener('change', savePoseSoon);
      window.removeEventListener('pagehide', savePoseNow);
      controls.dispose();
      renderer.dispose();
    },
  };
}
