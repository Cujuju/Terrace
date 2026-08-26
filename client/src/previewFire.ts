// previewFire.ts — THROWAWAY preview harness for the flame renderer in
// plugins/fire/client/flames/. The owner judges a fire's LOOK from screenshots,
// so the flame has to be photographable in isolation, under identical light, at
// identical times.
//
// IT DRAWS WHAT THE GAME DRAWS (SHIPPED_FLAMES), not a candidate chosen by
// query string. It was four candidates until the look was picked on 2026-08-24;
// pointing it at the shipped renderer instead is what keeps a picture taken here
// a picture of the real thing, now that there is a real thing. Mirrors previewCrops.ts's pattern — see that file's header
// for the fuller rationale; this restates only what differs. Not part of the
// shipped app: reached only through preview-fire.html, unlinked from
// index.html, not registered in plugins/registry.ts.
//
//   ?scene=<single|stand>   one burning tree, or five over two terrace steps
//   ?i=<0..1>               override every fire's intensity (default: the
//                           scene's own). Added when the shipped look became a
//                           CROSSFADE between two renderers: the handover is a
//                           function of intensity, so photographing it needs
//                           intensity to be the axis that moves.
//   ?t=<seconds>            animation time to capture at (default 0)
//   ?burn=<seconds>         run a REAL fire of this length instead of a frozen
//                           intensity: every tree ignites at t=0, its intensity
//                           comes from fireIntensity(t, burn), and it LEAVES THE
//                           BURNING SET once t passes burn. Added for smoke
//                           (plugins/fire/client/smoke.ts), which is the one
//                           fire visual that outlives the fire — photographing
//                           it needs a fire that can actually end, which a
//                           harness that applies one frozen set never gave.
//                           Overrides ?i, as ?i overrides the scene.
//   ?dist=<multiplier>      scale the fitted camera distance (default 1). Smoke
//                           is a DISTANCE signature and deliberately thins as
//                           the camera nears, so both ends of that have to be
//                           photographable from the same scene.
//
// WHY THE TREES ARE HERE. A flame in an empty frame is judged as an ornament.
// The question actually being asked is "does this look like that tree is on
// fire", so the harness stands the REAL flora models (createFloraModels) at the
// burning positions and sizes the fire to the tree's real height. A candidate
// whose flame floats above the crown, or vanishes inside it, fails here and
// nowhere else.
//
// WHY TIME IS STEPPED, NOT MEASURED. Every candidate animates, and the owner is
// judging motion from a filmstrip of stills. So the harness never uses the wall
// clock: it calls the renderer's own `update` in fixed 1/60 s steps from 0 up to
// ?t and only then draws. Two captures of the same URL are therefore identical
// to the pixel, and a difference between t=0 and t=0.7 is real movement rather
// than a race with the frame timer.
//
// A screenshot driver navigates here once per (scene, t) and waits
// for `window.__previewReady === true` before capturing.

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
import { fireIntensity } from '../../plugins/fire/protocol.ts';
import type { FireInstance } from '../../plugins/fire/client/flames/types.ts';

// ── Lighting rig, copied from previewCrops.ts / render/scene.ts ───────────
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

// ── Preview-only presentation ─────────────────────────────────────────────
/** Neutral mid-grey backdrop — no sky, so nothing tints the flame but the flame. */
const BACKDROP_COLOR = 0x808080;
/**
 * Terrace colours, taken from the land ramp's grass stops
 * (client/src/terrain/bandColors.ts, quoted in flora's models.ts): the upper
 * step is the brighter stop, the lower the darker one, and the risers are
 * darker again. A flame is only legible or not legible AGAINST SOMETHING, and
 * grass is what it will actually be seen against.
 */
const STEP_TOP_COLOR_UPPER = 0x8fc25a;
const STEP_TOP_COLOR_LOWER = 0x69a244;
const STEP_SIDE_COLOR = 0x4d7a2f;
/**
 * One terrace band is one world unit of relief (flora/models.ts) — the step
 * height the `stand` scene is built from.
 */
const TERRACE_BAND_HEIGHT = 1;
/** Plan size of the studio ground, in world units, and how deep the slabs are. */
const GROUND_HALF_SPAN = 5;
const GROUND_SLAB_DEPTH = 2;

/**
 * Framing padding around the burning set. Generous rather than tight: the
 * `stand` scene's box is fitted on its widest axis, and at 1.08 the two nearest
 * trees were cut off by the bottom of the frame — a picture that crops the fuel
 * cannot answer the question these pictures exist to answer.
 */
const CAMERA_FRAMING_PADDING = 1.34;
/**
 * The framing box is grown upward by this many world units before the camera is
 * fitted, because the box is computed from the TREES and the flame stands well
 * above them — fitting the trees alone crops the tips off every candidate.
 */
const FRAMING_HEADROOM = 1.0;
/**
 * Camera direction from the focus, unit vector. A god-game three-quarter view
 * from a middling orbit: high enough to see the terrace steps the fires stand
 * on, low enough that a flame is seen in profile rather than from above.
 */
const CAMERA_DIRECTION = new Vector3(0.62, 0.58, 1.0);
/** Frames rendered before the screenshot flag is raised — as previewCrops.ts. */
const SETTLE_FRAME_COUNT = 3;

// ── The animation clock ───────────────────────────────────────────────────
/** Fixed step the animation is advanced by. 60 Hz: the frame rate it is authored for. */
const ANIMATION_STEP_SECONDS = 1 / 60;
/**
 * Guard on ?t, so a fat-fingered URL cannot spin for minutes before capturing.
 *
 * RAISED from 30 for smoke: SMOKE_AFTERLIFE_SECONDS is 30 on its own, on top of
 * a tree's 22-second burn, so the frame in which the last column finally retires
 * lies past t = 52 — and a harness that cannot reach the end of the thing it is
 * photographing cannot answer the only question that matters about it, which is
 * whether it ever goes away.
 */
const MAX_PREVIEW_SECONDS = 90;
/**
 * Bounds on ?dist, as multiples of the fitted framing distance. Below 0.35 the
 * camera is inside the crown; above 12 a 1.5-unit tree is a handful of pixels,
 * which is past the point where any picture of it settles anything.
 */
const MIN_CAMERA_DISTANCE_MULTIPLIER = 0.35;
const MAX_CAMERA_DISTANCE_MULTIPLIER = 12;

// ── The burning scene ─────────────────────────────────────────────────────
/** One tree standing in the preview, and how fiercely it is alight. */
interface BurningTree {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly kind: 'conifer' | 'broadleaf';
  /** Model scale of the tree; the flame is sized from the height this gives. */
  readonly scale: number;
  readonly yaw: number;
  readonly intensity: number;
  /** Fixed per tree — the fire plugin's seeds are cell hashes, and these stand in. */
  readonly seed: number;
}

/**
 * Height of a full-grown conifer at scale 1, from flora's models.ts
 * (TRUNK_HEIGHT 0.45 + CONIFER_CROWN_HEIGHT 1.05). Restated rather than
 * imported because models.ts keeps those as private constants; it is the number
 * the fire's `fuelHeight` means, and getting it wrong is what makes a flame sit
 * at the wrong height on the tree.
 */
const TREE_HEIGHT_AT_UNIT_SCALE = 1.5;

/** `single`: one full-grown conifer, fully alight, on flat ground. */
const SINGLE_SCENE: readonly BurningTree[] = [
  { x: 0, z: 0, groundY: 0, kind: 'conifer', scale: 1, yaw: 0.4, intensity: 1.0, seed: 0x5a17c3 },
];

/**
 * `stand`: five trees over two terrace steps, at the five intensities the brief
 * asks for — a fire mid-spread, where the newest cells are barely alight and the
 * oldest are going hard. This is the picture that answers "do fifty of these
 * read as a burning wood or as fifty identical decals".
 */
const STAND_SCENE: readonly BurningTree[] = [
  { x: -1.5, z: 1.5, groundY: 0, kind: 'conifer', scale: 1.12, yaw: 0.2, intensity: 1.0, seed: 0x11f2a9 },
  { x: 0.2, z: 1.9, groundY: 0, kind: 'broadleaf', scale: 0.95, yaw: 1.7, intensity: 0.8, seed: 0x27bd41 },
  { x: 1.7, z: 1.1, groundY: 0, kind: 'conifer', scale: 0.86, yaw: 2.6, intensity: 0.55, seed: 0x3e0177 },
  { x: -0.9, z: -1.2, groundY: TERRACE_BAND_HEIGHT, kind: 'broadleaf', scale: 1.05, yaw: 4.1, intensity: 0.35, seed: 0x4c98e5 },
  { x: 1.2, z: -1.6, groundY: TERRACE_BAND_HEIGHT, kind: 'conifer', scale: 1.2, yaw: 5.3, intensity: 1.0, seed: 0x6ad30b },
];

/** Where the `stand` scene's upper terrace begins; everything nearer is the lower step. */
const STAND_STEP_EDGE_Z = 0;

type SceneName = 'single' | 'stand';

/**
 * The intensity every fire in the scene is forced to, or null to use each
 * tree's own. Out-of-range and unparseable both mean "use the scene's own",
 * so a typo photographs the scene rather than silently a fire at intensity 0.
 */
function readIntensityOverride(params: URLSearchParams): number | null {
  const raw = params.get('i');
  if (raw === null) return null;
  const requested = Number.parseFloat(raw);
  if (!Number.isFinite(requested) || requested < 0 || requested > 1) return null;
  return requested;
}

/**
 * The burn length every fire in the scene runs on, or null for the frozen
 * intensities the harness has always used. Out-of-range and unparseable both
 * mean "stay frozen", so a typo photographs the scene rather than silently a
 * world where nothing is alight.
 */
function readBurnSeconds(params: URLSearchParams): number | null {
  const raw = params.get('burn');
  if (raw === null) return null;
  const requested = Number.parseFloat(raw);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  return requested;
}

/** Camera distance as a multiple of the fitted framing distance. */
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

/**
 * Builds the ground: one slab for `single`, two overlapping slabs a band apart
 * for `stand`. Boxes rather than planes so the terrace RISER is visible — the
 * step is half the point of the `stand` picture, since it is what tells the
 * owner whether a flame reads correctly against a vertical face behind it.
 */
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
    // Six materials so the top face can be grass and the risers earth-dark.
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

/** Points `camera` at a box, with headroom for the flame above the trees. */
function frameCameraOn(camera: PerspectiveCamera, box: Box3, distanceMultiplier: number): void {
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
}

function main(): void {
  const params = new URLSearchParams(window.location.search);
  const sceneName = readScene(params);
  const intensityOverride = readIntensityOverride(params);
  const previewSeconds = readTime(params);
  const burnSeconds = readBurnSeconds(params);
  const distanceMultiplier = readDistanceMultiplier(params);

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

  // The real trees, placed exactly as the flora plugin places them.
  const trees = sceneName === 'single' ? SINGLE_SCENE : STAND_SCENE;
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

  // …and one fire per tree, sized to the tree it is consuming. Allocated ONCE
  // and rewritten in place per step: the key is what a renderer remembers a fire
  // by (plugins/fire/client/flames/types.ts), and it must not change between two
  // steps of the same run or smoke would treat every frame as a fresh fire.
  const fires: FireInstance[] = trees.map((tree, index) => ({
    // The preview draws one fixed set of trees, so the index is a stable
    // identity for the whole run.
    key: index + 1,
    x: tree.x,
    z: tree.z,
    groundY: tree.groundY,
    fuelHeight: TREE_HEIGHT_AT_UNIT_SCALE * tree.scale,
    intensity: intensityOverride ?? tree.intensity,
    // The renderers drive phase from `seed`, not from age; age is passed
    // through honestly all the same so a look that used it would work.
    ageSeconds: 0,
    seed: tree.seed,
  }));

  /**
   * Who is ALIGHT at time `t`, and how fiercely.
   *
   * With no ?burn the answer never changes — every tree stays at its frozen
   * intensity forever, which is what this harness has always photographed. With
   * ?burn it is a real fire on the shipped curve: every tree ignited at t = 0,
   * and a tree whose age has passed `burn` is simply NOT IN THE LIST, exactly as
   * an extinguished fire is not in the plugin's (plugins/fire/client/index.ts).
   * That absence is the whole thing smoke is written against.
   */
  const live: FireInstance[] = [];
  function burningAt(t: number): readonly FireInstance[] {
    live.length = 0;
    for (const fire of fires) {
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
  document.title = `Fire preview — ${flames.name} — ${sceneName} — t=${previewSeconds}${intensityOverride === null ? '' : ` — i=${intensityOverride}`}${burnSeconds === null ? '' : ` — burn=${burnSeconds}`}${distanceMultiplier === 1 ? '' : ` — dist=${distanceMultiplier}`}`;
  scene.add(smoke.root);
  scene.add(flames.root);

  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
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

  // Frame on the trees (the flame's own root has no meaningful bounds until it
  // has been updated, and half the candidates disable frustum culling anyway).
  frameCameraOn(camera, new Box3().setFromObject(flora.root), distanceMultiplier);

  // Advance to exactly ?t in fixed steps, APPLYING AND UPDATING at every one.
  // The old loop applied a frozen set once and only stepped `update`; smoke
  // cannot be photographed that way, because what it draws depends on which
  // fires it was handed on each of the steps in between — a column's whole
  // lifetime is integrated out of that history, not read off the final frame.
  const steps = Math.round(previewSeconds / ANIMATION_STEP_SECONDS);
  for (let step = 0; step <= steps; step++) {
    const t = step * ANIMATION_STEP_SECONDS;
    const burning = burningAt(t);
    flames.apply(burning);
    flames.update(ANIMATION_STEP_SECONDS, t);
    smoke.apply(burning);
    smoke.update(ANIMATION_STEP_SECONDS, t);
  }

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) {
      requestAnimationFrame(renderFrame);
    } else {
      // Published alongside the ready flag because the flame's budget rule is a
      // FIXED SMALL DRAW-CALL COUNT (plugins/fire/client/flames/types.ts), and a
      // claim about draw calls that is not read off the renderer is a guess. A
      // screenshot driver reads this in the same evaluate that confirms
      // readiness, so every picture comes with its own cost.
      (
        window as unknown as { __previewDrawCalls: number; __previewSmokeColumns: number }
      ).__previewDrawCalls = renderer.info.render.calls;
      (
        window as unknown as { __previewDrawCalls: number; __previewSmokeColumns: number }
      ).__previewSmokeColumns = smoke.drawnCount;
      (window as unknown as { __previewReady: boolean }).__previewReady = true;
    }
  }
  requestAnimationFrame(renderFrame);

  window.addEventListener('pagehide', () => {
    flames.dispose();
    smoke.dispose();
    flora.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  });
}

main();
