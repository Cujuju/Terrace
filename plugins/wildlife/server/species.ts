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

import {
  DEEP_WATER_BANDS_BELOW_SEA,
  DEEP_WATER_MAX_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  UNCONSTRAINED_GRADIENT_PER_CELL,
  WORLD_UNIT_CELLS,
  cellsAcross,
  cellsOverArea,
  groundOf,
} from '@terrace/shared';
import {
  DEFAULT_SIZE_CLASS,
  WILDLIFE_SIZE_CLASSES,
  type WildlifeHabitatSpecies,
  type WildlifeSizeClass,
} from '../protocol.ts';

/** Where a creature can live. Derived from cell height alone (see rule 2). */
export type Habitat = 'land' | 'shallow' | 'deep';

// DEEP_WATER_BANDS_BELOW_SEA / DEEP_WATER_MAX_HEIGHT moved to
// shared/src/traversal.ts (2026-08-19, the pilgrims/wildlife pathing
// contract) — the reasoning ("deep is water a whale can be IN, not a puddle
// it would be beached in the middle of") is unchanged; re-exported here so
// nothing that already imports these two names from THIS module has to move.
export { DEEP_WATER_BANDS_BELOW_SEA, DEEP_WATER_MAX_HEIGHT };

/**
 * Classifies one cell height. A thin wrapper over shared's `groundOf`: this
 * plugin's `Habitat` union predates and reads better in wildlife code than
 * shared's `TerrainGround` (`land` vs. `dry`), so the two stay distinct types
 * that happen to share every value but one, rather than importing shared's
 * naming into every wildlife call site.
 */
export function habitatOf(height: number): Habitat {
  const ground = groundOf(height);
  return ground === 'dry' ? 'land' : ground;
}

// ── Gradient limits ──────────────────────────────────────────────────────────
//
// Owner, 2026-08-19: "the animals/wildlife on the terrestrial side are
// traveling across the map with no regard for separate levels … a four-legged
// thing walk[s] across the slope of ten-plus terrace layers like it's
// nothing." Habitat classification (habitatOf, above) only asks WHAT a cell
// is, never how the ground gets there — so a sheer terrace riser and a flat
// lawn were indistinguishable to a land creature as long as both were "land".
// This section is the missing term: how much height change per cell of
// travel a species will accept, checked by census.ts's canTraverse.

/**
 * Aquatic species' gradient limit: unconstrained. Water has no risers — a
 * fish or whale is never blocked by the STEEPNESS of the seabed beneath it,
 * only by habitat class (still water vs. not) and unlock state, which
 * isValidCellFor already covers. Infinity rather than a species-specific
 * branch downstream: canTraverse treats "no limit" as "skip the sampling
 * loop entirely" via Number.isFinite, so every species answers the same
 * maxGradientPerCell question and nothing needs a "does this species care
 * about slope" flag.
 *
 * MOVED to shared/src/traversal.ts (2026-08-19, the pilgrims/wildlife pathing
 * contract) as UNCONSTRAINED_GRADIENT_PER_CELL — "water has no risers" is
 * terrain math, not a wildlife fact, and pilgrims' own aquatic-adjacent
 * profiles (none today, but the contract is shared regardless) get it for
 * free. Re-exported under this name so this plugin's own call sites and
 * tests don't have to rename.
 */
export const AQUATIC_MAX_GRADIENT_PER_CELL = UNCONSTRAINED_GRADIENT_PER_CELL;

/**
 * Grazer's gradient limit: the most height a grazer will climb or descend in
 * ONE CELL of travel, before it turns along the level instead of crossing.
 *
 * MOVED to shared/src/traversal.ts as LAND_WALKER_MAX_GRADIENT_PER_CELL
 * (2026-08-19) — the full derivation (half of MAX_STEP, the terrain's own
 * gradient cap) lives there now, generalised past "grazer": pilgrims' and
 * wanderers' land-walk profile uses the exact same number for the exact same
 * reason, and before this move each plugin re-derived (or, for pilgrims,
 * simply never derived) it independently. This re-export keeps the
 * grazer-specific name for this plugin's own call sites and tests.
 */
export const GRAZER_MAX_GRADIENT_PER_CELL = LAND_WALKER_MAX_GRADIENT_PER_CELL;

/**
 * How many of the eight compass directions must be walkable at a candidate
 * spawn point before a GRAZER will be placed there — census.ts's
 * `openDirectionCount`, read at a threshold.
 *
 * Owner, 2026-08-24: grazers should "spawn in fairly flat areas". Habitat
 * validity alone cannot express that: `isValidCellFor` classifies ONE cell, and
 * a one-cell pinnacle between two terrace risers is as valid as the middle of a
 * meadow. So the flatness test is a test of the NEIGHBOURHOOD, measured in the
 * only units this simulation has for "flat" — how far a land walker can
 * actually get from here before a riser stops it.
 *
 * FIVE OF EIGHT: a majority of the compass, so the worst a grazer can be placed
 * at is the edge of open ground, never in a notch, on a ledge or on a pinnacle.
 * Not eight, which would demand a fully enclosed disc of level ground and would
 * refuse the ordinary hillside a grazer belongs on; not four, which a saddle
 * between two risers passes while being exactly the trap this exists to avoid.
 *
 * A SPAWN-TIME RULE ONLY. It is deliberately far above the ZERO at which
 * `despawnWedged` (population.ts) removes a creature that has ended up walled
 * in: a grazer is placed on generous ground and is only ever culled from ground
 * that has become impossible, so ordinary grazing into a snug corner costs it
 * nothing.
 */
export const GRAZER_SPAWN_OPEN_DIRECTIONS = 5;

/**
 * The vacuous threshold — "put me anywhere my habitat is". Every water species:
 * a fish's shelf and a whale's basin have no risers in them by construction
 * (AQUATIC_MAX_GRADIENT_PER_CELL), so a neighbourhood test could only ever
 * refuse a spawn for being near a shoreline, which is precisely where a fish
 * should be. Stated as a named value rather than a bare 0 so a profile says
 * WHY it has no clearance rule.
 */
export const NO_SPAWN_CLEARANCE_REQUIRED = 0;

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
 * size — which is every species but fish and whales today, and is why nothing
 * else in this plugin needs a "does this species vary in size" flag.
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
 * Whale size mix: 3 : 5 : 2 calf : adult : bull.
 *
 * Owner, 2026-08-21: "add the ability to spawn different size whales and allow
 * them to school like whales in real life with different sizes". A pod is a
 * family, so adults are the plurality, calves are common and a full-grown bull
 * is the occasional one — the opposite shape to a fish shoal, where the many are
 * the small. Combined with WHALE_SIZE_DRAW ('per-member', see SpeciesProfile),
 * this is what puts a calf alongside its mother instead of grading the whole pod
 * to one size.
 *
 * At WILDLIFE_SIZE_MODEL_SCALE (0.6 / 1 / 1.4) a whale is 3, 5 or 7 world units
 * nose to tail. The 7-unit bull is the largest body this game draws, and it is
 * the reason swimmerWorldY had to start scaling its clearances by size class
 * (client/placement.ts): at 1.4x, a whale's own half-height exceeds the
 * fixed 0.7 the whale swim profile was written for, so the unscaled version put
 * its belly in the seabed and its dorsal through the surface.
 */
export const WHALE_SIZE_WEIGHTS: SizeWeights = { small: 3, medium: 5, large: 2 };

/**
 * How many whales spawn together, and therefore how big a pod is.
 *
 * Three is the smallest group that reads as a family rather than as a pair that
 * happened to meet: two whales side by side are ambiguous, three with a calf
 * among them are not. It is also what the day-one density below is sized
 * against — see the habitatCellsPerIndividual note.
 */
export const WHALE_POD_SIZE = 3;

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
 * PER SPECIES, not global (2026-08-21). These three numbers are a statement
 * about FISH — "the small ones shoal, the big ones don't" is fish ecology — and
 * a whale pod obeys the opposite rule: it holds together whatever sizes are in
 * it. Keying the table by size alone would have handed whales the solitary
 * large-fish probability and quietly undone the pod.
 *
 * Irrelevant for a species whose groupSize is 1: a group of one is its own
 * school under either branch, so the roll cannot change anything.
 */
export type SchoolingProbabilities = Readonly<Record<WildlifeSizeClass, number>>;

export const FISH_SCHOOLING_PROBABILITY_BY_SIZE: SchoolingProbabilities = {
  small: 0.9,
  medium: 0.5,
  large: 0.1,
};

/**
 * A pod holds together. Whales are social by default at every size, so the small
 * and adult entries are certainty rather than a coin flip.
 *
 * The bull is the one exception, and it is a real one: a full-grown male is the
 * whale most likely to be travelling alone. Three pods in four containing one
 * still form up (the group's character is set by its LARGEST member — see
 * spawnGroup), and the fourth disperses into singles, which is how a lone whale
 * still occurs without being the normal sight.
 */
export const WHALE_SCHOOLING_PROBABILITY_BY_SIZE: SchoolingProbabilities = {
  small: 1,
  medium: 1,
  large: 0.75,
};

/**
 * The table for a species that spawns one at a time. Certainty at every size,
 * because a group of one IS a school: the cohesive branch gives that single
 * creature the group's school id and the non-cohesive branch gives it its own,
 * and the two are indistinguishable. Stated as a value rather than left to a
 * "does this species school" branch downstream.
 */
export const SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE: SchoolingProbabilities = {
  small: 1,
  medium: 1,
  large: 1,
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
  readonly species: WildlifeHabitatSpecies;
  readonly habitat: Habitat;

  /**
   * Ordinary wander speed, cells per second. Every entry in the table below
   * states it in WORLD UNITS per second and multiplies by WORLD_UNIT_CELLS: a
   * creature's speed is a distance across the ground, and the 2026-08-21
   * re-sample changed only how finely that ground is sampled.
   */
  readonly cruiseSpeedCellsPerSecond: number;

  /**
   * Maximum random heading change, radians per second. This is the "how twitchy
   * is it" dial: high values read as darting, low values as gliding.
   */
  readonly turnNoiseRadiansPerSecond: number;

  /**
   * Nose-to-tail length in cells — stated in WORLD UNITS below and converted,
   * because it is the size of the animal the client draws.
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
   *     by the starter square — INITIAL_UNLOCK_CHUNK_SPAN² chunks, shrunk
   *     2026-08-19 by owner decision to 80×80 = 6 400 SQUARE WORLD UNITS, the
   *     same on every world size — split by that genesis profile into 2 304
   *     shallow and 4 096 deep.
   *
   *     UNITS, stated once and relied on for the rest of this comment: every
   *     figure here is a SQUARE WORLD UNIT, because that is what the densities
   *     below are (each is wrapped in cellsOverArea). The census itself counts
   *     CELLS, and one square world unit is WORLD_UNIT_CELLS² = 16 of them, so
   *     the same starter square is 102 400 cells split 36 864 shallow / 65 536
   *     deep — which is what test/wildlife.test.ts asserts against a real
   *     World.createFresh. Both sides of every division below are scaled by the
   *     same 16, so the quotients are the same either way; only mixing the two
   *     units in one division would be wrong.
   *
   *       fish     2 304 /   400 = 5       deepsea   4 096 / 1 500 = 2
   *       whale    4 096 / 2 000 = 2       grazer            — = 0
   *
   *     Whales fit on day one again as of 2026-08-21 (5 000 → 2 000, owner:
   *     "drop the number of unlocked cells required"). Two of them: an adult and
   *     a calf out of a WHALE_POD_SIZE of three, the third arriving with the
   *     first territory creep. This restores the 2026-08-14 "2–3 whales
   *     immediately" goal that the 2026-08-19 starter-square shrink had
   *     superseded — by moving the density, which is the dial that should have
   *     moved then, rather than by growing the square back.
   *
   *     Grazers alone have nothing on day one: there is no land until a player
   *     raises an island, and that is the intended shape of a world that starts
   *     as an ocean.
   *
   *     This is the case the owner's report was about, and it is why the two
   *     DEEP densities move much further than the other two: they were sized
   *     when deep water was a rare, remote habitat, and it is now three
   *     quarters of the ground a brand-new server opens on. That once made the
   *     deep densities the binding constraint on the shelf's size — see
   *     FRESH_SHELF_SPAN_DIVISOR, chosen against the whale figure here. The
   *     2026-08-21 drop to 2 000 halves how much open sea a fresh world must
   *     keep for whales to appear at all, so the shelf now has room it did not
   *     have; the divisor is left where it is because nothing has asked for a
   *     bigger shelf, not because it is still pinned.
   *
   * (b) A nominal half-land / half-water 512² world at full reveal (262 144
   *     SQUARE WORLD UNITS — the world's area, not its cell count;
   *     ~131 000 land, of the water roughly 40% shallow / 60% open sea):
   *
   *       fish     52 429 /   400 = 131     grazer   131 072 /   100 = 1 310
   *       deepsea  78 643 / 1 500 =  52     whale     78 643 / 2 000 =    39
   *
   *     1 532 asked for. WILDLIFE_POPULATION_CAP (850) scales every species down
   *     by 850/1 532 = 0.5548 and floors, giving 847 (72 fish / 28 deepsea /
   *     726 grazer / 21 whale).
   *
   *     RECOMPUTED FOR THE 2026-08-23 GRAZER CUT (2 700 → 100) AND THE CAP RAISE
   *     THAT PAID FOR IT (150 → 850). The three sea species are back at exactly
   *     the counts they held before the cut — 72 / 28 / 21, unchanged — which is
   *     the whole reason the cap moved: the proportional division would otherwise
   *     have taken the grazers' 86% share of demand out of the sea, leaving 12
   *     fish and a single whale pod. What the raise costs is upstream bandwidth,
   *     and that arithmetic is stated where the cap is (census.ts).
   *
   *     WHALES REMAIN THE RAREST SPECIES ASKED FOR (39 against deepsea's 52),
   *     which is the constraint that set 2 000 rather than a rounder, lower
   *     number — see the note on the whale entry itself.
   *
   * HONEST NOTE ON THE CAP, RECOMPUTED FOR THE FISH RETUNE. The cap was once a
   * safety rail nothing rode; after the first retune a fully revealed 512² world
   * rode it and lost ~10%; after this one it loses 40% (148 of 246). The shape
   * survives — the scaling is proportional, so a capped world is a smaller
   * ecosystem, not a distorted one — but three things are now true and are worth
   * saying rather than discovering later (recomputed for the 2026-08-21 whale
   * drop, which took the asked-for total from 246 to 270 and the loss to 45%):
   *
   *   * FISH ARE STILL THE LARGEST SPECIES at full reveal (72 of 147, 49%). That
   *     is the deliberate cost of the school retune: schools are five fish each,
   *     so "enough fish to see schools" is arithmetically "a lot of fish". At 72
   *     that is ~14 schools spread over a whole revealed world.
   *   * WHALES COST MORE OF THE CAP THAN THEY DID: 21 of 147 rather than 9 of
   *     148, and every other species is ~9% smaller for it. Accepted — a pod is
   *     three whales by definition, so a world with room for only nine could
   *     hold three pods in total and would read as a world of lone whales.
   *   * The cap now BINDS at roughly 56% of a fully revealed 512² world's
   *     unlocked area, so it is the population dial for large late-game worlds
   *     while the densities here are the dial for everything before that.
   *
   * Raising the cap was considered and rejected: it is a bandwidth budget
   * (census.ts shows the per-message arithmetic), and 150 is what keeps a
   * self-hoster's ~10-player figure intact. Fish density is the number that
   * moved, and the cap is what stops it from costing bandwidth on big worlds.
   */
  readonly habitatCellsPerIndividual: number;
  // AN AREA, so it scales as the SQUARE of the sampling density: each entry
  // below states square world units per individual and multiplies by
  // WORLD_UNIT_CELLS twice. Scaled as a length — or not at all — the
  // 2026-08-21 re-sample would have multiplied every population in the world
  // by four or sixteen.

  /**
   * How many spawn at once, and therefore the size of a school.
   *
   * A group spawns as a jittered cluster sharing one heading AND one school id
   * (population.ts), and — when the schooling roll fires — holds together from
   * then on under the cohesion steering in movement.ts. Fish shoal and whales
   * pod (2026-08-21); the deep-sea creature and the grazer are solitary, and a
   * solitary species' group of one is its own school, which makes every school
   * rule in this plugin degenerate correctly rather than needing a "does this
   * species school" branch.
   *
   * The two group-spawning species differ in what a group MEANS — see sizeDraw:
   * a shoal is graded to one size, a pod is a mixed family.
   */
  readonly groupSize: number;

  /**
   * Size-class mix at spawn. See FISH_SIZE_WEIGHTS / WHALE_SIZE_WEIGHTS /
   * SINGLE_SIZE_WEIGHTS.
   */
  readonly sizeWeights: SizeWeights;

  /**
   * Whether `sizeWeights` is drawn ONCE FOR THE GROUP or once per member.
   *
   * The two values are two different animals, not a tuning preference:
   *
   *   'per-group'  a size-GRADED group — every member the same class. A real
   *                shoal sorts itself by size, and this is what shipped for fish
   *                from the start (2026-08-14).
   *   'per-member' a MIXED group — a family. A whale pod is adults with a calf
   *                or two among them, and drawing one class for the whole pod
   *                would make every pod uniform, which is the one thing a pod
   *                never is (owner, 2026-08-21).
   *
   * The group still has ONE size class for the purposes of its school character
   * (the cohesion roll and, per member, its spacing) — for a mixed group that is
   * its largest member. See spawnGroup.
   */
  readonly sizeDraw: 'per-group' | 'per-member';

  /**
   * Chance this species' spawn group forms a cohesive school, by the group's
   * size class. See SchoolingProbabilities and the three tables above.
   */
  readonly schoolingProbabilityBySize: SchoolingProbabilities;

  /**
   * Maximum |height difference| this species will cross in ONE CELL of
   * travel, checked ALONG THE PATH by census.ts's canTraverse — never just
   * the two endpoints (see that function's doc for why endpoint-only would
   * miss a canyon between two similarly-high rims). AQUATIC_MAX_GRADIENT_
   * PER_CELL (Infinity) for every water species; GRAZER_MAX_GRADIENT_PER_CELL
   * for the one land species today. See those constants for the reasoning.
   */
  readonly maxGradientPerCell: number;

  /**
   * How many of the eight compass directions must be open — one body length of
   * walkable, climbable ground (census.ts's `openDirectionCount`) — at a cell
   * before this species may SPAWN there.
   *
   * The "fairly flat areas" dial (owner, 2026-08-24), and the same number the
   * scattered members of a spawn group are placed against, so a triplet cannot
   * arrive with two on the meadow and one on the riser above it.
   *
   * NO_SPAWN_CLEARANCE_REQUIRED for every water species, which is exactly the
   * behaviour that shipped before this field existed; GRAZER_SPAWN_OPEN_
   * DIRECTIONS for the one land species. See both constants.
   */
  readonly spawnOpenDirectionsRequired: number;
}

/**
 * Schools a brand-new world's shelf must be able to hold, and the reason the
 * fish density is 400 rather than 1 000.
 *
 * THE VISIBLE-DENSITY ARGUMENT. A school is a thing you recognise by seeing more
 * than one of them: one blob of fish on an otherwise empty shelf is just "the
 * fish", and at the old density the shelf's whole fish budget was 4 — less than
 * one full group of `groupSize` (5), so a fresh world could not contain a
 * complete school at all.
 *
 * The arithmetic, against the genesis geometry (server/src/world/world.ts): the
 * starter square (shrunk 2026-08-19) is 80×80 = 6 400 square world units of
 * which 2 304 are shallow (36 864 cells — see the units note on
 * habitatCellsPerIndividual), so the 400 density gives floor(2 304 / 400) = 5
 * fish — exactly ONE
 * complete school of `groupSize` (5). One, down from two on the old 128×128
 * square: the density (a world-wide tuning) stayed at 400, and a single whole
 * school still reads as a school; the second returns as soon as territory
 * creeps a little and the shallow census grows.
 *
 * The plugin cannot import the genesis constants (core owns them and must not be
 * imported by a plugin's tuning table), so this relation is PINNED BY TEST in
 * plugins/wildlife/test/wildlife.test.ts against a real World.createFresh census
 * rather than restated here as a magic 4 096.
 */
export const FISH_SCHOOLS_ON_FRESH_SHELF = 1;

/**
 * Speeds are set relative to each other, not measured against anything: the
 * design brief is "whales slow and stately, fish quicker, terrestrial moderate".
 * A fish crosses one chunk (16 world units) in ~5 s; a whale takes ~20 s. At
 * the broadcast cadence (5 Hz) the fastest of them moves 0.6 world units
 * between updates,
 * which is what makes 5 Hz + interpolation indistinguishable from 10 Hz.
 */
export const SPECIES_PROFILES: Readonly<Record<WildlifeHabitatSpecies, SpeciesProfile>> = {
  fish: {
    species: 'fish',
    habitat: 'shallow',
    cruiseSpeedCellsPerSecond: cellsAcross(3),
    turnNoiseRadiansPerSecond: 1.4,
    bodyLengthCells: cellsAcross(0.7),
    // 1 000 → 400. See FISH_SCHOOLS_ON_FRESH_SHELF: a school is only a school if
    // you can see it is one, and at 1 000 the day-one shelf could hold FOUR fish
    // in total — one truncated group, indistinguishable from four singletons.
    habitatCellsPerIndividual: cellsOverArea(400),
    groupSize: 5,
    sizeWeights: FISH_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: FISH_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    spawnOpenDirectionsRequired: NO_SPAWN_CLEARANCE_REQUIRED,
  },
  whale: {
    species: 'whale',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: cellsAcross(0.8),
    turnNoiseRadiansPerSecond: 0.25,
    bodyLengthCells: cellsAcross(5),
    // 5 000 → 2 000 (owner, 2026-08-21: "drop the number of unlocked cells
    // required"). The 5 000 figure was chosen against a 128-chunk starter square
    // and outlived it: the square shrank on 2026-08-19 to 4 096 square world
    // units of open sea, so 4 096/5 000 = 0 and a fresh world had no whales at
    // all.
    //
    // A PAIR ON DAY ONE IS NO LONGER PROMISED (owner, 2026-08-26). Genesis
    // guaranteed the starter square held deep water for two whales for one day,
    // and paid for it by reserving 62.5% of that square — which meant rescaling
    // most of it on most seeds, and looked like a rectangle on the map. The
    // guarantee is gone; the density is not. A fresh world whose seed drew an
    // abyss in the starter square still opens with whales, one whose seed drew
    // shallows gets them when territory creep reaches deep water. That is
    // progression, and it is the same answer the kraken has always had.
    //
    // 2 000 rather than the 1 365 that would fit a whole WHALE_POD_SIZE pod on
    // day one, because the same density also decides how many whales a fully
    // revealed world holds, and whales must stay the RAREST species there: at
    // 2 000 a nominal 512² asks for 39 against deepsea's 52, and at 1 365 it
    // would ask for 57 and make the largest animal in the game the second most
    // common one. Day-one completeness lost to late-game shape, deliberately —
    // and it costs one small territory expansion, not a redesign.
    habitatCellsPerIndividual: cellsOverArea(2000),
    groupSize: WHALE_POD_SIZE,
    sizeWeights: WHALE_SIZE_WEIGHTS,
    sizeDraw: 'per-member',
    schoolingProbabilityBySize: WHALE_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    spawnOpenDirectionsRequired: NO_SPAWN_CLEARANCE_REQUIRED,
  },
  deepsea: {
    species: 'deepsea',
    habitat: 'deep',
    cruiseSpeedCellsPerSecond: cellsAcross(1.2),
    turnNoiseRadiansPerSecond: 0.9,
    bodyLengthCells: cellsAcross(1.2),
    // 6 000 → 1 500. Deep water is three quarters of a fresh world's starter
    // region, so it needs the density of a populated habitat rather than of a
    // rarity: 8 on day one, ~46 on a capped full 512².
    habitatCellsPerIndividual: cellsOverArea(1500),
    groupSize: 1,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    spawnOpenDirectionsRequired: NO_SPAWN_CLEARANCE_REQUIRED,
  },
  grazer: {
    species: 'grazer',
    habitat: 'land',
    cruiseSpeedCellsPerSecond: cellsAcross(1.6),
    turnNoiseRadiansPerSecond: 1.1,
    bodyLengthCells: cellsAcross(1.1),
    // 4 000 → 2 700: half again as many grazers per hillside, matching fish.
    //
// 2 700 → 100 (owner, 2026-08-23: "reduce that to a 300 square world unit
    // per animal triplet" — 300 units buys a TRIPLET, so 100 buys the animal,
    // and `groupSize` below is the triplet). A 10×10 world-unit patch each: the
    // 2 700 figure was calibrated against a nominal fully-revealed half-land
    // world, and no such world exists — every world on this machine is ocean
    // with an island a player raised, the largest of them 462 square world
    // units of land, on which 2 700 put no grazers at all and 900 still put
    // none by density. At 100 that island carries four, which is the point.
    //
    // WHAT IT COSTS, STATED RATHER THAN DISCOVERED LATER. The ask on a
    // hypothetical fully-revealed half-land 512-unit world goes 48 → 1 310
    // grazers, i.e. 86% of all demand, and WILDLIFE_POPULATION_CAP divides the
    // budget PROPORTIONALLY — so on such a world the sea thins to 12 fish, 5
    // deepsea and 3 whales (one pod exactly). No world in existence is
    // anywhere near that shape, and on the worlds that DO exist the cap does
    // not bind at all, which is why the trade is acceptable rather than merely
    // accepted. It is worth knowing which dial moves it back: the cap is a
    // BANDWIDTH ceiling (census.ts: 150 × 58 B × 5 Hz per client), not an
    // ecology one, and a per-species reservation in `targetsFor` would be the
    // other answer — neither is warranted until a world of that shape exists.
    habitatCellsPerIndividual: cellsOverArea(100),
    // A TRIPLET (owner, 2026-08-23). Grazers arrive three at a time like whales
    // arrive as a pod; unlike whales they keep SOLITARY schooling odds below,
    // so the trio is how they are born rather than how they travel — three
    // animals appear on the hillside together and then graze apart.
    groupSize: 3,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: GRAZER_MAX_GRADIENT_PER_CELL,
    spawnOpenDirectionsRequired: GRAZER_SPAWN_OPEN_DIRECTIONS,
  },
};

/** Deterministic iteration order over species (see WILDLIFE_HABITAT_SPECIES). */
export function profileOf(species: WildlifeHabitatSpecies): SpeciesProfile {
  return SPECIES_PROFILES[species];
}

/**
 * The body length the school-spacing radii in movement.ts were written against.
 *
 * SCHOOL_COMFORT_RADIUS_CELLS and SCHOOL_FULL_PULL_RADIUS_CELLS are absolute
 * distances, and they were calibrated when the only schooling species was the
 * fish: 2.5 cells is "a few fish lengths", which is a sensible distance to start
 * pulling a shoal together and a nonsense one for an animal seven times longer.
 * Whales schooling (2026-08-21) made that latent: a pod would have been held at
 * fish spacing, which for a five-unit body is closer than its own separation
 * floor lets it get — cohesion pulling in and separation pushing out, for the
 * first time in this plugin's life.
 *
 * Taken FROM the fish profile rather than restated as 0.7, so this is by
 * construction the length those constants were tuned for, and the fish's own
 * spacing multiplier is exactly 1 — the retune cannot move the species it was
 * calibrated against. See schoolLoosenessOf in movement.ts.
 */
export const SCHOOL_SPACING_BASELINE_BODY_LENGTH_CELLS = SPECIES_PROFILES.fish.bodyLengthCells;
