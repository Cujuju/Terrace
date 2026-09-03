// THE DEV FORCE-SPAWN — an environment variable that collapses a hillside near
// the middle of the world at boot, so a developer can look at one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT EXISTS, and why it is an ENV VAR rather than a setting.
//
// A slide needs steep ground, ninety seconds of rain ON that ground, and then a
// Poisson arrival whose mean is minutes. Verifying the renderer meant waiting out
// three independent random processes, which is not verification, it is luck. This
// makes the wait zero.
//
// It is NOT a PluginSettingDeclaration, deliberately, and the distinction is the
// one WorldApi.setting's doc comment draws: a setting is a choice an OPERATOR
// makes about how their world plays, offered in the world panel and persisted
// with the world. This is not a way to play — it is a way to develop, it bypasses
// both triggers the plugin exists to enforce, and putting it in the panel would
// invite somebody to turn it on for a world they care about.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO USE IT.
//
//   MUDSLIDES_DEV_FORCE=slide            collapse the steepest hillside near the
//                                        centre, once, at boot
//   MUDSLIDES_DEV_FORCE_PERIOD_SECONDS=n and then again every n seconds
//   MUDSLIDES_DEV_SLOW=k                 and run each one k times slower, so a
//                                        capture can land mid-flow
//
// THE PERIOD IS WHAT MAKES A SLIDE PHOTOGRAPHABLE IN THIS ENVIRONMENT. A run
// lasts about six seconds; a headless WebGL client in WSL2 takes longer than
// that to produce its FIRST frame (see the project's screenshot recipe), so a
// one-shot force is always already over by the time anything can look at it.
// Re-forcing on a period means a capture taken at an arbitrary moment has a
// decent chance of landing mid-flow, and repeating the capture makes it a
// certainty. The head flattens as it is re-collapsed, so the forced site
// eventually stops qualifying and says so — which is the sim working, not a
// failure of the aid.
//
// The site is searched OUTWARD FROM THE MIDDLE OF THE WORLD, which is where a
// fresh world's revealed square is (server/src/world/initial-unlock.ts). That is
// not cosmetic: this plugin refuses to sculpt unrevealed ground at all, so a
// forced slide sited outside that square would simply not happen and the
// developer would conclude the sim was broken.
//
// MEASURED, 2026-08-28: AT `onWorldCreate` THE UNLOCK MASK IS NOT YET APPLIED —
// `isCellUnlocked` answers false everywhere, so the boot-time force can only ever
// find a two-cell run and collapses something marginal. That is a fact about core's
// boot order, not a bug in this plugin (the same guard is what keeps a real slide
// out of the fog), and the PERIOD is what works around it: the first re-force,
// seconds later, sees the real mask and finds a real hillside.
//
// Unset — which is every real deployment — this module does nothing at all.

import { DEV_SEARCH_RADIUS_CELLS } from '../../../server/src/plugins/kit/devSite.ts';
import { MUDSLIDE_MAX_PATH_CELLS } from '../protocol.ts';
import {
  MUDSLIDE_BRUSH_RADIUS_CELLS,
  movedGround,
  setDevFrozen,
  setDevSlowFactor,
  startSlide,
  type Slide,
} from './slides.ts';
import {
  cellKey,
  footprintUnlocked,
  nextFlowCell,
  slopeAt,
  type MudslideWorld,
} from './terrain.ts';

/** The variable, and the value it accepts. */
export const MUDSLIDES_DEV_FORCE_ENV = 'MUDSLIDES_DEV_FORCE';

/** Seconds between re-forced slides; unset or non-positive means "once". */
export const MUDSLIDES_DEV_PERIOD_ENV = 'MUDSLIDES_DEV_FORCE_PERIOD_SECONDS';

/**
 * Divides the speed of a running slide, so it can be photographed mid-flow.
 * See `setDevSlowFactor` in ./slides.ts for what it does and why it is the
 * slide's dt rather than the server's tick.
 */
export const MUDSLIDES_DEV_SLOW_ENV = 'MUDSLIDES_DEV_SLOW';

// The reach — how far out a forced site may be looked for — is the plugin kit's
// (server/src/plugins/kit/devSite.ts), because the rotating-storm plugins'
// force-spawn wanted exactly the same number for exactly the same reason. THE
// SCAN ITSELF STAYED HERE, and `scanForSite` below says why it is a grid scan
// and not the kit's ring of spokes.
//
// THE KIT'S STEP NO LONGER APPLIES TO THIS SCAN (issue #301, 2026-09-02) — see
// DEV_RIM_SCAN_STEP_CELLS below. It is still the right coarseness for the kit's
// own ring search, which is looking for a REGION (open water, land) where this
// one is looking for a one-cell feature.
export { DEV_SEARCH_RADIUS_CELLS };

/**
 * Cells between samples of the site scan.
 *
 * ONE — a full-resolution scan, where every other force-spawn search in the repo
 * steps by the kit's DEV_SEARCH_STEP_CELLS (4). A site is now a RIM (issue #301:
 * `slopeAt` admits only a cell whose own one-cell step down is at least
 * MUDSLIDE_RIM_DROP), and on genesis ground a rim is a contour line ONE CELL
 * WIDE: measured on a default-size world, of the 2338 qualifying cells inside
 * one search square only 7% sit on the 4-cell grid, and a rim that weaves
 * between the samples is missed entirely — which is the whole failure this
 * fixture exists to make visible. The kit's coarse step was right when a site
 * was a span-scale measurement that a 4-cell grid could not step over.
 *
 * WHAT IT COSTS: one `slopeAt` per cell of a (2·DEV_SEARCH_RADIUS_CELLS + 1)²
 * square — sixteen height reads, on a fixture world, once at boot and once per
 * forced period. The expensive part of a candidate, `dryRunLength`, still runs
 * only on cells that pass the site test, which the rim test made rarer.
 */
const DEV_RIM_SCAN_STEP_CELLS = 1;

/**
 * The shortest run worth forcing, in cells.
 *
 * SIXTEEN — four world units, the same length chronicle demands before it will
 * write a slide into the saga (CHRONICLE_MUDSLIDE_MIN_CELLS). Below it the
 * capture shows a dimple, and the developer learns nothing about the flow.
 */
const DEV_MIN_RUN_CELLS = 16;

/**
 * How far from the first forced site later ones are looked for, in cells.
 *
 * 48 — twelve world units, comfortably inside one camera framing of a hillside.
 * See `findSteepestSite` for why later forces are anchored at all.
 */
const DEV_ANCHOR_RADIUS_CELLS = 48;

/** The first site this world forced; later forces stay near it. */
let forcedAnchor: { x: number; y: number } | null = null;

/**
 * How far a front WOULD run from here, in cells, without moving any ground.
 *
 * A DRY RUN OF ./terrain.ts's OWN descent, not a second copy of it: the aid
 * walks the same `nextFlowCell` the sim walks, so a site it picks is a site the
 * sim can actually run, by construction. Read-only — nothing is sculpted, so the
 * heights it walks over are the heights the real run will start from.
 */
function dryRunLength(world: MudslideWorld, x: number, y: number): number {
  const visited = new Set<number>([cellKey(x, y)]);
  let cx = x;
  let cy = y;
  for (let step = 1; step < MUDSLIDE_MAX_PATH_CELLS; step++) {
    const next = nextFlowCell(world, cx, cy, visited);
    if (typeof next === 'string') return step;
    cx = next.x;
    cy = next.y;
    visited.add(cellKey(cx, cy));
  }
  return MUDSLIDE_MAX_PATH_CELLS;
}

/**
 * The best site within the search radius, or null.
 *
 * SCORED BY HOW FAR THE MUD WOULD ACTUALLY RUN, not by how steep the ground is,
 * and the first version of this function got that wrong: it picked the steepest
 * cell it could find, which on a genesis world is a sea cliff — a hillside whose
 * very first downhill step is water, so `startSlide` refused it and the fixture
 * produced nothing. Steepness is the tie-break, not the score.
 *
 * A GRID SCAN, NOT A RING SEARCH, which is the second thing this function got
 * wrong. Storms' ring search is right for a cyclone, because any patch of open
 * water will do and the nearest one is the best one. Qualifying hillsides are
 * rare enough that a ring's few hundred samples missed every one of them on a
 * 512-cell test world; the scan looks at every cell of the revealed square
 * instead (DEV_RIM_SCAN_STEP_CELLS). It runs once, at boot, on a fixture world.
 *
 * ONE DEFINITION OF "STEEP", NOT TWO (issue #301, 2026-09-02). The scan's whole
 * site test is `slopeAt` — the survey's own — so the fixture cannot prefer a
 * cell the sim would never pick. It used to: scoring by run length let a cell
 * set back on a plateau's tread beat the rim in front of it, because the tread's
 * dry run is the rim's plus the length of the tread. That preference is gone
 * with the cells it preferred, since `slopeAt` no longer admits tread at all,
 * and longest-run scoring now chooses BETWEEN RIMS, which is what it was for.
 */
/** What `scanForSite` found: the best site, and the numbers to report if none. */
interface SiteScan {
  readonly best: { x: number; y: number } | null;
  readonly bestRun: number;
  readonly bestDrop: number;
  /** Kept for the diagnostic: "no site" and "no steep ground at all" are
   *  different failures and a developer needs to be told which happened. */
  readonly steepestSeen: number;
  readonly longestSeen: number;
}

/**
 * The grid scan itself, around any centre: the boot-time force scans the
 * revealed square's middle (or its anchor), the admin panel's action scans
 * around where the operator is looking (`forceSlideNear`). One scan, two
 * callers, so the siting rules — footprint revealed, longest run wins,
 * steepest breaks the tie — cannot drift apart.
 */
function scanForSite(world: MudslideWorld, centre: { x: number; y: number }, reach: number): SiteScan {
  let best: { x: number; y: number } | null = null;
  let bestRun = 0;
  let bestDrop = 0;
  let steepestSeen = 0;
  let longestSeen = 0;

  for (let dy = -reach; dy <= reach; dy += DEV_RIM_SCAN_STEP_CELLS) {
    for (let dx = -reach; dx <= reach; dx += DEV_RIM_SCAN_STEP_CELLS) {
      const x = centre.x + dx;
      const y = centre.y + dy;
      const slope = slopeAt(world, x, y);
      if (slope === null) continue;
      // A site whose brush footprint reaches into fog can never slide
      // (`startSlide` refuses it), so the search must not spend its answer on
      // one — it did, repeatedly, on a world whose best slopes sat on the edge
      // of the revealed square.
      if (!footprintUnlocked(world, x, y, MUDSLIDE_BRUSH_RADIUS_CELLS)) continue;
      if (slope.drop > steepestSeen) steepestSeen = slope.drop;
      const run = dryRunLength(world, x, y);
      if (run > longestSeen) longestSeen = run;
      // NO HARD FLOOR, ONLY A PREFERENCE. A hard `run < DEV_MIN_RUN_CELLS`
      // reject was the third thing this search got wrong: after four or five
      // forced slides a small world genuinely has no 16-cell run left, and the
      // aid then produced NOTHING at all rather than the best hillside still
      // standing. Longest run wins, steepest breaks the tie; the floor survives
      // only as the threshold the diagnostic below reports against.
      if (run < 2) continue;
      if (run < bestRun || (run === bestRun && slope.drop <= bestDrop)) continue;
      bestRun = run;
      bestDrop = slope.drop;
      best = { x, y };
    }
  }
  return { best, bestRun, bestDrop, steepestSeen, longestSeen };
}

function findSteepestSite(world: MudslideWorld): { x: number; y: number } | null {
  // ANCHORED TO THE FIRST SITE THIS WORLD FOUND, once it has found one. Without
  // it a periodic force wanders the whole revealed square — every re-force picks
  // the best remaining hillside, which is somewhere else — and a camera pointed
  // at the last one photographs nothing. Anchoring keeps the whole sequence in
  // one frame, which is the entire point of the period. The anchor is dropped
  // when its neighbourhood has nothing left to collapse.
  const anchored = forcedAnchor !== null;
  const centre = anchored ? forcedAnchor! : { x: Math.floor(world.worldSize / 2), y: Math.floor(world.worldSize / 2) };
  const reach = anchored ? DEV_ANCHOR_RADIUS_CELLS : DEV_SEARCH_RADIUS_CELLS;
  const { best, bestRun, bestDrop, steepestSeen, longestSeen } = scanForSite(world, centre, reach);

  if (best === null && anchored) {
    // The anchored neighbourhood is spent. Drop the anchor and look at the whole
    // square again rather than reporting a failure the developer cannot act on.
    forcedAnchor = null;
    return findSteepestSite(world);
  }

  // Only a GOOD site becomes the anchor. The boot-time force runs before core
  // has applied the world's unlock mask, so every run it measures stops after a
  // cell or two ('locked'); anchoring on that would pin every later force to a
  // hillside that was never the best one.
  if (best !== null && forcedAnchor === null && bestRun >= DEV_MIN_RUN_CELLS) {
    forcedAnchor = best;
  }

  if (best === null) {
    console.warn(
      `[mudslides] ${MUDSLIDES_DEV_FORCE_ENV}: no hillside with anywhere to run; ` +
        `steepest qualifying slope seen was ${steepestSeen} height units, ` +
        `longest run ${longestSeen} cells`,
    );
  } else {
    if (bestRun < DEV_MIN_RUN_CELLS) {
      console.warn(
        `[mudslides] ${MUDSLIDES_DEV_FORCE_ENV}: best run is only ${bestRun} ` +
          `cells (wanted ${DEV_MIN_RUN_CELLS}+) — this world has been slid out`,
      );
    }
    console.info(
      `[mudslides] ${MUDSLIDES_DEV_FORCE_ENV}: site (${best.x}, ${best.y}) ` +
        `drop ${bestDrop}, run ${bestRun} cells`,
    );
  }
  return best;
}

/**
 * Collapses a hillside if `MUDSLIDES_DEV_FORCE` asked for one. Call once, from
 * onWorldCreate, after the settings have been read and the slice has loaded.
 *
 * `env` is passed in rather than read from `process.env` here, for the reason
 * server/src/config.ts gives for the same choice: it keeps the one place that
 * touches the process environment visible from the caller.
 */
export function forceSlideFromEnv(
  world: MudslideWorld,
  env: Record<string, string | undefined>,
): Slide | null {
  const value = env[MUDSLIDES_DEV_FORCE_ENV]?.trim().toLowerCase();
  // Anything else — unset, empty, a typo — forces nothing. A typo here costs a
  // developer one puzzled boot; refusing to start over it would cost every real
  // deployment a way to fail.
  if (value !== 'slide' && value !== '1') {
    periodSeconds = 0;
    setDevSlowFactor(1);
    return null;
  }

  // FROZEN, for the whole life of this world: a fixture whose ORDINARY trigger
  // keeps firing while the forced slide is being photographed is not a fixture.
  setDevFrozen(true);

  setDevSlowFactor(Number(env[MUDSLIDES_DEV_SLOW_ENV]));

  const period = Number(env[MUDSLIDES_DEV_PERIOD_ENV]);
  periodSeconds = Number.isFinite(period) && period > 0 ? period : 0;
  sincePeriodSeconds = 0;

  return forceOne(world);
}

/** Seconds between re-forced slides; 0 when this world was not forced, or once-only. */
let periodSeconds = 0;
let sincePeriodSeconds = 0;

/**
 * Re-forces on the period, if one was asked for. Call from onTick; a no-op on
 * every world that did not set both variables, which is all of them.
 */
export function tickDevForce(world: MudslideWorld, dt: number): void {
  if (periodSeconds <= 0) return;
  sincePeriodSeconds += dt;
  if (sincePeriodSeconds < periodSeconds) return;
  sincePeriodSeconds = 0;
  forceOne(world);
}

/** Forgets the period. Called when the world closes. */
export function resetDevForce(): void {
  periodSeconds = 0;
  sincePeriodSeconds = 0;
  forcedAnchor = null;
  lastForced = null;
}

/** The slide the last force produced, so the next one can see how it went. */
let lastForced: Slide | null = null;

function forceOne(world: MudslideWorld): Slide | null {
  // THE ANCHOR IS DROPPED WHEN ITS HILLSIDE IS SPENT. A forced slide that moved
  // no ground means the neighbourhood has already given up everything it had —
  // measured in-world, where an anchored fixture produced six real slides and
  // then fifty-two silent no-ops on the same flattened hillside. Looking at the
  // outcome of the PREVIOUS force is what makes this observable without the aid
  // having to wait for a slide to finish.
  if (lastForced !== null && !movedGround(lastForced)) forcedAnchor = null;
  lastForced = null;

  // `findSteepestSite` reports its own failure, with the numbers that say WHICH
  // failure it was (no steep ground at all, or steep ground with nowhere to run).
  const site = findSteepestSite(world);
  if (site === null) return null;

  const slide = startSlide(world, site.x, site.y);
  if (slide === null) {
    console.warn(
      `[mudslides] ${MUDSLIDES_DEV_FORCE_ENV}: (${site.x}, ${site.y}) is steep but ` +
        'has nowhere downhill to go',
    );
    return null;
  }
  console.info(
    `[mudslides] ${MUDSLIDES_DEV_FORCE_ENV}: forced slide ${slide.id} at ` +
      `(${site.x}, ${site.y})`,
  );
  lastForced = slide;
  return slide;
}

/**
 * THE ADMIN PANEL'S SLIDE (2026-09-01): collapses the best hillside within
 * DEV_ANCHOR_RADIUS_CELLS of `centre` — the cell the operator is looking at —
 * and says what it did in one line.
 *
 * NOT `forceSlideFromEnv`, and the difference is everything the env var does
 * BESIDES sliding: it freezes the ordinary trigger, slows the sim and anchors
 * a period, because it is building a photographic fixture. This is a person
 * asking for one slide, now, in a world that goes on being a world.
 */
export function forceSlideNear(
  world: MudslideWorld,
  centre: { x: number; y: number },
): { readonly slide: Slide | null; readonly detail: string } {
  const { best, bestRun, bestDrop, steepestSeen, longestSeen } = scanForSite(
    world,
    centre,
    DEV_ANCHOR_RADIUS_CELLS,
  );
  if (best === null) {
    return {
      slide: null,
      detail:
        `no hillside with anywhere to run within ${DEV_ANCHOR_RADIUS_CELLS} cells of ` +
        `(${centre.x}, ${centre.y}); steepest slope seen ${steepestSeen}, longest run ${longestSeen} cells`,
    };
  }
  const slide = startSlide(world, best.x, best.y);
  if (slide === null) {
    return { slide: null, detail: `(${best.x}, ${best.y}) is steep but has nowhere downhill to go` };
  }
  return {
    slide,
    detail: `slide ${slide.id} started at (${best.x}, ${best.y}): drop ${bestDrop}, run ${bestRun} cells`,
  };
}
