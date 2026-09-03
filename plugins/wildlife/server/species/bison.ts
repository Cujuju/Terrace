// The bison — a herd animal (owner, 2026-09-02: "add two additional grazer
// types … unique behavior").
//
// ITS ONE IDEA: it is never alone. Every other land animal here is born in a
// small group and then disperses — the grazer's triplet and the ibex's pair
// both take SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE, which gives each member its
// own school id and the wandering that goes with it. The bison is the first
// land species to school for real, and the first species of any kind whose
// alarm travels through the group rather than reaching each member on its own.
// Everything below follows from those two facts: a big slow animal that grazes
// in long bouts and moves as one body when something frightens it.

import { LAND_WALKER_MAX_GRADIENT_PER_CELL, cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  GRASSLAND_SPAWN_HEIGHTS,
  GRAZER_SPAWN_OPEN_DIRECTIONS,
  SINGLE_SIZE_WEIGHTS,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
  type SchoolingProbabilities,
  type SpeciesProfile,
} from './profile.ts';

/**
 * A herd holds together, at every size, always.
 *
 * ITS OWN TABLE, NOT THE WHALES' (WHALE_SCHOOLING_PROBABILITY_BY_SIZE,
 * ./profile.ts), even though the two agree at two of three entries. The whale
 * table says something specific about whales — a full-grown bull is the whale
 * most likely to be travelling alone, so one pod in four containing one
 * disperses — and a bison herd has no such member. Reusing that table would
 * have handed the bison the bull's 0.75 and produced, one herd in four, six
 * animals that spawned together and then wandered apart, which is the one thing
 * a herd never does.
 *
 * CERTAINTY IS AFFORDABLE HERE because the bison is single-size
 * (SINGLE_SIZE_WEIGHTS), so only the DEFAULT_SIZE_CLASS entry can ever be
 * drawn. The other two are stated anyway rather than left to a partial record:
 * the type is a total map over size classes precisely so that a species that
 * later gains sizes cannot silently acquire an undefined probability.
 */
export const HERD_SCHOOLING_PROBABILITY_BY_SIZE: SchoolingProbabilities = {
  small: 1,
  medium: 1,
  large: 1,
};

/**
 * Grazing bouts: it moves for ~20 s and grazes for ~10 s.
 *
 * A GRAZING ANIMAL IS MOSTLY STANDING STILL, and at these rates it spends a
 * third of its life stopped — the longest bouts of any species here, and the
 * only ones long enough that a player watching a herd sees the herd stop rather
 * than sees individuals flicker. Both rates are HALF the ibex's, which is the
 * same statement made twice: the bison does everything more slowly.
 *
 * THE BOUTS ARE PER ANIMAL, NOT PER HERD, and that is deliberate rather than
 * overlooked. A herd whose members all stopped at the same instant would read
 * as a paused animation; one where a few are always moving and the rest are
 * heads-down is what a grazing herd looks like. The cohesion steering
 * (movement.ts) is what keeps them together through it — a member that grazed
 * while the herd drifted on is outside its comfort radius when it resumes, and
 * turns to close the gap.
 */
const BISON_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.05, endPerSecond: 0.1 };

export const BISON_PROFILE: SpeciesProfile = {
  species: 'bison',
  habitat: 'land',
  // The slowest thing that walks, at three quarters of the halved grazer's 0.8
  // and half the ibex's 1.2. It is also now the animal that sets
  // FIRE_STARTLE_RADIUS_CELLS (../index.ts), which is derived from the slowest
  // land species so that every land animal an alarm reaches can outrun it.
  cruiseSpeedCellsPerSecond: cellsAcross(0.6),
  // The steadiest heading in the table apart from the whale's 0.25 — under half
  // the grazer's 1.1. A heavy animal walks in a line; the turn noise is what a
  // player reads as indecision, and a bison has none.
  turnNoiseRadiansPerSecond: 0.5,
  // The largest land body here: nearly half again the grazer's 1.1 and almost
  // twice the ibex's 0.9. It buys three things at once, all of them from
  // movement.ts — a longer look-ahead probe, a wider personal space (half the
  // body length), and looser school spacing (SCHOOL_SPACING_BASELINE_BODY_
  // LENGTH_CELLS) — so a herd stands apart at a bison's scale rather than
  // clumping at a fish's.
  bodyLengthCells: cellsAcross(1.6),
  // 600 square world units each — six times the grazer's 100, and one groupSize
  // of them, which is the relation that matters: the land that supports six
  // grazers supports ONE bison, so a hillside that holds a single herd is a
  // hillside that would otherwise have held thirty-six grazers. Denser than the
  // ibex (700) because open ground is commoner than broken ground, so the
  // rarer animal is the one with the specialist habitat.
  habitatCellsPerIndividual: cellsOverArea(600),
  // A HERD. Six is the smallest number that reads as a herd rather than as a
  // family — the whale pod is three and looks like a family, the grazer triplet
  // is three and looks like litter-mates — and it is small enough that six
  // bodies at 1.6 units each still fit the scatter a group is born into
  // (GROUP_SCATTER_BODY_LENGTHS) without half of them landing on a riser.
  groupSize: 6,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: HERD_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  idle: BISON_IDLE_BOUTS,
  // THE STAMPEDE. See `groupStartle` on SpeciesProfile: an alarm that reaches
  // one member reaches the herd. This is the only row that declares it, and it
  // is only meaningful because this is also the only land row that actually
  // schools — on a species whose members each have their own school id, the
  // propagation has nowhere to go.
  groupStartle: true,
  // The grazer's rule, at the grazer's threshold, and the same constant rather
  // than a second 5: "fairly flat areas" (owner, 2026-08-24) is a statement
  // about open country, and a herd of six needs it more than a triplet does.
  spawnGround: { kind: 'open', minOpenDirections: GRAZER_SPAWN_OPEN_DIRECTIONS },
  // GRASSLAND ONLY (owner, 2026-09-02: "Bison should only spawn in
  // grasslands"). The land ramp's green window — the same ground flora's
  // meadow covers — so a herd is born on grass and nowhere else: not on the
  // beach sand below it, not on the rock above. Open ground on the meadow is
  // then both rules at once, which is what a prairie is.
  spawnHeights: GRASSLAND_SPAWN_HEIGHTS,
};
