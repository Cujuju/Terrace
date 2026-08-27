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
//
// AMENDED 2026-08-19 — THE KRAKEN NO LONGER HAS A COLLAPSE THRESHOLD (owner:
// "For now, no eviction. Later, if we do boats, they can attack the kraken.").
// A correctness pass found that the paragraph above never described what the
// code did: collapse counts cells of the 3-band DEEP-WATER region, not of the
// 7-band trench, so refilling the trench that summoned it did nothing at all,
// genuinely draining it meant raising ~87% of a fresh world's ocean, and the
// only cheap counter was an undocumented trick — walling it into a pocket. The
// owner's answer was not to retune those numbers but to WITHDRAW the mechanic
// until there is a fiction for it: a monster you fight with terrain was never
// the intent, and boats are (backlog issue #43).
//
// WHAT REMAINS, AND WHY IT IS NOT THE SAME THING. enforceHabitat still banishes
// a kraken whose OWN CELL has stopped being deep water. That is not eviction
// policy, it is physics — a kraken standing on dry land is not a gameplay
// outcome, it is a rendering bug — and it stays the one departure a player can
// cause, by raising the seabed directly under it. The cooldown machinery is
// kept whole rather than deleted: enforceHabitat uses it today, and it is what
// the boats arc will need the day something is allowed to drive the kraken off
// again.
//
// THE YETI IS UNCHANGED. The ruling was about the kraken; levelling a snowfield
// still drives him off, and his threshold is why lairCollapseCells exists.
// ─────────────────────────────────────────────────────────────────────────────

import {
  MONSTER_KINDS,
  YETI_VARIANTS,
  type MonsterKind,
  type YetiVariant,
} from '../protocol.ts';
import {
  CELL_CENTRE_OFFSET,
  EMPTY_LAIR_SURVEY,
  HABITAT_REGIMES,
  type HabitatRegime,
  type HabitatRegimeId,
  type LairRegion,
  type LairSurvey,
  type LairWorld,
  isLairCell,
  isLairPose,
  qualifyingCellsIn,
  reachesIntoHabitat,
  releaseSurveyScratch,
  surveyLairs,
} from './habitat.ts';
import {
  MAX_LIVING_MONSTERS_PER_KIND,
  type MonsterProfile,
  bodyRadiusCells,
  habitatKindIndex,
  kindsInHabitat,
  lairFitRulesInHabitat,
  profileOf,
  summonRatePerSecond,
} from './kinds.ts';
import { hashToIndex, monsterRandom, randomIndex, rollEvent } from './rng.ts';

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
  /**
   * WHICH yeti, chosen once at summon time and then fixed for life (2026-08-26).
   * Undefined for every other kind — see YetiVariant in ../protocol.ts.
   *
   * READONLY, and that is the whole behavioural rule: nothing in the sim reads
   * it (the profile owns speed, footprint and habitat, and all four variants
   * share one profile), and nothing may rewrite it — a monster whose body
   * changed under a watching player would be a new animal wearing an old id,
   * which is precisely what the client's interpolation keys off.
   */
  readonly variant?: YetiVariant;
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

/**
 * Lifecycle transitions awaiting emission as world events (2026-08-19, for
 * the chronicle). QUEUED here rather than emitted here because summon/banish
 * are pure module functions with no WorldApi — index.ts drains this right
 * after each call that can grow it, so an event leaves in the same tick it
 * happened. Snapshot restore deliberately never queues: restoring a saved
 * world is not an arrival.
 */
export interface MonsterTransition {
  readonly event: 'arrived' | 'departed';
  readonly kind: MonsterKind;
  /** The cell it happened on (floored from the monster's position). */
  readonly x: number;
  readonly y: number;
}

let pendingTransitions: MonsterTransition[] = [];

/** Returns and clears the queued transitions, in the order they happened. */
export function drainMonsterTransitions(): MonsterTransition[] {
  const drained = pendingTransitions;
  pendingTransitions = [];
  return drained;
}

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
  pendingTransitions = [];
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
/**
 * WHICH BODY THIS ARRIVAL WEARS, for a kind that has more than one.
 *
 * Uniform over the variants, drawn through the plugin's random source — so it
 * is reproducible under `setMonsterRandomSource` (./rng.ts) like every other
 * decision this module makes, and unpredictable in a real world like the
 * arrival roll that just fired.
 *
 * NOT DERIVED FROM THE MONSTER'S ID or from the terrain, deliberately, and that
 * is the difference between this pick and the summon CELL's (see summonCellIn,
 * which is seeded by nextMonsterId because a cell must be reproducible from the
 * world state for the arrival tests to be writable). A variant has no such
 * requirement, and hashing the id would make the sequence of looks a fixed
 * cycle every world replays in the same order — the second yeti a player ever
 * meets would always be the same one.
 *
 * Undefined for kinds with no variants, which is what the wire and the
 * renderer both expect from them.
 */
function variantFor(kind: MonsterKind): YetiVariant | undefined {
  if (kind !== 'yeti') return undefined;
  return YETI_VARIANTS[randomIndex(YETI_VARIANTS.length)];
}

function summon(profile: MonsterProfile, cellX: number, cellY: number): Monster | null {
  const state = stateOf(profile.kind);
  if (livingCountOfKind(profile.kind) >= MAX_LIVING_MONSTERS_PER_KIND) return null;

  const variant = variantFor(profile.kind);

  state.living = {
    id: nextMonsterId++,
    kind: profile.kind,
    ...(variant === undefined ? {} : { variant }),
    // Cell centre: the survey reports a cell, and a monster placed on the corner
    // of one would be half a cell off from the ground the survey vouched for.
    // Named since 2026-08-26 (habitat.ts's CELL_CENTRE_OFFSET) because the
    // survey's fit count and summonCellIn's filter test the body's pose at
    // exactly this point — three places that must not disagree by half a cell.
    x: cellX + CELL_CENTRE_OFFSET,
    y: cellY + CELL_CENTRE_OFFSET,
    heading: monsterRandom() * Math.PI * 2,
    idle: false,
  };
  pendingTransitions.push({ event: 'arrived', kind: profile.kind, x: cellX, y: cellY });
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
  pendingTransitions.push({
    event: 'departed',
    kind: monster.kind,
    x: Math.floor(monster.x),
    y: Math.floor(monster.y),
  });
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
 *
 * THE FIT TESTS ARE PART OF THIS GATE (2026-08-26), not of the summon that
 * follows it, and that placement is the point. `minLairCells` is a bar on how
 * much habitat a region holds; a region can clear it and still contain no cell
 * this kind's BODY fits on — a 52-cell snow ribbon one cell wide is the case
 * that was shipping — and admitting such a region here would leave
 * `summonCellIn` to discover it, whose answer to "nowhere to go" is
 * `invalidateSurvey()`. That is a re-survey every time a roll fires, forever,
 * on a region that will never be summonable: a loop, not a refusal. Refusing
 * the region is the refusal.
 *
 * TWO OF THEM, because the survey counts two things (habitat.ts): the room this
 * kind has to ROAM (`fittingCells`, poses its body fits in anywhere in the
 * region) and the cells it may ARRIVE on (`summonableCells`, those same poses
 * that also clear its own `minLairReachBands`). The roam count is the owner's
 * bar below; the arrival count only has to be non-zero, and that is the clause
 * that keeps `summonCellIn`'s null a refusal rather than the loop above.
 *
 * IT COSTS NOTHING PER TICK because the survey already counted it: the walk
 * that measured the region tested each of its cells against each kind's
 * LairFitRule (habitat.ts) once per LAIR_SURVEY_INTERVAL_SECONDS. Re-deriving
 * it here would be a flood fill per candidate region per tick while the slot
 * is empty, which is the shape of cost this gate exists to stay out of.
 *
 * HOW MANY FITTING CELLS ARE ENOUGH is the kind's own `minLairFittingCells`
 * (owner decision, 2026-08-26): one body's worth of area, so the bar is not
 * merely "it fits" but "it can roam at least the ground it occupies". One
 * fitting cell would have left a lair the animal fills exactly, which is the
 * pinched case again a hair less literally.
 *
 * A survey taken WITHOUT fit rules reports no count for this kind, which reads
 * as zero and refuses — see surveyLairs on why that direction is the safe one.
 */
function bestLairFor(kind: MonsterKind): LairRegion | null {
  const profile = profileOf(kind);
  const fitIndex = habitatKindIndex(kind);
  const { regions } = surveys[profile.habitat.id];
  let best: LairRegion | null = null;
  for (const region of regions) {
    if (region.cells < profile.minLairCells) continue;
    if (!reachesIntoHabitat(profile.habitat, region.extremeHeight, profile.minLairReachBands)) {
      continue;
    }
    if ((region.fittingCells[fitIndex] ?? 0) < profile.minLairFittingCells) continue;
    if ((region.summonableCells[fitIndex] ?? 0) <= 0) continue;
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
/**
 * WHERE IN THE LAIR IT RISES (owner decision, 2026-08-19: spread the arrivals).
 *
 * THE DEFECT THIS REPLACES. The summon cell used to be `region.x/region.y` —
 * the region's EXTREME cell, the single deepest one the survey found. That made
 * the arrival point a pure function of the terrain, and a very sharp one: the
 * deepest cell of an ocean is unique almost always, so ONE cell owned every
 * future arrival of every sea kind. Since Deep Strata gave players 24 bands to
 * dig through, that cell is now typically a one-cell shaft somebody sank on
 * purpose, and both sea kinds would surface in it forever — including on top of
 * each other, which made the co-location the owner permits STRUCTURAL rather
 * than incidental.
 *
 * THE RULE NOW: uniform among the region's QUALIFYING cells — every cell that
 * reaches this kind's own `minLairReachBands`, which is exactly the set that
 * would have admitted the region on its own. Not "the deepest cells": a set
 * defined by the maximum would have the same single-cell failure the moment one
 * pit is one band deeper than the rest, which is the failure being fixed.
 *
 * IT STAYS PER KIND, so the two sea kinds did not become one animal: the
 * kraken scatters across trench cells (7 bands) and Cthulhu across any deep
 * water (3), the same bars their admission tests already use. Overlap may still
 * happen by chance — the owner's ruling that co-location is allowed stands —
 * but it is now a coincidence rather than a guarantee.
 *
 * THE SEED IS `nextMonsterId`: the id this monster is about to take. It is a
 * per-world counter, it is PERSISTED (so it keeps advancing across restarts
 * rather than replaying the same pick), it is unique per summon, and it differs
 * between two kinds summoned on the same tick — which is what de-correlates the
 * pair rather than merely spreading each. Deterministic end to end: same world,
 * same counter, same cell, on any machine (see hashToIndex).
 *
 * AND THE BODY MUST FIT WHERE IT LANDS (2026-08-26). The qualifying set is a
 * set of CELLS; the animal is a disc several cells wide, and picking uniformly
 * among cells whose centred pose is not habitat is how a yeti came to be born
 * pinched — pose-invalid from his first tick, permanently in lurk.ts's
 * clearance-0 fallback with his flanks in the rock. So the candidates are
 * filtered by `isLairPose` at the CELL CENTRE, which is exactly where `summon`
 * places him.
 *
 * IT IS THE SAME TEST GATE 3 ALREADY APPLIED, repeated here for the same reason
 * the cell re-check above it exists: `bestLairFor` reads a survey up to
 * LAIR_SURVEY_INTERVAL_SECONDS old, and the world may have moved since. Gate 3
 * is what stops a permanently unfittable region from being chosen at all; this
 * is what stops a stale count from placing a body in ground that arrived in the
 * last five seconds.
 *
 * Returns null when the region has stopped qualifying since the survey named
 * it, which the caller answers with a re-survey rather than a stale summon.
 */
function summonCellIn(
  profile: MonsterProfile,
  world: LairWorld,
  region: LairRegion,
): { readonly x: number; readonly y: number } | null {
  const candidates = qualifyingCellsIn(
    profile.habitat,
    world,
    region.x,
    region.y,
    profile.minLairReachBands,
  );
  const size = world.worldSize;
  const radiusCells = bodyRadiusCells(profile);
  const fitting = candidates.filter((index) => {
    const cellX = index % size;
    const cellY = (index - cellX) / size;
    return isLairPose(
      profile.habitat,
      world,
      cellX + CELL_CENTRE_OFFSET,
      cellY + CELL_CENTRE_OFFSET,
      radiusCells,
    );
  });
  if (fitting.length === 0) return null;

  const index = fitting[hashToIndex(nextMonsterId, fitting.length)]!;
  const x = index % size;
  return { x, y: (index - x) / size };
}

function trySummon(kind: MonsterKind, world: LairWorld, dt: number): void {
  const state = stateOf(kind);
  if (state.cooldownSeconds > 0) return;

  const profile = profileOf(kind);
  const cell = bestLairFor(kind);
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

  // The pick re-walks the region against the world as it is NOW, so it is also
  // the second half of that staleness check: a region whose qualifying cells
  // have all been filled in since the survey yields nothing to summon into.
  const spot = summonCellIn(profile, world, cell);
  if (spot === null) {
    invalidateSurvey();
    return;
  }

  summon(profile, spot.x, spot.y);
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
      const survey = surveyLairs(regime, world, occupants, lairFitRulesInHabitat(regime));
      surveys[regime.id] = survey;

      for (let i = 0; i < occupants.length; i++) {
        const monster = occupants[i];
        const banishment = profileOf(monster.kind).banishment;
        // Two separate questions, and a kind may answer yes to the first and no
        // to the second: `null` banishment is "nothing removes it" (Cthulhu),
        // and a null `lairCollapseCells` is "losing the habitat AROUND it does
        // not" (the kraken since the 2026-08-19 no-eviction ruling — see
        // kinds.ts). Only the ground under its own feet does, and that is
        // enforceHabitat's job, not this one's.
        if (banishment === null || banishment.lairCollapseCells === null) continue;
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
