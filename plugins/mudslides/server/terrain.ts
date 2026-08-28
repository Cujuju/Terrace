// Everything this plugin asks the GROUND, and the one guard that keeps it out
// of territory nobody has revealed.
//
// A NARROW WORLD INTERFACE (`MudslideWorld`) rather than WorldApi, for the
// reason volcanoes/server/flow.ts and storms/server/storms.ts both give: the
// members named here are the whole of this plugin's dependency on core, so the
// seam is auditable, and a harness can drive the sim with an object literal.
// WorldApi satisfies it structurally — there is no adapter and no cast.

import { CHUNK_SIZE, SEA_LEVEL, type CellDiff, type FreshwaterMap } from '@terrace/shared';
import {
  MUDSLIDE_SLOPE_SPAN_CELLS,
  MUDSLIDE_TRIGGER_DROP,
  type MudslideStop,
} from '../protocol.ts';

/** The slice of WorldApi this plugin uses. Structurally satisfied by WorldApi. */
export interface MudslideWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  readonly freshwater: FreshwaterMap;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
  isChunkUnlocked(cx: number, cy: number): boolean;
  sculpt(x: number, y: number, radius: number, amount: number): CellDiff[];
}

/** The eight neighbours, in a FIXED order — reproducibility, and tests. */
const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export function inBounds(world: MudslideWorld, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < world.worldSize && y < world.worldSize;
}

/** A stable integer key for a cell, for the visited sets and the debris map. */
export function cellKey(x: number, y: number): number {
  // The world is at most DEFAULT_WORLD_SIZE (2048) cells on an edge today and
  // the shift is sized for a world sixteen times that; both coordinates are
  // non-negative by every caller's bounds check, so this stays a safe integer.
  return x * 0x10000 + y;
}

/**
 * THE ONE GUARD THAT KEEPS THIS PLUGIN OUT OF LOCKED TERRITORY, and the answer
 * to issue #212's open question about `reveal` masks.
 *
 * WHY IT HAS TO EXIST AT ALL. `WorldApi.sculpt` writes heights whatever the
 * mask says — the mask is applied to the BROADCAST, not to the write (see
 * server/src/world/sculpt-service.ts). That is right for a player intent, whose
 * brush core has already validated, and wrong for a plugin that picked its own
 * coordinates: a slide that ran into fog would silently regrade ground the world
 * has not revealed, and a player unlocking that chunk later would be handed a
 * scar with no history.
 *
 * SO THE FOOTPRINT, NOT THE CENTRE, IS WHAT IS TESTED. A sculpt of radius r
 * touches every cell in the square [x−r, x+r] × [y−r, y+r] (the brush is round,
 * but the square is the cheap superset and erring outward is the safe direction
 * here). Tested by CHUNK rather than by cell: the mask's quantum IS the chunk,
 * so a radius-3 brush costs at most four `isChunkUnlocked` calls instead of
 * forty-nine `isCellUnlocked` ones, and the two can never disagree.
 *
 * Every sculpt in this plugin goes through `sculptGuarded` below; there is no
 * second call site that could forget this.
 */
export function footprintUnlocked(
  world: MudslideWorld,
  x: number,
  y: number,
  radius: number,
): boolean {
  const minX = x - radius;
  const maxX = x + radius;
  const minY = y - radius;
  const maxY = y + radius;
  if (!inBounds(world, minX, minY) || !inBounds(world, maxX, maxY)) return false;

  const minCx = Math.floor(minX / CHUNK_SIZE);
  const maxCx = Math.floor(maxX / CHUNK_SIZE);
  const minCy = Math.floor(minY / CHUNK_SIZE);
  const maxCy = Math.floor(maxY / CHUNK_SIZE);
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      if (!world.isChunkUnlocked(cx, cy)) return false;
    }
  }
  return true;
}

/**
 * How far past the brush edge the mass measurement below reads, in cells.
 *
 * SIXTEEN — four world units. A `WorldApi.sculpt` runs smooth+soft with BANDED
 * spill, which caps every cell outside the brush footprint to its pre-stroke
 * terrace band but does still touch them, so the diff is wider than the brush.
 * Four world units past the edge covers that skirt for the small radii this
 * plugin uses; anything the diff puts beyond it is counted as UNMEASURED rather
 * than silently as zero, which is what keeps the ledger's error visible instead
 * of making the ledger wrong (see `SculptMeasurement.unmeasuredCells`).
 */
export const MUDSLIDE_MEASURE_MARGIN_CELLS = 16;

/** What one guarded sculpt actually did to the ground. */
export interface SculptMeasurement {
  /**
   * NET height units moved inside the measurement window — positive for a
   * raise, negative for a scour. This, not the requested `amount`, is what the
   * mass ledger in ./slides.ts is kept in: relaxation and banded spill decide
   * how much ground really moved, and they routinely move more than the brush
   * centre was asked for.
   */
  readonly net: number;
  /** Cells the sculpt changed, in total (the diff's own length). */
  readonly changedCells: number;
  /**
   * Cells the sculpt changed OUTSIDE the measurement window, whose contribution
   * to `net` is therefore missing. Non-zero means the ledger under-counts this
   * edit; ./slides.ts sums it across a slide and reports it, so "mass is
   * conserved to within X" is a measured claim rather than an assumption.
   */
  readonly unmeasuredCells: number;
}

const NO_SCULPT: SculptMeasurement = { net: 0, changedCells: 0, unmeasuredCells: 0 };

/**
 * The ONLY way this plugin changes the ground: a sculpt whose whole footprint is
 * revealed, or nothing at all.
 *
 * WHY THE HEIGHTS ARE READ TWICE rather than taken from the diff. `CellDiff`
 * carries the cell's NEW height and not its old one (shared/src/heightmap.ts),
 * so the only way to know what an edit moved is to have looked before. The
 * window is a square around the brush, `MUDSLIDE_MEASURE_MARGIN_CELLS` past its
 * edge; scanning it twice costs a few hundred array reads, against a few sculpts
 * per second per slide.
 *
 * A zero result means "nothing happened", whether because the footprint was
 * locked or because the terrain was already at its limit. Callers treat the two
 * the same — there is nothing useful either can do differently.
 */
export function sculptGuarded(
  world: MudslideWorld,
  x: number,
  y: number,
  radius: number,
  amount: number,
): SculptMeasurement {
  if (!footprintUnlocked(world, x, y, radius)) return NO_SCULPT;

  const reach = radius + MUDSLIDE_MEASURE_MARGIN_CELLS;
  const minX = Math.max(0, x - reach);
  const maxX = Math.min(world.worldSize - 1, x + reach);
  const minY = Math.max(0, y - reach);
  const maxY = Math.min(world.worldSize - 1, y + reach);

  const width = maxX - minX + 1;
  const before = new Int32Array(width * (maxY - minY + 1));
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      before[(cy - minY) * width + (cx - minX)] = world.heightAt(cx, cy);
    }
  }

  const diff = world.sculpt(x, y, radius, amount);

  let net = 0;
  let unmeasuredCells = 0;
  for (const cell of diff) {
    if (cell.x < minX || cell.x > maxX || cell.y < minY || cell.y > maxY) {
      unmeasuredCells++;
      continue;
    }
    net += cell.h - before[(cell.y - minY) * width + (cell.x - minX)]!;
  }
  return { net, changedCells: diff.length, unmeasuredCells };
}

/**
 * The drop from (x, y) to the lowest cell MUDSLIDE_SLOPE_SPAN_CELLS away, in
 * height units, and the direction of it.
 *
 * MEASURED ALONG THE EIGHT BEARINGS AT ONE FIXED RADIUS, not over every cell in
 * a disc: a slope is a direction as well as a number, and the bearing that gives
 * the drop is the bearing the mud will take, so finding it here saves the caller
 * a second search. Diagonal bearings reach √2 further than axial ones, which
 * makes them very slightly easier to qualify — accepted, because correcting it
 * would mean either a non-integer span or a per-bearing threshold, and the
 * error is smaller than one terrace band over the span.
 *
 * Null when the site is out of bounds, at or under the sea, or not steep enough.
 */
export function slopeAt(
  world: MudslideWorld,
  x: number,
  y: number,
): { readonly drop: number; readonly dx: number; readonly dy: number } | null {
  if (!inBounds(world, x, y)) return null;
  const here = world.heightAt(x, y);
  // Ground that is already under water does not slide; it is already where
  // gravity was taking it, and a slide starting on the sea floor would be
  // invisible as well as meaningless.
  if (here <= SEA_LEVEL) return null;

  let bestDrop = 0;
  let bestDx = 0;
  let bestDy = 0;
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx * MUDSLIDE_SLOPE_SPAN_CELLS;
    const ny = y + dy * MUDSLIDE_SLOPE_SPAN_CELLS;
    if (!inBounds(world, nx, ny)) continue;
    const drop = here - world.heightAt(nx, ny);
    if (drop <= bestDrop) continue;
    bestDrop = drop;
    bestDx = dx;
    bestDy = dy;
  }

  if (bestDrop < MUDSLIDE_TRIGGER_DROP) return null;
  return { drop: bestDrop, dx: bestDx, dy: bestDy };
}

/**
 * Is there fresh water within the slope span of (x, y)?
 *
 * THE SECOND TRIGGER (issue #212): a bank a river is cutting into is saturated
 * whether or not it is raining, which is why this is an alternative to rain
 * rather than a multiplier on it. The span is the SAME one the slope is measured
 * over, deliberately — "the water is inside the piece of hillside that would go"
 * is the physical claim, and measuring the two over different distances would
 * make it two unrelated claims that happen to share a site.
 *
 * The four axial bearings only, at the span and at half of it: a river is a
 * connected course, so a channel that misses all eight of these samples is not
 * running through this hillside.
 */
export function freshwaterAdjacent(world: MudslideWorld, x: number, y: number): boolean {
  const half = Math.max(1, Math.floor(MUDSLIDE_SLOPE_SPAN_CELLS / 2));
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    // Diagonals are skipped: the axial samples at two radii already cover the
    // span densely enough for a one-cell-wide course, and halving the sample
    // count halves what the survey pays per candidate.
    if (dx !== 0 && dy !== 0) continue;
    for (const reach of [half, MUDSLIDE_SLOPE_SPAN_CELLS]) {
      const nx = x + dx * reach;
      const ny = y + dy * reach;
      if (!inBounds(world, nx, ny)) continue;
      if (world.freshwater.at(nx, ny) !== 'none') return true;
    }
  }
  return world.freshwater.at(x, y) !== 'none';
}

/**
 * The cell a front at (x, y) flows into next, or a reason it stops.
 *
 * STEEPEST DESCENT over the eight neighbours, ties broken by the fixed offset
 * order above — the same rule volcanoes' lava follows, and for the same reason:
 * a four-neighbour front can only run along the axes, and a flow that goes down
 * a diagonal slope in a staircase of norths and easts looks like a pathfinder
 * rather than like a liquid.
 *
 * `visited` is THIS SLIDE's own cells: a front crossing its own path could
 * circle forever, while an OLD slide's run-out is ordinary ground a new one may
 * perfectly well run down.
 *
 * THE STOP TESTS ARE ON THE CELL THE FRONT IS ABOUT TO ENTER, not the one it is
 * in, so a slide reaching a river stops ON THE BANK — which is where the debris
 * dam a player can see would be.
 */
export function nextFlowCell(
  world: MudslideWorld,
  x: number,
  y: number,
  visited: ReadonlySet<number>,
): { readonly x: number; readonly y: number } | MudslideStop {
  const here = world.heightAt(x, y);

  let bestX = -1;
  let bestY = -1;
  let bestHeight = here;

  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(world, nx, ny)) continue;
    if (visited.has(cellKey(nx, ny))) continue;
    const height = world.heightAt(nx, ny);
    if (height >= bestHeight) continue;
    bestHeight = height;
    bestX = nx;
    bestY = ny;
  }

  if (bestX < 0) return 'basin';
  if (world.freshwater.at(bestX, bestY) !== 'none') return 'water';
  if (bestHeight <= SEA_LEVEL) return 'sea';
  // Locked LAST of the four, so a front that would have stopped at the water's
  // edge anyway reports the reason a player can see rather than one they cannot.
  if (!world.isCellUnlocked(bestX, bestY)) return 'locked';

  return { x: bestX, y: bestY };
}
