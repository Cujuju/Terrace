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

import { BAND_HEIGHT, SEA_LEVEL, type FreshwaterMap } from '@terrace/shared';
// A DELIBERATE IMPORT CYCLE with ./habitat-index.ts, and it is safe by
// construction: neither module touches a binding of the other at evaluation
// time (every use is inside a function body), so whichever ES module the
// loader enters first completes. The alternative — moving LairRegion,
// LairSurvey and the flood fill into the index file — would put the survey's
// meaning in the file about its storage.
import {
  HABITAT_BIT_SET,
  type HabitatIndex,
  type RegimeIndex,
  buildHabitatIndex,
  indexAnswers,
} from './habitat-index.ts';

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
 *
 * STATED IN HEIGHT UNITS SINCE 2026-08-20, band count derived. It was the
 * literal 3 bands, which made "deep water" a function of the render quantum:
 * re-terracing the world 64 -> 16 would have moved the open sea to a quarter of
 * its depth, and every monster that lives in it with it. The DEPTH is the fact.
 *
 * Two clauses above went stale with the re-terrace and are corrected here
 * rather than left to mislead: MAX_STEP is now BAND_HEIGHT, not BAND_HEIGHT/2,
 * so terrain falls at most a FULL band per cell — but since this threshold is
 * pinned to a depth rather than a band count, the distance it buys from the
 * shoreline went UP, not down: 192 units at 16 per cell is at least twelve
 * cells of shallows, where it used to be six. And it is three world units of
 * water column exactly as before, because HEIGHT_WORLD_SCALE did not move
 * (client/src/config.ts now derives it from relief rather than from the band).
 */
export const DEEP_WATER_DEPTH_BELOW_SEA = 192;
export const DEEP_WATER_BANDS_BELOW_SEA = DEEP_WATER_DEPTH_BELOW_SEA / BAND_HEIGHT;

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
 *
 * STATED IN HEIGHT UNITS SINCE 2026-08-20, band count derived — for exactly the
 * reason the restatement note above gives. The palette's snow stop did not
 * move when the world was re-terraced (client/src/terrain/bandColors.ts pins
 * SNOW_LINE_HEIGHT at the same 576 units and generates its band from it), so
 * neither does this: "band 9" was the old spelling of 576, and spelling it the
 * old way would have dropped the snow line to 144 units while the mountains
 * stayed white above 576.
 *
 * The arithmetic in the second bullet moved with it and is restated: MAX_STEP
 * is now BAND_HEIGHT, so terrain climbs at most a full band per cell, and 576
 * units at 16 per cell puts a snow cell at least THIRTY-SIX cells from the
 * shoreline — twice the eighteen it used to buy, because the world's slope
 * halved. It remains the upper half of everything a world can be: 576 of the
 * 1024 units MAX_HEIGHT allows.
 */
export const SNOW_LINE_HEIGHT_ABOVE_SEA = 576;
export const SNOW_LINE_BANDS_ABOVE_SEA = SNOW_LINE_HEIGHT_ABOVE_SEA / BAND_HEIGHT;

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
  /**
   * Where the rivers and lakes are, per cell — supplied by core's WorldApi and
   * consumed by `shared/`'s traversal predicates, which read it off whatever
   * `TerrainSampler` they are handed.
   *
   * DECLARED HERE EVEN THOUGH `TerrainSampler.freshwater` IS OPTIONAL. Leaving
   * it out would still compile and would still work in the running server —
   * the concrete object passed in is the WorldApi, which has the property
   * regardless of what this interface says — but it would work by accident:
   * the rule would be live in production and silently absent from every test
   * that builds a stand-in world, which is the one place a rivers-vs-lakes
   * regression would otherwise be caught. Naming it makes the dependency
   * checked rather than incidental. Optional so a test may still omit it and
   * mean "this world has no fresh water".
   */
  readonly freshwater?: FreshwaterMap;
  /**
   * The chunk grid, read ONLY as a change detector for the unlock mask
   * (habitat-index.ts's `unlockGenerationOf`) — never to decide whether a cell
   * is habitat, which stays `isCellUnlocked`'s answer.
   *
   * OPTIONAL because a hand-built test world has no chunk mask, and the index
   * answers "cannot tell" for one rather than guessing; the concrete object
   * production passes in is the WorldApi, which has both.
   */
  readonly chunksPerEdge?: number;
  isChunkUnlocked?(cx: number, cy: number): boolean;
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
 * How many points of a BODY'S RIM `isLairPose` samples, and the fixed unit-circle
 * offsets it samples them at.
 *
 * EIGHT, and it is a resolution choice with a stated cost. The widest gap
 * between two adjacent probes is the chord `2·r·sin(π/8)` ≈ `0.765·r`, which at
 * today's widest body (7 cells across, so r = 3.5) is about 2.7 cells. So this
 * ring detects any shore, wall or shoal thicker than that, and a narrower
 * tongue of it can still pass between two probes unseen. Eight is chosen to
 * match the 45° granularity `AVOID_TURN_ATTEMPTS` already steers at (lurk.ts) —
 * a finer probe ring than the steering can act on buys nothing.
 *
 * RADIAL, NOT PERPENDICULAR TO THE HEADING. The sea kinds' bodies are a radial
 * crown of arms (plugins/monsters/client/kraken-anatomy.ts) and the server
 * animates them by YAW only, so the swept footprint is a disc and the predicate
 * must be yaw-independent — a heading-relative probe would let the same pose be
 * legal or illegal depending on which way the animal happened to be looking,
 * which is a rule that disagrees with itself as the model turns.
 *
 * RESIDUAL, STATED RATHER THAN PAPERED OVER: the rim and the centre are
 * sampled, the INTERIOR between them is not. An isolated pillar of rock that
 * rises inside the body's disc without touching its rim or its centre passes
 * this test. Filling the disc is O(r²) samples per candidate heading per tick
 * for a case the terrain generator does not produce (the flood fill that
 * defines a lair already excludes non-habitat cells, so an interior pillar can
 * only arrive by a player sculpting one — and `protection.ts` refuses exactly
 * that raise inside `groundProtectionRadiusCells`).
 */
export const BODY_RIM_PROBE_COUNT = 8;

/**
 * EXPORTED (2026-08-26) so `habitat-index.ts` can bake the same ring into the
 * whole-cell offsets its fit bitmap is built from. One ring, one definition —
 * a second copy of these eight points is a second answer to `isLairPose`.
 */
export const BODY_RIM_PROBE_OFFSETS: readonly (readonly [number, number])[] = Array.from(
  { length: BODY_RIM_PROBE_COUNT },
  (_unused, index) => {
    const angle = (index * 2 * Math.PI) / BODY_RIM_PROBE_COUNT;
    return [Math.cos(angle), Math.sin(angle)] as const;
  },
);

/**
 * Is a BODY of this radius, centred here, entirely inside this habitat?
 *
 * THE POINT OF THIS FUNCTION, in one sentence: `isLairCell` answers for a CELL,
 * every caller that steers a monster owns a body several cells wide, and until
 * 2026-08-20 those callers all asked the cell question and got the wrong answer
 * at every shoreline.
 *
 * The asymmetry it removes was visible in one diff: `protection.ts` has always
 * treated a monster as a DISC of `groundProtectionRadiusCells` — a player may
 * not raise ground within 4.5 cells of the kraken — while `lurk.ts` treated the
 * same animal as a POINT, so the kraken was free to swim its own 3.5-cell arm
 * crown into ground that already existed. The server forbade the world from
 * moving into the monster's body and permitted the monster to move its body
 * into the world.
 *
 * `radiusCells` of 0 degenerates to exactly `isLairCell`, which is what makes
 * this a safe single predicate for callers that sometimes want the point test
 * (see lurk.ts's pinched-body escape).
 */
export function isLairPose(
  regime: HabitatRegime,
  world: LairWorld,
  centreX: number,
  centreY: number,
  radiusCells: number,
): boolean {
  if (!isLairCell(regime, world, centreX, centreY)) return false;
  if (radiusCells <= 0) return true;
  for (const [ux, uy] of BODY_RIM_PROBE_OFFSETS) {
    if (!isLairCell(regime, world, centreX + ux * radiusCells, centreY + uy * radiusCells)) {
      return false;
    }
  }
  return true;
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
  /**
   * How many cells of this region each of the survey's `fitRules` FITS ON — its
   * body, centred on the cell, entirely inside the habitat. Index-aligned with
   * the rule list handed to `surveyLairs`, and empty for a survey that was asked
   * for no rules at all.
   *
   * ADDED 2026-08-26, and it is the missing half of the admission test. A
   * region used to be admitted on `cells` alone, which counts CELLS and not
   * ROOM: a 52-cell snow ribbon one cell wide clears the yeti's cell bar while
   * containing no pose his 4.81-cell body fits in, so he was summoned pinched
   * and spent his whole life in lurk.ts's clearance-0 fallback with his flanks
   * in the rock. `cells >= minLairCells` is a bar on AREA; this is the bar on
   * SHAPE, and a lair has to clear both.
   *
   * IT IS THE ROOM TO ROAM, and deliberately ignores the rule's `minReachBands`
   * — see `summonableCells` for the other count and why they are two.
   */
  readonly fittingCells: readonly number[];
  /**
   * How many cells of this region each rule could be SUMMONED onto: the same
   * pose test, AND the rule's own `minReachBands`. Index-aligned the same way.
   *
   * TWO COUNTS, BECAUSE ARRIVING AND LIVING ARE DIFFERENT QUESTIONS, and the
   * kraken is the kind that proves it. He must ARRIVE in a trench 31 bands down
   * — a natural ocean floor shows perhaps 177 such cells — but he LIVES in deep
   * water, which is the whole basin: lurk.ts steers him against `isLairPose`
   * against the habitat and has never once read `minLairReachBands`. Counting
   * one number for both would have forced a choice between two settled rules —
   * either the yeti keeps being born in shapes he does not fit, or the owner's
   * 2026-08-19 "the natural ocean floor admits the kraken, no manual dig"
   * quietly stops being true.
   *
   * `summonableCells` is what stops a REFUSAL from becoming a LOOP: a region
   * with room to roam but no cell that also clears the depth bar would be
   * admitted by gate 3 and then found empty by `summonCellIn`, whose answer to
   * that is `invalidateSurvey()` — a re-survey on every roll, forever. Gate 3
   * requires at least one, so the region is refused instead of retried.
   *
   * The two share their expensive half: one pose test per cell per rule feeds
   * both counters.
   */
  readonly summonableCells: readonly number[];
}

/**
 * One kind's whole-body rule, as the survey must count it (2026-08-26): how wide
 * its body is, and how far into the habitat a cell must reach before that kind
 * may be summoned onto it.
 *
 * The two are asked of every cell of every region and feed the two counts on
 * LairRegion: the pose alone gives `fittingCells` (room to roam), the pose AND
 * the reach give `summonableCells` (somewhere to arrive). See those fields for
 * why one number could not have served both.
 *
 * The centre offset the fit is measured at is +0.5 (CELL_CENTRE_OFFSET), because
 * that is where `summon` places the animal.
 */
export interface LairFitRule {
  /** Half the kind's footprint — kinds.ts's `bodyRadiusCells`. */
  readonly radiusCells: number;
  /** The kind's own `minLairReachBands`. */
  readonly minReachBands: number;
}

/**
 * Where in a cell a summoned monster stands: its centre.
 *
 * Named because two files have to agree on it — the survey counts a cell as
 * fitting by testing the pose HERE, and summoning.ts places the animal HERE —
 * and a half-cell disagreement between them would put the body somewhere the
 * count never checked.
 */
export const CELL_CENTRE_OFFSET = 0.5;

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
 *
 * READS BITMAPS, NOT THE WORLD (2026-08-26). Every question this walk used to
 * ask the WorldApi — is that neighbour habitat, does this kind's body fit here
 * — is a byte in habitat-index.ts's maintained arrays, kept in step by the
 * terrain diff that changed it. The 4-neighbour order, the FIFO queue and the
 * tie-break on the extreme cell are unchanged, so the regions and the counts
 * are bit-for-bit what the classifying walk reported for the same world.
 */
function floodRegion(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  size: number,
  labels: Int32Array,
  queue: Int32Array,
  seedIndex: number,
  label: number,
): LairRegion {
  const { heights } = index;
  const { habitat, fit, rules } = regimeIndex;

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
  /** One running count per fit rule each; see LairRegion.fittingCells. */
  const fittingCells = rules.map(() => 0);
  const summonableCells = rules.map(() => 0);

  while (head < tail) {
    const cellIndex = queue[head++]!;
    const x = cellIndex % size;
    const y = (cellIndex - x) / size;
    cells++;

    const height = heights[cellIndex]!;
    const reach = habitatReachHeightUnits(regime, height);
    if (reach > extremeReach) {
      extremeReach = reach;
      extremeHeight = height;
      extremeX = x;
      extremeY = y;
    }

    // The shape half of the admission test. It used to be measured HERE, at
    // nine `isLairCell` calls per rule per cell — the single most expensive
    // thing this plugin did (see habitat-index.ts's header for the measurement
    // that ended it). It is now one byte lookup per rule.
    for (let rule = 0; rule < rules.length; rule++) {
      if (fit[rule]![cellIndex] !== HABITAT_BIT_SET) continue;
      fittingCells[rule]!++;
      if (reachesIntoHabitat(regime, height, rules[rule]!.minReachBands)) summonableCells[rule]!++;
    }

    // 4-neighbourhood, in a fixed order: west, east, north, south.
    if (
      x > 0 &&
      labels[cellIndex - 1] === UNLABELLED &&
      habitat[cellIndex - 1] === HABITAT_BIT_SET
    ) {
      labels[cellIndex - 1] = label;
      queue[tail++] = cellIndex - 1;
    }
    if (
      x + 1 < size &&
      labels[cellIndex + 1] === UNLABELLED &&
      habitat[cellIndex + 1] === HABITAT_BIT_SET
    ) {
      labels[cellIndex + 1] = label;
      queue[tail++] = cellIndex + 1;
    }
    if (
      y > 0 &&
      labels[cellIndex - size] === UNLABELLED &&
      habitat[cellIndex - size] === HABITAT_BIT_SET
    ) {
      labels[cellIndex - size] = label;
      queue[tail++] = cellIndex - size;
    }
    if (
      y + 1 < size &&
      labels[cellIndex + size] === UNLABELLED &&
      habitat[cellIndex + size] === HABITAT_BIT_SET
    ) {
      labels[cellIndex + size] = label;
      queue[tail++] = cellIndex + size;
    }
  }

  return { cells, x: extremeX, y: extremeY, extremeHeight, fittingCells, summonableCells };
}

/**
 * Every cell of ONE region that reaches at least `bands` into the habitat, as
 * row-major cell indices in flood order.
 *
 * WHY IT EXISTS (owner decision, 2026-08-19: spread the arrivals). A region's
 * survey carries one cell — the extreme one — and for a long time that was also
 * the summon point, which made the arrival cell a pure function of the terrain:
 * one player-dug pit one band deeper than anything else owned every future
 * arrival of every sea kind, forever. The fix is to summon among the cells that
 * QUALIFY rather than at the single cell that wins, so this reports the set and
 * summoning.ts picks from it.
 *
 * "QUALIFY" IS THE KIND'S OWN BAR, not the habitat's — `bands` is the caller's
 * `minLairReachBands`. That is what keeps the two sea kinds meaningfully
 * different after the change: the kraken's candidates are trench cells and
 * Cthulhu's are any deep water, exactly as their admission tests already differ.
 * It is also why this takes a band count rather than reading the regime's own
 * threshold — a function that spread every kind over the same set would have
 * quietly made them one animal again.
 *
 * SEEDED FROM A CELL, not from a region id, because the survey's regions are
 * scratch state that the next regime's walk overwrites: re-flooding from the
 * region's extreme cell re-derives exactly the same region (connectivity is
 * deterministic and the terrain has not moved within a tick), with no per-region
 * memory to keep alive across the tick.
 *
 * COST is one flood fill, and it is paid ONLY on a summon that has already won
 * its Poisson roll — a mean of once every SUMMON_MEAN_WAIT_SECONDS per kind, so
 * on the order of a millisecond every few minutes. That is why the set is built
 * on demand instead of being carried on every LairRegion of every survey, where
 * it would have cost a megabyte of cell lists per walk, five seconds apart,
 * forever, to answer a question almost no walk is ever asked.
 *
 * Returns an empty array if the seed cell is not habitat at all (the terrain
 * moved since the survey), which is the caller's signal to re-survey rather
 * than to summon into a stale cell.
 *
 * ORDER IS THE FLOOD'S — fixed (FIFO, west/east/north/south), so the same world
 * and the same seed cell produce the same list, and therefore the same pick.
 */
export function qualifyingCellsIn(
  regime: HabitatRegime,
  world: LairWorld,
  seedX: number,
  seedY: number,
  bands: number,
): number[] {
  const size = world.worldSize;
  if (size <= 0) return [];

  const x = Math.floor(seedX);
  const y = Math.floor(seedY);
  if (!isLairCell(regime, world, x, y)) return [];

  const scratch = scratchFor(size * size);
  scratch.labels.fill(UNLABELLED);

  const { labels, queue } = scratch;
  /** The one label this walk uses; the buffer is re-filled on every call. */
  const VISITED = 0;

  let head = 0;
  let tail = 0;
  const seedIndex = y * size + x;
  labels[seedIndex] = VISITED;
  queue[tail++] = seedIndex;

  const qualifying: number[] = [];

  while (head < tail) {
    const index = queue[head++]!;
    const cellX = index % size;
    const cellY = (index - cellX) / size;

    if (reachesIntoHabitat(regime, world.heightAt(cellX, cellY), bands)) {
      qualifying.push(index);
    }

    // The same 4-neighbourhood, in the same fixed order, as floodRegion — the
    // two must agree on what "one region" means or the candidate set could
    // include a cell the survey counted in a different region.
    if (cellX > 0 && labels[index - 1] === UNLABELLED && isLairCell(regime, world, cellX - 1, cellY)) {
      labels[index - 1] = VISITED;
      queue[tail++] = index - 1;
    }
    if (
      cellX + 1 < size &&
      labels[index + 1] === UNLABELLED &&
      isLairCell(regime, world, cellX + 1, cellY)
    ) {
      labels[index + 1] = VISITED;
      queue[tail++] = index + 1;
    }
    if (
      cellY > 0 &&
      labels[index - size] === UNLABELLED &&
      isLairCell(regime, world, cellX, cellY - 1)
    ) {
      labels[index - size] = VISITED;
      queue[tail++] = index - size;
    }
    if (
      cellY + 1 < size &&
      labels[index + size] === UNLABELLED &&
      isLairCell(regime, world, cellX, cellY + 1)
    ) {
      labels[index + size] = VISITED;
      queue[tail++] = index + size;
    }
  }

  return qualifying;
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
 * COST, MEASURED (2026-08-26, and the old figure here was wrong by ~50×). This
 * used to CLASSIFY as it walked — `isLairCell` per cell for the flood plus
 * `isLairPose`'s nine probes per fit rule on top, every one of them a WorldApi
 * getter through the plugin host's `bound()` indirection — which profiled at
 * ~100 ms per regime on a full 512² world, not the "~1 ms" the comment used to
 * claim. It now floods habitat-index.ts's maintained bitmaps and reads no
 * WorldApi at all per cell: one pass over every cell plus a BFS over the
 * habitat ones, MEASURED AT 3–6 ms for BOTH regimes together on a generated
 * 512² world (~34 ms for the first one of a process, which pays for the index
 * build itself). Re-measure with the profiling rig, not by reasoning from
 * these: the walk is proportional to how much of the board is habitat, so a
 * world that is mostly ocean costs more than one that is mostly hillside.
 *
 * The interval (LAIR_SURVEY_INTERVAL_SECONDS) and the debounced reactive path
 * (LAIR_SURVEY_DEBOUNCE_SECONDS, summoning.ts) remain the cadence: habitat
 * only changes when terrain or the unlock mask changes, and both are
 * human-paced.
 *
 * `index` is the caller's maintained HabitatIndex. It is used only when it
 * answers this exact question — same world size, same regime, same fit rules
 * (`indexAnswers`) — and a throwaway one is built otherwise, so a caller that
 * omits it (every test) gets the same answer for a little more work.
 *
 * ITERATION ORDER is fixed (row-major, then a FIFO BFS) so that two runs against
 * the same world report the same summon cell. Determinism is not required here —
 * this is not terrain math — but a survey that answered differently on identical
 * input would make every failure in this plugin harder to read.
 *
 * `fitRules` (2026-08-26) is the per-kind whole-body admission rule, ONE ROW PER
 * KIND OF THIS HABITAT in the caller's order, and every region comes back with
 * two counts against each (LairRegion.fittingCells and summonableCells).
 *
 * WHY THE CALLER PASSES A LIST RATHER THAN THE SURVEY KNOWING ONE RADIUS. The
 * survey is per HABITAT and the kinds sharing a habitat have different bodies
 * and different depth bars — Cthulhu and the kraken are both 7 cells wide but
 * want 3 and 7 bands, and the yeti is 4.81. Taking a single radius (say the
 * widest) would make the answer wrong for every other kind the moment a second
 * one joined a habitat, which is exactly how the yeti's rule came to be wrong
 * for HIM: a bar written for one animal, inherited by another. A list keeps each
 * kind's rule its own, at the cost of one extra pose test per cell per kind.
 *
 * The default is NO RULES, which reports both counts empty — for the tests and
 * for any caller that only wants sizes and connectivity. `bestLairFor`
 * (summoning.ts) treats a missing entry as zero fitting cells, so forgetting the
 * argument refuses summons rather than silently permitting pinched ones.
 */
export function surveyLairs(
  regime: HabitatRegime,
  world: LairWorld,
  occupied: ReadonlyArray<{ readonly x: number; readonly y: number }> = [],
  fitRules: readonly LairFitRule[] = [],
  index?: HabitatIndex,
): LairSurvey {
  const size = world.worldSize;
  if (size <= 0) return EMPTY_LAIR_SURVEY;

  // The maintained index when the caller has one that answers THIS question,
  // and a throwaway build otherwise (the tests, which hand in small hand-built
  // worlds and no index). One code path either way: a build produces exactly
  // the bitmaps the maintained one holds, so a test and the server survey the
  // same world the same way.
  const view =
    index !== undefined && indexAnswers(index, world, regime, fitRules)
      ? index
      : buildHabitatIndex(world, [{ regime, fitRules }]);
  const regimeIndex = view.regimes.get(regime.id)!;

  const cellCount = size * size;
  const scratch = scratchFor(cellCount);
  scratch.labels.fill(UNLABELLED);

  /** Regions, in scan order. A region's index in here IS its label. */
  const regions: LairRegion[] = [];

  for (let seedY = 0; seedY < size; seedY++) {
    for (let seedX = 0; seedX < size; seedX++) {
      const seedIndex = seedY * size + seedX;
      if (scratch.labels[seedIndex] !== UNLABELLED) continue;
      if (regimeIndex.habitat[seedIndex] !== HABITAT_BIT_SET) continue;

      regions.push(
        floodRegion(
          regime,
          view,
          regimeIndex,
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
