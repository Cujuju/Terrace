// The shark — a hunter (owner, 2026-09-02: "add two additional fish types …
// different behavior").
//
// ITS ONE IDEA: it is the only creature in this plugin that other creatures
// react to. Everything else on the shelf reacts to the PLAYER — a sculpt, a
// fire — and to nothing alive. A shark carries an alarm with it (see
// `Predation` on SpeciesProfile), so the fish ahead of it scatter and the ones
// behind it settle, and the whole behaviour is visible without a single frame
// of animation or one byte of extra payload: what a player sees is fish
// getting out of the way.

import { cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  TURN_RADIUS_BODY_LENGTHS,
  type Predation,
  type SpeciesProfile,
} from './profile.ts';

/**
 * How far a shark's presence is felt, in cells.
 *
 * THREE WORLD UNITS — twice its own body length, and the number is bounded from
 * both sides by what the animals can do about it. A startled creature runs at
 * FLEE_SPEED_MULTIPLIER for FLEE_DURATION_SECONDS (movement.ts), so a fish
 * clears 3 × 3 × 2.5 = 22 cells in one flight against this radius of 12: it can
 * put the whole alarm well behind it before it calms, which is the invariant
 * FIRE_STARTLE_RADIUS_CELLS (../index.ts) states for fire and the same
 * invariant holds here with a wide margin.
 *
 * Larger would be wrong for the READ rather than for the arithmetic: an alarm
 * that reaches a shelf's whole fish population turns "a shark went past" into
 * "everything on the shelf is permanently frightened", and since the alarm is
 * re-applied every tick from wherever the shark now is, a wide radius never
 * lets anything calm down. Smaller than the shark's own body would mean prey
 * scattering only once the shark is among them, which is a collision, not a
 * hunt.
 *
 * IT IS NOT THE SHARK'S SPEED THAT MAKES THIS WORK. A fleeing fish (9 cells/s)
 * is faster than a cruising shark (7.2), so prey genuinely outrun it — the
 * shark never catches anything, which is correct, because nothing is ever
 * caught (see `Predation`: no creature is removed by this).
 */
export const SHARK_ALARM_RADIUS_CELLS = cellsAcross(3);

/**
 * What a shark frightens: the shelf's other two species.
 *
 * ITSELF EXCLUDED, and structurally so rather than by a self-check in the
 * engine — a hunter's alarm is applied through the ordinary `startleNear` with
 * this list as a filter (movement.ts), so a shark is out of scope of its own
 * alarm because it is not in its own prey list. Two sharks that pass close
 * likewise ignore each other, which is right: a solitary animal is not
 * frightened of its own kind.
 *
 * THE WHALE AND THE ANGLER ARE NOT HERE because they are not on the shelf —
 * both live in `deep` and a shallow-water hunter never comes within its alarm
 * radius of one. Listing them would be a rule that can never fire, and a rule
 * that can never fire is a claim nobody can check.
 */
const SHARK_PREY: Predation = {
  preySpecies: ['fish', 'ray'],
  alarmRadiusCells: SHARK_ALARM_RADIUS_CELLS,
};

export const SHARK_PROFILE: SpeciesProfile = {
  species: 'shark',
  habitat: 'shallow',
  // The second fastest thing in the game after the fish's 3, and slower than it
  // deliberately: a fish must be able to escape (see SHARK_ALARM_RADIUS_CELLS).
  // Nearly twice the ray's 1.0, which is what makes a shark crossing a shelf
  // read as purposeful next to a ray drifting over it.
  cruiseSpeedCellsPerSecond: cellsAcross(1.8),
  // Between the ray's 0.3 and the fish's 1.4, nearer the ray: a cruising
  // predator holds a line without being rigid about it.
  turnNoiseRadiansPerSecond: 0.6,
  // The largest body on the shelf — over twice the fish's 0.7 and half again
  // the ray's 1.0 — and only the whale (5) and the angler (1.2) are bigger
  // anywhere. It is also the length the alarm radius is stated against.
  bodyLengthCells: cellsAcross(1.5),
  // 2 500 square world units each — the thinnest density in the table, six
  // times the fish's 400 and twice the ray's 1 200. Two reasons, and both are
  // binding. ECOLOGY: a predator that is as common as its prey is not a
  // predator. COST: the alarm is O(hunters × population) every tick (see
  // `Predation`), so the density is what keeps the hunter count in single
  // figures on any world. On the day-one starter shelf (2 304 shallow) that is
  // floor(2 304 / 2 500) = ZERO sharks — the shelf a world opens on is too
  // small for one, and the first shark arrives with territory creep. That is
  // the same progression the whale and the kraken already have, and it is the
  // right first sight of a shark: not on the first screen.
  habitatCellsPerIndividual: cellsOverArea(2500),
  // Solitary — the animal is a lone cruiser, and the alarm it carries would
  // otherwise be applied several times over from nearly the same point.
  groupSize: 1,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
  // The ordinary turning circle. A shark is a fish shape, and the ray's wide
  // arc is the exception in this plugin, not the rule for everything large.
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  // NO IDLE BOUTS, and it is the one row that states nothing here. A resting
  // shark is a contradiction of the only thing this species does: the alarm is
  // applied from wherever it is, so a shark that stopped would hold a patch of
  // shelf permanently frightened while itself appearing to have died. It is
  // also the plugin's only always-moving animal, which is a legible reason for
  // a player to watch it.
  groupStartle: false,
  hunts: SHARK_PREY,
  spawnGround: NO_SPAWN_GROUND_RULE,
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
