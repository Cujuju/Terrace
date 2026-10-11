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

export const MUDSLIDES_DEV_FORCE_ENV = 'MUDSLIDES_DEV_FORCE';

export const MUDSLIDES_DEV_PERIOD_ENV = 'MUDSLIDES_DEV_FORCE_PERIOD_SECONDS';

export const MUDSLIDES_DEV_SLOW_ENV = 'MUDSLIDES_DEV_SLOW';

export { DEV_SEARCH_RADIUS_CELLS };

const DEV_RIM_SCAN_STEP_CELLS = 1;

const DEV_MIN_RUN_CELLS = 16;

const DEV_ANCHOR_RADIUS_CELLS = 48;

let forcedAnchor: { x: number; y: number } | null = null;

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

interface SiteScan {
  readonly best: { x: number; y: number } | null;
  readonly bestRun: number;
  readonly bestDrop: number;
  readonly steepestSeen: number;
  readonly longestSeen: number;
}

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
      if (!footprintUnlocked(world, x, y, MUDSLIDE_BRUSH_RADIUS_CELLS)) continue;
      if (slope.drop > steepestSeen) steepestSeen = slope.drop;
      const run = dryRunLength(world, x, y);
      if (run > longestSeen) longestSeen = run;
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
  const anchored = forcedAnchor !== null;
  const centre = anchored ? forcedAnchor! : { x: Math.floor(world.worldSize / 2), y: Math.floor(world.worldSize / 2) };
  const reach = anchored ? DEV_ANCHOR_RADIUS_CELLS : DEV_SEARCH_RADIUS_CELLS;
  const { best, bestRun, bestDrop, steepestSeen, longestSeen } = scanForSite(world, centre, reach);

  if (best === null && anchored) {
    forcedAnchor = null;
    return findSteepestSite(world);
  }

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

export function forceSlideFromEnv(
  world: MudslideWorld,
  env: Record<string, string | undefined>,
): Slide | null {
  const value = env[MUDSLIDES_DEV_FORCE_ENV]?.trim().toLowerCase();
  if (value !== 'slide' && value !== '1') {
    periodSeconds = 0;
    setDevSlowFactor(1);
    return null;
  }

  setDevFrozen(true);

  setDevSlowFactor(Number(env[MUDSLIDES_DEV_SLOW_ENV]));

  const period = Number(env[MUDSLIDES_DEV_PERIOD_ENV]);
  periodSeconds = Number.isFinite(period) && period > 0 ? period : 0;
  sincePeriodSeconds = 0;

  return forceOne(world);
}

let periodSeconds = 0;
let sincePeriodSeconds = 0;

export function tickDevForce(world: MudslideWorld, dt: number): void {
  if (periodSeconds <= 0) return;
  sincePeriodSeconds += dt;
  if (sincePeriodSeconds < periodSeconds) return;
  sincePeriodSeconds = 0;
  forceOne(world);
}

export function resetDevForce(): void {
  periodSeconds = 0;
  sincePeriodSeconds = 0;
  forcedAnchor = null;
  lastForced = null;
}

let lastForced: Slide | null = null;

function forceOne(world: MudslideWorld): Slide | null {
  if (lastForced !== null && !movedGround(lastForced)) forcedAnchor = null;
  lastForced = null;

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
