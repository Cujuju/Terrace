// Habitat classification and the per-species tuning table.
//
// Everything here is a design decision expressed as a named constant. Two rules
// govern the numbers:
//
//   1. Habitat thresholds are written in BAND_HEIGHT terms, never as raw height
//      units. BAND_HEIGHT is explicitly provisional (shared/src/constants.ts
//      "feel-tune in Phase 2"); "three bands below the sea" survives a retune,
//      "-192" does not.
//   2. Habitats are DISJOINT and EXHAUSTIVE over the height range. Every cell is
//      exactly one of land / shallow / deep. If they overlapped, a creature
//      could stand in two habitats; if they left a gap, a creature could drift
//      into a no-man's-land and be despawned by the habitat-loss rule for having
//      done nothing but swim in a straight line.

import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import {
  DEFAULT_SIZE_CLASS,
  WILDLIFE_SIZE_CLASSES,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../protocol.ts';

/** Where a creature can live. Derived from cell height alone (see rule 2). */
export type Habitat = 'land' | 'shallow' | 'deep';

/**
 * Depth, in terrace bands below sea level, at which water stops being coastal
 * shallows and becomes open sea.
 *
 * Three bands. The gradient limit is MAX_STEP = BAND_HEIGHT/2, so terrain can
 * fall at most half a band per cell: a cell this deep is at least six cells from
 * the nearest shoreline. That is what makes the threshold meaningful rather than
 * arbitrary — "deep" is water a whale can be IN, not a puddle it would be
 * beached in the middle of. It is also three world units of water column
 * (HEIGHT_WORLD_SCALE maps one band to one world unit), enough to hold the
 * 5-cell-long whale model clear of both the seabed and the surface.
 */
export const DEEP_WATER_BANDS_BELOW_SEA = 3;

/** Heights at or below this are deep water; above it, up to SEA_LEVEL, shallow. */
export const DEEP_WATER_MAX_HEIGHT = SEA_LEVEL - DEEP_WATER_BANDS_BELOW_SEA * BAND_HEIGHT;

/**
 * Classifies one cell height. Mirrors shared's `isWater` (h <= SEA_LEVEL is
 * water) and then splits the water range once.
 */
export function habitatOf(height: number): Habitat {
  if (height > SEA_LEVEL) return 'land';
  return height <= DEEP_WATER_MAX_HEIGHT ? 'deep' : 'shallow';
}

// ── Size classes ─────────────────────────────────────────────────────────────
//
// Owner, 2026-08-14: "fish come in three sizes; smaller fish should be more
// likely to school". Size is drawn once per SPAWN GROUP, not per individual, for
// two reasons: a real shoal is size-graded rather than a jumble, and the
// schooling decision below is a property of the group, so drawing size per
// member would leave a group with no single answer to "does this one school".

/**
 * Relative spawn weight of each size class, per species. Weights are drawn
 * against their own sum, so they are ratios and nothing needs to add up to 1.
 *
 * A species whose only non-zero weight is DEFAULT_SIZE_CLASS has exactly one
 * size — which is every species but fish today, and is why nothing else in this
 * plugin needs a "does this species vary in size" flag.
 */
export type SizeWeights = Readonly<Record<WildlifeSizeClass, number>>;

/**
 * The one-size table: every non-fish species. Derived from DEFAULT_SIZE_CLASS
 * rather than typed out, so "the size everything else is" stays one decision
 * made in protocol.ts (where the model scale of 1 is pinned to it).
 */
const SINGLE_SIZE_WEIGHTS: SizeWeights = Object.fromEntries(
  WILDLIFE_SIZE_CLASSES.map((sizeClass) => [sizeClass, sizeClass === DEFAULT_SIZE_CLASS ? 1 : 0]),
) as SizeWeights;

/**
 * Fish size mix: 6 : 3 : 1 small : medium : large.
 *
 * Ecology reads the same way at every scale — small fish are the many, big fish
 * are the few — and it is also what makes the SCHOOLING PROBABILITIES below
 * visible rather than theoretical: at these weights 60% of fish groups draw the
 * strongly-schooling class, so a player looking at a shelf sees schools as the
 * normal case and a lone big fish as the exception. Reversing the ratio would
 * make "no schools" the common sight again, which is the reported bug.
 */
export const FISH_SIZE_WEIGHTS: SizeWeights = { small: 6, medium: 3, large: 1 };

/**
 * Chance that a spawn group of a group-spawning species forms a SCHOOL — one
 * cohesive body that steers together (movement.ts) and departs together
 * (population.ts) — rather than that many independent individuals that merely
 * happened to appear in the same place.
 *
 * This is the "smaller fish school more" dial, and it is a probability rather
 * than a hard rule so that every size can still be seen doing both: a lone small
 * fish and a rare pair of big ones are both possible, they are just not typical.
 *
 *   small  0.9 — schooling is what a small fish does; the 1-in-10 loner is the
 *                exception that stops the shelf looking mechanical.
 *   medium 0.5 — genuinely mixed; a medium group is a coin flip.
 *   large  0.1 — "mostly solitary" stated as a number. Nine large groups in ten
 *                disperse immediately, which is exactly the pre-schooling
 *                behaviour, so a big fish reads as a big fish alone.
 *
 * Irrelevant for a species whose groupSize is 1: a group of one is its own
 * school under either branch, so the roll cannot change anything.
 */
export const SCHOOLING_PROBABILITY_BY_SIZE: Readonly<Record<WildlifeSizeClass, number>> = {
  small: 0.9,
  medium: 0.5,
  large: 0.1,
};

/**
 * How loosely each size class holds together once it HAS formed a school.
 *
 * One multiplier, applied to the two cohesion radii and (reciprocally) to the
 * maximum cohesion turn rate in movement.ts, so a single number says everything
 * about a class's schooling character: 1 is the tight baseline the constants in
 * movement.ts are written for, and larger values mean "further apart AND slower
 * to close the gap". Big fish keeping a body length or two more space than small
 * ones is the same rule real shoals follow — spacing scales with body size.
 */
export const SCHOOL_LOOSENESS_BY_SIZE: Readonly<Record<WildlifeSizeClass, number>> = {
  small: 1,
  medium: 1.5,
  large: 2,
};

/** Tuning for one species. All rates are per SECOND of simulated time. */
export interface SpeciesProfile {
  readonly species: WildlifeSpecies;
  readonly habitat: Habitat;

  /** Ordinary wander speed, cells per second. */
  readonly cruiseSpeedCellsPerSecond: number;

  /**
   * Maximum random heading change, radians per second. This is the "how twitchy
   * is it" dial: high values read as darting, low values as gliding.
   */
  readonly turnNoiseRadiansPerSecond: number;

  /**
   * Nose-to-tail length in cells (CELL_WORLD_SIZE is 1, so also world units).
   * Doubles as the minimum look-ahead distance — a creature must never commit to
   * a step that puts its own body outside its habitat.
   */
  readonly bodyLengthCells: number;

  /**
   * Habitat cells required per individual. This is the population dial, and it
   * is expressed as an AREA density rather than a flat count so that a world
   * with one unlocked chunk holds a handful of creatures and a fully revealed
   * 512² world holds a full ecosystem, with no separate small/large-world case.
   *
   * RETUNED 2026-08-14 (owner: "we need more wildlife, I don't see any deep sea
   * creatures") and again 2026-08-14 for FISH ONLY (owner: "I see individual
   * fish but I haven't seen any schools of fish" — see FISH_SCHOOLS_ON_FRESH_SHELF
   * below). Two worlds are sized against, and both matter:
   *
   * (a) A FRESH world — since 2026-08-14 an ocean with a coast: a shallow shelf
   *     and slope ring at the centre, open sea beyond (server/src/world/
   *     world.ts). The census only counts UNLOCKED cells, so day one is bounded
   *     by the starter square — INITIAL_UNLOCK_CHUNK_SPAN² chunks = 128×128 =
   *     16 384 cells, the same on every world size — split by that genesis
   *     profile into 4 096 shallow and 12 288 deep:
   *
   *       fish     4 096 /   400 = 10      deepsea  12 288 / 1 500 = 8
   *       whale   12 288 / 5 000 =  2      grazer            — = 0
   *
   *     Grazers alone have nothing on day one: there is no land until a player
   *     raises an island, and that is the intended shape of a world that starts
   *     as an ocean.
   *
   *     This is the case the owner's report was about, and it is why the two
   *     DEEP densities move much further than the other two: they were sized
   *     when deep water was a rare, remote habitat, and it is now three
   *     quarters of the ground a brand-new server opens on. It also makes the
   *     deep densities the binding constraint on the shelf's size — see
   *     FRESH_SHELF_SPAN_DIVISOR, which is chosen against the whale figure here.
   *
   * (b) A nominal half-land / half-water 512² world at full reveal (262 144
   *     cells; ~131 000 land, of the water roughly 40% shallow / 60% open sea):
   *
   *       fish     52 429 /   400 = 131     grazer   131 072 / 2 700 = 48
   *       deepsea  78 643 / 1 500 =  52     whale     78 643 / 5 000 = 15
   *
   *     246 asked for. WILDLIFE_POPULATION_CAP (150) scales every species down
   *     by 150/246 = 0.6098 and floors, giving 148 (79 fish / 31 deepsea /
   *     29 grazer / 9 whale).
   *
   * HONEST NOTE ON THE CAP, RECOMPUTED FOR THE FISH RETUNE. The cap was once a
   * safety rail nothing rode; after the first retune a fully revealed 512² world
   * rode it and lost ~10%; after this one it loses 40% (148 of 246). The shape
   * survives — the scaling is proportional, so a capped world is a smaller
   * ecosystem, not a distorted one — but two things are now true and are worth
   * saying rather than discovering later:
   *
   *   * FISH ARE THE MAJORITY SPECIES at full reveal (79 of 148, 53%). That is
   *     the deliberate cost of the school retune: schools are five fish each, so
   *     "enough fish to see schools" is arithmetically "a lot of fish". At 79
   *     that is ~16 schools spread over a whole revealed world.
   *   * The cap now BINDS at roughly 60% of a fully revealed 512² world's
   *     unlocked area, so it is the population dial for large late-game worlds
   *     while the densities here are the dial for everything before that.
   *
   * Raising the cap was considered and rejected: it is a bandwidth budget
   * (census.ts shows the per-message arithmetic), and 150 is what keeps a
   * self-hoster's ~10-player figure intact. Fish density is the number that
   * moved, and the cap is what stops it from costing bandwidth on big worlds.
   */
  readonly habitatCellsPerIndividual: number;

  /**
   * How many spawn at once, and therefore the size of a school.
   *
   * A group spawns as a jittered cluster sharing one heading AND one school id
   * (population.ts), and — when the schooling roll fires — holds together from
   * then on under the cohesion steering in movement.ts. Fish shoal; everything
   * else is solitary, and a solitary species' group of one is its own school,
   * which makes every school rule in this plugin degenerate correctly rather
   * than needing a "does this species school" branch.
   */
  readonly groupSize: number;

  /** Size-class mix at spawn. See FISH_SIZE_WEIGHTS / SINGLE_SIZE_WEIGHTS. */
  readonly sizeWeights: SizeWeights;
}

/**
 * Schools a brand-new world's shelf must be able to hold, and the reason the
 * fish density is 400 rather than 1 000.
 *
 * THE VISIBLE-DENSITY ARGUMENT. A school is a thing you recognise by seeing more
 * than one of them: one blob of fish on an otherwise empty shelf is just "the
 * fish", and at the old density the shelf's whole fish budget was 4 — less than
 * one full group of `groupSize` (5), so a fresh world could not contain a
 * complete school at all, let alone two. Two is the smallest number that makes
 * "school" a category rather than a singular noun.
 *
 * The arithmetic, against the genesis geometry (server/src/world/world.ts): the
 * starter square is 128×128 = 16 384 cells of which 4 096 are shelf, so a
 * density of D gives floor(4 096 / D) fish, and
 *
 *     FISH_SCHOOLS_ON_FRESH_SHELF × groupSize = 2 × 5 = 10 fish
 *     4 096 / 10 = 409.6  →  D = 400  (floor(4 096/400) = 10, exactly two schools)
 *
 * 400 rather than 409 because it is a round number with the same outcome and
 * a little headroom: at 409 a one-cell change in the shelf geometry would drop
 * the tenth fish and leave a truncated second school.
 *
 * The plugin cannot import the genesis constants (core owns them and must not be
 * imported by a plugin's tuning table), so this relation is PINNED BY TEST in
 * plugins/wildlife/test/wildlife.test.ts against a real World.createFresh census
 * rather than restated here as a magic 4 096.
 */
export const FISH_SCHOOLS_ON_FRESH_SHELF = 2;

/**
 * Speeds are set relative to each other, not measured against anything: the
 * design brief is "whales slow and stately, fish quicker, terrestrial moderate".
 * A fish crosses one chunk (16 cells) in ~5 s; a whale takes ~20 s. At the
 * broadcast cadence (5 Hz) the fastest of them moves 0.6 cells between updates,
 * which is what makes 5 Hz + interpolation indistinguishable from 10 Hz.
 */
export const SPECIES_PROFILES: Readonly<Record<WildlifeSpecies, SpeciesProfile>> = {
  fish: {
    species: 'fish',
    habitat: 'shallow',
    cruiseSpeedCellsPerSecond: 3,
    turnNoiseRadiansPerSecond: 1.4,
    bodyLengthCells: 0.7,
    // 1 000 → 400. See FISH_SCHOOLS_ON_FRESH_SHELF: a school is only a school if
    // you can see it is one, and at 1 000 the day-one shelf could hold FOUR fish
    // in total — one truncated group, indistinguishable from four singletons.
    habitatCellsPerIndividual: 400,
    groupSize: 5,
    sizeWeights: FISH_SIZE_WEIGHTS,
  },
  whale: {
    species: 'whale',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: 0.8,
    turnNoiseRadiansPerSecond: 0.25,
    bodyLengthCells: 5,
    // 20 000 → 5 000. The binding requirement: a fresh world's 12 288 cells of
    // open sea inside the starter square must hold whales on day one, and
    // 12 288/5 000 = 2 does. The old figure asked for 0 there — the owner's "I
    // don't see any deep sea creatures" was, for whales, arithmetically
    // guaranteed.
    habitatCellsPerIndividual: 5000,
    groupSize: 1,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
  },
  deepsea: {
    species: 'deepsea',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: 1.2,
    turnNoiseRadiansPerSecond: 0.9,
    bodyLengthCells: 1.2,
    // 6 000 → 1 500. Deep water is three quarters of a fresh world's starter
    // region, so it needs the density of a populated habitat rather than of a
    // rarity: 8 on day one, ~46 on a capped full 512².
    habitatCellsPerIndividual: 1500,
    groupSize: 1,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
  },
  grazer: {
    species: 'grazer',
    habitat: 'land',
    cruiseSpeedCellsPerSecond: 1.6,
    turnNoiseRadiansPerSecond: 1.1,
    bodyLengthCells: 1.1,
    // 4 000 → 2 700: half again as many grazers per hillside, matching fish.
    habitatCellsPerIndividual: 2700,
    groupSize: 1,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
  },
};

/** Deterministic iteration order over species (see WILDLIFE_SPECIES). */
export function profileOf(species: WildlifeSpecies): SpeciesProfile {
  return SPECIES_PROFILES[species];
}
