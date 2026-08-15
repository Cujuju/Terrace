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
// singleton, the summon roll, the lair test, the banishment rule and the
// terrain guard are all written against the profile, not against Cthulhu:
// adding a kraken was adding a row plus a model, not editing the state machine.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO KINDS, AND THE AXES THAT SEPARATE THEM (owner decisions, 2026-08-14)
//
//                       Cthulhu                     Kraken
//   habitat             deep water, any basin       a TRENCH, and a big one
//   banishable          NO — nothing removes him    yes, by draining its lair
//
// The two rows are deliberately opposite: Cthulhu is the horror you cannot do
// anything about, the kraken is the one you can fight with a shovel. Neither
// behaviour is written into the lifecycle — `banishment: null` is a FIELD, so a
// third kind picks its own corner of the same table.
// ─────────────────────────────────────────────────────────────────────────────

import { BAND_HEIGHT, CHUNK_SIZE, MIN_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { MONSTER_KINDS, type MonsterKind } from '../protocol.ts';
import { DEEP_WATER_BANDS_BELOW_SEA } from './habitat.ts';

/**
 * HARD SINGLETON. The world holds at most this many living monsters, of any
 * kind, ever, at once.
 *
 * The owner's brief is "no more than one per map", and it is expressed as a
 * WORLD-wide cap rather than a per-kind one on purpose: a map with two
 * different horrors in it is a bestiary, and the entire dramatic weight of this
 * plugin is that the thing in the water is THE thing in the water. It stays at
 * one now that a second KIND exists — the kinds contest the one slot in
 * MONSTER_KINDS order (see SUMMON_ORDER), which is what that order is for.
 */
export const MAX_LIVING_MONSTERS = 1;

/**
 * Mean wait, in simulated seconds, between a world becoming eligible and a
 * monster arriving. THE dial for how often the event happens.
 *
 * PLUGIN-WIDE, NOT PER KIND, and that is the decision the single name records:
 * arrival pacing is a statement about how often this plugin interrupts a
 * session, which is the same question whichever animal answers the door. What
 * differs between kinds is WHERE they can live, not how eagerly they come. The
 * profile field stays per-kind so a future kind CAN differ; both rows today
 * point at this one number rather than at two copies of it.
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
export const SUMMON_MEAN_WAIT_SECONDS = 240;

// ── Cthulhu ──────────────────────────────────────────────────────────────────

/**
 * Cells in the smallest deep-water region Cthulhu will accept as a lair, given
 * as a multiple of a chunk's area.
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

// ── Kraken ───────────────────────────────────────────────────────────────────

/**
 * Cells in the smallest region the kraken will accept, as a multiple of a
 * chunk's area.
 *
 * Nine chunks — 2304 cells, a 48×48 basin if it were square, and 2.25× the
 * Cthulhu threshold. Derived from the way it MOVES rather than from its size
 * (the two animals are the same 7 cells across): the kraken cruises at 0.6
 * cells/s, so it crosses Cthulhu's minimum 32-cell basin in 53 seconds and
 * would spend its life turning at a shoreline — which reads as an animal pacing
 * a tank, the opposite of the thing that came up from the deep. 48 cells is 80
 * seconds of straight travel, long enough that its course reads as a patrol
 * between the turns.
 */
export const KRAKEN_LAIR_MIN_AREA_CHUNKS = 9;
export const KRAKEN_MIN_LAIR_DEEP_CELLS = KRAKEN_LAIR_MIN_AREA_CHUNKS * CHUNK_SIZE * CHUNK_SIZE;

/**
 * How deep the deepest cell of the kraken's lair must be, in bands below sea
 * level. THE FIELD THAT MAKES A SECOND KIND MEAN SOMETHING: Cthulhu takes any
 * deep water, the kraken wants a trench.
 *
 * DERIVED, not chosen: half of everything the world has below the sea. The map
 * bottoms out at MIN_HEIGHT, which is (SEA_LEVEL - MIN_HEIGHT) / BAND_HEIGHT =
 * 16 bands of water column, so this is "the deeper half of what a world can be"
 * — 8 bands, 512 height units. Stated as a derivation so it follows a retune of
 * MIN_HEIGHT or BAND_HEIGHT instead of quietly becoming a different fraction of
 * the sea; stated as a FRACTION because the honest requirement is relative
 * ("deep for this world"), not an absolute number of metres.
 *
 * For scale against the other threshold: the deep-water line is 3 bands, so a
 * kraken trench is nearly three times as deep as the shallowest water Cthulhu
 * will take, and a player who wants one has to dig for it.
 */
export const WORLD_WATER_COLUMN_BANDS = (SEA_LEVEL - MIN_HEIGHT) / BAND_HEIGHT;
export const KRAKEN_LAIR_MIN_DEPTH_BANDS = WORLD_WATER_COLUMN_BANDS / 2;

/**
 * Cells in its own region below which the kraken's trench has COLLAPSED and it
 * leaves, as a multiple of a chunk's area.
 *
 * Two chunks (512 cells, ~23×23). A QUARTER of the arrival threshold, which is
 * hysteresis and not sloppiness: arrival and departure being the same number
 * would mean a player idly nibbling the rim of a marginal basin could evict the
 * monster and re-qualify the basin repeatedly, turning a dread event into a
 * light switch. Two distinct numbers mean the water has to be genuinely,
 * visibly gone before it submerges.
 *
 * AREA ONLY, DELIBERATELY — not depth. Refilling the trench to shallower than
 * KRAKEN_LAIR_MIN_DEPTH_BANDS does NOT evict it: the depth requirement says
 * where it comes FROM, and re-testing an arrival condition every five seconds
 * is exactly the light switch the previous paragraph rejects. Draining is the
 * eviction, and it is the one a player can see themselves doing.
 */
export const KRAKEN_LAIR_COLLAPSE_AREA_CHUNKS = 2;
export const KRAKEN_LAIR_COLLAPSE_DEEP_CELLS =
  KRAKEN_LAIR_COLLAPSE_AREA_CHUNKS * CHUNK_SIZE * CHUNK_SIZE;

/**
 * Simulated seconds after a kraken is banished before it may be rolled for
 * again. Ten minutes.
 *
 * Draining its trench is the only way a player can be rid of it, so being rid
 * of it has to feel earned and has to LAST — long enough to reshape the coast,
 * not so long that a world becomes permanently monster-free by accident. With
 * the 4-minute mean wait on top, a player who banishes it and then refloods the
 * trench waits ~14 minutes on average for the sequel.
 */
export const KRAKEN_RESPAWN_COOLDOWN_SECONDS = 600;

/**
 * Cruising speed, cells per second.
 *
 * 0.6 — 2.4× Cthulhu's lurk and still below the wildlife whale's 0.8, so
 * nothing in the water is faster than the whale. It is the difference the two
 * kinds are BUILT around: Cthulhu broods in place and the kraken hunts, and at
 * 0.6 cells/s it covers most of a body-width every ten seconds, which is a
 * speed you can watch it make progress at without it ever looking like a boat.
 */
export const KRAKEN_LURK_SPEED_CELLS_PER_SECOND = 0.6;

/**
 * Maximum random heading change, radians per second. 0.18 rad/s is ~10°/s —
 * nearly twice Cthulhu's drift and still under the whale's 0.25: it prowls,
 * changing its mind on the scale of a few seconds, where Cthulhu's course is
 * inexorable.
 */
export const KRAKEN_TURN_NOISE_RADIANS_PER_SECOND = 0.18;

/**
 * IDLE BEATS, the mirror image of Cthulhu's:
 *
 *   onset 0.02/s → while moving, a mean 50 s before it stops;
 *   end   0.20/s → once stopped, a mean 5 s hold.
 *
 * Steady state is 0.02/0.22 ≈ 9% of the time stationary, in beats averaging
 * five seconds — a third of Cthulhu's share, in beats little more than half as
 * long. The stillness is Cthulhu's characteristic behaviour, so the kraken must
 * not borrow it: it pauses the way a hunter pauses, briefly and rarely.
 */
export const KRAKEN_IDLE_ONSET_PER_SECOND = 0.02;
export const KRAKEN_IDLE_END_PER_SECOND = 0.2;

/**
 * Horizontal extent of the modelled body, in cells: the crown of arms, tip to
 * tip (client/kraken-anatomy.ts).
 *
 * The SAME 7 cells as Cthulhu, and deliberately so rather than by coincidence.
 * The footprint is the number the steering look-ahead is sized from and the
 * number the atmosphere (client/dread.ts) keeps its lightning clear of, so a
 * wider second kind would have meant re-deriving effects that were tuned around
 * the first one. The kraken is built to fit inside the same 7 cells — it is a
 * different SHAPE in the same box, which is where a silhouette should differ
 * anyway. A test pins the model's reach against it.
 */
export const KRAKEN_FOOTPRINT_CELLS = 7;

// ── The table ────────────────────────────────────────────────────────────────

/**
 * How a kind can be driven out of the world, or `null` for one that cannot.
 *
 * THE POINT OF THE NULL (owner decision, 2026-08-14): Cthulhu cannot be
 * banished by any means. Expressing that as a missing RULE rather than as a
 * `banishable: false` flag is what keeps the two numbers that only make sense
 * for a banishable kind — the collapse threshold and the cooldown that follows
 * a banishment — from having to exist as dead values on his row. There is
 * nothing to leave unset and nothing to accidentally read.
 */
export interface BanishmentRule {
  /** Deep-water cells in its own region below which it leaves. */
  readonly lairCollapseDeepCells: number;
  /** Simulated seconds of enforced absence after a banishment. */
  readonly respawnCooldownSeconds: number;
}

/** Tuning for one kind. All rates are per SECOND of simulated time. */
export interface MonsterProfile {
  readonly kind: MonsterKind;

  /** Deep-water cells required in one region before this kind will arrive. */
  readonly minLairDeepCells: number;
  /**
   * How deep the lair's DEEPEST cell must be, in bands below sea level. The
   * global deep-water line (habitat.ts) is the floor for every kind; a kind may
   * demand more, and the kraken does.
   */
  readonly minLairDepthBands: number;

  /** Mean simulated seconds from "eligible" to "arrived". See rollEvent. */
  readonly summonMeanWaitSeconds: number;

  /** How it can be driven off, or null if nothing can drive it off. */
  readonly banishment: BanishmentRule | null;

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
    // No extra demand: the global deep-water line IS his habitat.
    minLairDepthBands: DEEP_WATER_BANDS_BELOW_SEA,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    // HE CANNOT BE BANISHED. See BanishmentRule and summoning.ts.
    banishment: null,
    lurkSpeedCellsPerSecond: CTHULHU_LURK_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: CTHULHU_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: CTHULHU_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: CTHULHU_IDLE_END_PER_SECOND,
    footprintCells: CTHULHU_FOOTPRINT_CELLS,
  },
  kraken: {
    kind: 'kraken',
    minLairDeepCells: KRAKEN_MIN_LAIR_DEEP_CELLS,
    minLairDepthBands: KRAKEN_LAIR_MIN_DEPTH_BANDS,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    banishment: {
      lairCollapseDeepCells: KRAKEN_LAIR_COLLAPSE_DEEP_CELLS,
      respawnCooldownSeconds: KRAKEN_RESPAWN_COOLDOWN_SECONDS,
    },
    lurkSpeedCellsPerSecond: KRAKEN_LURK_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: KRAKEN_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: KRAKEN_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: KRAKEN_IDLE_END_PER_SECOND,
    footprintCells: KRAKEN_FOOTPRINT_CELLS,
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

/**
 * The height at or below which this kind's lair must bottom out. Bands are what
 * the table states (rule 1 at the top of this file); heights are what the
 * survey measures, and this is the one place the two meet.
 */
export function minLairDeepestHeight(profile: MonsterProfile): number {
  return SEA_LEVEL - profile.minLairDepthBands * BAND_HEIGHT;
}

/** The kinds, in the fixed order the summoner considers them. */
export const SUMMON_ORDER: readonly MonsterKind[] = MONSTER_KINDS;
