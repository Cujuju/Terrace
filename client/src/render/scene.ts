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
} from '../config.ts';

/** Sky/background, and the hemisphere light's sky colour. */
const SKY_COLOR = 0x9fc7e8;
/** Bounce colour from below — keeps shaded terrace faces from going black. */
const GROUND_BOUNCE_COLOR = 0x5b5a4e;
const HEMISPHERE_LIGHT_INTENSITY = 1.1;
/** Key light. Intensity is tuned against ACES tone mapping, below. */
const SUN_LIGHT_INTENSITY = 2.2;
/**
 * Sun direction as a unit-ish vector. Deliberately off-axis on all three axes
 * so that the four sides of a terrace step each catch a different amount of
 * light — an axis-aligned sun makes opposite faces identical and the steps
 * stop reading as steps.
 */
const SUN_DIRECTION = new Vector3(0.55, 0.7, 0.45);
/** Distance to place the (directional) sun at; only its direction matters. */
const SUN_DISTANCE_CELLS = 200;

/** Pixel-ratio cap: beyond 2x the fill cost buys nothing visible. */
const MAX_PIXEL_RATIO = 2;

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
  /** Re-centres and frames the camera once the world's size is known. */
  focusWorld(worldSize: number): void;
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

  return {
    scene,
    camera,
    renderer,
    controls,
    terrainGroup,
    focusWorld,
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
      controls.dispose();
      renderer.dispose();
    },
  };
}
