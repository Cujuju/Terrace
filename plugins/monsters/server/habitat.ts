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
  repairableDirtyCellCap,
} from './habitat-index.ts';
import { hashToIndex } from './rng.ts';

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
  /**
   * A bounded, uniform, DETERMINISTIC sample of the cell indices counted in
   * `summonableCells` — the set `summonCellIn` (summoning.ts) picks the arrival
   * cell out of. Index-aligned with the rule list like the two counts, and
   * empty for a rule with no summonable cell in this region.
   *
   * WHY THE SURVEY CARRIES IT (2026-09-01, #270). The pick used to re-flood the
   * whole region through the WorldApi and then re-filter every cell of it with
   * `isLairPose` — nine probes per candidate for an answer the fit bitmap
   * already holds, measured at 19.5 ms on a 68 000-cell basin and 176 ms on a
   * 447 000-cell one, once per unfilled kind per summon roll. The walk that
   * counts `summonableCells` visits exactly those cells anyway, so it samples
   * them on the way past and the pick becomes a lookup.
   *
   * A SAMPLE AND NOT THE WHOLE SET, because the whole set is the region: an
   * ocean basin would hand every survey a list of hundreds of thousands of
   * integers, per rule, five seconds apart, to answer a question asked once
   * every few minutes. See SUMMON_CANDIDATE_SAMPLE_CELLS for the size and the
   * behavioural consequence.
   */
  readonly summonCandidates: readonly (readonly number[])[];
}

/**
 * How many summonable cells of a region the survey keeps as arrival candidates.
 *
 * SIXTY-FOUR, and the number is a spread argument rather than a memory one.
 * The rule this replaces (uniform over EVERY summonable cell of the region) was
 * itself the fix for a spread defect — one player-dug pit owning every future
 * arrival — so the sample only has to be wide enough that arrivals still look
 * scattered. A kind arrives about once every SUMMON_MEAN_WAIT_SECONDS while its
 * slot is empty (four minutes), so 64 is on the order of four hours of arrivals
 * before a cell is expected to repeat, and two consecutive arrivals land on the
 * same cell with probability 1/64. Against that it costs at most 64 integers
 * per rule per region that has any summonable cell at all.
 *
 * The sample is drawn by reservoir (Algorithm R) with a hash in place of the
 * random source, so it is uniform over the region's summonable cells AND a pure
 * function of the region — see `candidateReservoirDraw`.
 */
export const SUMMON_CANDIDATE_SAMPLE_CELLS = 64;

/**
 * Odd 32-bit mixers that fold a region's identity, a rule's row and a cell's
 * ordinal into one seed for `hashToIndex`. Golden-ratio and murmur3 constants:
 * any odd word would do, but two DIFFERENT ones are what stop rule 0 of region
 * r and rule r of region 0 from drawing the same sequence.
 */
const CANDIDATE_REGION_MIX = 0x9e3779b1;
const CANDIDATE_RULE_MIX = 0x85ebca6b;

/**
 * Algorithm R's draw, made deterministic: which reservoir slot the `ordinal`-th
 * summonable cell of this region claims, or a slot past the end (meaning "not
 * sampled").
 *
 * Seeded from the region's SEED CELL rather than from its position in the
 * survey's region list, because the list is scratch that re-orders as terrain
 * moves while the seed cell is the region's own lowest cell index — so the same
 * region samples the same cells across surveys, which is what makes a re-survey
 * between the roll and the pick harmless.
 */
function candidateReservoirDraw(seedIndex: number, ruleIndex: number, ordinal: number): number {
  const seed =
    (Math.imul(seedIndex, CANDIDATE_REGION_MIX) ^
      Math.imul(ruleIndex + 1, CANDIDATE_RULE_MIX) ^
      ordinal) |
    0;
  return hashToIndex(seed, ordinal + 1);
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
 * The lair survey's REGION TABLE, kept across surveys and repaired in place.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS KEPT (2026-09-01, #269, measured).
 *
 * The survey used to start from nothing every time: `labels.fill(UNLABELLED)`
 * over the whole board, then an unconditional row-major scan of every cell to
 * find seeds, then a BFS over every habitat cell — on a 2048² world, 32 ms of
 * it per pass before a single region had been measured, and a hard floor of
 * that much even on a board with no habitat at all. It ran on the five-second
 * timer AND half a second after every sculpt burst, to re-derive a table that a
 * 29-cell diff had changed almost none of.
 *
 * So the labels and the components survive, and a survey does one of three
 * things:
 *
 *   * NOTHING CHANGED (the ordinary five-second tick) — reuse the table
 *     outright and answer only the per-occupant question, which is O(monsters);
 *   * A BOUNDED CHANGE (a sculpt, an unlocked chunk) — delete the components
 *     the changed cells belong to or touch, and re-flood just those. The
 *     changed cells are habitat-index.ts's `dirtyCells`, which lists a cell
 *     only when its height, its habitat bit or one of its fit bits actually
 *     moved;
 *   * A BOARD-SCALE CHANGE (the list outgrew `repairableDirtyCellCap`, or the
 *     index itself was rebuilt) — the old whole-board walk, unchanged.
 *
 * THE OUTPUT IS THE SAME IN ALL THREE, and two rules are what make it so:
 * a component's identity is its LOWEST CELL INDEX (`seedIndex`), which is
 * exactly the seed a row-major scan would have found it at, so sorting the
 * components by it reproduces the scan order the regions used to come back in;
 * and a repaired component is re-walked FROM that seed before its region is
 * measured, so the FIFO visit order — which breaks ties on the extreme cell and
 * orders the arrival sample — is the order a full survey would have walked it
 * in.
 *
 * A STALE LABEL IS NOT CLEARED, IT IS ORPHANED. Clearing is the cost being
 * avoided: a `fill` over 4.19 M cells is a third of the floor this file is
 * removing. Component ids are never reused, so a cell whose component has been
 * deleted reads as unowned (`components.has(labels[cell])` is false) with no
 * write at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */
interface SurveyComponent {
  /** Never reused, which is what lets a deleted component orphan its labels. */
  id: number;
  /** Lowest cell index in the component — its seed under a row-major scan. */
  seedIndex: number;
  region: LairRegion;
}

interface SurveyTable {
  /** Owning component id per cell, or a dead/never-written id (see above). */
  readonly labels: Int32Array;
  readonly components: Map<number, SurveyComponent>;
  nextComponentId: number;
  /** The components' regions, in seed order — what a survey returns. */
  regions: LairRegion[];
}

/**
 * The kept tables, one per regime, and the index they were built against.
 *
 * KEYED ON THE INDEX OBJECT, not on the world: `surveyLairs` builds a throwaway
 * index when the caller hands it none (every test does), and a throwaway is a
 * new object every call — so those callers miss the cache and get the
 * whole-board walk, which is the same answer for the same work they always
 * paid. The server hands in the maintained index, which is one object for the
 * life of a world.
 */
let tableIndex: HabitatIndex | null = null;
const tables = new Map<HabitatRegimeId, SurveyTable>();

/**
 * BFS scratch, cached across surveys: a 2048² world needs 16 MB of it and the
 * working set never changes size.
 *
 * ONE queue for ALL regimes, and that is safe because surveys are SEQUENTIAL: a
 * survey fills it, reads it and returns before the next one starts. Nothing
 * here is re-entrant and nothing holds a reference past its own call.
 */
let queue: Int32Array | null = null;

/** No component owns this cell, and none ever has. */
const UNLABELLED = -1;

function queueFor(cellCount: number): Int32Array {
  if (queue === null || queue.length !== cellCount) queue = new Int32Array(cellCount);
  return queue;
}

/** Frees the scratch and the kept tables (used by the plugin's reset seam). */
export function releaseSurveyScratch(): void {
  queue = null;
  tableIndex = null;
  tables.clear();
}

/** Is this cell owned by a component that is still part of the table? */
function isOwned(table: SurveyTable, cellIndex: number): boolean {
  const owner = table.labels[cellIndex]!;
  return owner !== UNLABELLED && table.components.has(owner);
}

/**
 * `walkComponent`'s two CLAIMING modes, as values of its `claimFrom` argument.
 * Any other value is a component id, and means "relabel that component's cells,
 * do not claim anything new".
 *
 * TWO CLAIMING MODES AND NOT ONE, because the membership test differs in cost
 * by a hash lookup per neighbour. A whole-board walk starts from a cleared label
 * array, so "nobody owns this cell" is the array read `labels[n] === UNLABELLED`
 * — four of those per cell over four million cells is the walk's whole inner
 * loop, and asking the component map instead would put a `Map.has` there. A
 * repair walks a board whose labels are full of orphaned ids, where only the map
 * can tell an orphan from a live owner; it pays the lookup, over the handful of
 * components the repair actually touches.
 */
const WALK_CLAIM_FRESH = -2;
const WALK_CLAIM_UNOWNED = -3;

/**
 * Walks one connected component of habitat from `seedIndex`, writing `ownerId`
 * into every cell it reaches and measuring the region as it goes.
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
 *
 * `minIndex` comes back with the region because a repair does not get to choose
 * its seed — it starts from a cell near the change — and a component's IDENTITY
 * and its measurement order are both defined by its lowest cell index. The
 * caller re-walks in RELABEL mode from `minIndex` when the two differ; see
 * `repairTable`.
 */
function walkComponent(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
  queue: Int32Array,
  seedIndex: number,
  ownerId: number,
  claimFrom: number,
): { readonly minIndex: number; readonly region: LairRegion } {
  const size = index.size;
  const { heights } = index;
  const { habitat, fit, rules } = regimeIndex;
  const labels = table.labels;
  const claimFresh = claimFrom === WALK_CLAIM_FRESH;
  const claimUnowned = claimFrom === WALK_CLAIM_UNOWNED;

  let head = 0;
  let tail = 0;
  labels[seedIndex] = ownerId;
  queue[tail++] = seedIndex;

  let cells = 0;
  let minIndex = seedIndex;
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
  /** The arrival sample per rule; see LairRegion.summonCandidates. */
  const summonCandidates: number[][] = rules.map(() => []);

  while (head < tail) {
    const cellIndex = queue[head++]!;
    const x = cellIndex % size;
    const y = (cellIndex - x) / size;
    cells++;
    if (cellIndex < minIndex) minIndex = cellIndex;

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
      if (!reachesIntoHabitat(regime, height, rules[rule]!.minReachBands)) continue;
      // The ordinal of this cell among the region's summonable ones, which is
      // what Algorithm R draws against. Read before the increment so the first
      // one is ordinal 0.
      const ordinal = summonableCells[rule]!;
      summonableCells[rule]!++;
      const reservoir = summonCandidates[rule]!;
      if (ordinal < SUMMON_CANDIDATE_SAMPLE_CELLS) {
        reservoir.push(cellIndex);
        continue;
      }
      const slot = candidateReservoirDraw(seedIndex, rule, ordinal);
      if (slot < SUMMON_CANDIDATE_SAMPLE_CELLS) reservoir[slot] = cellIndex;
    }

    // 4-neighbourhood, in a fixed order: west, east, north, south. The
    // admission test is spelled out at each rather than lifted into a helper:
    // this is the file's innermost loop, and the three modes differ by whether
    // they read an array, a map or an id (see WALK_CLAIM_FRESH).
    if (x > 0) {
      const next = cellIndex - 1;
      if (
        claimFresh
          ? habitat[next] === HABITAT_BIT_SET && labels[next] === UNLABELLED
          : claimUnowned
            ? habitat[next] === HABITAT_BIT_SET && !isOwned(table, next)
            : labels[next] === claimFrom
      ) {
        labels[next] = ownerId;
        queue[tail++] = next;
      }
    }
    if (x + 1 < size) {
      const next = cellIndex + 1;
      if (
        claimFresh
          ? habitat[next] === HABITAT_BIT_SET && labels[next] === UNLABELLED
          : claimUnowned
            ? habitat[next] === HABITAT_BIT_SET && !isOwned(table, next)
            : labels[next] === claimFrom
      ) {
        labels[next] = ownerId;
        queue[tail++] = next;
      }
    }
    if (y > 0) {
      const next = cellIndex - size;
      if (
        claimFresh
          ? habitat[next] === HABITAT_BIT_SET && labels[next] === UNLABELLED
          : claimUnowned
            ? habitat[next] === HABITAT_BIT_SET && !isOwned(table, next)
            : labels[next] === claimFrom
      ) {
        labels[next] = ownerId;
        queue[tail++] = next;
      }
    }
    if (y + 1 < size) {
      const next = cellIndex + size;
      if (
        claimFresh
          ? habitat[next] === HABITAT_BIT_SET && labels[next] === UNLABELLED
          : claimUnowned
            ? habitat[next] === HABITAT_BIT_SET && !isOwned(table, next)
            : labels[next] === claimFrom
      ) {
        labels[next] = ownerId;
        queue[tail++] = next;
      }
    }
  }

  return {
    minIndex,
    region: {
      cells,
      x: extremeX,
      y: extremeY,
      extremeHeight,
      fittingCells,
      summonableCells,
      summonCandidates,
    },
  };
}

/**
 * A region measured from a walk whose seed was not the component's lowest cell,
 * re-walked from that cell so its measurement order is the one a whole-board
 * scan would have used.
 *
 * TWO WALKS AND NOT ONE, and only on the repair path. The tie-break on the
 * extreme cell and the ordinals the arrival sample is drawn against are both
 * FIFO visit order, so a component walked from a cell near a sculpt would
 * report a different (equally valid, but different) extreme cell than the same
 * component walked from its scan seed. The re-walk costs a second pass over one
 * component; disagreeing with the whole-board path would cost the guarantee
 * that a repair and a rebuild produce the same table.
 *
 * The re-walk RELABELS to a fresh id, which is what marks its own visited
 * cells: the cells it may enter are exactly those the claiming walk labelled,
 * and rewriting each on arrival is the same test the claiming walk got from
 * `labels[n] === UNLABELLED`.
 */
function remeasureFromSeed(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
  queue: Int32Array,
  minIndex: number,
  claimedId: number,
): { readonly id: number; readonly region: LairRegion } {
  const id = table.nextComponentId++;
  const walk = walkComponent(regime, index, regimeIndex, table, queue, minIndex, id, claimedId);
  return { id, region: walk.region };
}

/** The region a component is given while its own walk is still running. */
const EMPTY_LAIR_REGION: LairRegion = {
  cells: 0,
  x: 0,
  y: 0,
  extremeHeight: 0,
  fittingCells: [],
  summonableCells: [],
  summonCandidates: [],
};

/**
 * Walks the whole board and rebuilds this regime's table from nothing — the
 * path a first survey, a rebuilt index and a board-scale change all take, and
 * the path every caller that hands in no index takes.
 */
function rebuildTable(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
): void {
  const size = index.size;
  const { labels, components } = table;
  const cellQueue = queueFor(size * size);

  labels.fill(UNLABELLED);
  components.clear();
  table.nextComponentId = 0;

  const regions: LairRegion[] = [];
  for (let seedY = 0; seedY < size; seedY++) {
    for (let seedX = 0; seedX < size; seedX++) {
      const seedIndex = seedY * size + seedX;
      if (labels[seedIndex] !== UNLABELLED) continue;
      if (regimeIndex.habitat[seedIndex] !== HABITAT_BIT_SET) continue;

      const id = table.nextComponentId++;
      const walk = walkComponent(
        regime,
        index,
        regimeIndex,
        table,
        cellQueue,
        seedIndex,
        id,
        WALK_CLAIM_FRESH,
      );
      // The scan reaches a component at its lowest cell index by construction,
      // so this walk's seed IS the canonical one and its measurement stands.
      components.set(id, { id, seedIndex, region: walk.region });
      regions.push(walk.region);
    }
  }
  table.regions = regions;
}

/**
 * Repairs this regime's table for the cells habitat-index.ts listed as moved.
 *
 * TWO PHASES, AND THEY CANNOT BE ONE. Every component a listed cell belongs to
 * or touches is deleted FIRST, and only then is anything re-flooded — because a
 * change can MERGE two components (a cell that became habitat between them) and
 * a re-flood that met a still-live neighbour would either stop at it and split
 * one component in two, or absorb its cells without deleting its entry.
 *
 * WHY DELETING THE NEIGHBOURS' COMPONENTS IS ENOUGH. A component can only lose
 * cells at a listed cell, so any piece it breaks into is adjacent to one; and a
 * component can only gain cells at a listed cell, so any component it merges
 * with is adjacent to one too. A component that is neither adjacent to nor
 * containing a listed cell is untouched, and keeping it is the whole saving.
 *
 * WHY A DELETED COMPONENT'S CELLS ARE NOT UNLABELLED. They read as unowned
 * through `isOwned` because ids are never reused; clearing them would be the
 * whole-board write this repair exists to avoid.
 */
function repairTable(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
  dirtyCells: readonly number[],
): void {
  const size = index.size;
  const cellCount = size * size;
  const { labels, components } = table;
  const habitat = regimeIndex.habitat;
  const cellQueue = queueFor(cellCount);

  for (const cell of dirtyCells) {
    if (cell < 0 || cell >= cellCount) continue;
    // The cell's OWN component, whether or not it is still habitat: a cell that
    // stopped being habitat still has to take its old component apart.
    const owner = labels[cell]!;
    if (owner !== UNLABELLED) components.delete(owner);
    const x = cell % size;
    const y = (cell - x) / size;
    if (x > 0 && habitat[cell - 1] === HABITAT_BIT_SET) components.delete(labels[cell - 1]!);
    if (x + 1 < size && habitat[cell + 1] === HABITAT_BIT_SET) {
      components.delete(labels[cell + 1]!);
    }
    if (y > 0 && habitat[cell - size] === HABITAT_BIT_SET) {
      components.delete(labels[cell - size]!);
    }
    if (y + 1 < size && habitat[cell + size] === HABITAT_BIT_SET) {
      components.delete(labels[cell + size]!);
    }
  }

  for (const cell of dirtyCells) {
    if (cell < 0 || cell >= cellCount) continue;
    const x = cell % size;
    const y = (cell - x) / size;
    // The listed cell and its four neighbours, in the same fixed order the walk
    // uses. Seed order does not change the components — connectivity is a
    // property of the board — but a fixed order keeps two runs identical.
    reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell);
    if (x > 0) reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell - 1);
    if (x + 1 < size) reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell + 1);
    if (y > 0) reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell - size);
    if (y + 1 < size) reclaimFrom(regime, index, regimeIndex, table, cellQueue, cell + size);
  }

  // Scan order, restored: a component's seed index is the cell a whole-board
  // scan would have found it at, so this IS the order `rebuildTable` produces.
  const ordered = [...components.values()].sort((a, b) => a.seedIndex - b.seedIndex);
  table.regions = ordered.map((component) => component.region);
}

/**
 * Claims the component containing `seedIndex` if it is habitat that no live
 * component owns, and measures it from its own lowest cell.
 *
 * A no-op for a cell that is not habitat or is already owned, which is what
 * makes the repair's seed list free to contain duplicates and neighbours of
 * neighbours.
 */
function reclaimFrom(
  regime: HabitatRegime,
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  table: SurveyTable,
  cellQueue: Int32Array,
  seedIndex: number,
): void {
  if (regimeIndex.habitat[seedIndex] !== HABITAT_BIT_SET) return;
  if (isOwned(table, seedIndex)) return;

  const claimedId = table.nextComponentId++;
  // Registered before the walk so its own claimed cells read as OWNED, which is
  // what stops the walk re-entering them through `isOwned`.
  table.components.set(claimedId, {
    id: claimedId,
    seedIndex,
    region: EMPTY_LAIR_REGION,
  });
  const walk = walkComponent(
    regime,
    index,
    regimeIndex,
    table,
    cellQueue,
    seedIndex,
    claimedId,
    WALK_CLAIM_UNOWNED,
  );

  if (walk.minIndex === seedIndex) {
    table.components.set(claimedId, { id: claimedId, seedIndex, region: walk.region });
    return;
  }

  // The claim started somewhere other than the component's scan seed, so its
  // visit order is not the one a whole-board walk would have used. Re-walk from
  // the seed, relabelling as it goes (see remeasureFromSeed).
  table.components.delete(claimedId);
  const measured = remeasureFromSeed(
    regime,
    index,
    regimeIndex,
    table,
    cellQueue,
    walk.minIndex,
    claimedId,
  );
  table.components.set(measured.id, {
    id: measured.id,
    seedIndex: walk.minIndex,
    region: measured.region,
  });
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
 * WorldApi at all per cell.
 *
 * RE-MEASURED 2026-09-01 (#269) on a generated 2048² world, BOTH regimes per
 * pass. The bitmap walk was still a whole-board one, and that was still 32 ms
 * per pass — every five seconds, and again half a second after every sculpt
 * burst. With the kept region table (see SurveyComponent above):
 *
 *   * nothing changed since the last pass — 0.00 ms (a per-occupant lookup);
 *   * a 29-cell sculpt diff — 0.26 ms typical, 8.0 ms worst case (the diff
 *     landed inside the board's biggest basin, 67 769 cells, so that whole
 *     component is re-flooded);
 *   * a held stroke of sixty diffs, debounced into one pass — 6.5 ms;
 *   * a board-scale change or a rebuilt index — the whole-board walk, 32 ms,
 *     unchanged.
 *
 * Re-measure with the profiling rig, not by reasoning from these: both the walk
 * and the repair are proportional to how much of the board is habitat and to
 * how big the components a change lands in are.
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
  // A different index object means a different world (or a rebuilt one), and
  // every kept table describes the old one.
  if (tableIndex !== view) {
    tableIndex = view;
    tables.clear();
  }

  let table = tables.get(regime.id);
  if (table === undefined || table.labels.length !== cellCount) {
    table = {
      labels: new Int32Array(cellCount),
      components: new Map<number, SurveyComponent>(),
      nextComponentId: 0,
      regions: [],
    };
    tables.set(regime.id, table);
    rebuildTable(regime, view, regimeIndex, table);
    regimeIndex.dirtyCells.length = 0;
  } else {
    const dirtyCells = regimeIndex.dirtyCells;
    if (dirtyCells.length > repairableDirtyCellCap(cellCount)) {
      rebuildTable(regime, view, regimeIndex, table);
    } else if (dirtyCells.length > 0) {
      repairTable(regime, view, regimeIndex, table, dirtyCells);
    }
    dirtyCells.length = 0;
  }

  // One answer per queried occupant, in the caller's order (see LairSurvey).
  const labels = table.labels;
  const components = table.components;
  const occupiedRegionCells = occupied.map((position) => {
    const x = Math.floor(position.x);
    const y = Math.floor(position.y);
    if (x < 0 || y < 0 || x >= size || y >= size) return 0;
    const component = components.get(labels[y * size + x]!);
    // An orphaned label — a component the last repair took apart and did not
    // put this cell back into — means the cell is not habitat any more, which
    // is the same answer UNLABELLED gave.
    return component === undefined ? 0 : component.region.cells;
  });

  return { regions: table.regions, occupiedRegionCells };
}
