// The monster table: one profile per kind, every number named and justified.
//
// Two rules govern this file, both inherited from the wildlife plugin's
// species table for the same reasons:
//
//   1. Sizes and depths are written in BAND_HEIGHT / cell terms, never as raw
//      height units. BAND_HEIGHT is explicitly provisional (shared/src/
//      constants.ts "feel-tune in Phase 2"); "three bands below the sea"
//      survives a retune, "-192" does not.
//   2. Rates are per SECOND of simulated time and are consumed through
//      rollEvent (./rng.ts), so behaviour is identical at any TICK_HZ.
//
// It is a TABLE rather than a set of cthulhu-named globals because the
// singleton, the summon roll and the lair test are all written against the
// profile, not against Cthulhu: adding a second kind is adding a row plus a
// model, not editing the state machine.

import { CHUNK_SIZE } from '@terrace/shared';
import { MONSTER_KINDS, type MonsterKind } from '../protocol.ts';

/**
 * HARD SINGLETON. The world holds at most this many living monsters, of any
 * kind, ever, at once.
 *
 * The owner's brief is "no more than one per map", and it is expressed as a
 * WORLD-wide cap rather than a per-kind one on purpose: a map with two
 * different horrors in it is a bestiary, and the entire dramatic weight of this
 * plugin is that the thing in the water is THE thing in the water. When a
 * second kind is added, the kinds contest the one slot in MONSTER_KINDS order.
 */
export const MAX_LIVING_MONSTERS = 1;

/**
 * Cells in the smallest deep-water region a monster will accept as a lair,
 * given as a multiple of a chunk's area.
 *
 * Four chunks — 1024 cells, a 32×32 basin if it were square. Sized off the
 * animal, not off taste: Cthulhu's footprint is ~7 cells across, so 32 cells is
 * about four and a half body-widths in every direction. That is the smallest
 * region in which it can lurk and wander for minutes without its shoulders
 * grinding along a shoreline — which is the actual failure mode the threshold
 * exists to prevent. A Cthulhu in a puddle is comedy, not horror.
 *
 * For scale: a nominal half-water 512² world holds ~79 000 deep cells, so this
 * is 1.3% of one — a real basin, and easily dug on purpose by a player who
 * wants one.
 */
export const LAIR_MIN_AREA_CHUNKS = 4;
export const MIN_LAIR_DEEP_CELLS = LAIR_MIN_AREA_CHUNKS * CHUNK_SIZE * CHUNK_SIZE;

/**
 * Cells below which a lair has COLLAPSED and the monster leaves, as a multiple
 * of a chunk's area.
 *
 * One chunk (256 cells, 16×16). Deliberately a quarter of the arrival
 * threshold, which is hysteresis and not sloppiness: arrival and departure
 * being the same number would mean a player idly nibbling the rim of a
 * marginal basin could evict the monster and re-qualify the basin repeatedly,
 * turning a dread event into a light switch. Two distinct numbers mean the
 * water has to be genuinely, visibly gone before the thing submerges — at
 * 16 cells across, barely two body-widths, it is a pool, not a sea.
 */
export const LAIR_COLLAPSE_AREA_CHUNKS = 1;
export const LAIR_COLLAPSE_DEEP_CELLS = LAIR_COLLAPSE_AREA_CHUNKS * CHUNK_SIZE * CHUNK_SIZE;

/**
 * Mean wait, in simulated seconds, between a world becoming eligible and the
 * monster arriving. THE dial for how often the event happens.
 *
 * 240 s = 4 minutes. The roll is a Poisson process of rate 1/240 per second
 * (see rollEvent), so the derivation is exact rather than approximate:
 *
 *   P(arrived within  30 s) = 1 - e^(-30/240)  ≈ 12%
 *   P(arrived within 240 s) = 1 - e^(-1)       ≈ 63%
 *   P(arrived within 600 s) = 1 - e^(-2.5)     ≈ 92%
 *
 * That is the shape the brief asks for: never on the first minute of a session
 * as a matter of course, essentially certain across an evening's play, and with
 * no fixed timer a player could learn to count down. Arrival is an EVENT.
 */
export const CTHULHU_SUMMON_MEAN_WAIT_SECONDS = 240;

/**
 * Simulated seconds after a banishment before the monster may be rolled for
 * again. Ten minutes.
 *
 * Draining its lair is the only way a player can be rid of it, so being rid of
 * it has to feel earned and has to LAST — long enough to reshape the coast, not
 * so long that a world becomes permanently monster-free by accident. With the
 * 4-minute mean wait on top, a player who banishes it and then refloods the
 * basin waits ~14 minutes on average for the sequel.
 */
export const CTHULHU_RESPAWN_COOLDOWN_SECONDS = 600;

/**
 * Lurking speed, cells per second.
 *
 * 0.25 — under a third of the wildlife plugin's whale (0.8 cells/s), which is
 * the slowest thing otherwise in the water, and it crosses one chunk in just
 * over a minute. Read alongside the ~7-cell body: it covers a third of its own
 * width per second, which at any watchable camera distance is the difference
 * between "swimming" and "the horizon is moving".
 */
export const CTHULHU_LURK_SPEED_CELLS_PER_SECOND = 0.25;

/**
 * Maximum random heading change, radians per second. 0.1 rad/s is ~6°/s: over a
 * ten-second stretch it can drift a right angle at most, so its course reads as
 * inexorable rather than as browsing. (The wildlife whale, the least twitchy
 * creature there, is 0.25.)
 */
export const CTHULHU_TURN_NOISE_RADIANS_PER_SECOND = 0.1;

/**
 * IDLE BEATS — the long holds that make it read as watching rather than
 * commuting. A two-state Poisson process, both rates named here:
 *
 *   onset 0.05/s → while moving, a mean 20 s before it stops;
 *   end   0.12/s → once stopped, a mean 8.3 s of absolute stillness.
 *
 * Steady state is onset/(onset+end) ≈ 29% of the time stationary, in beats
 * averaging eight seconds. Eight seconds is the number chosen first: it is long
 * enough that a player watching it notices the stillness and starts wondering,
 * and short enough that it never reads as a frozen entity or a stuck server.
 */
export const CTHULHU_IDLE_ONSET_PER_SECOND = 0.05;
export const CTHULHU_IDLE_END_PER_SECOND = 0.12;

/**
 * Horizontal extent of the modelled body, in cells (CELL_WORLD_SIZE is 1, so
 * also world units). Wing tip to wing tip on the client model — see
 * client/anatomy.ts, which is where the silhouette's numbers live.
 *
 * The server needs it for exactly one thing: steering. A monster must never
 * commit to a step that would put its SHOULDER through a cliff, so the
 * look-ahead probe is never shorter than half of this.
 */
export const CTHULHU_FOOTPRINT_CELLS = 7;

/** Tuning for one kind. All rates are per SECOND of simulated time. */
export interface MonsterProfile {
  readonly kind: MonsterKind;

  /** Deep-water cells required in one region before this kind will arrive. */
  readonly minLairDeepCells: number;
  /** Deep-water cells in its own region below which it leaves. */
  readonly lairCollapseDeepCells: number;

  /** Mean simulated seconds from "eligible" to "arrived". See rollEvent. */
  readonly summonMeanWaitSeconds: number;
  /** Simulated seconds of enforced absence after a banishment. */
  readonly respawnCooldownSeconds: number;

  /** Wander speed while not idling, cells per second. */
  readonly lurkSpeedCellsPerSecond: number;
  /** Maximum random heading change, radians per second. */
  readonly turnNoiseRadiansPerSecond: number;

  /** Rate of entering an idle beat while moving. */
  readonly idleOnsetPerSecond: number;
  /** Rate of leaving an idle beat. */
  readonly idleEndPerSecond: number;

  /** Widest horizontal extent of the model, in cells. */
  readonly footprintCells: number;
}

export const MONSTER_PROFILES: Readonly<Record<MonsterKind, MonsterProfile>> = {
  cthulhu: {
    kind: 'cthulhu',
    minLairDeepCells: MIN_LAIR_DEEP_CELLS,
    lairCollapseDeepCells: LAIR_COLLAPSE_DEEP_CELLS,
    summonMeanWaitSeconds: CTHULHU_SUMMON_MEAN_WAIT_SECONDS,
    respawnCooldownSeconds: CTHULHU_RESPAWN_COOLDOWN_SECONDS,
    lurkSpeedCellsPerSecond: CTHULHU_LURK_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: CTHULHU_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: CTHULHU_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: CTHULHU_IDLE_END_PER_SECOND,
    footprintCells: CTHULHU_FOOTPRINT_CELLS,
  },
};

/** Deterministic iteration order over kinds (see MONSTER_KINDS). */
export function profileOf(kind: MonsterKind): MonsterProfile {
  return MONSTER_PROFILES[kind];
}

/**
 * Summon rate in events per second — the reciprocal of the mean wait, which is
 * the exact relationship for the Poisson process rollEvent implements. Derived
 * here rather than written into the table so the tuning dial stays the number a
 * human can reason about ("four minutes"), with no second constant to keep in
 * sync with it.
 */
export function summonRatePerSecond(profile: MonsterProfile): number {
  return 1 / profile.summonMeanWaitSeconds;
}

/** The kinds, in the fixed order the summoner considers them. */
export const SUMMON_ORDER: readonly MonsterKind[] = MONSTER_KINDS;
