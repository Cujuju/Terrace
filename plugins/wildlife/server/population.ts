// Population regulation: how many creatures exist, where they appear, and when
// they are removed. The serialized form lives next door in ./persistence.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE SPAWN PATH
//
// There is exactly one way a creature comes into existence: a RESPAWN CREDIT is
// issued, ripens, and is consumed. Both callers go through it —
//
//   * the periodic census, when it finds a species below its habitat-derived
//     target (this is also how a brand new world fills up: at boot every target
//     is a deficit);
//   * a habitat-loss despawn, which issues a credit that ripens after a delay so
//     the population recovers ELSEWHERE rather than popping back instantly.
//
// One path means "initial fill" and "recovery" cannot drift apart, and the
// habitat/unlocked-area checks that make a spawn legal exist in one place.
// ─────────────────────────────────────────────────────────────────────────────
//
// ─────────────────────────────────────────────────────────────────────────────
// THE POPULATION IS A LIVING PROCESS, NOT AN INVENTORY (owner, 2026-08-14)
//
// A census target is a CEILING that the world drifts toward, never a quota that
// is filled on sight. Two named rates make that true, and they are the only
// stochastic things in this plugin's population maths:
//
//   * SPAWN_MEAN_WAIT_SECONDS — a pending credit does not become a creature the
//     moment it can. Each one has a constant hazard of hatching, so arrivals are
//     spread out and unpredictable instead of "the whole ecosystem appears in
//     the first three seconds of the server's life".
//   * NATURAL_LIFESPAN_SECONDS — creatures also leave of their own accord. That
//     is what keeps spawn events happening forever: at equilibrium the world is
//     losing and gaining individuals continuously, so the mix a player watches
//     is never the same mix twice.
//
// Both are per-SECOND rates converted with the host's `dt`, so a server running
// at any TICK_HZ behaves identically per simulated second (see CLOCK below).
//
// WHERE THE POPULATION SETTLES. With per-credit hatch rate 1/W, per-creature
// departure rate 1/L, and k the EFFECTIVE group size one spawn event delivers,
// a habitat whose target is T settles at
//
//     N = T / (1 + W/(k·L))
//
// The balance has to be struck in INDIVIDUALS, not events: one spawn event
// delivers up to groupSize creatures (5 for fish, 3 for whales), so arrivals
// measured in individuals are (T−N)·k/W, and those balance departures N/L. The
// earlier form of this derivation, N = T/(1 + W/L), credited each event with a
// single individual — that is the SOLITARY-species case (k = 1), still the
// right figure for the deep-sea creature and the grazer: at the shipped
// W = 20 s and L = 300 s it is T/1.067 ≈ 0.94·T. A group spawner settles much
// closer to target: k = 5 gives T/(1 + 20/1500) ≈ 0.99·T for fish. Honest
// caveat: k is the EFFECTIVE group size, smaller than groupSize when fewer
// credits are ripe or when members land outside the habitat and are dropped,
// so real group-spawner populations sit between the two figures. Tests assert
// BOUNDS around all of this, never an exact count — there is no seeded RNG here
// and there should not be one.
// ─────────────────────────────────────────────────────────────────────────────
//
// ANTI-CHEAT BY OMISSION: every spawn candidate is drawn from the UNLOCKED chunk
// list, and movement refuses to leave it. Creatures therefore only ever exist in
// territory the clients can already see, so the full-state broadcast (which is
// not mask-filtered — the plugin host offers no per-player filtering) leaks
// nothing about locked land. That is a property of the sim, not of the wire
// format, which is why it holds trivially rather than needing a filter.
//
// CLOCK: `dt` from the host is the only time source. No Date.now anywhere, so a
// server running at a different TICK_HZ behaves identically per simulated second.

import { CHUNK_SIZE } from '@terrace/shared';
import {
  DEFAULT_SIZE_CLASS,
  WILDLIFE_HABITAT_SPECIES,
  WILDLIFE_SIZE_CLASSES,
  type WildlifeEntityState,
  type WildlifeHabitatSpecies,
  type WildlifeSizeClass,
  roundBroadcastPosition,
  sizeClassAt,
  sizeClassIndex,
} from '../protocol.ts';
import {
  HABITAT_CENSUS_INTERVAL_SECONDS,
  WILDLIFE_POPULATION_CAP,
  type HabitatWorld,
  emptySpeciesCounts,
  isValidCellFor,
  takeCensus,
  targetsFor,
} from './census.ts';
import { randomSigned } from './rng.ts';
import { type SizeWeights, type SpeciesProfile, profileOf } from './species.ts';

/** A living creature. Mutable — the tick loop writes these in place. */
export interface WildlifeEntity {
  readonly id: number;
  readonly species: WildlifeHabitatSpecies;

  /**
   * The school this creature belongs to. Allocated at spawn and never changed:
   * schools do not merge, split or recruit — a school is born, shrinks as
   * members are lost to terrain, and eventually departs whole (see
   * applyNaturalTurnover).
   *
   * EVERY creature has one, including solitary species and fish that drew a
   * non-schooling group: those simply get a school to themselves. That is what
   * lets cohesion, turnover and persistence be written once instead of once per
   * "does this thing school" branch — a school of one degenerates to exactly the
   * per-individual behaviour that shipped before schools existed.
   *
   * NEVER ON THE WIRE. The client draws creatures where the server says they
   * are; it needs no concept of a school to do that, and adding one would cost
   * bandwidth for something no renderer reads.
   */
  readonly schoolId: number;

  /** Size class, drawn once per spawn group. Drives cohesion and model scale. */
  readonly size: WildlifeSizeClass;

  /** Cell-space position, fractional. */
  x: number;
  y: number;
  /** Radians. Movement direction is (cos heading, sin heading) in cell space. */
  heading: number;
  /** Seconds of burst-speed flight left; 0 when calm. */
  fleeSecondsRemaining: number;
}

/** A pending spawn. `readyAt` is accumulated SIMULATED seconds, never wall-clock. */
interface RespawnCredit {
  readonly species: WildlifeHabitatSpecies;
  readonly readyAt: number;
}

/**
 * Delay before a creature displaced by terrain reappears. Long enough that the
 * player who just drained the lake sees the fish LEAVE rather than teleport,
 * short enough that the area does not stay conspicuously sterile afterwards.
 */
export const HABITAT_LOSS_RESPAWN_DELAY_SECONDS = 8;

/**
 * Spawn groups admitted per tick. One — a hard ceiling on top of the
 * probabilistic roll below, so that even a pathological world can never produce
 * a single frame in which dozens of animals blink into existence at once.
 */
export const SPAWN_GROUPS_PER_TICK = 1;

/**
 * Mean simulated seconds a single pending credit waits before it hatches.
 *
 * Every ripe credit carries a constant hazard of 1/W per second, so with k of
 * them the expected arrivals per second are k/W and the deficit decays
 * exponentially with time constant W — INDEPENDENTLY of world size, which is
 * the property worth having: a fresh 256² starter ocean (13 credits) and a
 * fully revealed 512² world (150) both reach ~63% of target after W seconds,
 * ~86% after 2W and ~95% after 3W.
 *
 * 20 s makes that "most of the way there in a minute, effectively full in
 * three" — the requested "a couple of minutes, not instantly", and slow enough
 * that a player watching a brand-new world sees animals ARRIVE one at a time.
 * It is also short against NATURAL_LIFESPAN_SECONDS (1:15), which is what keeps
 * the equilibrium population close to target rather than well under it.
 */
export const SPAWN_MEAN_WAIT_SECONDS = 20;

/**
 * Mean simulated seconds a creature lives before wandering off for good.
 *
 * Old age / migration / "it swam out of the story" — the plugin does not model a
 * cause, only the departure. Five minutes is the gentle end of the useful range:
 * long enough that no individual visibly blinks out of a scene a player is
 * watching (at the shipped densities a full world loses one creature every ~2 s
 * spread over 262 144 cells), short enough that the population is fully replaced
 * a few times an hour, so spawn events never stop and the mix keeps changing.
 *
 * Shorter would read as creatures popping in and out; longer and a world reaches
 * a fixed cast and stays there, which is the "inventory" feel this exists to
 * avoid.
 */
export const NATURAL_LIFESPAN_SECONDS = 300;

/**
 * Rejection-sampling attempts when looking for a habitat cell to spawn in.
 * Bounded on purpose: a world whose unlocked area contains no deep water at all
 * must cost a fixed amount of work and then give up, not scan 262k cells looking
 * for something that is not there. A credit that fails to place is kept and
 * retried later (see consumeCredits).
 */
export const SPAWN_SAMPLE_ATTEMPTS = 48;

/** Group members scatter this many body lengths around the seed cell. */
const GROUP_SCATTER_BODY_LENGTHS = 2;

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching the shape of the mana and
// reveal plugins (one plugin instance per server process).

/** Living creatures, in spawn order. */
const entities: WildlifeEntity[] = [];

/** Pending spawns, oldest first. */
let credits: RespawnCredit[] = [];

/** Accumulated simulated seconds — the only clock this plugin has. */
let simSeconds = 0;

/** Simulated time of the last census; -Infinity forces one on the first tick. */
let lastCensusSeconds = Number.NEGATIVE_INFINITY;

/** Per-species population targets from the most recent census. */
let targets: Record<WildlifeHabitatSpecies, number> = emptySpeciesCounts();

/** Unlocked chunk coordinates from the most recent census; the spawn pool. */
let spawnChunks: ReadonlyArray<readonly [number, number]> = [];

let nextEntityId = 1;

/**
 * The next school id to hand out. Ids are never reused within a process, and are
 * carried through a snapshot (persistence.ts) so a restored school stays one
 * school instead of dissolving into singletons on restart.
 */
let nextSchoolId = 1;

/**
 * Creatures lost to natural turnover since the last reset. Observability only —
 * nothing in the sim reads it. It exists so a test can distinguish "the
 * population changed because animals came and went" from "the habitat rules
 * culled something", which is otherwise unobservable from the outside.
 */
let naturalDepartures = 0;

export function livingEntities(): readonly WildlifeEntity[] {
  return entities;
}

/** Cumulative natural (old-age) departures — see `naturalDepartures`. */
export function naturalDepartureCount(): number {
  return naturalDepartures;
}

export function populationTargets(): Readonly<Record<WildlifeHabitatSpecies, number>> {
  return targets;
}

export function pendingCreditCount(): number {
  return credits.length;
}

/**
 * Snapshot of every pending credit's species and readyAt, for tests that need
 * to check WHICH credits survived a removal — pendingCreditCount() alone
 * cannot distinguish "the ripe credit that earned this spawn was removed" from
 * "the not-yet-ripe one was removed instead", which is exactly the distinction
 * the removal step in consumeCredits has to get right (see its comment).
 */
export function pendingCreditsSnapshot(): ReadonlyArray<{
  readonly species: WildlifeHabitatSpecies;
  readonly readyAt: number;
}> {
  return credits.map((credit) => ({ ...credit }));
}

/**
 * The id the next spawn will take. Persisted, so ids are never reused across a
 * restart even when every creature happened to be despawned at snapshot time.
 */
export function nextEntityIdValue(): number {
  return nextEntityId;
}

/**
 * THE ONE ENTITY-ID ALLOCATOR for everything this plugin broadcasts — habitat
 * creatures here and birds in ./flocks.ts alike.
 *
 * It has to be one counter rather than one per subsystem: the client keys its
 * interpolation purely by id (client/interpolation.ts), so two allocators would
 * eventually hand out the same number and a bird would inherit a fish's pose.
 * Birds are not persisted, so ids they consume simply advance the counter that
 * IS persisted — which is exactly right, because the invariant the snapshot
 * cares about is "never reuse an id", not "never skip one".
 */
export function allocateEntityId(): number {
  return nextEntityId++;
}

/** The id the next school will take. Persisted alongside nextEntityIdValue. */
export function nextSchoolIdValue(): number {
  return nextSchoolId;
}

/** Members of one school, in spawn order. Empty for an id that has departed. */
export function schoolMembers(schoolId: number): WildlifeEntity[] {
  return entities.filter((entity) => entity.schoolId === schoolId);
}

/** Drops all state so a suite (or a fresh world) starts from zero. */
export function resetPopulation(): void {
  entities.length = 0;
  credits = [];
  simSeconds = 0;
  lastCensusSeconds = Number.NEGATIVE_INFINITY;
  targets = emptySpeciesCounts();
  spawnChunks = [];
  nextEntityId = 1;
  nextSchoolId = 1;
  naturalDepartures = 0;
}

function countOf(species: WildlifeHabitatSpecies): number {
  let count = 0;
  for (const entity of entities) if (entity.species === species) count++;
  return count;
}

function creditsFor(species: WildlifeHabitatSpecies): number {
  let count = 0;
  for (const credit of credits) if (credit.species === species) count++;
  return count;
}

/**
 * Reconciles the living population against freshly computed targets: issues
 * credits for a deficit, and for a surplus trims the excess and cancels credits
 * that are no longer wanted (a drained sea must not keep spawning fish).
 */
function reconcileToTargets(): void {
  for (const species of WILDLIFE_HABITAT_SPECIES) {
    const deficit = targets[species] - countOf(species) - creditsFor(species);

    if (deficit > 0) {
      // Ripe immediately: the SPAWN_MEAN_WAIT_SECONDS hazard roll in
      // consumeCredits is what staggers the fill, not the ripening clock.
      // Ripeness only encodes "this credit is not allowed to hatch YET", which
      // is a habitat-loss concept.
      for (let n = 0; n < deficit; n++) credits.push({ species, readyAt: simSeconds });
      continue;
    }
    if (deficit === 0) continue;

    // Surplus. Cancel the most-recently-added credits for this species first
    // (scanning from the end) — cheaper than despawning a living creature, and
    // it avoids despawning something a player may currently be looking at.
    let surplus = -deficit;
    for (let i = credits.length - 1; i >= 0 && surplus > 0; i--) {
      if (credits[i].species !== species) continue;
      credits.splice(i, 1);
      surplus--;
    }
    // Then the youngest living creatures (end of the array), which are the least
    // likely to be established somewhere anyone is watching.
    for (let i = entities.length - 1; i >= 0 && surplus > 0; i--) {
      if (entities[i].species !== species) continue;
      entities.splice(i, 1);
      surplus--;
    }
  }
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/** Uniform sample of a cell inside a random unlocked chunk, or null if none. */
function sampleUnlockedCell(): { x: number; y: number } | null {
  if (spawnChunks.length === 0) return null;
  const [cx, cy] = spawnChunks[Math.floor(Math.random() * spawnChunks.length)];
  return {
    x: cx * CHUNK_SIZE + Math.random() * CHUNK_SIZE,
    y: cy * CHUNK_SIZE + Math.random() * CHUNK_SIZE,
  };
}

/** Rejection-samples a spawn point for `species`. Null when none was found. */
function findSpawnCell(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
): { x: number; y: number } | null {
  for (let attempt = 0; attempt < SPAWN_SAMPLE_ATTEMPTS; attempt++) {
    const candidate = sampleUnlockedCell();
    if (candidate === null) return null;
    if (isValidCellFor(world, species, candidate.x, candidate.y)) return candidate;
  }
  return null;
}

/**
 * Draws one size class against its species' weights. Iterates
 * WILDLIFE_SIZE_CLASSES in order, so the mapping from a random number to a class
 * is fixed rather than dependent on object key order.
 *
 * A weight table that sums to zero (a species configured with no sizes at all)
 * yields the default class rather than undefined — the only defensive branch
 * here, and it costs one comparison.
 */
function drawSizeClass(weights: SizeWeights): WildlifeSizeClass {
  let total = 0;
  for (const sizeClass of WILDLIFE_SIZE_CLASSES) total += weights[sizeClass];
  if (total <= 0) return DEFAULT_SIZE_CLASS;

  let roll = Math.random() * total;
  for (const sizeClass of WILDLIFE_SIZE_CLASSES) {
    roll -= weights[sizeClass];
    if (roll < 0) return sizeClass;
  }
  // Only reachable if the accumulated float sum lands exactly on `total`.
  return DEFAULT_SIZE_CLASS;
}

/**
 * The size class of every member of one spawn group, in creation order.
 *
 * One draw shared by the whole group, or one draw each, per the species'
 * `sizeDraw` — the two group shapes this plugin models (a size-graded shoal and
 * a mixed family pod). Drawn up front rather than inside the creation loop so
 * the group's own class is known BEFORE the first member exists, which is what
 * the cohesion roll needs.
 */
function drawGroupSizes(profile: SpeciesProfile, wanted: number): WildlifeSizeClass[] {
  if (profile.sizeDraw === 'per-member') {
    return Array.from({ length: wanted }, () => drawSizeClass(profile.sizeWeights));
  }
  const shared = drawSizeClass(profile.sizeWeights);
  return Array.from({ length: wanted }, () => shared);
}

/**
 * The one class that stands for a whole group: its LARGEST member.
 *
 * A group needs a single answer to "how strongly does this school hold
 * together", and for a mixed group the honest answer is set by its adults —
 * three whales travelling with a bull are a bull's pod, not a calf's. For a
 * graded group every member is that class already, so this is the identity and
 * the caller needs no branch.
 *
 * An empty group (every member landed outside the habitat) has no largest
 * member; DEFAULT_SIZE_CLASS stands in, and nothing is created either way.
 */
function groupSizeClassOf(sizes: readonly WildlifeSizeClass[]): WildlifeSizeClass {
  let largest = -1;
  for (const size of sizes) largest = Math.max(largest, sizeClassIndex(size));
  return largest < 0 ? DEFAULT_SIZE_CLASS : sizeClassAt(largest);
}

/**
 * Spawns up to `wanted` creatures of one species around a seed cell. Members
 * that land outside the habitat are dropped rather than nudged inward: a school
 * that meets a shoreline should simply be smaller on that side.
 *
 * SCHOOL IDENTITY IS DECIDED HERE, once per group, in two rolls:
 *
 *   1. the members' SIZE CLASSES, drawn from the species' weights — once for the
 *      whole group or once per member, per the species' `sizeDraw` (a shoal is
 *      graded, a pod is a mixed family);
 *   2. whether the group is COHESIVE, at the species' own schooling probability
 *      for the group's class — small fish nearly always, large fish nearly
 *      never, whales at any size.
 *
 * A cohesive group shares one school id and will hold together (movement.ts) and
 * leave together (applyNaturalTurnover). A non-cohesive one hands every member
 * its own school id, which is precisely the independent-wanderer behaviour that
 * shipped before schools existed. Both branches produce valid schools, so
 * nothing downstream has to ask which happened.
 *
 * Returns how many were actually created, so the caller consumes exactly that
 * many credits.
 */
function spawnGroup(world: HabitatWorld, species: WildlifeHabitatSpecies, wanted: number): number {
  const seed = findSpawnCell(world, species);
  if (seed === null) return 0;

  const profile = profileOf(species);
  const sizes = drawGroupSizes(profile, wanted);
  const cohesive = Math.random() < profile.schoolingProbabilityBySize[groupSizeClassOf(sizes)];
  // Allocated up front so every member of a cohesive group gets the same id even
  // though members are created one at a time.
  const groupSchoolId = nextSchoolId++;

  const scatter = profile.bodyLengthCells * GROUP_SCATTER_BODY_LENGTHS;
  // One shared heading: a group leaves the seed cell as a group.
  const heading = Math.random() * Math.PI * 2;
  let created = 0;

  for (let n = 0; n < wanted; n++) {
    // Member 0 sits exactly on the known-valid seed; the rest scatter.
    const x = n === 0 ? seed.x : seed.x + randomSigned(scatter);
    const y = n === 0 ? seed.y : seed.y + randomSigned(scatter);
    if (!isValidCellFor(world, species, x, y)) continue;
    entities.push({
      id: allocateEntityId(),
      species,
      schoolId: cohesive ? groupSchoolId : nextSchoolId++,
      // Member n's own class: the same one for every member of a graded group,
      // an independent draw for every member of a mixed one.
      size: sizes[n]!,
      x,
      y,
      heading,
      fleeSecondsRemaining: 0,
    });
    created++;
  }
  return created;
}

/** How many credits are ripe right now. Drives the spawn hazard below. */
function ripeCreditCount(): number {
  let count = 0;
  for (const credit of credits) if (credit.readyAt <= simSeconds) count++;
  return count;
}

/**
 * Rolls whether a spawn EVENT happens in this `dt`.
 *
 * The hazard is `ripe / SPAWN_MEAN_WAIT_SECONDS` events per second — see the
 * module header for why it scales with the number of waiting credits rather
 * than being a flat per-tick chance. Clamped at 1 for safety: at the shipped
 * cap and tick rate the probability is at most 150 × 0.1 / 20 = 0.75, so the
 * clamp is a guard against a future retune, not something that fires.
 */
function rollSpawnEvent(ripe: number, dt: number): boolean {
  return Math.random() < Math.min(1, (ripe * dt) / SPAWN_MEAN_WAIT_SECONDS);
}

/**
 * Consumes ripe credits, at most SPAWN_GROUPS_PER_TICK groups per call and only
 * when the probabilistic roll fires.
 */
function consumeCredits(world: HabitatWorld, dt: number): void {
  for (let group = 0; group < SPAWN_GROUPS_PER_TICK; group++) {
    if (entities.length >= WILDLIFE_POPULATION_CAP) return;
    const ripe = ripeCreditCount();
    if (ripe === 0) return;
    if (!rollSpawnEvent(ripe, dt)) return;

    const index = credits.findIndex((credit) => credit.readyAt <= simSeconds);
    if (index === -1) return;

    const species = credits[index].species;
    const wanted = Math.min(
      profileOf(species).groupSize,
      creditsFor(species),
      WILDLIFE_POPULATION_CAP - entities.length,
    );
    const created = spawnGroup(world, species, wanted);

    if (created === 0) {
      // No habitat available right now (all deep water still locked, say).
      // Defer this credit by a census interval rather than rejection-sampling
      // for it on every tick forever.
      credits[index] = { species, readyAt: simSeconds + HABITAT_CENSUS_INTERVAL_SECONDS };
      return;
    }

    // Debit exactly the credits `created` was earned against: ripe ones, same
    // as ripeCreditCount()'s and findIndex's predicate above. A habitat-loss
    // credit pushed for this species (readyAt still in the future) must never
    // be removed here just because it happens to sit later in the array than
    // the ripe credits that actually paid for this spawn — that would both
    // discard a recovery nobody has hatched yet AND leave the ripe credit that
    // DID pay for it still pending, to spawn a duplicate later.
    let removed = 0;
    for (let i = credits.length - 1; i >= 0 && removed < created; i--) {
      if (credits[i].species !== species || credits[i].readyAt > simSeconds) continue;
      credits.splice(i, 1);
      removed++;
    }
  }
}

// ── Despawning ───────────────────────────────────────────────────────────────

/**
 * Removes the creature at `index` and issues a delayed credit so the species
 * recovers somewhere else. Used when the ground under a creature stops being its
 * habitat — a drained lake, a filled bay, a chunk that somehow re-locked.
 */
export function despawnWithCredit(index: number): void {
  const [removed] = entities.splice(index, 1);
  if (removed === undefined) return;
  credits.push({
    species: removed.species,
    readyAt: simSeconds + HABITAT_LOSS_RESPAWN_DELAY_SECONDS,
  });
}

/**
 * Sweeps every creature whose CURRENT cell has stopped being valid habitat, and
 * returns how many were removed.
 *
 * Runs after movement each tick AND again after any terrain change, so the two
 * ways a creature can end up somewhere invalid (it swam there / the world
 * changed under it) share one implementation. Cheap enough to run unconditionally
 * over the whole population: WILDLIFE_POPULATION_CAP height lookups.
 */
export function despawnInvalidHabitat(world: HabitatWorld): number {
  let despawned = 0;
  for (let i = entities.length - 1; i >= 0; i--) {
    const entity = entities[i];
    if (isValidCellFor(world, entity.species, entity.x, entity.y)) continue;
    despawnWithCredit(i);
    despawned++;
  }
  return despawned;
}

/**
 * NATURAL TURNOVER, ROLLED PER SCHOOL.
 *
 * Each SCHOOL independently has a `dt / L` chance of leaving this tick, and when
 * it fires every member of that school goes at once. L is
 * NATURAL_LIFESPAN_SECONDS — the same constant, at the same value, as when the
 * roll was per individual.
 *
 * WHY THE MEAN DOES NOT CHANGE (the arithmetic, because the intuition is
 * wrong the other way). Write p = dt/L for the per-roll hazard, N for the living
 * fish and k for the mean school size.
 *
 *     per-individual rolls:  N rolls × p × 1 fish lost  = N·p fish per tick
 *     per-school rolls:      (N/k) rolls × p × k fish   = N·p fish per tick
 *
 * They are equal. A member's own departure hazard is the hazard of its school,
 * which is p either way, so an individual fish still has an exponential lifetime
 * with mean L = 300 s, the equilibrium population N = T/(1 + W/L) ≈ 0.94·T is
 * untouched, and no compensating multiplier is needed or wanted — scaling L by k
 * would have cut fish turnover fivefold. What DOES change is the EVENT rate: a
 * departure now happens k times less often and takes k fish with it. At the
 * shipped numbers a 79-fish world sees a school leave every ~19 s instead of a
 * fish leaving every ~3.8 s.
 *
 * WHY IT HAD TO CHANGE. Losing members one at a time is a slow leak that
 * fragments schools: after a couple of minutes what was a group of five is a
 * three and two strays, and the strays never rejoin anything (schools do not
 * recruit). Departing whole keeps the visible unit intact for its whole life,
 * and the replacement arrives as a whole group too — the census sees a deficit
 * of `groupSize` and spawnGroup fills it in one event, where a deficit of 1
 * could only ever produce another singleton.
 *
 * Non-schooling species are unaffected in every sense: their groupSize is 1, so
 * each individual is its own school and this IS the per-individual roll.
 *
 * Deliberately NOT despawnWithCredit: a natural departure is not a habitat
 * failure, so it must not book a HABITAT_LOSS_RESPAWN_DELAY_SECONDS credit of
 * its own. The next census sees the resulting deficit and issues an ordinary
 * ripe credit, which then waits its own SPAWN_MEAN_WAIT_SECONDS — one arrival
 * mechanism for every kind of gap, exactly as the "one spawn path" note above
 * demands.
 *
 * Exported alongside despawnInvalidHabitat because it is the other half of "how
 * a creature stops existing", and because the school semantics above are a
 * contract worth asserting directly rather than inferring from a whole tick.
 */
export function applyNaturalTurnover(dt: number): void {
  const departureChance = dt / NATURAL_LIFESPAN_SECONDS;

  // One roll per school, in first-appearance order — a fixed order, so the roll
  // a given school gets does not depend on how the array happens to be laid out.
  const rolled = new Set<number>();
  const departing = new Set<number>();
  for (const entity of entities) {
    if (rolled.has(entity.schoolId)) continue;
    rolled.add(entity.schoolId);
    if (Math.random() < departureChance) departing.add(entity.schoolId);
  }
  if (departing.size === 0) return;

  // Iterates backwards so a removal cannot skip the next candidate.
  for (let i = entities.length - 1; i >= 0; i--) {
    if (!departing.has(entities[i].schoolId)) continue;
    entities.splice(i, 1);
    naturalDepartures++;
  }
}

// ── Fire ─────────────────────────────────────────────────────────────────────
// What `fire` needs to know about this population, and nothing more: which
// creature is standing on a cell, where a given one is now, and how to kill it.
// See ./fire-bridge.ts and plugins/fire/server/entityFuel.ts.

/**
 * How close a creature's own position must be to a cell for that cell's fire to
 * be ON it, in cells.
 *
 * HALF A CELL — the cell it is standing in, and nothing more. A creature is a
 * point in fractional cell space, so "is it here" is a rounding question, and
 * rounding to the containing cell is the only answer a player can predict: they
 * torched the cell the animal is drawn on.
 */
const FIRE_CELL_REACH = 0.5;

/**
 * The land creature standing on this cell, or null. First match wins — which
 * member of a crowded cell caught is not a question anyone can ask.
 *
 * LAND ONLY, and not as a performance filter: a fish is not flammable, and the
 * owner's rule for this whole mechanic is that what is ON LAND can be burned.
 */
export function burnableEntityAt(x: number, y: number): WildlifeEntity | null {
  for (const entity of entities) {
    if (profileOf(entity.species).habitat !== 'land') continue;
    if (Math.abs(entity.x - x) > FIRE_CELL_REACH) continue;
    if (Math.abs(entity.y - y) > FIRE_CELL_REACH) continue;
    return entity;
  }
  return null;
}

/** Where this creature is now, in fractional cell space — null once it is gone. */
export function entityPosition(id: number): { x: number; y: number } | null {
  const entity = entities.find((candidate) => candidate.id === id);
  return entity === undefined ? null : { x: entity.x, y: entity.y };
}

/**
 * Kills these outright — no respawn credit, deliberately.
 *
 * A credit means "this one was displaced and will reappear elsewhere shortly"
 * (despawnWithCredit, for the drained lake). A creature that burned to death
 * did not go anywhere. The population recovers through the ordinary census and
 * spawn machinery, at the ordinary pace, exactly as it does after natural
 * turnover — which is the same kind of event: one fewer animal in the world.
 *
 * Returns how many were actually removed.
 */
export function killEntities(ids: readonly number[]): number {
  if (ids.length === 0) return 0;
  const doomed = new Set(ids);
  let killed = 0;
  // Backwards, so a removal cannot skip the next candidate — applyNaturalTurnover's
  // idiom, for its reason.
  for (let i = entities.length - 1; i >= 0; i--) {
    if (!doomed.has(entities[i].id)) continue;
    entities.splice(i, 1);
    killed++;
  }
  return killed;
}

// ── Tick entry point ─────────────────────────────────────────────────────────

/**
 * Advances the population clock and runs the turnover / census / spawn
 * machinery.
 *
 * Order: turnover first, so the census that may run this same tick counts the
 * population as it actually is and books the replacement credits immediately
 * rather than a census interval later.
 */
export function advancePopulation(world: HabitatWorld, dt: number): void {
  simSeconds += dt;
  applyNaturalTurnover(dt);

  if (simSeconds - lastCensusSeconds >= HABITAT_CENSUS_INTERVAL_SECONDS) {
    lastCensusSeconds = simSeconds;
    const census = takeCensus(world);
    spawnChunks = census.chunks;
    targets = targetsFor(census.cellsByHabitat);
    reconcileToTargets();
  }

  consumeCredits(world, dt);
}

// ── Wire ────────────────────────────────────────────────────────────────────────

/** The broadcast payload's entity list: cell-space floats at wire precision. */
export function entityStates(): WildlifeEntityState[] {
  return entities.map((entity) => ({
    id: entity.id,
    species: entity.species,
    x: roundBroadcastPosition(entity.x),
    y: roundBroadcastPosition(entity.y),
    heading: roundBroadcastPosition(entity.heading),
    // The class INDEX, not its name — one msgpack byte instead of seven.
    // `schoolId` is deliberately absent: see the field's note on WildlifeEntity.
    size: sizeClassIndex(entity.size),
  }));
}

/**
 * Swaps the whole population out, used only by a snapshot restore
 * (./persistence.ts). Everything else that changes the population goes through
 * the credit path, so this is the one seam where creatures appear without one —
 * which is exactly what restoring a saved world means.
 */
export function replacePopulation(
  restored: readonly WildlifeEntity[],
  nextId: number,
  nextSchool: number,
): void {
  resetPopulation();
  for (const entity of restored) entities.push({ ...entity });
  nextEntityId = nextId;
  // Never below "one past the highest restored school", or a newly spawned group
  // would join a restored school and inherit its departure roll.
  let highestSchool = 0;
  for (const entity of entities) highestSchool = Math.max(highestSchool, entity.schoolId);
  nextSchoolId = Math.max(nextSchool, highestSchool + 1, 1);
}
