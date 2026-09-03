// The eel — a bottom ribbon (owner, 2026-09-03: "two new fish species").
//
// ITS ONE IDEA: it does not dart and it does not glide — it pours. Every other
// swimmer here beats a fin to move; the eel travels as a wave through its whole
// length, slow (0.9, the slowest thing in the water except the whale), hugging
// the seabed at depthFraction 0.8 and settling into crevices for long rests.
// It is the third solitary shelf animal after the ray and the shark, and the
// three read apart at a glance: a disc, a hunter, a ribbon.

import { cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
  type SpeciesProfile,
} from './profile.ts';

/**
 * Resting in a crevice: it cruises for ~25 s and settles for ~10 s.
 *
 * A touch lazier than the ray (20 s on, ~6.7 s off): an eel at rest is nearly
 * invisible against the bottom — a thin olive line, not a disc — so it can
 * afford to stay put longer without the player reading it as gone. The client
 * already draws it low (depthFraction 0.8 in client/placement.ts), so a resting
 * eel reads as resting ON the seabed, same mechanism as the ray's.
 */
const EEL_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.04, endPerSecond: 0.10 };

export const EEL_PROFILE: SpeciesProfile = {
  species: 'eel',
  habitat: 'shallow',
  // The slowest thing in the water except the whale (0.8): slower than the ray
  // (1.0) it shares the bottom with, much slower than the fish (3) flickering
  // above it. Slow is what makes a wave-swimmer read instead of a dart.
  cruiseSpeedCellsPerSecond: cellsAcross(0.9),
  // Between the ray's 0.3 and the shark's 0.6: a ribbon holds a line, but a
  // whole-body wave never tracks quite as straight as a gliding disc.
  turnNoiseRadiansPerSecond: 0.5,
  // The second longest body on the shelf after the shark's 1.5, and measured
  // nose to tail-fan tip — most of it is tail, which is the point.
  bodyLengthCells: cellsAcross(1.2),
  // 1 500 square world units each — between the ray's 1 200 and the shark's
  // 2 500. On the day-one starter shelf (2 304 shallow) that is exactly ONE
  // eel: solitary from the first minute, like the ray, which is the right
  // first impression for it.
  habitatCellsPerIndividual: cellsOverArea(1500),
  // Solitary. Eels do not shoal, and a group of one is its own school.
  groupSize: 1,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
  // The ordinary turning circle. The ray's wide arc is the exception for a
  // stiff glider; a ribbon bends along its whole length, so it turns like a
  // fish despite its size.
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  idle: EEL_IDLE_BOUTS,
  // Nothing to propagate through: a solitary species' school is one animal.
  groupStartle: false,
  spawnGround: NO_SPAWN_GROUND_RULE,
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
