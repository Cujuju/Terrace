// Three.js scene, camera, orbit controls and the render loop.
//
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
import type { SkyRigState } from '../plugins/types.ts';

/**
 * The hemisphere light's sky colour — the daylight falling on the map from
 * above. Exported so other render modules that want to blend toward "the sky"
 * derive it from this one definition rather than picking a second sky colour
 * that could drift out of sync.
 *
 * NOT the background any more (issue #326). Outside the map is the celestial
 * void (./celestialVoid.ts), and nothing blends toward it: the frontier mist
 * (./frontierFog.ts) is water-coloured throughout. This constant is the map's
 * own light.
 */
export const SKY_COLOR = 0x9fc7e8;
/**
 * Bounce colour from below — keeps shaded terrace faces from going black.
 * Lightened from 0x5b5a4e with the 2026-08-14 rebalance: the old bounce was
 * charcoal, so a face tilted away from the sky received almost nothing and
 * read as a black cut whatever the intensities above said.
 *
 * Exported as the day/night plugin's noon anchor for the hemisphere's ground
 * term — see SUN_DIRECTION_NOON.
 */
export const GROUND_BOUNCE_COLOR = 0x9a948a;
/**
 * Key-to-fill balance, retuned 2026-08-14 (owner: "the sun is too harsh. It
 * acts too much like a spotlight", then "too much shadow. The world is too
 * dark"). The original 2.2 sun over 1.1 hemisphere put two thirds of a lit
 * face's light in the directional term, so faces swung hard between blasted
 * and murky as they turned. Now the FILL leads (1.9) and the sun (1.5) only
 * models the terraces — its off-axis direction does that work, not raw
 * intensity — so no face of a step is ever far from daylight.
 *
 * EXPORTED as the NOON ANCHOR of the day/night plugin's cycle (plugins/
 * daynight): that plugin derives its whole lighting sweep from these values
 * so that an unmodded server — or any server at the exact instant its cycle
 * passes through noon — looks exactly like this file always has. Core has no
 * idea a day/night cycle exists; it only publishes the numbers it already
 * had an opinion about.
 */
export const HEMISPHERE_LIGHT_INTENSITY = 1.5;
/** Key light. Intensity is tuned against ACES tone mapping, below. */
export const SUN_LIGHT_INTENSITY = 1.2;

/**
 * The FLOOR under every face, from an AmbientLight — the one lamp with no
 * direction at all. The sun is directional and the hemisphere is vertical-
 * orientation-dependent, so with only those two a face turned away from both
 * is dark from SOME camera angle whatever their intensities are — which is
 * exactly the report this closes (owner, 2026-08-14, third round: "it still
 * doesn't fix the darker view when looking at the side of terrain"). 0.9
 * guarantees roughly a third of full daylight to the worst-oriented face;
 * modeling contrast on top comes from the (now gentler) sun and hemisphere.
 *
 * Exported for the same day/night noon-anchor reason as HEMISPHERE_LIGHT_
 * INTENSITY above.
 */
export const AMBIENT_FLOOR_INTENSITY = 0.9;
/**
 * Sun direction as a unit-ish vector. Deliberately off-axis on all three axes
 * so that the four sides of a terrace step each catch a different amount of
 * light — an axis-aligned sun makes opposite faces identical and the steps
 * stop reading as steps.
 *
 * A plain tuple, not a Vector3, and EXPORTED: the day/night plugin's pure
 * numeric module (plugins/daynight/client/sky.ts) needs these three numbers
 * as its noon anchor but must stay import.meta.env-free to run under a plain
 * node test (the same constraint plugins/weather/client/sky.ts documents on
 * WORLD_UNITS_PER_BAND) — a Vector3 export would be fine for that constraint
 * itself, but the raw numbers are also what that plugin's tests assert
 * against directly, without constructing three.js objects to do it.
 */
// LOWERED 2026-08-14 (owner: the light "feels like it's overhead and still
// harsh so the sides of terrain appears dark"): y dropped 0.7 → 0.45 takes
// the sun from ~45° to ~27° elevation, so terrace WALLS now catch real sun
// while treads keep enough of it to stay the brightest surfaces. Still
// off-axis on all three axes for the reasons above.
export const SUN_DIRECTION_NOON: readonly [number, number, number] = [0.7, 0.45, 0.55];
/**
 * Distance to place the (directional) sun at; only its direction matters —
 * exported so applySkyRig (./skyRig.ts) can place a plugin-driven sun the
 * same way core places its own, without a second unjustified number.
 */
export const SUN_DISTANCE_WORLD_UNITS = 200;

/** Pixel-ratio cap: beyond 2x the fill cost buys nothing visible. */
const MAX_PIXEL_RATIO = 2;

/** See the assignment site next to renderer.toneMapping for the reasoning. */
const TONE_MAPPING_EXPOSURE = 1.25;

/** Initial orbit angles, before a world size is known. */
const INITIAL_AZIMUTH_DEGREES = 45;
const INITIAL_POLAR_DEGREES = 55;

/**
 * The lights a plugin-driven sky rig may mutate — see Viewport.lighting and
 * ClientPluginCtx.setSkyRig (client/src/plugins/types.ts). Deliberately just
 * the three light objects and nothing else of the scene (no camera, no
 * terrain, no `scene` itself): the capability this backs is "the shape of a
 * sky", not a raw scene handle.
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
   * The three lights core builds at boot, handed out so client/plugins/
   * host.ts can mutate them on behalf of the ONE plugin that claims
   * ClientPluginCtx.setSkyRig (see ./skyRig.ts). Nothing outside host.ts and
   * skyRig.ts should reach into this — a second mutator would race the first
   * with no error, exactly the failure the single-claimant rule in
   * setSkyRig's own doc comment exists to prevent.
   */
  readonly lighting: SkyLightingRig;
  /**
   * The sky as an environment map for authored PBR assets to reflect — see
   * ./skyEnvironment.ts. Painted at boot from the same noon constants the
   * lamps above are built from, and repainted by applySkyRig whenever a plugin
   * changes the sky, so a reflection and the lamps never disagree about what
   * time of day it is. NOT scene.environment: only assets loaded with
   * ClientPluginCtx.loadRigAsset's 'sky-environment' policy sample it.
   */
  readonly skyEnvironment: SkyEnvironment;
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
  onFrame(handler: (dt: number) => void, phase?: FramePhase): () => void;
  /**
   * Supplies the ground the camera is held above (render/cameraClearance.ts).
   * Null — the state at boot — disables the floor entirely, which is correct
   * before a world exists: there is no ground to be under yet.
   *
   * Core cannot build this itself. The height field belongs to the world
   * (world.ts owns the mirror), and the viewport deliberately knows nothing
   * about terrain data; main.tsx is where the two meet.
   */
  setGroundHeightSampler(sampler: GroundHeightSampler | null): void;
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

/**
 * Dev-only handle onto the live Scene, filled once it exists below. Held in a
 * holder rather than assigned to the global directly so the global exists (and
 * a driver can wait on `.scene`) from the first line of createViewport.
 */
const scene0Holder: { scene: unknown } = { scene: null };

export function createViewport(canvas: HTMLCanvasElement): Viewport {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  // Dev-only handles for the CDP perf drivers (scripts/gpu-bench.md and the
  // .gpu-perf / .perf-run rigs): the renderer, so a driver can read
  // renderer.info (draw calls, triangles) per frame, and the scene, so it can
  // census instanced meshes and lights. Same gate as the `__terrace` handle in
  // main.tsx — import.meta.env.DEV is statically false in production builds,
  // so the block is eliminated there (issue #309).
  if (import.meta.env.DEV) {
    (globalThis as unknown as { __terraceRenderer: unknown }).__terraceRenderer = renderer;
    (globalThis as unknown as { __terraceScene: unknown }).__terraceScene = scene0Holder;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  // Per-material clipping planes are ignored until this is on. The brush
  // preview (render/brushPreview.ts) is the one user, cutting its outline at
  // the world's edge (issue #281); a material with no clippingPlanes set pays
  // nothing for the flag.
  renderer.localClippingEnabled = true;
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
  scene0Holder.scene = scene;
  // NO scene.background. What is drawn outside the map is the celestial void
  // pass (./celestialVoid.ts, issue #326), a fullscreen mesh main.tsx adds to
  // this scene — not a flat colour. Leaving `background` at its null default
  // is also what keeps time of day off the void: ./skyRig.ts only writes a
  // background that is a Color, so the day/night plugin's backgroundColor now
  // has nothing to land on. See celestialVoid.ts's header.

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
  // No shadow map in Phase 1: a directional shadow covering a 512-cell world
  // needs a large cascade to avoid acne, and the terraced silhouette already
  // reads without it. Revisit with the Phase 2 look pass.
  scene.add(sun);

  // The SAME noon the lamps above were just built from, as a SkyRigState —
  // the shape applySkyRig will later repaint the environment from — so the
  // boot-time reflection is the boot-time sky and not a second opinion of it.
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

  /**
   * Frame callbacks, in TWO PHASES.
   *
   * WHY A PHASE AND NOT JUST REGISTRATION ORDER (bug, 2026-08-24). Some plugins
   * draw a thing ON another plugin's thing — a flame on a burning boat — by
   * asking its owner, every frame, where that thing is being drawn
   * (ClientPluginCtx.publishMovers). That is a read-after-write between two
   * plugins inside one frame, and with a single callback list its correctness
   * came down to the order of an array in client/src/plugins/registry.ts: fire
   * happened to be listed after wildlife and before boats, so it read one
   * owner's poses fresh and the other's one frame stale.
   *
   * So the dependency is DECLARED instead of stumbled into. Everything that
   * publishes poses runs in the 'pose' phase, everything else in 'draw', and
   * the loop below runs the phases in that order.
   */
  const frameCallbacks = new Set<(dt: number) => void>();
  const poseFrameCallbacks = new Set<(dt: number) => void>();

  // Null until the world can answer where the ground is (main.tsx wires it),
  // and null again for any point with no ground — see GroundHeightSampler.
  let groundHeightSampler: GroundHeightSampler | null = null;

  /**
   * Frame callbacks that have already thrown once. A callback that throws does
   * so EVERY frame, so the console would otherwise carry sixty copies of the
   * same stack per second and bury whatever else was being reported — the same
   * once-per-claimant rule the plugin host applies to its sky-rig refusals.
   */
  const brokenFrameCallbacks = new WeakSet<(dt: number) => void>();

  /**
   * Runs one frame callback in isolation.
   *
   * WITHOUT THIS, ONE PLUGIN FREEZES THE WHOLE GAME. The callbacks share a
   * single loop with `controls.update()` and `renderer.render()` below, so a
   * throw from any one of them skipped every later subscriber AND the render
   * itself: the canvas kept showing its last frame forever, which reads as
   * "the world froze" rather than as "one plugin is broken". A per-callback
   * boundary keeps the failure the size of the plugin that caused it.
   *
   * A throwing callback is NOT unsubscribed. Some of them are waiting on data
   * that has not arrived (a chunk, a texture) and recover on their own, and
   * silently disabling a plugin for one bad frame would be a worse failure than
   * the one this guards against.
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
    // First frame has no predecessor; a zero step is correct for it.
    const dt =
      lastFrameMs === 0
        ? 0
        : Math.min((nowMs - lastFrameMs) / 1000, FRAME_DELTA_CAP_S);
    lastFrameMs = nowMs;
    // POSE FIRST, then everything that may read a pose.
    for (const cb of poseFrameCallbacks) runFrameCallback(cb, dt);
    for (const cb of frameCallbacks) runFrameCallback(cb, dt);
    // Damping needs a per-frame update; it is also what applies any pending
    // camera input.
    controls.update();
    // AFTER the update, never before: the update is what writes the camera
    // position, so a floor applied ahead of it is simply overwritten. See
    // ./cameraClearance.ts for why the orbit's own minDistance cannot do this.
    if (groundHeightSampler !== null) {
      applyGroundClearance(camera.position, groundHeightSampler);
    }
    // BEFORE the render: a repaint's own draws reset renderer.info, and the
    // draw-budget sampler reads that after this frame's render (plugins/
    // host.ts) — run here they cannot land in its count.
    skyEnvironment.flush(nowMs);
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
