// The vocabulary a species profile is written in: habitat classification, the
// traversal and spawn-ground rules, the size and schooling tables, and the
// `SpeciesProfile` shape itself.
//
// SPLIT OUT OF ../species.ts (2026-09-02, the four new species). Nothing here
// changed in the move — this is the half of that file every per-species row
// READS, and the rows themselves now live beside it (./ibex.ts, ./bison.ts,
// ./ray.ts, ./shark.ts) with ../species.ts assembling the table. A per-name
// file cannot import its shared vocabulary from the module that imports IT:
// that is a module cycle, and the constants below would be in their temporal
// dead zone at the moment the row is built. ../species.ts re-exports every
// name here, so nothing that already imported one has to move.
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
} from '../../protocol.ts';

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

/**
 * The tightest arc a creature will turn through, as a fraction of its own body
 * length — the radius of its turning circle, and the value every row in the
 * table states except the ray.
 *
 * ROOT CAUSE THIS FIXES (owner, 2026-08-24: whales "will do 90-degree turns in
 * place"; sea creatures should "travel in smooth polylines"). Nothing bounded
 * how far a creature's heading could move in ONE tick. Every steering term
 * ABOVE the habitat veto is rate-limited — turn noise by
 * turnNoiseRadiansPerSecond, cohesion by SCHOOL_MAX_PULL_RADIANS_PER_SECOND,
 * alignment by SCHOOL_ALIGNMENT_RADIANS_PER_SECOND — and then the veto itself,
 * which is the term that actually decides where a creature near anything goes,
 * committed whichever compass candidate it liked with no rate at all. A whale
 * pressed against a ridge went from heading east to heading north in 100 ms.
 *
 * HALF A BODY LENGTH. An animal that pivots inside its own hull reads as a
 * sprite being rotated; one that needs several body lengths of water to come
 * about reads as a barge. Half its length is the arc that looks like an animal
 * turning — tight, but visibly an arc — and expressing it as a RATIO is what
 * makes "a whale turns like a whale and a fish turns like a fish" a consequence
 * of how long they are (bodyLengthCells), already stated once, rather than a
 * fourth table to keep in step with the other three.
 *
 * IT IS ALSO WHY THE LOOK-AHEAD IS ALREADY LONG ENOUGH, and that relation is
 * the reason this number is not free. A mover must see an obstacle while it
 * still has room to arc around it, i.e. at no less than its turning radius;
 * `lookaheadCellsFor` floors the probe at a full body length, which at this
 * ratio is exactly twice that radius. A ratio ABOVE 0.5 makes a creature's
 * turning circle wider than its own sightline, and it will arc into things it
 * had already seen — so a row that states one is claiming its habitat has
 * nothing to arc into. See `turnRadiusBodyLengths` on SpeciesProfile, and the
 * ray's own note (./ray.ts).
 *
 * MOVED HERE FROM movement.ts (2026-09-02) when it stopped being global: it is
 * now the value a row DECLARES rather than the rule the engine applies, and it
 * has to be visible to the per-name files that declare it. movement.ts still
 * re-exports the name.
 */
export const TURN_RADIUS_BODY_LENGTHS = 0.5;

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
export const SINGLE_SIZE_WEIGHTS: SizeWeights = Object.fromEntries(
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
   * for a plain land walker, and IBEX_MAX_GRADIENT_PER_CELL (./ibex.ts) for
   * the one animal that climbs what a plain walker cannot. See those constants.
   *
   * IT IS THE FIGURE THE TRAVERSAL PROFILE ACTUALLY CARRIES (2026-09-02).
   * census.ts's `walkerProfileOf` used to pick a shared archetype by habitat
   * alone and hand it straight on, so this field was DECLARED by every row and
   * READ by nothing: it happened to agree with the archetype's own limit for
   * all four original species, and a row that disagreed would have been
   * silently ignored. `walkerProfileOf` now overrides the archetype's
   * `maxGradientPerCell` with this value, which is a no-op for the four rows
   * that already agreed and is what makes the ibex climb.
   */
  readonly maxGradientPerCell: number;

  /**
   * The radius of this creature's turning circle, as a fraction of its own body
   * length — the one rate limit on the habitat veto's chosen heading
   * (movement.ts's `maxTurnRadiansPerSecondOf`).
   *
   * PER SPECIES SINCE 2026-09-02, and REQUIRED rather than defaulted. It was a
   * single global 0.5 (movement.ts's TURN_RADIUS_BODY_LENGTHS, still the name
   * of that value and still what every row but one states), on the argument
   * that "a whale turns like a whale" should follow from how long a whale is.
   * That argument holds for everything whose turn is bounded by its body; it
   * does not hold for an animal whose turn is bounded by its GAIT — a ray banks
   * through a wide arc it could physically turn inside of. So the ratio is a
   * declaration now. No default: a default is how a row forgets, and a
   * forgotten turning circle is invisible until someone watches the animal.
   *
   * The relation that makes it not free is unchanged and is stated on
   * TURN_RADIUS_BODY_LENGTHS: `lookaheadCellsFor` floors the probe at one body
   * length, so a ratio above 0.5 gives a creature a turning circle wider than
   * its own sightline and it arcs into things it has already seen. The RAY is
   * the row that exceeds it (1.5), and it is a swimmer over open shelf where
   * the only thing to arc into is the shoreline — named as the residual it is
   * rather than discovered later.
   */
  readonly turnRadiusBodyLengths: number;

  /**
   * The idle bouts this species takes, or `undefined` for one that never stops.
   *
   * See IdleBouts. Declared here rather than as two always-present rates so
   * that "this animal does not idle" is a shape the engine can see, not a pair
   * of zeroes it has to interpret.
   */
  readonly idle?: IdleBouts;

  /**
   * Does startling ONE member of a school startle the whole school?
   *
   * A HERD ANIMAL'S RULE (owner, 2026-09-02: bison "stampede"). Ordinarily a
   * disturbance reaches exactly the creatures inside its radius, which for a
   * spread-out school means the near half bolts and the far half grazes on.
   * That is right for a shoal — fish scatter, and the ones that saw nothing
   * saw nothing — and wrong for a herd, which moves as one body precisely
   * because an alarm at its edge travels through it.
   *
   * The propagated startle obeys every rule the direct one does, and in
   * particular it NEVER SHORTENS an existing panic (movement.ts's
   * `startleNear`): a herd member already fleeing something else keeps the
   * longer of the two flights.
   */
  readonly groupStartle: boolean;

  /**
   * What this species hunts, or `undefined` for everything that hunts nothing.
   * See Predation.
   */
  readonly hunts?: Predation;

  /**
   * What the ground around a candidate spawn cell must look like before this
   * species may be placed on it. See SpawnGround.
   *
   * The same rule the scattered members of a spawn group are placed against, so
   * a group cannot arrive with two on the meadow and one on the riser above it.
   */
  readonly spawnGround: SpawnGround;
}

/**
 * A two-state Poisson idle beat: while moving a creature may stall, while
 * stalled it may resume, and both are memoryless — there is no countdown to
 * store and no phase for a player to learn.
 *
 * THE SHAPE IS MONSTERS' (plugins/monsters/server/lurk.ts's `advanceIdleState`
 * and the two rates on its `MonsterProfile`), deliberately: this is the second
 * plugin to want "an animal that stops for a while", the first one settled what
 * the state machine should be, and copying its shape is what keeps the two
 * legible as the same behaviour. Nothing is IMPORTED from monsters — a plugin
 * may not depend on another plugin — so what travels is the design, not code.
 *
 * WHAT AN IDLE BOUT MEANS HERE (movement.ts's `advanceEntity`): the creature
 * does not translate AND does not wander — it holds its heading exactly. That
 * is stricter than the monsters' beat, which still drifts its gaze, and it is
 * the difference between an animal that has stopped to graze and one that is
 * treading water on the spot. Fleeing cancels it outright: a startled animal
 * has stopped grazing by definition.
 *
 * Both rates are per SECOND, and the mean time in each state is its
 * reciprocal — onset 0.05/s and end 0.10/s is "moves 20 s, stops 10 s".
 */
export interface IdleBouts {
  /** Rate of entering an idle bout while moving. */
  readonly onsetPerSecond: number;
  /** Rate of leaving an idle bout. */
  readonly endPerSecond: number;
}

/**
 * A hunter's alarm: which species it frightens, and how far.
 *
 * NOT PREDATION IN THE SENSE OF EATING (owner, 2026-09-02: "prey scatter ahead
 * of it"). Nothing is killed and no energy is modelled; what a hunter has is a
 * presence, and the population machinery is untouched by it. That is the whole
 * mechanic, and it is deliberately the whole mechanic: a shark that removed
 * fish would put a second, unregulated drain next to the census's own turnover
 * and the two would fight over what the shelf's fish count means.
 *
 * The alarm is applied FROM THE HUNTER'S OWN POSITION each tick, after
 * movement, through the same `startleNear` a sculpt uses (movement.ts's
 * `advanceMovement`) — so prey turn away from where the shark IS, and a fish
 * told to flee toward a beach still turns along the shore.
 *
 * COST: O(hunters × population) per tick. Affordable only because hunters are
 * rare by density — the shark's is the thinnest in the table — and the residual
 * is named rather than hidden: a species declaring `hunts` at a common density
 * would make this the plugin's most expensive loop.
 */
export interface Predation {
  /** Species this hunter startles. A hunter never appears in its own list. */
  readonly preySpecies: readonly WildlifeHabitatSpecies[];
  /** How far the alarm carries, in cells from the hunter. */
  readonly alarmRadiusCells: number;
}

/**
 * The ground a species needs around a candidate spawn cell — ONE rule with two
 * readings of the same eight-direction probe (census.ts's `openDirectionCount`
 * and `steepDirectionCount`).
 *
 * WHY ONE FIELD AND NOT TWO (2026-09-02). `spawnOpenDirectionsRequired` asked
 * "how much of the compass is walkable", which is the flatness question the
 * grazer needed. The ibex needs the OPPOSITE reading — broken ground, ledges a
 * plain walker cannot leave — and a second parallel field would have let a row
 * state both, or neither, with nothing to say what that meant. A discriminated
 * union makes "a species has exactly one spawn-ground rule" true by
 * construction, and the census evaluates the rule rather than each caller
 * re-deriving which field applies.
 *
 *   'open'   at least `minOpenDirections` of 8 are somewhere this species could
 *            walk to. `NO_SPAWN_CLEARANCE_REQUIRED` (0) is the vacuous case —
 *            "put me anywhere my habitat is" — which is every swimmer, and is
 *            bit-for-bit the behaviour that shipped before any of this existed.
 *   'broken' at least `minSteepDirections` of 8 are steps a PLAIN LAND WALKER
 *            could not take but this species can. See ./ibex.ts.
 */
export type SpawnGround =
  | { readonly kind: 'open'; readonly minOpenDirections: number }
  | { readonly kind: 'broken'; readonly minSteepDirections: number };

/** The rule every water species has: habitat validity and nothing else. */
export const NO_SPAWN_GROUND_RULE: SpawnGround = {
  kind: 'open',
  minOpenDirections: NO_SPAWN_CLEARANCE_REQUIRED,
};

/**
 * Does this rule constrain anything at all?
 *
 * Read by two callers with two different reasons, which is why it is a function
 * and not an inlined comparison: spawning skips the eight-direction probe
 * entirely when nothing is required (population.ts's `canSettleAt`), and the
 * walled-in sweep exempts the same species from being culled for having nowhere
 * to go (population.ts's `despawnWedged` — a whale nosing into a bay is not
 * wedged, it is a whale in a bay).
 */
export function spawnGroundConstrains(rule: SpawnGround): boolean {
  return rule.kind === 'open' ? rule.minOpenDirections > 0 : rule.minSteepDirections > 0;
}
