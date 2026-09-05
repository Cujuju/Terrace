// The wolf — a ranger (owner, 2026-09-04: "add the wolf in game").
//
// ITS ONE IDEA: it covers ground. The ibex climbs, the bison herds, the grazer
// is the generalist that stands still for nothing in particular; the wolf is
// the animal a player sees CROSSING a hillside. Everything below is that one
// sentence — a mid speed, the steadiest heading of the three fast land
// species, and the shortest pauses in the table — plus the one thing a
// predator's silhouette demands, which is that there be few of them.
//
// IT HUNTS THE DEER (owner, 2026-09-05: "wolves should hunt the deer").
//
// It DID NOT, and that was decided rather than pending on 2026-09-04: this row
// left `hunts` unset on the argument that "predator" here was what the animal
// LOOKS like and not a mechanic — nothing fled it, nothing was eaten — because
// predation was a design question for the owner and a half-wired one would have
// been a mechanic nobody chose. The owner has now chosen it. That is the whole
// change of mind: the reasoning was never that predation was wrong, only that
// it was not yet asked for.
//
// WHAT IT IS NOW, in one sentence: a wolf sees a deer six body lengths off,
// runs it down at the same burst a frightened animal flees at, takes it if it
// gets within a body length inside four seconds, and then does not
// hunt again for two minutes. Everything else — the alarm the deer bolts from,
// the removal of the one that is caught — is machinery this plugin already had
// (`Predation` on ./profile.ts, `despawnWithCredit` in ../population.ts).

import { LAND_WALKER_MAX_GRADIENT_PER_CELL, cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  FLEE_SPEED_MULTIPLIER,
  GRAZER_SPAWN_OPEN_DIRECTIONS,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  SPAWN_AT_ANY_HEIGHT,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
  type Predation,
  type SpeciesProfile,
} from './profile.ts';

/**
 * Ranging bouts: it moves for ~20 s and stops for ~2.5 s.
 *
 * THE LEAST STILL ANIMAL IN THE TABLE, at 11% of its life stopped, and the
 * ratio is the point rather than either rate. The bison grazes (33% still,
 * ./bison.ts) and the ibex perches on the ledge it just reached (24%,
 * ./ibex.ts); a wolf that stopped as often as either would read as a third
 * grazing animal in a different coat. The onset matches the bison's 0.05 — a
 * wolf, like a bison, walks a long way between pauses — and the END rate is
 * 0.4, the fastest here, so what pauses there are read as a check rather than
 * as a rest.
 *
 * NOT ZERO, which the grazer and the fish both are. A creature that never
 * stops is a creature on rails, and the one thing this species is for is being
 * watched crossing ground: a two-and-a-half-second check is what turns a
 * traverse into an animal doing it.
 */
const WOLF_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.05, endPerSecond: 0.4 };

/**
 * Square world units of land per wolf — the LOWEST density of any land species,
 * by a wide margin.
 *
 * 2 000, against the grazer's 100, the bison's 600 and the ibex's 700. Twenty
 * grazers to a wolf is the relation that matters and the one a player reads
 * without counting: a predator's silhouette is only a predator's silhouette if
 * it is rare, and a hillside carrying more wolves than deer reads as a kennel.
 * (The grazer's own figure was 2 700 until 2026-08-23 and is now 100 — see
 * ../species.ts, which argues both the cut and what it costs. This row is
 * therefore twenty times denser-spaced than the grazer, not "the old grazer
 * number reused".)
 *
 * WHAT IT COSTS UNDER THE CAP, stated rather than discovered. Demand is divided
 * proportionally by WILDLIFE_POPULATION_CAP (../census.ts), so every species
 * pays a little for a new one: on the nominal fully-revealed half-land 512²
 * world the test in ../../test/wildlife.test.ts pins, the wolf asks for 65 of a
 * total that was 2 099, which thins every other species by ~3%. That is the
 * cheapest a visible new species can be, and it is cheap precisely because the
 * density is low.
 */
const WOLF_HABITAT_AREA_PER_INDIVIDUAL = 2000;

// ── The hunt ─────────────────────────────────────────────────────────────────
//
// Every number below is stated in WORLD UNITS and every speed in world units
// per second, which is how the rest of this table is written; `cellsAcross`
// converts. The two facts everything is derived from: a deer cruises at 0.8 and
// bolts at 0.8 × FLEE_SPEED_MULTIPLIER = 2.4, and a wolf cruises at 1.0 and
// bursts at 3.0. THE HUNT IS THAT 0.6 u/s GAP — a wolf out-runs a fleeing deer,
// but only just, so the chase is long enough to watch and short enough to lose.

/**
 * How far a wolf sees a deer worth chasing.
 *
 * SIX BODY LENGTHS. The one thing this species is for is covering ground (see
 * the header), and an animal that covers ground sees a long way over it.
 *
 * IT IS TWICE THE ALARM RADIUS BELOW, AND THE GAP IS THE MECHANIC. Between 6
 * and 3 units the wolf is hunting and the deer has not noticed: it walks at 0.8
 * while the wolf comes at 3.0, so the wolf closes at 2.2 u/s even in the worst
 * case — the deer walking directly away — and the first half of the hunt is a
 * stalk the player can see coming. Inside 3 the deer bolts and the closing rate
 * collapses to 0.6. A detect radius EQUAL to the alarm radius would delete the
 * stalk and make every hunt the slow half only; a much larger one would have
 * wolves crossing a hillside at burst speed on sight of something they have no
 * chance of catching inside WOLF_CHASE_MAX_SECONDS.
 */
const WOLF_DETECT_RADIUS_CELLS = cellsAcross(6);

/**
 * How far a wolf's presence is felt — the radius at which deer bolt.
 *
 * THREE WORLD UNITS, the same figure the shark states for the same reason it
 * gives (./shark.ts's SHARK_ALARM_RADIUS_CELLS): a grazing head is down, and
 * prey that only scattered once the hunter was among them would be a collision
 * rather than a hunt.
 *
 * NOT THE SHARK'S CONSTANT, deliberately, and this is the whole reason it is
 * typed out again rather than imported. The two are the same number for the
 * same argument, not one number shared: a shark retune is a decision about the
 * shelf, and it must not silently move when a deer notices a wolf. The
 * duplication is the contract.
 *
 * IT IS ALSO WHAT MAKES A DEER'S FLIGHT A REAL FLIGHT rather than a twitch. The
 * startle is re-armed every tick the deer is inside this radius and never
 * shortened (../movement.ts's `startleNear`), so a deer under chase runs at 2.4
 * for as long as the wolf is on it plus FLEE_DURATION_SECONDS after.
 */
const WOLF_ALARM_RADIUS_CELLS = cellsAcross(3);

/**
 * How close a wolf must get to take a deer: ONE WOLF BODY LENGTH, the
 * `bodyLengthCells` this row declares below.
 *
 * The animals are touching at that distance — a wolf a body length from a deer
 * has its jaws where the deer is — so the kill lands where a player watching
 * would already have called it. Any larger and the deer disappears with daylight
 * between them; any smaller and the two would have to occupy the same point,
 * which the steering's own personal-space separation (../movement.ts) works to
 * prevent.
 */
const WOLF_CATCH_RADIUS_CELLS = cellsAcross(1.0);

/**
 * How long one chase may last before the wolf gives up. FOUR SECONDS, picked so
 * that a deer spotted at the EDGE of WOLF_DETECT_RADIUS_CELLS is a coin flip
 * and a deer spotted well inside it is a kill.
 *
 * THE MODEL, in two phases, from the speeds at the top of this section.
 *
 *   STALK, 6 → 3 units: the deer has not noticed and walks at 0.8 in whatever
 *   direction it was already going. Closing is 3.8 head-on, 2.2 straight away,
 *   3.0 on average — so the 3 units take 0.8 s at best, 1.4 s at worst.
 *   RUN, 3 → 1 unit: the deer is bolting directly away from the wolf at 2.4
 *   (`startleNear` points it away), so closing is 3.0 − 2.4 = 0.6 and the last
 *   2 units take 2 / 0.6 = 3.33 s.
 *
 * From the edge that totals 4.1 s in the best geometry and 4.7 s in the worst;
 * from 4 units the stalk is 1 unit (0.26–0.45 s) and the total is 3.6–3.8 s.
 *
 * THE MODEL IS THE FLOOR, NOT THE ANSWER, and the value is MEASURED (headless
 * run, 600 simulated seconds on the test suite's ramp world, ~25 wolves and
 * ~515 deer). Real chases close FASTER than the model: the model gives the deer
 * an unobstructed straight line away, and a real one is deflected by the ground
 * and by the other deer it has to keep clear of, so its escape speed is under
 * 2.4. At 4.5 s the measured kill rate for a deer locked at 5–6 units was 82%
 * — a magnet, not a hunt. At 4.0 s it is 51% at 5–6 units, 65% at 4–5 and 92%
 * at 3–4, which is exactly the shape this constant is for. Overall: 117 kills
 * against 53 misses.
 *
 * BOTH ENDS OF THE RANGE ARE FAILURES. A hunt that never fails is a magnet —
 * every deer inside 6 units is already dead and the species reads as an
 * area-denial effect. A hunt that never succeeds is the shark: an animal that
 * carries an alarm and nothing else. This is the number to move first if
 * eyes-on says the balance is wrong, and it should be moved against a measured
 * rate rather than by feel.
 */
const WOLF_CHASE_MAX_SECONDS = 4.0;

/**
 * How long a wolf goes without hunting after a kill. TWO MINUTES — satiety, and
 * THE POPULATION GOVERNOR: at most one deer per wolf per two minutes, whatever
 * else happens.
 *
 * AGAINST THE CENSUS'S OWN CLOCKS (../population.ts). A caught deer leaves
 * through `despawnWithCredit`, so its replacement credit ripens after
 * HABITAT_LOSS_RESPAWN_DELAY_SECONDS (8) and then hatches at the
 * SPAWN_MEAN_WAIT_SECONDS (20) hazard: the deer is back after ~28 s on average,
 * which is less than a quarter of this. The replacement therefore always
 * arrives long before the wolf that took it hunts again, and in steady state
 * the deer population sits at target minus at most (wolves × 1) — one deer in
 * flight per wolf, never a decline. Set against NATURAL_LIFESPAN_SECONDS (300),
 * predation is also the smaller force on any deer's life by a wide margin: a
 * deer is far likelier to wander off than to be eaten.
 *
 * WHAT IT COSTS ON THE SMALLEST ISLAND THAT HAS ANY ANIMALS AT ALL, computed
 * rather than hoped. A habitat of MIN_FOUNDING_HABITAT_CELLS (../census.ts,
 * cellsOverArea(64) = 1 024 cells) is below BOTH densities — a deer wants 1 600
 * cells and a wolf 32 000 — so `targetsFor` gives each species its
 * FOUNDING_POPULATION of 2: two wolves and two deer. Two wolves at this rate
 * take at most one deer per 60 s, each absent ~28 s, so the island carries ~1.5
 * of its 2 deer on average and is briefly down to one. That is the honest cost
 * and it is the reason this number is 120 rather than 30: at 30 the same island
 * would sit at ~1 deer and read as a place where deer cannot live.
 */
const WOLF_REST_AFTER_KILL_SECONDS = 120;

/**
 * How long a wolf goes without hunting after a chase it lost. TWENTY SECONDS —
 * winded, and long enough that the deer which escaped is genuinely gone.
 *
 * THE ESCAPE HAS TO BE AN ESCAPE. A wolf that re-locked the same deer on the
 * tick after giving up on it is a dog on a lead, and — because the deer is
 * still inside the detect radius at the moment the chase times out, by
 * construction — that is exactly what a short rest would produce. In 20 s the
 * deer covers its remaining FLEE_DURATION_SECONDS at 2.4 and then 16 units at
 * cruise, which is several detect radii from a wolf that is meanwhile wandering
 * at 1.0; the pair have to meet again by chance rather than by momentum.
 *
 * IT IS ALSO THE DUTY CYCLE. At 4.5 s of chase against 20 s of rest a wolf
 * spends at most 18% of its life at burst speed, so a player watching a
 * hillside sees an animal that mostly ranges and occasionally hunts. A wolf
 * that was always chasing would be a wolf on rails, and the burst would stop
 * reading as an event.
 *
 * A quarter of WOLF_REST_AFTER_KILL_SECONDS, which is the right ordering for
 * the right reason: a full wolf has a reason not to hunt, a winded one only
 * needs to get its breath back.
 */
const WOLF_REST_AFTER_MISS_SECONDS = 20;

/**
 * What a wolf hunts: the deer, and nothing else.
 *
 * THE GRAZER ONLY, and the other two land species are NAMED PUNTS rather than
 * omissions. The bison (./bison.ts) is the one row with `groupStartle`, so
 * hunting it would mean designing what a herd does when one of them is taken —
 * a bigger question than this change, and the wrong one to answer by side
 * effect. The ibex (./ibex.ts) lives on broken ground a plain land walker
 * cannot follow it onto, so a wolf could see one it can never reach and would
 * spend its chases running at a ledge. Both are decisions for the owner.
 *
 * THE PURSUIT'S SPEED IS FLEE_SPEED_MULTIPLIER, imported rather than restated:
 * a hunting wolf is at burst exactly as a fleeing deer is, and it is the same
 * physics, so it must be the same constant. 3.0 against the deer's 2.4 is the
 * 0.6 u/s the whole hunt is built on. Note what this does NOT change: the ibex
 * (1.2) is still the fastest CRUISING land animal, because a burst is a state
 * an animal is in and not a number in its row.
 */
const WOLF_PREDATION: Predation = {
  preySpecies: ['grazer'],
  alarmRadiusCells: WOLF_ALARM_RADIUS_CELLS,
  pursuit: {
    detectRadiusCells: WOLF_DETECT_RADIUS_CELLS,
    speedMultiplier: FLEE_SPEED_MULTIPLIER,
    catchRadiusCells: WOLF_CATCH_RADIUS_CELLS,
    maxSeconds: WOLF_CHASE_MAX_SECONDS,
    restAfterMissSeconds: WOLF_REST_AFTER_MISS_SECONDS,
    restAfterKillSeconds: WOLF_REST_AFTER_KILL_SECONDS,
  },
};

export const WOLF_PROFILE: SpeciesProfile = {
  species: 'wolf',
  habitat: 'land',
  // 1.0 — exactly between the halved grazer's 0.8 and the ibex's 1.2, and it is
  // the middle on purpose: a wolf ranges further than a deer, but the light
  // small-hoofed climber is still the quickest thing on land, because that is
  // what the ibex's whole row is about. It leaves the bison's 0.6 the slowest,
  // so SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND (../species.ts) and the fire
  // alarm derived from it (../index.ts, FIRE_STARTLE_RADIUS_CELLS) do not move.
  cruiseSpeedCellsPerSecond: cellsAcross(1.0),
  // Steadier than the grazer's 1.1 and much steadier than the ibex's 1.3: an
  // animal crossing ground has somewhere to be. Still well above the bison's
  // 0.5 — a wolf casts about, a bison does not.
  turnNoiseRadiansPerSecond: 0.9,
  // 1.0: leaner than the grazer's 1.1, longer than the ibex's 0.9, well under
  // the bison's 1.6. It is the STEERING body — look-ahead floor, personal
  // space and school spacing in ../movement.ts — not the model's box, which is
  // 0.72 world units only because a third of it is tail (../../client/species/
  // wolf.ts). Pacing the steering off a tail would give a lean animal a
  // bison's personal space.
  bodyLengthCells: cellsAcross(1.0),
  habitatCellsPerIndividual: cellsOverArea(WOLF_HABITAT_AREA_PER_INDIVIDUAL),
  // A PAIR, born together and dispersed immediately by the solitary schooling
  // odds below. It is a pack in the sense the grazer's triplet is a family: how
  // they ARRIVE, not how they travel. A pack that held together would need the
  // bison's real schooling and its group alarm, and both of those exist to
  // carry a STARTLE through a herd — which is predation's machinery, and
  // predation was out of scope when this row shipped.
  //
  // UNCHANGED BY THE HUNT (2026-09-05), which is a decision. Two wolves that
  // happen to lock the same deer both close on it and both are sated when one
  // takes it (../movement.ts's `resolveCatches`), and that is the whole of the
  // pack behaviour: coordinated flanking, a shared target, or a wolf calling
  // another in are named punts, not omissions.
  groupSize: 2,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  idle: WOLF_IDLE_BOUTS,
  // Two of them are inside any radius that reaches either, so there is nothing
  // for an alarm to travel through. The bison is the only row that declares it.
  groupStartle: false,
  // THE HUNT (owner, 2026-09-05). See WOLF_PREDATION above for every number.
  hunts: WOLF_PREDATION,
  // The grazer's rule at the grazer's threshold, and the same constant rather
  // than a second 5: open country is where an animal that covers ground can
  // cover it.
  spawnGround: { kind: 'open', minOpenDirections: GRAZER_SPAWN_OPEN_DIRECTIONS },
  // ANY HEIGHT, like the grazer and unlike the ibex and the bison. A wolf's
  // range is not a band of the land ramp: beach, meadow, rock and snow are all
  // ground it crosses. Pinning it to the uplands would have put the one species
  // whose silhouette answers the grazer's where the grazer never is.
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
