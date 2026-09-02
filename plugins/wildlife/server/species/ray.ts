// The ray — a bottom glider (owner, 2026-09-02: "add two additional fish types
// … different behavior").
//
// ITS ONE IDEA: it does not dart. Every other swimmer on the shelf is a fish
// with a fish's turn noise (1.4 rad/s) and a fish's turning circle (half a body
// length); the ray banks through an arc three times as wide as its own body is
// long, wanders barely at all, and settles onto the seabed for long rests. It
// is the slow read on a shelf whose other inhabitant is the quick one, and the
// two behaviours are visible side by side because they share a habitat.

import { cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  NO_SPAWN_GROUND_RULE,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  type IdleBouts,
  type SpeciesProfile,
} from './profile.ts';

/**
 * The ray's turning circle: one and a half body lengths, three times the
 * TURN_RADIUS_BODY_LENGTHS every other row states.
 *
 * WHAT IT BUYS. `maxTurnRadiansPerSecondOf` (movement.ts) is speed divided by
 * this radius, so the ray turns at a third of the rate a same-sized fish would
 * and traces an arc three times as wide at any speed. That is the whole visual
 * difference between a fish changing its mind and a ray coming about, and it is
 * expressed as a RADIUS rather than as a slower turn rate so that it stays true
 * when the animal is fleeing: panic triples the speed AND the radians per
 * second, and the arc through the water is identical. A frightened ray covers
 * its turn faster; it does not suddenly become able to pivot.
 *
 * THE RESIDUAL THIS ACCEPTS, named rather than discovered. TURN_RADIUS_BODY_
 * LENGTHS' own note states the relation that bounds it: `lookaheadCellsFor`
 * floors the probe at one body length, so any ratio above 0.5 gives a creature
 * a turning circle wider than its own sightline, and it can arc into something
 * it had already seen. At 1.5 the ray's circle is three times its probe. What
 * makes that acceptable HERE and nowhere else is the habitat: a ray is a
 * shallow-water animal on open shelf, where the only thing to arc into is the
 * shoreline, and the shoreline is not an obstacle it can be wedged against —
 * the veto simply refuses the step and the two-stage retry (advanceEntity)
 * turns it along the beach over the next few ticks. It is also the SLOWEST
 * thing on the shelf, so the arc it cannot complete is the smallest.
 *
 * If a ray is ever wanted on a reef — genuine obstacles at its own scale — this
 * is the number that has to come back down, or `lookaheadCellsFor`'s floor has
 * to rise to match the widest turning circle in the table.
 */
export const RAY_TURN_RADIUS_BODY_LENGTHS = 1.5;

/**
 * Resting on the seabed: it glides for ~20 s and settles for ~6.7 s.
 *
 * A BOTTOM-DWELLER'S RHYTHM. The onset matches the bison's — a resting animal
 * is one that stops often — but the rest is half again shorter, so the ray
 * spends ~25% of its life still against the bison's ~33%. That is the
 * difference between an animal grazing and an animal waiting: a ray settled on
 * sand is a shape a player notices and then watches, and it should move again
 * before they stop watching.
 *
 * THE CLIENT ALREADY DRAWS IT LOW. The ray's swim profile sits at depthFraction
 * 0.85 (client/placement.ts), the deepest of any swimmer but the angler, so a
 * resting ray is already nearly on the seabed and the bout is what makes it
 * read as resting THERE rather than as hanging in the water column. The server
 * models no vertical axis at all — depth is entirely the client's — so "rests
 * on the seabed" is these two rates plus that one fraction, and nothing else.
 */
const RAY_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.05, endPerSecond: 0.15 };

export const RAY_PROFILE: SpeciesProfile = {
  species: 'ray',
  habitat: 'shallow',
  // A third of the fish's 3 and a little over half the shark's 1.8: the slowest
  // thing in the water except the whale (0.8). Slow is the species.
  cruiseSpeedCellsPerSecond: cellsAcross(1.0),
  // The lowest turn noise of any shelf animal — a fifth of the fish's 1.4 and
  // half the shark's 0.6. Combined with the wide turning circle above, a ray's
  // path is very nearly a straight line with long, slow bends in it.
  turnNoiseRadiansPerSecond: 0.3,
  // Half again the fish's 0.7 and two thirds of the shark's 1.5. Body length
  // sets the turning circle it is multiplied into, so a larger body at the same
  // ratio would already turn wider; the 1.5 ratio is on top of that.
  bodyLengthCells: cellsAcross(1.0),
  // 1 200 square world units each — three times the fish's 400, so a shelf
  // holds three fish for every ray, and less than half the shark's 2 500, so a
  // ray is an ordinary sight where a shark is not. On the day-one starter
  // shelf (2 304 shallow) that is exactly ONE ray: a solitary animal, present
  // from the first minute, which is the right first impression for it.
  habitatCellsPerIndividual: cellsOverArea(1200),
  // Solitary. Rays do not shoal, and a group of one is its own school — every
  // school rule in the plugin degenerates correctly rather than needing a
  // branch (see `groupSize` on SpeciesProfile).
  groupSize: 1,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: RAY_TURN_RADIUS_BODY_LENGTHS,
  idle: RAY_IDLE_BOUTS,
  // Nothing to propagate through: a solitary species' school is one animal.
  groupStartle: false,
  spawnGround: NO_SPAWN_GROUND_RULE,
};

