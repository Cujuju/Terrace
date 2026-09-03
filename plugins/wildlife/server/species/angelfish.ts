// The angelfish — a striped disc (owner, 2026-09-03: "two new fish species").
//
// ITS ONE IDEA: it is the shelf's second shoaler. The fish owns small, fast
// and orange; the angelfish is a tall golden disc with dark bars, taller than
// it is long, cruising mid-water in threes where the fish schools in fives.
// Same schooling ecology (per-group size draw, the fish's probabilities), a
// different silhouette and a different depth — the two shoals read apart even
// when they cross.

import { cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  FISH_SCHOOLING_PROBABILITY_BY_SIZE,
  FISH_SIZE_WEIGHTS,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  TURN_RADIUS_BODY_LENGTHS,
  type SpeciesProfile,
} from './profile.ts';

export const ANGELFISH_PROFILE: SpeciesProfile = {
  species: 'angelfish',
  habitat: 'shallow',
  // Between the ray's 1.0 and the shark's 1.8, well under the fish's 3: a disc
  // pushes more water than a torpedo, so it cruises slower than either
  // torpedo-shaped shoaler. Still faster than everything it shares the bottom
  // with, which is what keeps its shoal off the seabed.
  cruiseSpeedCellsPerSecond: cellsAcross(1.6),
  // Between the fish's 1.4 and the shark's 0.6: a shoaler wanders more than a
  // hunter, less than the darting fish it schools beside.
  turnNoiseRadiansPerSecond: 1.0,
  // A 0.6-unit body — between the fish's 0.7 and below the ray's 1.0. Small,
  // but tall: the length is what the turning circle is multiplied into, and a
  // disc turns on its centre.
  bodyLengthCells: cellsAcross(0.6),
  // 800 square world units each — half the eel's 1 500, twice the fish's 400.
  // On the day-one starter shelf (2 304 shallow) that is TWO angelfish: a pair
  // on the first screen, the third arriving with a little territory creep to
  // complete the first trio.
  habitatCellsPerIndividual: cellsOverArea(800),
  // Threes. Fives belong to the fish; a trio is visibly fewer without reading
  // as a broken school.
  groupSize: 3,
  // Graded like the fish's (many small, few large) and drawn the same way —
  // one class per group, so a trio sorts itself the way real shoals do.
  sizeWeights: FISH_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: FISH_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  // No idle bouts, for the fish's reason: a fish that stopped would leave its
  // school behind, and the same holds for anything that shoals.
  groupStartle: false,
  spawnGround: NO_SPAWN_GROUND_RULE,
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
