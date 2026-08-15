// Reading the world: what counts as deep water, and how much of it is joined up.
//
// Everything here is a pure function of the world's current state — no mutable
// sim state, no side effects (the scratch buffers are an allocation cache, not
// state) — which is what lets the tests assert the lair maths directly against a
// hand-built world.

import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';

/**
 * Depth, in terrace bands below sea level, at which water stops being coastal
 * shallows and becomes open sea.
 *
 * THREE BANDS, and this is a DELIBERATE RESTATEMENT of the wildlife plugin's
 * DEEP_WATER_BANDS_BELOW_SEA (plugins/wildlife/server/species.ts), not an
 * import: plugins are independently installable, so one must not break because
 * another was removed or retuned. The semantics are meant to match — a cell that
 * is "deep" to a whale is "deep" to Cthulhu — and the shared reasoning is worth
 * repeating: MAX_STEP is BAND_HEIGHT/2, so terrain falls at most half a band per
 * cell and a cell this deep is at least six cells from the nearest shoreline.
 * That is what makes the threshold meaningful rather than arbitrary. It is also
 * three world units of water column (HEIGHT_WORLD_SCALE maps one band to one
 * world unit), which is what the client's placement clamps against.
 *
 * If wildlife's number ever moves, this one is a considered decision to follow
 * it, not an automatic one.
 *
 * IT IS THE FLOOR, NOT THE WHOLE RULE. This is what "water a monster can be in"
 * means, and it is what the flood fill, the steering probe and the per-tick
 * habitat check all read. A KIND may demand more of the basin it moves INTO —
 * the kraken wants a trench eight bands down (kinds.ts) — but nothing may be
 * anywhere shallower than this line.
 */
export const DEEP_WATER_BANDS_BELOW_SEA = 3;

/** Heights at or below this are deep water. */
export const DEEP_WATER_MAX_HEIGHT = SEA_LEVEL - DEEP_WATER_BANDS_BELOW_SEA * BAND_HEIGHT;

/** Is this height deep water? Mirrors shared's `isWater`, then splits it once. */
export function isDeepWaterHeight(height: number): boolean {
  return height <= DEEP_WATER_MAX_HEIGHT;
}

/** The slice of the server's WorldApi this plugin actually reads. */
export interface LairWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * Is this cell somewhere a monster may be? Three conditions, all required:
 * inside the world, inside unlocked territory, and deep water.
 *
 * ONE predicate, used by the lair survey, by the movement look-ahead and by the
 * per-tick habitat check, so those three can never disagree about what "valid"
 * means. The unlocked requirement is also this plugin's entire anti-leak story:
 * a monster only ever exists in territory clients can already see, so the
 * unfiltered full-state broadcast reveals nothing about locked land.
 */
export function isLairCell(world: LairWorld, cellX: number, cellY: number): boolean {
  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return isDeepWaterHeight(world.heightAt(x, y));
}

/**
 * One connected deep-water region, as the survey measured it.
 *
 * The DEEPEST cell is carried rather than a centroid for two reasons: a
 * centroid can fall outside a crescent-shaped basin, and the abyssal point of a
 * basin is the right place for a thing to rise from anyway. Its HEIGHT is
 * carried too, because "how deep does this basin get" is a per-kind admission
 * test (a kraken wants a trench, Cthulhu takes any deep water) and the flood
 * fill has already visited every cell — re-deriving it later would mean a
 * second pass over the region for a number that was in hand.
 */
export interface LairRegion {
  readonly cells: number;
  /** Deepest cell of the region; ties broken by BFS visit order. */
  readonly x: number;
  readonly y: number;
  /** Height of that cell. Lower is deeper; always ≤ DEEP_WATER_MAX_HEIGHT. */
  readonly deepestHeight: number;
}

/** What one survey learned about the world's deep water. */
export interface LairSurvey {
  /**
   * Every connected deep-water region, in scan order (row-major by seed cell).
   * WHICH of them qualifies as a lair is a per-kind POLICY question and is
   * answered in summoning.ts; this file only reports what the world contains.
   */
  readonly regions: readonly LairRegion[];
  /**
   * Cells in the region containing the queried `occupied` cell, or 0 when no
   * cell was queried / it is not deep water. This is what the collapse test
   * reads: what matters is the size of the basin the monster is ACTUALLY in,
   * not the size of the biggest one on the map.
   */
  readonly occupiedRegionCells: number;
}

export const EMPTY_LAIR_SURVEY: LairSurvey = {
  regions: [],
  occupiedRegionCells: 0,
};

/**
 * Scratch buffers for the flood fill, cached across surveys.
 *
 * A 512² world needs a 1 MB label array and a 1 MB queue. Allocating those every
 * survey would hand the GC 2 MB every few seconds forever, for a job whose
 * working set never changes size; they are reallocated only when the world size
 * does (which is once, at boot, in practice).
 */
let labels: Int32Array | null = null;
let queue: Int32Array | null = null;

const UNLABELLED = -1;

function scratchFor(cellCount: number): { labels: Int32Array; queue: Int32Array } {
  if (labels === null || labels.length !== cellCount) labels = new Int32Array(cellCount);
  if (queue === null || queue.length !== cellCount) queue = new Int32Array(cellCount);
  return { labels, queue };
}

/** Frees the scratch buffers (used by the plugin's reset seam). */
export function releaseSurveyScratch(): void {
  labels = null;
  queue = null;
}

/**
 * Floods one connected deep-water region from `seedIndex`, writing `label` into
 * every cell it reaches.
 *
 * A module-scope function rather than a closure inside the scan loop: the scan
 * calls it once per region, and a pathological world (a checkerboard of
 * single-cell pools) has tens of thousands of regions — that is tens of
 * thousands of closure allocations for something with no captured state worth
 * keeping.
 */
function floodRegion(
  world: LairWorld,
  size: number,
  labels: Int32Array,
  queue: Int32Array,
  seedIndex: number,
  label: number,
): LairRegion {
  let head = 0;
  let tail = 0;
  labels[seedIndex] = label;
  queue[tail++] = seedIndex;

  let cells = 0;
  let deepestHeight = Number.POSITIVE_INFINITY;
  let deepestX = seedIndex % size;
  let deepestY = (seedIndex - deepestX) / size;

  while (head < tail) {
    const index = queue[head++];
    const x = index % size;
    const y = (index - x) / size;
    cells++;

    const height = world.heightAt(x, y);
    if (height < deepestHeight) {
      deepestHeight = height;
      deepestX = x;
      deepestY = y;
    }

    // 4-neighbourhood, in a fixed order: west, east, north, south.
    if (x > 0 && labels[index - 1] === UNLABELLED && isLairCell(world, x - 1, y)) {
      labels[index - 1] = label;
      queue[tail++] = index - 1;
    }
    if (x + 1 < size && labels[index + 1] === UNLABELLED && isLairCell(world, x + 1, y)) {
      labels[index + 1] = label;
      queue[tail++] = index + 1;
    }
    if (y > 0 && labels[index - size] === UNLABELLED && isLairCell(world, x, y - 1)) {
      labels[index - size] = label;
      queue[tail++] = index - size;
    }
    if (y + 1 < size && labels[index + size] === UNLABELLED && isLairCell(world, x, y + 1)) {
      labels[index + size] = label;
      queue[tail++] = index + size;
    }
  }

  return { cells, x: deepestX, y: deepestY, deepestHeight };
}

/**
 * Labels every connected deep-water region and reports all of them, plus the
 * size of the region under `occupied`.
 *
 * CONNECTIVITY IS 4-NEIGHBOUR. Two basins joined only at a diagonal pinch are
 * two basins: that is a corner a body 7 cells wide cannot swim through, so
 * counting them as one would let a monster qualify on water it cannot reach.
 *
 * COST. One pass over every cell plus a BFS that visits each deep cell once —
 * two WorldApi calls per cell, ~262 000 cells on a full 512² world, on the order
 * of a millisecond. That is why the caller runs it on an interval
 * (LAIR_SURVEY_INTERVAL_SECONDS) and never per tick; habitat only changes when
 * terrain or the unlock mask changes, and both are human-paced.
 *
 * ITERATION ORDER is fixed (row-major, then a FIFO BFS) so that two runs against
 * the same world report the same summon cell. Determinism is not required here —
 * this is not terrain math — but a survey that answered differently on identical
 * input would make every failure in this plugin harder to read.
 */
export function surveyLairs(
  world: LairWorld,
  occupied: { readonly x: number; readonly y: number } | null = null,
): LairSurvey {
  const size = world.worldSize;
  if (size <= 0) return EMPTY_LAIR_SURVEY;

  const cellCount = size * size;
  const scratch = scratchFor(cellCount);
  scratch.labels.fill(UNLABELLED);

  /** Regions, in scan order. A region's index in here IS its label. */
  const regions: LairRegion[] = [];

  for (let seedY = 0; seedY < size; seedY++) {
    for (let seedX = 0; seedX < size; seedX++) {
      const seedIndex = seedY * size + seedX;
      if (scratch.labels[seedIndex] !== UNLABELLED) continue;
      if (!isLairCell(world, seedX, seedY)) continue;

      regions.push(
        floodRegion(world, size, scratch.labels, scratch.queue, seedIndex, regions.length),
      );
    }
  }

  let occupiedRegionCells = 0;
  if (occupied !== null) {
    const x = Math.floor(occupied.x);
    const y = Math.floor(occupied.y);
    if (x >= 0 && y >= 0 && x < size && y < size) {
      const label = scratch.labels[y * size + x];
      if (label !== UNLABELLED) occupiedRegionCells = regions[label]!.cells;
    }
  }

  return { regions, occupiedRegionCells };
}
