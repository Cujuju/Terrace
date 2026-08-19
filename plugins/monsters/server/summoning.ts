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
// SUPERSEDED 2026-08-19 — THE SLOT IS NOW PER KIND (owner decision: "allow
// multiple sea monsters to spawn"). The day foreseen two paragraphs up
// arrived: the sea was meant to hold both Cthulhu and the kraken, and the
// per-habitat slot meant the kraken could never once appear (Cthulhu summons
// first — any deep basin qualifies him, only a trench qualifies the kraken —
// and he cannot be banished, so the sea slot never re-opened). The invariant
// stays structural in the same spirit: one nullable slot per KIND, in a total
// record over MonsterKind, so a SECOND KRAKEN is as unrepresentable as a
// second sea monster used to be. MAX_LIVING_MONSTERS_PER_KIND (./kinds.ts) is
// the new grep marker; the per-habitat argument above survives one level
// down — every KIND is still a singleton, an arrival is still an event, and
// the cooldown moves per kind too (banishing the kraken says nothing about
// the yeti, and now also nothing about a future second water kind).
//
// The lair SURVEY stays per habitat — it is a fact about the world's terrain,
// one flood-fill walk per regime, whichever kinds read it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR GATES ON ARRIVAL
//
// A monster appears only when ALL of these hold, checked in this order (gates
// 1 and 2 read PER-KIND state since the 2026-08-19 amendment above):
//
//   1. that kind's slot is empty               — the per-kind singleton;
//   2. that kind's cooldown has expired        — minutes of enforced absence
//                                                after THAT KIND was driven
//                                                off. Per kind, so banishing
//                                                the yeti cannot suppress the
//                                                sea, nor the kraken Cthulhu;
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

import { MONSTER_KINDS, type MonsterKind } from '../protocol.ts';
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
  MAX_LIVING_MONSTERS_PER_KIND,
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

/** Everything the lifecycle owns about ONE kind (per-kind slots, 2026-08-19). */
interface KindState {
  /** THE SLOT. Null means no monster of this kind is out there. */
  living: Monster | null;
  /** Simulated seconds of enforced absence remaining. 0 when not banished. */
  cooldownSeconds: number;
}

function emptyKindState(): KindState {
  return { living: null, cooldownSeconds: 0 };
}

/**
 * One slot per KIND. Written out rather than built from MONSTER_KINDS so the
 * type is a TOTAL Record over MonsterKind: a new kind added to the protocol
 * fails to compile here until it is given a slot, where a `Map`-shaped
 * construction would have silently returned undefined for it at runtime —
 * the same argument the per-habitat record used to make about regimes.
 */
function emptyKindStates(): Record<MonsterKind, KindState> {
  return {
    cthulhu: emptyKindState(),
    kraken: emptyKindState(),
    yeti: emptyKindState(),
  };
}

let kindStates: Record<MonsterKind, KindState> = emptyKindStates();

/**
 * The most recent survey of each habitat. Still PER HABITAT: a survey is one
 * flood-fill walk over the world's terrain, a fact every kind living there
 * reads (gate 3 and the collapse test), not a per-kind possession.
 */
function emptySurveys(): Record<HabitatRegimeId, LairSurvey> {
  return { water: EMPTY_LAIR_SURVEY, land: EMPTY_LAIR_SURVEY };
}

let surveys: Record<HabitatRegimeId, LairSurvey> = emptySurveys();

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

function stateOf(kind: MonsterKind): KindState {
  return kindStates[kind];
}

/** The monster of this kind, or null. */
export function livingMonsterOfKind(kind: MonsterKind): Monster | null {
  return stateOf(kind).living;
}

/**
 * The monsters living in this habitat, in MONSTER_KINDS order. A LIST since
 * the 2026-08-19 per-kind slots: the sea can hold both of its kinds at once.
 */
export function livingMonstersIn(regime: HabitatRegime): Monster[] {
  const alive: Monster[] = [];
  for (const kind of kindsInHabitat(regime)) {
    const monster = stateOf(kind).living;
    if (monster !== null) alive.push(monster);
  }
  return alive;
}

/**
 * Every living monster, in MONSTER_KINDS order (was HABITAT_REGIMES order
 * before per-kind slots — equally fixed, differently keyed).
 *
 * The order is fixed rather than incidental because this is what the broadcast
 * list is built from: a list whose ORDER wobbled between ticks would be a wire
 * payload that changed for no reason, and a diff nobody could read.
 */
export function livingMonsters(): Monster[] {
  const alive: Monster[] = [];
  for (const kind of MONSTER_KINDS) {
    const monster = stateOf(kind).living;
    if (monster !== null) alive.push(monster);
  }
  return alive;
}

/** How many monsters are alive in the world, across all kinds. */
export function livingMonsterCount(): number {
  let count = 0;
  for (const kind of MONSTER_KINDS) {
    if (stateOf(kind).living !== null) count++;
  }
  return count;
}

/** 0 or 1. The counting form of one kind's slot, for the cap comparison. */
export function livingCountOfKind(kind: MonsterKind): number {
  return stateOf(kind).living === null ? 0 : 1;
}

/** Per KIND since 2026-08-19: banishing the kraken says nothing about the yeti. */
export function cooldownRemainingSecondsFor(kind: MonsterKind): number {
  return stateOf(kind).cooldownSeconds;
}

export function lastLairSurvey(regime: HabitatRegime): LairSurvey {
  return surveys[regime.id];
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
  kindStates = emptyKindStates();
  surveys = emptySurveys();
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
 * Refuses outright if this KIND's slot is occupied. That check is redundant
 * with every caller's own gate and is kept anyway: it is the last line of the
 * invariant, it costs one comparison per summon, and it means a future caller
 * cannot introduce a second monster of one kind by forgetting a precondition.
 *
 * Returns the monster, or null if it refused.
 */
function summon(profile: MonsterProfile, cellX: number, cellY: number): Monster | null {
  const state = stateOf(profile.kind);
  if (livingCountOfKind(profile.kind) >= MAX_LIVING_MONSTERS_PER_KIND) return null;

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
 * Removes this monster and starts its KIND's cooldown. The one exit — habitat
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
 * THE COOLDOWN IS THE KIND'S (was the habitat's until the 2026-08-19 per-kind
 * slots), not the world's: the sea being empty of krakens for ten minutes says
 * nothing about the mountain — and now also nothing about Cthulhu, or any
 * future second water kind. The original argument ("a shared cooldown would
 * make levelling a peak a way to keep the kraken out of the water") applies
 * one level down, unchanged.
 *
 * Returns true if something actually left.
 */
export function banish(monster: Monster): boolean {
  const profile = profileOf(monster.kind);
  const state = stateOf(profile.kind);
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
  const { regions } = surveys[profile.habitat.id];
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
 * Gates 2–4 of arrival, for ONE KIND. Called only when its slot is empty.
 *
 * PER KIND since 2026-08-19: kinds no longer compete for a habitat slot, so
 * each rolls its own independent Poisson arrival against its own lair
 * requirements. (Before, kinds in one habitat were tried strictest-first and
 * the first winner took the slot — which in practice meant the kraken never
 * arrived: any deep basin qualifies Cthulhu, and once summoned he never
 * leaves.)
 */
function trySummon(kind: MonsterKind, world: LairWorld, dt: number): void {
  const state = stateOf(kind);
  if (state.cooldownSeconds > 0) return;

  const profile = profileOf(kind);
  const cell = bestLairFor(profile);
  if (cell === null) return;
  if (!rollEvent(summonRatePerSecond(profile), dt)) return;

  // The survey can be up to LAIR_SURVEY_INTERVAL_SECONDS stale, so the cell it
  // named is re-checked against the world as it is NOW. Failing here costs the
  // roll that just fired — a negligible lengthening of the mean wait in the
  // rare case where a player filled that exact cell within the last five
  // seconds — and forces a fresh survey rather than trying a stale cell again.
  if (!isLairCell(profile.habitat, world, cell.x, cell.y)) {
    invalidateSurvey();
    return;
  }

  summon(profile, cell.x, cell.y);
}

/**
 * THE LIFECYCLE STEP. Once per host tick, before movement.
 *
 * Fixed order:
 *   1. clock;
 *   2. cooldown decay, per KIND — a banished monster's absence is measured in
 *      simulated seconds, so it survives a paused or slow server exactly;
 *   3. survey, on its interval, PER HABITAT (one terrain walk each), and the
 *      COLLAPSE TEST per OCCUPANT of that habitat: if the region a monster is
 *      actually in has shrunk below its kind's collapse threshold, it leaves.
 *      Note this reads its own entry of occupiedRegionCells, not the biggest
 *      region on the map — taking the habitat away from AROUND it is what
 *      drives it off, and a bigger ocean (or a taller mountain) elsewhere is
 *      no comfort. A kind that cannot be banished has no collapse threshold
 *      to compare against and is skipped entirely;
 *   4. the arrival gates, for each KIND whose slot is empty (per-kind slots,
 *      2026-08-19 — each kind rolls independently, so Cthulhu's presence no
 *      longer keeps the kraken out of the sea).
 *
 * Steps 1–4 are all driven by `dt`; nothing here reads a wall clock.
 */
export function advanceSummoning(world: LairWorld, dt: number): void {
  simSeconds += dt;

  const surveyDue = simSeconds - lastSurveySeconds >= LAIR_SURVEY_INTERVAL_SECONDS;
  if (surveyDue) lastSurveySeconds = simSeconds;

  for (const kind of MONSTER_KINDS) {
    const state = stateOf(kind);
    if (state.cooldownSeconds > 0) state.cooldownSeconds = Math.max(0, state.cooldownSeconds - dt);
  }

  if (surveyDue) {
    for (const regime of HABITAT_REGIMES) {
      // The occupants are surveyed together: one walk per habitat, one
      // occupiedRegionCells entry per monster, index-aligned (habitat.ts).
      const occupants = livingMonstersIn(regime);
      const survey = surveyLairs(regime, world, occupants);
      surveys[regime.id] = survey;

      for (let i = 0; i < occupants.length; i++) {
        const monster = occupants[i];
        const banishment = profileOf(monster.kind).banishment;
        if (banishment === null) continue;
        if (survey.occupiedRegionCells[i]! < banishment.lairCollapseCells) {
          banish(monster);
        }
      }
    }
  }

  for (const kind of MONSTER_KINDS) {
    if (stateOf(kind).living === null) trySummon(kind, world, dt);
  }
}

// ── Snapshot restore ─────────────────────────────────────────────────────────

/**
 * Replaces the whole lifecycle state from a snapshot (../server/persistence.ts).
 *
 * This is the ONLY seam through which a monster appears without passing the four
 * gates, which is exactly what restoring a saved world means: the gates already
 * ran, before the shutdown. It takes at most one monster PER KIND (per-kind
 * slots, 2026-08-19; was per habitat) — a second one for a kind whose slot is
 * already filled is dropped — so a corrupt or hand-edited snapshot cannot
 * smuggle in a duplicate.
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
  cooldowns: Partial<Record<MonsterKind, number>>,
): void {
  resetSummoning();

  for (const monster of monsters) {
    const state = stateOf(monster.kind);
    if (state.living !== null) continue;
    state.living = { ...monster };
  }

  for (const kind of MONSTER_KINDS) {
    const cooldown = cooldowns[kind];
    if (cooldown !== undefined) stateOf(kind).cooldownSeconds = cooldown;
  }

  nextMonsterId = nextId;
}
