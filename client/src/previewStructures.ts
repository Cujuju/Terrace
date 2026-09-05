// previewStructures.ts — THROWAWAY preview harness for the structures
// plugin. Not part of the shipped app: reached only through preview.html (a
// separate Vite entry point next to index.html, unlinked from it), and not
// registered in plugins/registry.ts. Exists solely so every tier's model —
// and the Durand's variant — can be screenshotted in isolation against a
// neutral backdrop, one per page load, driven by this page's own query
// string:
//
//   ?tier=<0..STRUCTURE_TIER_COUNT-1>   — that tier's standard model
//   ?durands=1                          — the Durand's variant (forces the
//                                         top tier regardless of ?tier)
//   ?hut=<0..9>                         — one of the ten COASTAL fishing-hut
//                                         models (fishingHuts.ts), forcing the
//                                         top tier and a coastal site; the
//                                         cell is searched for one whose own
//                                         variant roll lands on the index, so
//                                         what is captured is the real roll's
//                                         output and not a model handed
//                                         straight to the renderer
//   ?flash=on|off                       — durands=1 only: freezes the sign's
//                                         flash at its brightest ("on") or
//                                         dimmest ("off") point, so a driver
//                                         can capture both halves of the
//                                         flash without waiting on real time
//   ?beside=<0..STRUCTURE_TIER_COUNT-1> — a SECOND tier standing next to the
//                                         first, at the same scale on the same
//                                         ground, so the size relation between
//                                         two tiers is visible in one shot —
//                                         the only way to judge whether an
//                                         IMPORTED model (models.ts's
//                                         IMPORTED_STRUCTURE_TIER) sits right
//                                         among the procedural ones
//   ?view=front|rear|left|right|top     — which 3/4 angle the camera takes
//                                         (default front, the original view);
//                                         rear/left/right exist so a driver
//                                         can inspect every face for missing
//                                         sections, not just the show side,
//                                         and top looks straight down, which
//                                         is the only view that shows how much
//                                         of its cell a model covers
//   ?bulbphase=a|b                      — durands=1 only, overrides ?flash:
//                                         freezes the marquee bulb chase at
//                                         phase A brightest/phase B dimmest
//                                         ("a") or the reverse ("b"), with
//                                         the SIGN left at the same
//                                         brightness in both, so a driver
//                                         capturing durands-phase-a.png and
//                                         durands-phase-b.png sees only the
//                                         bulbs swap
//
// The lighting rig (hemisphere + directional + ambient, ACES tone mapping)
// is copied from render/scene.ts's own recipe — "nicely lit" here means "lit
// the way the real game lights it", not a bespoke studio setup. Only the
// background and the addition of a small ground disc (so a building does not
// look like it is floating with no reference plane) are preview-specific.
//
// A screenshot driver navigates here once per combination above and waits
// for `window.__previewReady === true` before capturing the canvas — set at
// the bottom of this file, only after the frame the building was actually
// drawn into has been presented.

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Group,
} from 'three';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURE_TIER_COUNT,
  settlementRace,
  type SettlerRace,
} from '../../plugins/structures/protocol.ts';
import timberHouseUrl from '../../plugins/structures/client/assets/timber-house.glb?url';
import {
  createStructureModels,
  preloadStructureModels,
  DURANDS_MARQUEE_BULB_PERIOD_SECONDS,
  DURANDS_SIGN_FLASH_PERIOD_SECONDS,
  type StructurePlacement,
} from '../../plugins/structures/client/models.ts';
import { FISHING_HUT_BUILDERS, fishingHutVariantIndex } from '../../plugins/structures/client/fishingHuts.ts';
import { isDurandsCell } from '../../plugins/structures/client/durands.ts';

// ── Lighting rig, copied from render/scene.ts (see that file for the tuning
// history behind each number — this preview borrows the values, not just the
// shape, so a screenshot here means what it would mean in the real scene). ──
const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;

// ── Preview-only presentation ────────────────────────────────────────────
/** Neutral mid-grey backdrop — no sky, no terrain, just the model. */
const BACKDROP_COLOR = 0x808080;
/** A slightly darker neutral disc under the model, purely as a ground reference. */
const GROUND_COLOR = 0x6c6c6c;
const GROUND_RADIUS = 3;
/**
 * How much headroom the camera leaves around the model's bounding sphere.
 * 1.25 reads as "framed close" (the brief's own words) while still leaving a
 * hair of margin so the model's silhouette does not clip the frame edge.
 */
const CAMERA_FRAMING_PADDING = 1.25;
/** Frames rendered before the screenshot flag is raised — lets the WebGL
 * context's first-frame setup cost (shader compiles, texture upload) land
 * before the driver captures, rather than possibly catching a partial frame. */
const SETTLE_FRAME_COUNT = 3;

function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/**
 * Finds the lowest-coordinate cell whose top-tier roll matches `wantDurands`,
 * scanning row-major from (0, 0). isDurandsCell's own share (~1 in 6, see
 * ./durands.ts) means both directions of this search terminate almost
 * immediately; the small upper bound is only a defensive backstop against an
 * unexpected all-one-way region, not a tuned budget — see the thrown error.
 *
 * Needed for BOTH directions, not just the Durand's one: a plain `?tier=5`
 * request must land on a cell that does NOT roll Durand's, or the standard
 * watchtower screenshot would silently come back as the Durand's skin
 * instead — cell (0, 0) itself happens to roll Durand's, which is exactly
 * the bug a hardcoded (0, 0) here would have shipped.
 */
function findTopTierCell(wantDurands: boolean): { x: number; y: number } {
  const SCAN_EDGE = 64;
  for (let y = 0; y < SCAN_EDGE; y++) {
    for (let x = 0; x < SCAN_EDGE; x++) {
      if (isDurandsCell(MAX_STRUCTURE_TIER, x, y) === wantDurands) return { x, y };
    }
  }
  throw new Error(
    `preview: found no ${wantDurands ? '' : 'non-'}Durand's cell in the first ${SCAN_EDGE}x${SCAN_EDGE} cells`,
  );
}

/**
 * A cell whose coastal variant roll lands on `variant` — the same search
 * findTopTierCell does, and for the same reason: the preview must exercise
 * the ROLL, not bypass it, or it would happily screenshot a model the game
 * can never actually produce on any cell.
 */
function findCoastalCell(variant: number): { x: number; y: number } {
  const SCAN_EDGE = 64;
  for (let y = 0; y < SCAN_EDGE; y++) {
    for (let x = 0; x < SCAN_EDGE; x++) {
      if (fishingHutVariantIndex(x, y) === variant) return { x, y };
    }
  }
  throw new Error(`preview: no cell in the first ${SCAN_EDGE}x${SCAN_EDGE} rolls fishing hut ${variant}`);
}

function buildScene(): { scene: Scene; camera: PerspectiveCamera; renderer: WebGLRenderer } {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;

  const scene = new Scene();
  scene.background = new Color(BACKDROP_COLOR);

  const ground = new Mesh(
    new CircleGeometry(GROUND_RADIUS, 32),
    new MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
  scene.add(sun);

  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.05, 100);

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  renderer.outputColorSpace = SRGBColorSpace;

  return { scene, camera, renderer };
}

/**
 * Camera directions per `?view=` value. `front` is the original hand-tuned
 * 3/4 view; the others are its mirrors so a driver can walk all four sides
 * of a building — the rear/side faces are exactly where "missing sections"
 * hide from a single fixed angle.
 */
const VIEW_DIRECTIONS: Readonly<Record<string, Vector3>> = {
  front: new Vector3(0.6, 0.45, 0.85),
  rear: new Vector3(-0.6, 0.45, -0.85),
  left: new Vector3(-0.85, 0.45, 0.6),
  right: new Vector3(0.85, 0.45, -0.6),
  // Straight down, barely off-axis so `lookAt` still has a defined up vector.
  // The FOOTPRINT view: it is the only one that shows how much of its cell a
  // model actually covers, which is the property an imported building has to
  // be judged on (the footprint contract, models.ts's STRUCTURE_FOOTPRINT_RADIUS).
  top: new Vector3(0.01, 1, 0.01),
};

/** Points `camera` at `object`'s bounding sphere, close enough to fill the frame with `CAMERA_FRAMING_PADDING` of headroom. */
function frameCameraOn(camera: PerspectiveCamera, object: { root: Group }, view: string): void {
  const box = new Box3().setFromObject(object.root);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance = (radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2);

  const direction = (VIEW_DIRECTIONS[view] ?? VIEW_DIRECTIONS.front).clone().normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

/**
 * How far apart two buildings stand in a `?beside=` shot, in world units.
 *
 * One and a bit footprint spans (STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS is 1):
 * far enough that neither model's silhouette touches the other, close enough
 * that both fill the frame the camera fits around the pair.
 */
const BESIDE_SPACING_WORLD_UNITS = 1.2;

async function main(): Promise<void> {
  const query = readQuery();
  const durandsRequested = query.get('durands') === '1';
  const hutParam = query.get('hut');
  const hutRequested = hutParam !== null && Number.isInteger(Number(hutParam));
  const hutVariant = hutRequested
    ? Math.min(Math.max(Number(hutParam), 0), FISHING_HUT_BUILDERS.length - 1)
    : -1;
  const flashOn = query.get('flash') !== 'off';
  const bulbPhaseParam = query.get('bulbphase');
  const requestedTier = Number(query.get('tier') ?? '0');
  const tier = durandsRequested || hutRequested
    ? MAX_STRUCTURE_TIER
    : Math.min(Math.max(requestedTier, 0), STRUCTURE_TIER_COUNT - 1);

  const { scene, camera, renderer } = buildScene();

  // The asset BEFORE the models, exactly as the plugin's preload/attach pair
  // runs it: createStructureModels draws the imported tier from the installed
  // asset and falls back to primitives when there is none, so a preview that
  // skipped this would quietly screenshot the superseded model.
  await preloadStructureModels(timberHouseUrl);
  const models = createStructureModels();
  scene.add(models.root);

  // Below the top tier, isDurandsCell is false for every cell by contract
  // (see ./durands.ts), so (0, 0) is fine there; AT the top tier, (0, 0)
  // itself happens to roll Durand's, which is why the plain-model case also
  // has to search rather than hardcode a cell — see findTopTierCell's own
  // comment.
  const cell = hutRequested
    ? findCoastalCell(hutVariant)
    : tier === MAX_STRUCTURE_TIER
      ? findTopTierCell(durandsRequested)
      : { x: 0, y: 0 };
  // `?race=rudy|uno` pins the tint for side-by-side review shots; absent, the
  // preview derives it from the cell exactly as the game client does.
  const raceParam = query.get('race');
  const race: SettlerRace =
    raceParam === 'rudy' || raceParam === 'uno' ? raceParam : settlementRace(cell.x, cell.y);
  const placement: StructurePlacement = {
    x: cell.x,
    z: cell.y,
    // The cell drives every cosmetic roll (Durand's skin, the fishing-hut
    // variant); x/z above are a world position this preview happens to set
    // from the same numbers. Keeping them separate is what lets the searches
    // above mean anything — see models.ts's StructurePlacement.cellX.
    cellX: cell.x,
    cellY: cell.y,
    groundY: 0,
    tier,
    scale: 1,
    yaw: 0,
    race,
    // This preview has no terrain at all (a neutral backdrop, see the file
    // banner), so there is no water for site.ts to survey — the site is
    // ASSERTED here rather than derived, which is exactly what makes ?hut=
    // able to show a coastal model at all.
    site: hutRequested ? 'coastal' : 'inland',
  };
  // `?beside=<tier>`: a second building of another tier, one spacing along +X,
  // sharing this one's race, scale and yaw so the ONLY difference in the shot
  // is the model itself. Its cell goes through findTopTierCell exactly as the
  // main placement does, for that function's own reason: (0, 0) rolls
  // Durand's, so a hardcoded cell would show the saloon whenever the beside
  // tier is the top one — and this comparison is about SIZE, not skins.
  const besideParam = query.get('beside');
  const placements: StructurePlacement[] = [placement];
  if (besideParam !== null && Number.isInteger(Number(besideParam))) {
    const besideTier = Math.min(Math.max(Number(besideParam), 0), STRUCTURE_TIER_COUNT - 1);
    const besideCell = besideTier === MAX_STRUCTURE_TIER ? findTopTierCell(false) : { x: 0, y: 0 };
    placements.push({
      ...placement,
      x: placement.x + BESIDE_SPACING_WORLD_UNITS,
      cellX: besideCell.x,
      cellY: besideCell.y,
      tier: besideTier,
    });
  }
  models.apply(placements);

  if (durandsRequested) {
    // A single animate() call sets the flash clock to exactly `dt` seconds
    // since attach (models.ts's elapsed accumulator starts at 0) — a quarter
    // period lands a sine wave at its peak, three quarters at its trough. See
    // models.ts's animate() for the same formula both branches below mirror.
    let dt: number;
    if (bulbPhaseParam === 'a' || bulbPhaseParam === 'b') {
      // The marquee bulb period is half the sign's own (see
      // DURANDS_MARQUEE_BULB_PERIOD_SECONDS's comment in models.ts), so a
      // quarter of IT lands phase A at its peak (and phase B, exactly π out
      // of phase, at its trough); a further half-period on top swaps which
      // phase is which without moving the sign — sin(x) and sin(x + π) at
      // t = quarter + half both sit at the SAME sign angle they started at
      // (the sign's own period being twice as long), so both captures show
      // an identically-lit sign and only the bulbs swap.
      const marqueeQuarterPeriod = DURANDS_MARQUEE_BULB_PERIOD_SECONDS / 4;
      dt =
        bulbPhaseParam === 'a'
          ? marqueeQuarterPeriod
          : marqueeQuarterPeriod + DURANDS_MARQUEE_BULB_PERIOD_SECONDS / 2;
    } else {
      const quarterPeriod = DURANDS_SIGN_FLASH_PERIOD_SECONDS / 4;
      dt = flashOn ? quarterPeriod : quarterPeriod * 3;
    }
    models.animate(dt);
  }

  frameCameraOn(camera, models, query.get('view') ?? 'front');

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) {
      requestAnimationFrame(renderFrame);
    } else {
      // Signals the screenshot driver: the building is drawn, the frame is
      // presented, it is safe to capture the canvas now. The stats ride with
      // it because client/scripts/shootSpeciesPreview.mjs polls
      // `__previewReady === true ? __previewStats : null` and would wait for
      // ever on a harness that raises the flag alone — and because a draw-call
      // count read off the renderer is worth more than one asserted.
      (window as unknown as { __previewStats: unknown }).__previewStats = {
        tiers: placements.map((placed) => placed.tier),
        race,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      };
      (window as unknown as { __previewReady: boolean }).__previewReady = true;
    }
  }
  requestAnimationFrame(renderFrame);
}

void main();
