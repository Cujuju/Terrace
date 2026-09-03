// The ibex — a crag climber (owner, 2026-09-02: "add two additional grazer
// types … unique behavior").
//
// ITS ONE IDEA: it lives where nothing else can stand. Every other land animal
// in this plugin is bounded by LAND_WALKER_MAX_GRADIENT_PER_CELL, which is
// half the terrain's own gradient cap and therefore makes a terrace riser a
// wall (shared/src/traversal.ts). The ibex's limit is twice that — exactly the
// terrain cap — so the steepest slope the world can legally contain is the
// steepest slope it can climb, and there is no ground on the map it is barred
// from by slope alone. That is the whole species: a grazer with one number
// doubled, plus a spawn rule that puts it where the number matters.

import { LAND_WALKER_MAX_GRADIENT_PER_CELL, cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  MOUNTAIN_SPAWN_HEIGHTS,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
  type SpeciesProfile,
} from './profile.ts';

/**
 * The ibex's gradient limit: TWICE the plain land walker's, which is the
 * terrain's own relaxation cap (`MAX_STEP`).
 *
 * Derived from the walker's figure rather than written as a height, and the
 * derivation is the design: LAND_WALKER_MAX_GRADIENT_PER_CELL is defined as
 * half of MAX_STEP precisely so that "the steepest half of legally possible
 * slopes are impassable to a walker". Doubling it therefore does not mean
 * "quite a bit steeper" — it means EXACTLY the ceiling, no more, so the ibex
 * can cross any legal slope and nothing about it needs re-deriving when
 * BAND_HEIGHT is feel-tuned. A larger multiple would buy nothing that exists.
 *
 * IT IS NOT A FLYING GOAT. The gradient is the only traversal axis that moves:
 * the ibex is still shared's land-walker archetype in every other respect
 * (census.ts's `walkerProfileOf`) — the band-0 waterline fringe is not ground,
 * and a river or a lake is still something to walk around.
 */
export const IBEX_MAX_GRADIENT_PER_CELL = 2 * LAND_WALKER_MAX_GRADIENT_PER_CELL;

/**
 * How many of the eight compass directions from a candidate spawn cell must be
 * steps a PLAIN land walker could not take but an ibex can — the "broken
 * ground" rule (SpawnGround, ./profile.ts).
 *
 * THREE OF EIGHT, and the number is bounded from both sides. Fewer than three
 * (a single riser, or a two-direction notch) is ordinary rolling country that
 * happens to have a step in it, which is where the grazer already lives; more
 * than three starts to demand a pinnacle, and a pinnacle is the trap
 * `openDirectionCount` was written to keep animals OFF (census.ts). Three is a
 * ledge with a face above and below it and open ground to either side, which is
 * where an ibex belongs and where the doubled gradient above is the difference
 * between an animal that can be there and one that cannot.
 *
 * IT IS NOT A FLATNESS RULE READ BACKWARDS. The grazer's
 * GRAZER_SPAWN_OPEN_DIRECTIONS asks for a MAJORITY of easy ground so that an
 * animal is never placed somewhere it cannot leave; this asks for a MINORITY of
 * hard ground so that an animal is placed somewhere its one ability is worth
 * having. The two rules can both be satisfied by the same cell, and that is
 * correct: the shoulder of a scarp is good ground for either animal.
 */
export const IBEX_SPAWN_STEEP_DIRECTIONS = 3;

/**
 * Perching bouts: it moves for ~12 s and stands for ~4 s.
 *
 * A CLIMBER'S RHYTHM, and the ratio is the point rather than either rate. An
 * ibex on a face reads as an animal picking its next foothold — mostly moving,
 * pausing on the ledge it just reached — so the onset is the slower of the two
 * rates and the bouts are short. The bison's are the other way round (a grazing
 * animal is mostly stationary, see ./bison.ts), which is what makes the two new
 * land species read as different animals at a glance rather than as one animal
 * at two speeds.
 *
 * 1/0.08 = 12.5 s moving, 1/0.25 = 4 s perched: it spends ~24% of its life
 * still. Short enough that a player never wonders whether it has frozen —
 * which, at the ~40% the bison sits at, would be a real question for an animal
 * standing on a cliff.
 */
const IBEX_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.08, endPerSecond: 0.25 };

export const IBEX_PROFILE: SpeciesProfile = {
  species: 'ibex',
  habitat: 'land',
  // Faster than the halved grazer (0.8) and much faster than the bison (0.6):
  // the small, light-footed one of the three land animals. Still well under the
  // fish's 3, because it is a walker and the sea is where speed lives.
  cruiseSpeedCellsPerSecond: cellsAcross(1.2),
  // The twitchiest thing on land (grazer 1.1, bison 0.5). An animal that
  // changes its mind about footings reads as alert; combined with the short
  // perches above, that is the whole character.
  turnNoiseRadiansPerSecond: 1.3,
  // Slightly smaller than the grazer's 1.1 and less than two thirds of the
  // bison's 1.6. Body length is also the look-ahead floor and the personal
  // space (movement.ts), so a smaller animal probes shorter and packs closer —
  // which is what lets an ibex use a ledge the bison could not stand on.
  bodyLengthCells: cellsAcross(0.9),
  // 700 square world units each — seven times the grazer's 100, so on any
  // hillside that holds both, grazers outnumber ibex seven to one. Steep ground
  // is a fraction of most terrain and a specialist that is as common as the
  // generalist stops reading as a specialist. Sparser than the bison (600) for
  // the same reason: a herd animal arrives six at a time and needs the land to
  // support the herd, where these arrive in twos.
  habitatCellsPerIndividual: cellsOverArea(700),
  // A PAIR. Not the grazer's triplet and nowhere near the bison's herd: two is
  // the smallest group that is a group, and on a ledge it is also the largest
  // one that fits. The pair is how they are BORN, not how they travel — the
  // solitary schooling odds below disperse them immediately.
  groupSize: 2,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: IBEX_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  idle: IBEX_IDLE_BOUTS,
  // A pair on a crag is not a herd; there is nothing for an alarm to travel
  // through, and the two of them are inside any radius that reaches either.
  groupStartle: false,
  spawnGround: { kind: 'broken', minSteepDirections: IBEX_SPAWN_STEEP_DIRECTIONS },
  // MOUNTAIN ONLY (owner, 2026-09-02: "Ibex should only spawn in the
  // mountains"). From the land ramp's first rock anchor up, snow included.
  // The broken-ground rule above finds a LEDGE; this says the ledge must be on
  // a mountain — a riser in a lowland meadow is a step, not a crag, and it was
  // exactly where a pair could be born before this.
  spawnHeights: MOUNTAIN_SPAWN_HEIGHTS,
};
