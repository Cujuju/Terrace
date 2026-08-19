// Reading the world: what counts as habitable ground for a monster, and how
// much of it is joined up.
//
// Everything here is a pure function of the world's current state — no mutable
// sim state, no side effects (the scratch buffers are an allocation cache, not
// state) — which is what lets the tests assert the lair maths directly against a
// hand-built world.
//
// ─────────────────────────────────────────────────────────────────────────────
// HABITAT IS A REGIME, NOT A DEPTH (generalised 2026-08-14, for the yeti)
//
// This file used to know exactly one thing about the world: how deep the water
// was. A monster that lives on high snow needs the same machinery pointed the
// other way — a connected region of cells, a minimum area, a survey interval,
// an extreme cell to arrive at — and every one of those is habitat-AGNOSTIC.
// What is NOT agnostic is a single question: which cells count?
//
// So the answer is one small value, a HabitatRegime, carrying the direction the
// habitat gets more extreme in (`inward`) and where it begins (`thresholdBands`).
// Everything else in this file — the predicate, the flood fill, the extreme
// cell, the per-kind admission test in summoning.ts — is written against
// `habitatReachHeightUnits`, so a third regime would be one more row here and
// nothing else.
//
// REJECTED ALTERNATIVE 1: a per-regime pair of lambdas (`contains`,
// `isFurtherIn`, `boundaryHeight`, `admits`). Four closures per regime, of
// which three are derivable from the fourth, and the failure mode is one of
// them written with the comparison the wrong way round — a land habitat whose
// "deepest" cell was its lowest would summon the yeti to the bottom of his own
// mountain, and nothing but a screenshot would say so.
// REJECTED ALTERNATIVE 2: a second parallel module (`land-habitat.ts`) mirroring
// this one. That is the duplication this file exists to avoid: the flood fill,
// the scratch cache and the 4-neighbour argument are one algorithm, and two
// copies of it would drift the day one of them is fixed.
// ─────────────────────────────────────────────────────────────────────────────

import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';

/**
 * The habitat regimes that exist, and the fixed order everything iterates them
 * in (surveys, the summon pass, the broadcast list, the snapshot).
 *
 * Two, and they are the two halves of a heightmap: below the sea and above it.
 */
export type HabitatRegimeId = 'water' | 'land';

/**
 * Which way a habitat gets MORE of itself, as a multiplier on height.
 *
 * -1: water — the lower the cell, the deeper in you are.
 * +1: land  — the higher the cell, the higher in you are.
 *
 * Named rather than written as bare -1/+1 at the two rows below, because this
 * one number is what every derived rule in the file is built out of: the
 * predicate, the "which cell is furthest in" comparison the flood fill uses to
 * pick a summon point, and the per-kind admission test.
 */
export const HABITAT_INWARD_DOWNWARD = -1;
export const HABITAT_INWARD_UPWARD = 1;

export interface HabitatRegime {
  readonly id: HabitatRegimeId;
  /** HABITAT_INWARD_DOWNWARD or HABITAT_INWARD_UPWARD. */
  readonly inward: -1 | 1;
  /**
   * Bands from sea level at which this habitat begins — its FLOOR, and the
   * shallowest/lowest a monster of any kind in it may ever be. A kind may
   * demand more (see MonsterProfile.minLairReachBands); nothing may demand
   * less.
   */
  readonly thresholdBands: number;
}

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
 */
export const DEEP_WATER_BANDS_BELOW_SEA = 3;

/**
 * Height, in terrace bands ABOVE sea level, at which ground stops being rock and
 * becomes permanent snow — the SNOW LINE, and the floor of the land habitat.
 *
 * NINE BANDS, and it is the same kind of statement DEEP_WATER_BANDS_BELOW_SEA
 * is: a deliberate restatement of a number that lives somewhere else, chosen so
 * that what the server calls habitat is what the player can SEE.
 *
 *   * WHAT IT RESTATES. The client's terrain palette (client/src/terrain/
 *     bandColors.ts) draws every band from 9 upward as snow — its last stop —
 *     and bands 6–8 as rock. So band 9 is exactly where a mountain turns white
 *     on screen. It is restated and not imported for the harder version of the
 *     plugin-independence reason: the SERVER may not import the client at all
 *     (it runs in a process with no three, no DOM and no client bundle), so the
 *     honest arrangement is one number here, one there, and a note at each.
 *     If the palette's snow stop ever moves, this is a considered decision to
 *     follow it, not an automatic one.
 *   * WHY THAT IS ALSO A GOOD NUMBER ON ITS OWN, independent of the palette —
 *     because a threshold that is only "what the artist picked" is a threshold
 *     that breaks when the artist changes their mind. MAX_STEP is BAND_HEIGHT/2,
 *     so terrain climbs at most half a band per cell: a cell nine bands up is at
 *     least EIGHTEEN cells from the nearest shoreline, three times the six the
 *     deep-water line buys, and 9 of the 16 bands MAX_HEIGHT allows — the upper
 *     half of everything a world can be. Snow is the high country by
 *     construction, not by decoration.
 *
 * CONSEQUENCE, STATED: a fresh world has NO land at all (design record,
 * 2026-08-14 genesis decision), so the land habitat is empty until a player
 * raises a mountain nine bands out of the sea. That is intended — the sea
 * monsters are what a new world has, and the yeti is something a player builds
 * the country for.
 */
export const SNOW_LINE_BANDS_ABOVE_SEA = 9;

/** Deep water: the sea from three bands down. */
export const WATER_HABITAT: HabitatRegime = {
  id: 'water',
  inward: HABITAT_INWARD_DOWNWARD,
  thresholdBands: DEEP_WATER_BANDS_BELOW_SEA,
};

/** The high Alps: everything from the snow line up. */
export const LAND_HABITAT: HabitatRegime = {
  id: 'land',
  inward: HABITAT_INWARD_UPWARD,
  thresholdBands: SNOW_LINE_BANDS_ABOVE_SEA,
};

/**
 * Every regime, in the fixed order surveys, summons, broadcasts and snapshots
 * iterate them. Water first because it is the habitat every world has from its
 * first tick; the order is otherwise arbitrary and only has to be STABLE, so
 * that two runs over the same world produce the same broadcast list.
 */
export const HABITAT_REGIMES: readonly HabitatRegime[] = [WATER_HABITAT, LAND_HABITAT];

export function habitatById(id: HabitatRegimeId): HabitatRegime {
  return id === 'water' ? WATER_HABITAT : LAND_HABITAT;
}

// ── The one primitive ────────────────────────────────────────────────────────

/**
 * How far this height reaches INTO the given habitat, in height units, measured
 * from sea level. Negative for a height on the wrong side of the sea entirely.
 *
 * THE ONE PRIMITIVE. Every question this file and summoning.ts ask about a
 * height — is it habitat, is it further in than that other one, is it far enough
 * in for this kind — is a comparison of two of these, which is what makes it
 * impossible for the land regime to disagree with itself about which way is up.
 */
export function habitatReachHeightUnits(regime: HabitatRegime, height: number): number {
  return regime.inward * (height - SEA_LEVEL);
}

/** The height whose reach into this habitat is exactly `bands` bands. */
export function habitatBoundaryHeight(regime: HabitatRegime, bands: number): number {
  return SEA_LEVEL + regime.inward * bands * BAND_HEIGHT;
}

/** Does this height reach at least `bands` bands into this habitat? */
export function reachesIntoHabitat(
  regime: HabitatRegime,
  height: number,
  bands: number,
): boolean {
  return habitatReachHeightUnits(regime, height) >= bands * BAND_HEIGHT;
}

/**
 * Is a cell at this height inside this habitat at all?
 *
 * IT IS THE FLOOR, NOT THE WHOLE RULE. This is what "ground a monster can be on"
 * means, and it is what the flood fill, the steering probe and the per-tick
 * habitat check all read. A KIND may demand more of the region it moves INTO —
 * the kraken wants a trench seven bands down (kinds.ts) — but nothing may be
 * anywhere shallower (or lower) than this line.
 */
export function isHabitatHeight(regime: HabitatRegime, height: number): boolean {
  return reachesIntoHabitat(regime, height, regime.thresholdBands);
}

/** Heights at or below this are deep water. The water regime's own boundary. */
export const DEEP_WATER_MAX_HEIGHT = habitatBoundaryHeight(
  WATER_HABITAT,
  DEEP_WATER_BANDS_BELOW_SEA,
);

/** Heights at or above this are permanent snow. The land regime's boundary. */
export const SNOW_LINE_MIN_HEIGHT = habitatBoundaryHeight(
  LAND_HABITAT,
  SNOW_LINE_BANDS_ABOVE_SEA,
);

/** Is this height deep water? Mirrors shared's `isWater`, then splits it once. */
export function isDeepWaterHeight(height: number): boolean {
  return isHabitatHeight(WATER_HABITAT, height);
}

/** Is this height at or above the snow line? */
export function isSnowHeight(height: number): boolean {
  return isHabitatHeight(LAND_HABITAT, height);
}

/** The slice of the server's WorldApi this plugin actually reads. */
export interface LairWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * Is this cell somewhere a monster of this habitat may be? Three conditions, all
 * required: inside the world, inside unlocked territory, and inside the habitat.
 *
 * ONE predicate, used by the lair survey, by the movement look-ahead and by the
 * per-tick habitat check, so those three can never disagree about what "valid"
 * means. The unlocked requirement is also this plugin's entire anti-leak story:
 * a monster only ever exists in territory clients can already see, so the
 * unfiltered full-state broadcast reveals nothing about locked land.
 */
export function isLairCell(
  regime: HabitatRegime,
  world: LairWorld,
  cellX: number,
  cellY: number,
): boolean {
  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return isHabitatHeight(regime, world.heightAt(x, y));
}

/**
 * One connected region of habitat, as the survey measured it.
 *
 * The EXTREME cell — the deepest cell of a basin, the highest cell of a massif —
 * is carried rather than a centroid for two reasons: a centroid can fall outside
 * a crescent-shaped region, and the abyssal point of a basin (or the summit of a
 * mountain) is the right place for a thing to rise from anyway. Its HEIGHT is
 * carried too, because "how far into its habitat does this region get" is a
 * per-kind admission test (a kraken wants a trench, Cthulhu takes any deep
 * water) and the flood fill has already visited every cell — re-deriving it
 * later would mean a second pass over the region for a number that was in hand.
 */
export interface LairRegion {
  readonly cells: number;
  /** Extreme cell of the region; ties broken by BFS visit order. */
  readonly x: number;
  readonly y: number;
  /** Height of that cell: the furthest into the habitat the region gets. */
  readonly extremeHeight: number;
}

/** What one survey learned about one habitat. */
export interface LairSurvey {
  /**
   * Every connected region of this habitat, in scan order (row-major by seed
   * cell). WHICH of them qualifies as a lair is a per-kind POLICY question and
   * is answered in summoning.ts; this file only reports what the world contains.
   */
  readonly regions: readonly LairRegion[];
  /**
   * Cells in the region containing each queried `occupied` cell — aligned
   * index-for-index with the `occupied` list handed to surveyLairs, 0 for a
   * position that is not in this habitat. This is what the collapse test
   * reads: what matters is the size of the region the monster is ACTUALLY in,
   * not the size of the biggest one on the map.
   *
   * A LIST since 2026-08-19 (per-kind slots): one habitat can now hold one
   * monster of EACH of its kinds, so the collapse test needs one answer per
   * occupant rather than one per habitat.
   */
  readonly occupiedRegionCells: readonly number[];
}

export const EMPTY_LAIR_SURVEY: LairSurvey = {
  regions: [],
  occupiedRegionCells: [],
};

/**
 * Scratch buffers for the flood fill, cached across surveys.
 *
 * A 512² world needs a 1 MB label array and a 1 MB queue. Allocating those every
 * survey would hand the GC 2 MB every few seconds forever, for a job whose
 * working set never changes size; they are reallocated only when the world size
 * does (which is once, at boot, in practice).
 *
 * ONE pair for ALL regimes, and that is safe because surveys are SEQUENTIAL: a
 * survey fills the labels, reads them and returns before the next one starts.
 * Nothing here is re-entrant and nothing holds a reference to the buffers past
 * its own call.
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
 * Floods one connected region from `seedIndex`, writing `label` into every cell
 * it reaches.
 *
 * A module-scope function rather than a closure inside the scan loop: the scan
 * calls it once per region, and a pathological world (a checkerboard of
 * single-cell pools) has tens of thousands of regions — that is tens of
 * thousands of closure allocations for something with no captured state worth
 * keeping.
 */
function floodRegion(
  regime: HabitatRegime,
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
  // Reach of the most extreme cell seen so far. Starts below every real reach:
  // the seed itself is habitat, so its reach is at least thresholdBands, and
  // the first iteration always replaces this.
  let extremeReach = Number.NEGATIVE_INFINITY;
  let extremeHeight = 0;
  let extremeX = seedIndex % size;
  let extremeY = (seedIndex - extremeX) / size;

  while (head < tail) {
    const index = queue[head++];
    const x = index % size;
    const y = (index - x) / size;
    cells++;

    const height = world.heightAt(x, y);
    const reach = habitatReachHeightUnits(regime, height);
    if (reach > extremeReach) {
      extremeReach = reach;
      extremeHeight = height;
      extremeX = x;
      extremeY = y;
    }

    // 4-neighbourhood, in a fixed order: west, east, north, south.
    if (x > 0 && labels[index - 1] === UNLABELLED && isLairCell(regime, world, x - 1, y)) {
      labels[index - 1] = label;
      queue[tail++] = index - 1;
    }
    if (x + 1 < size && labels[index + 1] === UNLABELLED && isLairCell(regime, world, x + 1, y)) {
      labels[index + 1] = label;
      queue[tail++] = index + 1;
    }
    if (y > 0 && labels[index - size] === UNLABELLED && isLairCell(regime, world, x, y - 1)) {
      labels[index - size] = label;
      queue[tail++] = index - size;
    }
    if (
      y + 1 < size &&
      labels[index + size] === UNLABELLED &&
      isLairCell(regime, world, x, y + 1)
    ) {
      labels[index + size] = label;
      queue[tail++] = index + size;
    }
  }

  return { cells, x: extremeX, y: extremeY, extremeHeight };
}

/**
 * Labels every connected region of one habitat and reports all of them, plus the
 * size of the region under each `occupied` position (one habitat can hold one
 * monster per kind since 2026-08-19, so the occupants come as a list).
 *
 * CONNECTIVITY IS 4-NEIGHBOUR. Two basins joined only at a diagonal pinch are
 * two basins: that is a corner a body 7 cells wide cannot swim through, so
 * counting them as one would let a monster qualify on water it cannot reach. The
 * same argument holds on land, where the pinch is a knife-edge ridge nothing
 * bulky walks across.
 *
 * COST. One pass over every cell plus a BFS that visits each habitat cell once —
 * two WorldApi calls per cell, ~262 000 cells on a full 512² world, on the order
 * of a millisecond PER REGIME (so ~2 ms for the two of them, since each is its
 * own scan). That is why the caller runs it on an interval
 * (LAIR_SURVEY_INTERVAL_SECONDS) and never per tick; habitat only changes when
 * terrain or the unlock mask changes, and both are human-paced.
 *
 * ITERATION ORDER is fixed (row-major, then a FIFO BFS) so that two runs against
 * the same world report the same summon cell. Determinism is not required here —
 * this is not terrain math — but a survey that answered differently on identical
 * input would make every failure in this plugin harder to read.
 */
export function surveyLairs(
  regime: HabitatRegime,
  world: LairWorld,
  occupied: ReadonlyArray<{ readonly x: number; readonly y: number }> = [],
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
      if (!isLairCell(regime, world, seedX, seedY)) continue;

      regions.push(
        floodRegion(
          regime,
          world,
          size,
          scratch.labels,
          scratch.queue,
          seedIndex,
          regions.length,
        ),
      );
    }
  }

  // One answer per queried occupant, in the caller's order (see LairSurvey).
  const occupiedRegionCells = occupied.map((position) => {
    const x = Math.floor(position.x);
    const y = Math.floor(position.y);
    if (x < 0 || y < 0 || x >= size || y >= size) return 0;
    const label = scratch.labels[y * size + x];
    return label === UNLABELLED ? 0 : regions[label]!.cells;
  });

  return { regions, occupiedRegionCells };
}
