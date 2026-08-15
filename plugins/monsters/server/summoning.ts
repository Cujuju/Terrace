// THE SLOTS. Whether a monster exists, where it came from, and when it is
// allowed to come back.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE INVARIANT, AND WHY IT IS STRUCTURAL RATHER THAN CHECKED
//
// "At most one monster is alive per HABITAT, ever, at a time" is not enforced by
// counting and comparing at the call sites — it is enforced by there being
// exactly ONE SLOT per habitat to be alive in: each `HabitatState.living` is a
// `Monster | null`, not a list, and the states are a fixed record keyed by the
// regimes that exist. A second monster cannot be added to a nullable slot; the
// worst a buggy caller can do is overwrite the first, and `summon` refuses to
// write a non-empty slot. There is therefore no code path — spawn, restore,
// terrain reaction, or tick — that can produce two in one habitat, and no test
// can be written that would catch a violation, because the shape of the state
// makes the violation unrepresentable.
//
// MAX_LIVING_MONSTERS_PER_HABITAT (=1, ./kinds.ts) exists anyway, and is
// compared against anyway, for one reason: it gives the decision a name to grep
// for. The day a habitat is meant to hold two, this module changes from a slot
// to a list and the constant is the marker of every place that has to be
// reconsidered.
//
// WHY PER HABITAT AND NOT PER WORLD (owner decision, 2026-08-14 — the yeti):
// see MAX_LIVING_MONSTERS_PER_HABITAT. The short version is that a mountain and
// an ocean are disjoint, and one silently blocking the other reads as a bug.
// Everything the world-wide slot bought — you never meet two horrors at once in
// the place you are standing — is preserved, because the places are different.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR GATES ON ARRIVAL
//
// A monster appears in a habitat only when ALL of these hold, checked in this
// order:
//
//   1. that habitat's slot is empty            — the singleton;
//   2. that habitat's cooldown has expired     — minutes of enforced absence
//                                                after something was driven off
//                                                THERE. Per habitat, so
//                                                banishing the yeti cannot
//                                                suppress the sea;
//   3. a qualifying lair exists                — one CONNECTED region of that
//                                                habitat of at least
//                                                minLairCells that reaches at
//                                                least minLairReachBands in;
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
// trench collapses, it goes, and its ten minutes of absence begin. The yeti is
// the same rule on land: level his snowfield and he leaves.
// ─────────────────────────────────────────────────────────────────────────────

import type { MonsterKind } from '../protocol.ts';
import {
  EMPTY_LAIR_SURVEY,
  HABITAT_REGIMES,
  type HabitatRegime,
  type HabitatRegimeId,
  type LairRegion,
  type LairSurvey,
  type LairWorld,
  isLairCell,
  reachesIntoHabitat,
  releaseSurveyScratch,
  surveyLairs,
} from './habitat.ts';
import {
  MAX_LIVING_MONSTERS_PER_HABITAT,
  type MonsterProfile,
  kindsInHabitat,
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
 * reason: the survey walks every cell of the world once PER HABITAT (~1 ms each
 * on a full 512² board — see surveyLairs), so it must not run per tick, but
 * habitat only changes when terrain or the unlock mask changes, and both are
 * human-paced. A five-second worst-case lag in noticing a drained basin or a
 * levelled peak is invisible next to the ten-minute cooldown that follows it,
 * and the reactive path (invalidateSurvey, called from onTerrainChanged)
 * collapses that lag to one tick whenever a player actually sculpts.
 */
export const LAIR_SURVEY_INTERVAL_SECONDS = 5;

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching the shape of the wildlife,
// mana and reveal plugins (one plugin instance per server process).

/** Everything the lifecycle owns about ONE habitat. */
interface HabitatState {
  /** THE SLOT. Null means nothing is out there. */
  living: Monster | null;
  /** Simulated seconds of enforced absence remaining. 0 when not banished. */
  cooldownSeconds: number;
  /** The most recent survey of this habitat. Drives gate 3 and the collapse. */
  survey: LairSurvey;
}

function emptyHabitatState(): HabitatState {
  return { living: null, cooldownSeconds: 0, survey: EMPTY_LAIR_SURVEY };
}

/**
 * One state per habitat. Written out rather than built from HABITAT_REGIMES so
 * the type is a TOTAL Record over HabitatRegimeId: a new regime added to
 * habitat.ts fails to compile here until it is given a slot, where a
 * `Map`-shaped construction would have silently returned undefined for it at
 * runtime.
 */
function emptyStates(): Record<HabitatRegimeId, HabitatState> {
  return {
    water: emptyHabitatState(),
    land: emptyHabitatState(),
  };
}

let states: Record<HabitatRegimeId, HabitatState> = emptyStates();

/** Accumulated simulated seconds — the only clock this plugin has. */
let simSeconds = 0;

/** Simulated time of the last survey; -Infinity forces one on the first tick. */
let lastSurveySeconds = Number.NEGATIVE_INFINITY;

/**
 * The id the next summon will take. Persisted, so an id is never reused across a
 * restart — a client that had the old monster interpolating would otherwise
 * blend the new one's arrival out of the old one's position. It is WORLD-wide
 * rather than per habitat: ids key the client's interpolation map, which knows
 * nothing about habitats.
 */
let nextMonsterId = 1;

function stateOf(regime: HabitatRegime): HabitatState {
  return states[regime.id];
}

/** The monster living in this habitat, or null. */
export function livingMonsterIn(regime: HabitatRegime): Monster | null {
  return stateOf(regime).living;
}

/**
 * Every living monster, in HABITAT_REGIMES order.
 *
 * The order is fixed rather than incidental because this is what the broadcast
 * list is built from: a list whose ORDER wobbled between ticks would be a wire
 * payload that changed for no reason, and a diff nobody could read.
 */
export function livingMonsters(): Monster[] {
  const alive: Monster[] = [];
  for (const regime of HABITAT_REGIMES) {
    const monster = stateOf(regime).living;
    if (monster !== null) alive.push(monster);
  }
  return alive;
}

/** How many monsters are alive in the world, across all habitats. */
export function livingMonsterCount(): number {
  let count = 0;
  for (const regime of HABITAT_REGIMES) {
    if (stateOf(regime).living !== null) count++;
  }
  return count;
}

/** 0 or 1. The counting form of one habitat's slot, for the cap comparison. */
export function livingCountIn(regime: HabitatRegime): number {
  return stateOf(regime).living === null ? 0 : 1;
}

export function cooldownRemainingSeconds(regime: HabitatRegime): number {
  return stateOf(regime).cooldownSeconds;
}

export function lastLairSurvey(regime: HabitatRegime): LairSurvey {
  return stateOf(regime).survey;
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
  states = emptyStates();
  simSeconds = 0;
  lastSurveySeconds = Number.NEGATIVE_INFINITY;
  nextMonsterId = 1;
  releaseSurveyScratch();
}

/**
 * Forces the next tick to re-survey EVERY habitat. Called from the terrain
 * reaction: a player who just drained a basin should not wait out the survey
 * interval to find out whether it worked — and one sculpt can change both
 * habitats at once, since raising the seabed nine bands is the same edit that
 * makes a mountain.
 */
export function invalidateSurvey(): void {
  lastSurveySeconds = Number.NEGATIVE_INFINITY;
}

// ── Arrival and departure ────────────────────────────────────────────────────

/**
 * THE ONLY FUNCTION THAT PUTS A MONSTER IN THE WORLD (the snapshot restore
 * below is the other way in, and that is what restoring a saved world means).
 *
 * Refuses outright if the habitat's slot is occupied. That check is redundant
 * with every caller's own gate and is kept anyway: it is the last line of the
 * invariant, it costs one comparison per summon, and it means a future caller
 * cannot introduce a second monster by forgetting a precondition.
 *
 * Returns the monster, or null if it refused.
 */
function summon(profile: MonsterProfile, cellX: number, cellY: number): Monster | null {
  const state = stateOf(profile.habitat);
  if (livingCountIn(profile.habitat) >= MAX_LIVING_MONSTERS_PER_HABITAT) return null;

  state.living = {
    id: nextMonsterId++,
    kind: profile.kind,
    // Cell centre: the survey reports a cell, and a monster placed on the corner
    // of one would be half a cell off from the ground the survey vouched for.
    x: cellX + 0.5,
    y: cellY + 0.5,
    heading: monsterRandom() * Math.PI * 2,
    idle: false,
  };
  return state.living;
}

/**
 * Removes this monster and starts its habitat's cooldown. The one exit — habitat
 * collapse, the ground moving out from under it, and any future cause all go
 * through here, so "it left" and "it cannot come back for ten minutes" can never
 * come apart.
 *
 * AND THE ONE PLACE BANISHABILITY IS DECIDED. A kind whose profile carries no
 * BanishmentRule is refused here, at the exit, rather than at each caller: the
 * habitat check, the collapse test and every future cause of departure are all
 * made harmless by the same three lines, and a new caller cannot introduce a
 * way to remove Cthulhu by forgetting to ask whether he can be removed.
 *
 * THE COOLDOWN IS THE HABITAT'S, not the world's: the sea being empty for ten
 * minutes says nothing about the mountain, and a shared cooldown would make
 * levelling a peak a way to keep the kraken out of the water.
 *
 * Returns true if something actually left.
 */
export function banish(monster: Monster): boolean {
  const profile = profileOf(monster.kind);
  const state = stateOf(profile.habitat);
  if (state.living !== monster) return false;
  const rule = profile.banishment;
  if (rule === null) return false;
  state.cooldownSeconds = rule.respawnCooldownSeconds;
  state.living = null;
  return true;
}

/**
 * Banishes every monster standing somewhere that has stopped being its habitat —
 * drained, filled, levelled, or somehow re-locked.
 *
 * Runs every tick after movement AND from the terrain reaction, so the two ways
 * a monster can end up somewhere invalid (it walked there / the world changed
 * under it) share one implementation. It is two WorldApi calls per living
 * monster; there is no reason to make it conditional.
 *
 * For an unbanishable kind this is a no-op by construction (`banish` refuses),
 * and the monster is left standing on whatever the ground has become.
 *
 * Returns true if anything left.
 */
export function enforceHabitat(world: LairWorld): boolean {
  let banished = false;
  for (const monster of livingMonsters()) {
    const profile = profileOf(monster.kind);
    if (isLairCell(profile.habitat, world, monster.x, monster.y)) continue;
    if (banish(monster)) banished = true;
  }
  return banished;
}

/**
 * The best lair for this kind in its habitat's last survey, or null if the world
 * holds none. GATE 3, and the only place a kind's habitat demands are applied.
 *
 * BIGGEST QUALIFYING REGION, not the biggest region: a kraken that wants a
 * trench must not be turned away because the map also contains a larger shallow
 * bay, and it must not be summoned INTO that bay either. Ties go to the earlier
 * region in scan order, which is fixed (habitat.ts), so two runs over the same
 * world pick the same lair.
 */
function bestLairFor(profile: MonsterProfile): LairRegion | null {
  const { regions } = stateOf(profile.habitat).survey;
  let best: LairRegion | null = null;
  for (const region of regions) {
    if (region.cells < profile.minLairCells) continue;
    if (!reachesIntoHabitat(profile.habitat, region.extremeHeight, profile.minLairReachBands)) {
      continue;
    }
    if (best !== null && region.cells <= best.cells) continue;
    best = region;
  }
  return best;
}

/**
 * Gates 2–4 of arrival, for ONE habitat. Called only when its slot is empty.
 *
 * Kinds are considered in SUMMON_ORDER, restricted to the kinds that live here —
 * strictest habitat first, see MONSTER_KINDS — and the first one whose lair
 * qualifies AND whose roll fires takes this habitat's slot.
 */
function trySummon(regime: HabitatRegime, world: LairWorld, dt: number): void {
  const state = stateOf(regime);
  if (state.cooldownSeconds > 0) return;

  for (const kind of kindsInHabitat(regime)) {
    const profile = profileOf(kind);
    const cell = bestLairFor(profile);
    if (cell === null) continue;
    if (!rollEvent(summonRatePerSecond(profile), dt)) continue;

    // The survey can be up to LAIR_SURVEY_INTERVAL_SECONDS stale, so the cell it
    // named is re-checked against the world as it is NOW. Failing here costs the
    // roll that just fired — a negligible lengthening of the mean wait in the
    // rare case where a player filled that exact cell within the last five
    // seconds — and forces a fresh survey rather than trying a stale cell again.
    if (!isLairCell(regime, world, cell.x, cell.y)) {
      invalidateSurvey();
      return;
    }

    summon(profile, cell.x, cell.y);
    return;
  }
}

/**
 * THE LIFECYCLE STEP. Once per host tick, before movement.
 *
 * Fixed order:
 *   1. clock;
 *   2. cooldown decay, per habitat — a banished monster's absence is measured in
 *      simulated seconds, so it survives a paused or slow server exactly;
 *   3. survey, on its interval, and the COLLAPSE TEST, both per habitat: if the
 *      region the monster is actually in has shrunk below its kind's collapse
 *      threshold, it leaves. Note this reads occupiedRegionCells, not the
 *      biggest region on the map — taking the habitat away from AROUND it is
 *      what drives it off, and a bigger ocean (or a taller mountain) elsewhere
 *      is no comfort. A kind that cannot be banished has no collapse threshold
 *      to compare against and is skipped entirely;
 *   4. the arrival gates, for each habitat whose slot is empty.
 *
 * Steps 1–4 are all driven by `dt`; nothing here reads a wall clock.
 */
export function advanceSummoning(world: LairWorld, dt: number): void {
  simSeconds += dt;

  const surveyDue = simSeconds - lastSurveySeconds >= LAIR_SURVEY_INTERVAL_SECONDS;
  if (surveyDue) lastSurveySeconds = simSeconds;

  for (const regime of HABITAT_REGIMES) {
    const state = stateOf(regime);

    if (state.cooldownSeconds > 0) state.cooldownSeconds = Math.max(0, state.cooldownSeconds - dt);

    if (surveyDue) {
      state.survey = surveyLairs(regime, world, state.living);

      const monster = state.living;
      const banishment = monster === null ? null : profileOf(monster.kind).banishment;
      if (
        monster !== null &&
        banishment !== null &&
        state.survey.occupiedRegionCells < banishment.lairCollapseCells
      ) {
        banish(monster);
      }
    }

    if (state.living === null) trySummon(regime, world, dt);
  }
}

// ── Snapshot restore ─────────────────────────────────────────────────────────

/**
 * Replaces the whole lifecycle state from a snapshot (../server/persistence.ts).
 *
 * This is the ONLY seam through which a monster appears without passing the four
 * gates, which is exactly what restoring a saved world means: the gates already
 * ran, before the shutdown. It takes at most one monster PER HABITAT — a second
 * one for a habitat that already has its slot filled is dropped — so a corrupt
 * or hand-edited snapshot cannot smuggle in a duplicate.
 *
 * The surveys are deliberately left empty and stale so the first tick re-derives
 * them against the world as restored; a BANISHABLE monster whose habitat was
 * destroyed by another plugin's migration is then banished on that first tick
 * rather than trusted. An unbanishable one is restored exactly where it was and
 * stays there, which is the same answer a running server would have given — a
 * restart is not a way to be rid of it either.
 */
export function restoreSummoning(
  monsters: readonly Monster[],
  nextId: number,
  cooldowns: Partial<Record<HabitatRegimeId, number>>,
): void {
  resetSummoning();

  for (const monster of monsters) {
    const state = stateOf(profileOf(monster.kind).habitat);
    if (state.living !== null) continue;
    state.living = { ...monster };
  }

  for (const regime of HABITAT_REGIMES) {
    const cooldown = cooldowns[regime.id];
    if (cooldown !== undefined) stateOf(regime).cooldownSeconds = cooldown;
  }

  nextMonsterId = nextId;
}
