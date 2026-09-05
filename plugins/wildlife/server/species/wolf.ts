// The wolf — a ranger (owner, 2026-09-04: "add the wolf in game").
//
// ITS ONE IDEA: it covers ground. The ibex climbs, the bison herds, the grazer
// is the generalist that stands still for nothing in particular; the wolf is
// the animal a player sees CROSSING a hillside. Everything below is that one
// sentence — a mid speed, the steadiest heading of the three fast land
// species, and the shortest pauses in the table — plus the one thing a
// predator's silhouette demands, which is that there be few of them.
//
// IT DOES NOT HUNT, and that is decided rather than pending (2026-09-04).
// "Predator" here is what the animal LOOKS like, not a mechanic: nothing flees
// it, nothing is eaten, and this row deliberately leaves `hunts` (the
// `Predation` field on ./profile.ts) unset rather than filling it in "for
// later". Predation is a design question for the owner; a half-wired one would
// be a mechanic nobody chose.

import { LAND_WALKER_MAX_GRADIENT_PER_CELL, cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  GRAZER_SPAWN_OPEN_DIRECTIONS,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  SPAWN_AT_ANY_HEIGHT,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
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
  // predation is out of scope here.
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
