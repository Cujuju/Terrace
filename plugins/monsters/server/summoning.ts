// THE SINGLETON. Whether a monster exists, where it came from, and when it is
// allowed to come back.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE INVARIANT, AND WHY IT IS STRUCTURAL RATHER THAN CHECKED
//
// "At most one monster is alive, ever, at a time" is not enforced by counting
// and comparing at the call sites — it is enforced by there being exactly ONE
// SLOT to be alive in: `living` is a `Monster | null`, not a list. A second
// monster cannot be added to a nullable slot; the worst a buggy caller can do is
// overwrite the first, and `summon` refuses to write a non-empty slot. There is
// therefore no code path — spawn, restore, terrain reaction, or tick — that can
// produce two, and no test can be written that would catch a violation, because
// the shape of the state makes the violation unrepresentable.
//
// MAX_LIVING_MONSTERS (=1, ./kinds.ts) exists anyway, and is compared against
// anyway, for one reason: it gives the decision a name to grep for. The day a
// world is meant to hold two, this module changes from a slot to a list and the
// constant is the marker of every place that has to be reconsidered.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR GATES ON ARRIVAL
//
// A monster appears only when ALL of these hold, checked in this order:
//
//   1. the slot is empty                       — the singleton;
//   2. the banishment cooldown has expired     — minutes of enforced absence
//                                                after it was driven off;
//   3. a qualifying lair exists                — one CONNECTED deep-water region
//                                                of at least minLairDeepCells
//                                                that bottoms out at least
//                                                minLairDepthBands down;
//   4. the per-second summon roll fires        — arrival is a stochastic EVENT,
//                                                mean wait summonMeanWaitSeconds.
//
// Gates 1–3 are facts about the world; gate 4 is what stops arrival from being
// boot inventory. A world that satisfies 1–3 from the first tick still waits a
// Poisson-distributed few minutes, with no timer a player could learn to count
// down. See rollEvent (./rng.ts) for why the roll is exponential and not
// `random() < rate * dt`.
//
// CLOCK: `dt` from the host is the only time source. No Date.now anywhere, so a
// server running at a different TICK_HZ behaves identically per simulated
// second — including the mean summon wait and the cooldown.
//
// ─────────────────────────────────────────────────────────────────────────────
// DEPARTURE IS PER KIND (owner decision, 2026-08-14)
//
// A kind with `banishment: null` in the table CANNOT LEAVE. Cthulhu is the
// first: no collapse test, no habitat eviction, no cooldown — there is no code
// path that removes him, because `banish` refuses at the single exit rather
// than each caller remembering to ask. What happens when a player drains his
// sea is therefore not "he is banished" but nothing at all: the water goes, the
// basin becomes a puddle, and the thing is still standing in it. That is the
// owner's rule and the comedy is accepted; the lurk step (./lurk.ts) makes it
// read as an animal holding still rather than as a wedged simulation, and if
// the water ever comes back he simply resumes. A restart does not launder it
// either — persistence restores him where he was, and the first tick's habitat
// check no longer has the power to remove him.
//
// The kraken keeps the original behaviour, which is what the field is for: its
// trench collapses, it goes, and its ten minutes of absence begin.
// ─────────────────────────────────────────────────────────────────────────────

import type { MonsterKind } from '../protocol.ts';
import {
  EMPTY_LAIR_SURVEY,
  type LairRegion,
  type LairSurvey,
  type LairWorld,
  isLairCell,
  releaseSurveyScratch,
  surveyLairs,
} from './habitat.ts';
import {
  MAX_LIVING_MONSTERS,
  SUMMON_ORDER,
  type MonsterProfile,
  minLairDeepestHeight,
  profileOf,
  summonRatePerSecond,
} from './kinds.ts';
import { monsterRandom, rollEvent } from './rng.ts';

/** A living monster. Mutable — the lurk step writes it in place. */
export interface Monster {
  /** Stable for its whole life; never reused after a banishment. */
  readonly id: number;
  readonly kind: MonsterKind;
  /** Cell-space position, fractional. */
  x: number;
  y: number;
  /** Radians. Movement direction is (cos heading, sin heading) in cell space. */
  heading: number;
  /** True during an idle beat: it holds position and simply watches. */
  idle: boolean;
}

/**
 * Seconds between lair surveys.
 *
 * Five, the same interval the wildlife plugin's census uses and for the same
 * reason: the survey walks every cell of the world (~1 ms on a full 512²
 * board — see surveyLairs), so it must not run per tick, but deep water only
 * changes when terrain or the unlock mask changes, and both are human-paced. A
 * five-second worst-case lag in noticing a drained basin is invisible next to
 * the ten-minute cooldown that follows it, and the reactive path
 * (invalidateSurvey, called from onTerrainChanged) collapses that lag to one
 * tick whenever a player actually sculpts.
 */
export const LAIR_SURVEY_INTERVAL_SECONDS = 5;

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching the shape of the wildlife,
// mana and reveal plugins (one plugin instance per server process).

/** THE SLOT. Null means nothing is out there. */
let living: Monster | null = null;

/** Simulated seconds of enforced absence remaining. 0 when not banished. */
let cooldownSeconds = 0;

/** Accumulated simulated seconds — the only clock this plugin has. */
let simSeconds = 0;

/** Simulated time of the last survey; -Infinity forces one on the first tick. */
let lastSurveySeconds = Number.NEGATIVE_INFINITY;

/** The most recent survey. Drives gate 3 and the collapse test. */
let survey: LairSurvey = EMPTY_LAIR_SURVEY;

/**
 * The id the next summon will take. Persisted, so an id is never reused across a
 * restart — a client that had the old monster interpolating would otherwise
 * blend the new one's arrival out of the old one's position.
 */
let nextMonsterId = 1;

export function livingMonster(): Monster | null {
  return living;
}

/** 0 or 1. The counting form of the slot, for the cap comparison. */
export function livingMonsterCount(): number {
  return living === null ? 0 : 1;
}

export function cooldownRemainingSeconds(): number {
  return cooldownSeconds;
}

export function lastLairSurvey(): LairSurvey {
  return survey;
}

export function nextMonsterIdValue(): number {
  return nextMonsterId;
}

/** Simulated seconds since this plugin's state was last reset. */
export function summoningSimSeconds(): number {
  return simSeconds;
}

/** Drops all state so a suite (or a fresh world) starts from zero. */
export function resetSummoning(): void {
  living = null;
  cooldownSeconds = 0;
  simSeconds = 0;
  lastSurveySeconds = Number.NEGATIVE_INFINITY;
  survey = EMPTY_LAIR_SURVEY;
  nextMonsterId = 1;
  releaseSurveyScratch();
}

/**
 * Forces the next tick to re-survey. Called from the terrain reaction: a player
 * who just drained a basin should not wait out the survey interval to find out
 * whether it worked.
 */
export function invalidateSurvey(): void {
  lastSurveySeconds = Number.NEGATIVE_INFINITY;
}

// ── Arrival and departure ────────────────────────────────────────────────────

/**
 * THE ONLY FUNCTION THAT PUTS A MONSTER IN THE WORLD (the snapshot restore
 * below is the other way in, and that is what restoring a saved world means).
 *
 * Refuses outright if the slot is occupied. That check is redundant with every
 * caller's own gate and is kept anyway: it is the last line of the invariant,
 * it costs one comparison per summon, and it means a future caller cannot
 * introduce a second monster by forgetting a precondition.
 *
 * Returns the monster, or null if it refused.
 */
function summon(kind: MonsterKind, cellX: number, cellY: number): Monster | null {
  if (livingMonsterCount() >= MAX_LIVING_MONSTERS) return null;

  living = {
    id: nextMonsterId++,
    kind,
    // Cell centre: the survey reports a cell, and a monster placed on the corner
    // of one would be half a cell off from the water the survey vouched for.
    x: cellX + 0.5,
    y: cellY + 0.5,
    heading: monsterRandom() * Math.PI * 2,
    idle: false,
  };
  return living;
}

/**
 * Removes the monster and starts its cooldown. The one exit — habitat collapse,
 * the ground being raised out from under it, and any future cause all go
 * through here, so "it left" and "it cannot come back for ten minutes" can
 * never come apart.
 *
 * AND THE ONE PLACE BANISHABILITY IS DECIDED. A kind whose profile carries no
 * BanishmentRule is refused here, at the exit, rather than at each caller: the
 * habitat check, the collapse test and every future cause of departure are all
 * made harmless by the same three lines, and a new caller cannot introduce a
 * way to remove Cthulhu by forgetting to ask whether he can be removed.
 *
 * Returns true if something actually left.
 */
export function banish(): boolean {
  if (living === null) return false;
  const rule = profileOf(living.kind).banishment;
  if (rule === null) return false;
  cooldownSeconds = rule.respawnCooldownSeconds;
  living = null;
  return true;
}

/**
 * Banishes the monster if the cell it stands in has stopped being deep unlocked
 * water — drained, filled, or somehow re-locked.
 *
 * Runs every tick after movement AND from the terrain reaction, so the two ways
 * it can end up somewhere invalid (it swam there / the world changed under it)
 * share one implementation. It is two WorldApi calls; there is no reason to
 * make it conditional.
 *
 * For an unbanishable kind this is a no-op by construction (`banish` refuses),
 * and the monster is left standing on whatever the ground has become.
 */
export function enforceHabitat(world: LairWorld): boolean {
  if (living === null) return false;
  if (isLairCell(world, living.x, living.y)) return false;
  return banish();
}

/**
 * The best lair for this kind in the last survey, or null if the world holds
 * none. GATE 3, and the only place a kind's habitat demands are applied.
 *
 * BIGGEST QUALIFYING REGION, not the biggest region: a kraken that wants a
 * trench must not be turned away because the map also contains a larger shallow
 * bay, and it must not be summoned INTO that bay either. Ties go to the earlier
 * region in scan order, which is fixed (habitat.ts), so two runs over the same
 * world pick the same lair.
 */
function bestLairFor(profile: MonsterProfile): LairRegion | null {
  const deepestHeightAllowed = minLairDeepestHeight(profile);
  let best: LairRegion | null = null;
  for (const region of survey.regions) {
    if (region.cells < profile.minLairDeepCells) continue;
    if (region.deepestHeight > deepestHeightAllowed) continue;
    if (best !== null && region.cells <= best.cells) continue;
    best = region;
  }
  return best;
}

/**
 * Gates 2–4 of arrival. Called only when the slot is empty.
 *
 * Kinds are considered in SUMMON_ORDER — strictest habitat first, see
 * MONSTER_KINDS — and the first one whose lair qualifies AND whose roll fires
 * takes the world's single slot.
 */
function trySummon(world: LairWorld, dt: number): void {
  if (cooldownSeconds > 0) return;

  for (const kind of SUMMON_ORDER) {
    const profile = profileOf(kind);
    const cell = bestLairFor(profile);
    if (cell === null) continue;
    if (!rollEvent(summonRatePerSecond(profile), dt)) continue;

    // The survey can be up to LAIR_SURVEY_INTERVAL_SECONDS stale, so the cell it
    // named is re-checked against the world as it is NOW. Failing here costs the
    // roll that just fired — a negligible lengthening of the mean wait in the
    // rare case where a player filled that exact cell within the last five
    // seconds — and forces a fresh survey rather than trying a stale cell again.
    if (!isLairCell(world, cell.x, cell.y)) {
      invalidateSurvey();
      return;
    }

    summon(kind, cell.x, cell.y);
    return;
  }
}

/**
 * THE LIFECYCLE STEP. Once per host tick, before movement.
 *
 * Fixed order:
 *   1. clock;
 *   2. cooldown decay — a banished monster's absence is measured in simulated
 *      seconds, so it survives a paused or slow server exactly;
 *   3. survey, on its interval, and the COLLAPSE TEST: if the region the monster
 *      is actually in has shrunk below its kind's collapse threshold, it
 *      submerges. Note this reads occupiedRegionCells, not the biggest basin on
 *      the map — draining the sea around it is what drives it off, and a bigger
 *      ocean elsewhere is no comfort. A kind that cannot be banished has no
 *      collapse threshold to compare against and is skipped entirely;
 *   4. the arrival gates, but only while the slot is empty.
 */
export function advanceSummoning(world: LairWorld, dt: number): void {
  simSeconds += dt;

  if (cooldownSeconds > 0) cooldownSeconds = Math.max(0, cooldownSeconds - dt);

  if (simSeconds - lastSurveySeconds >= LAIR_SURVEY_INTERVAL_SECONDS) {
    lastSurveySeconds = simSeconds;
    survey = surveyLairs(world, living);

    const banishment = living === null ? null : profileOf(living.kind).banishment;
    if (banishment !== null && survey.occupiedRegionCells < banishment.lairCollapseDeepCells) {
      banish();
    }
  }

  if (living === null) trySummon(world, dt);
}

// ── Snapshot restore ─────────────────────────────────────────────────────────

/**
 * Replaces the whole lifecycle state from a snapshot (../server/persistence.ts).
 *
 * This is the ONLY seam through which a monster appears without passing the four
 * gates, which is exactly what restoring a saved world means: the gates already
 * ran, before the shutdown. It takes at most one monster BY TYPE, so a corrupt
 * or hand-edited snapshot cannot smuggle in a second — the duplication a restart
 * could otherwise introduce is impossible to express here.
 *
 * The survey is deliberately left empty and stale so the first tick re-derives
 * it against the world as restored; a BANISHABLE monster whose basin was drained
 * by another plugin's migration is then banished on that first tick rather than
 * trusted. An unbanishable one is restored exactly where it was and stays there,
 * which is the same answer a running server would have given — a restart is not
 * a way to be rid of it either.
 */
export function restoreSummoning(
  monster: Monster | null,
  nextId: number,
  cooldownRemaining: number,
): void {
  resetSummoning();
  living = monster === null ? null : { ...monster };
  nextMonsterId = nextId;
  cooldownSeconds = cooldownRemaining;
}
