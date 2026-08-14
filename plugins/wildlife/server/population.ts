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
// WHERE THE POPULATION SETTLES. With per-credit hatch rate 1/W and per-creature
// departure rate 1/L, a habitat whose target is T settles at
//
//     N = T / (1 + W/L)
//
// (arrivals (T−N)/W balance departures N/L). At the shipped W = 20 s and
// L = 300 s that is T/1.067 ≈ 0.94·T: near the target, deliberately never
// pinned to it. Tests assert BOUNDS around that, never an exact count — there
// is no seeded RNG here and there should not be one.
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
  WILDLIFE_SPECIES,
  type WildlifeEntityState,
  type WildlifeSpecies,
  roundBroadcastPosition,
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
import { profileOf } from './species.ts';

/** A living creature. Mutable — the tick loop writes these in place. */
export interface WildlifeEntity {
  readonly id: number;
  readonly species: WildlifeSpecies;
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
  readonly species: WildlifeSpecies;
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
let targets: Record<WildlifeSpecies, number> = emptySpeciesCounts();

/** Unlocked chunk coordinates from the most recent census; the spawn pool. */
let spawnChunks: ReadonlyArray<readonly [number, number]> = [];

let nextEntityId = 1;

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

export function populationTargets(): Readonly<Record<WildlifeSpecies, number>> {
  return targets;
}

export function pendingCreditCount(): number {
  return credits.length;
}

/**
 * The id the next spawn will take. Persisted, so ids are never reused across a
 * restart even when every creature happened to be despawned at snapshot time.
 */
export function nextEntityIdValue(): number {
  return nextEntityId;
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
  naturalDepartures = 0;
}

function countOf(species: WildlifeSpecies): number {
  let count = 0;
  for (const entity of entities) if (entity.species === species) count++;
  return count;
}

function creditsFor(species: WildlifeSpecies): number {
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
  for (const species of WILDLIFE_SPECIES) {
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

    // Surplus. Cancel unripe credits first — cheaper, and it avoids despawning
    // something a player may currently be looking at.
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
  species: WildlifeSpecies,
): { x: number; y: number } | null {
  for (let attempt = 0; attempt < SPAWN_SAMPLE_ATTEMPTS; attempt++) {
    const candidate = sampleUnlockedCell();
    if (candidate === null) return null;
    if (isValidCellFor(world, species, candidate.x, candidate.y)) return candidate;
  }
  return null;
}

/**
 * Spawns up to `wanted` creatures of one species around a seed cell. Members
 * that land outside the habitat are dropped rather than nudged inward: a school
 * that meets a shoreline should simply be smaller on that side.
 *
 * Returns how many were actually created, so the caller consumes exactly that
 * many credits.
 */
function spawnGroup(world: HabitatWorld, species: WildlifeSpecies, wanted: number): number {
  const seed = findSpawnCell(world, species);
  if (seed === null) return 0;

  const profile = profileOf(species);
  const scatter = profile.bodyLengthCells * GROUP_SCATTER_BODY_LENGTHS;
  // One shared heading: a group leaves the seed cell as a group.
  const heading = Math.random() * Math.PI * 2;
  let created = 0;

  for (let n = 0; n < wanted; n++) {
    // Member 0 sits exactly on the known-valid seed; the rest scatter.
    const x = n === 0 ? seed.x : seed.x + (Math.random() * 2 - 1) * scatter;
    const y = n === 0 ? seed.y : seed.y + (Math.random() * 2 - 1) * scatter;
    if (!isValidCellFor(world, species, x, y)) continue;
    entities.push({ id: nextEntityId++, species, x, y, heading, fleeSecondsRemaining: 0 });
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

    let removed = 0;
    for (let i = credits.length - 1; i >= 0 && removed < created; i--) {
      if (credits[i].species !== species) continue;
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
 * NATURAL TURNOVER. Each creature independently has a `dt / L` chance of
 * leaving this tick, which is an exponential lifetime with mean
 * NATURAL_LIFESPAN_SECONDS.
 *
 * Deliberately NOT despawnWithCredit: a natural departure is not a habitat
 * failure, so it must not book a HABITAT_LOSS_RESPAWN_DELAY_SECONDS credit of
 * its own. The next census sees the resulting deficit and issues an ordinary
 * ripe credit, which then waits its own SPAWN_MEAN_WAIT_SECONDS — one arrival
 * mechanism for every kind of gap, exactly as the "one spawn path" note above
 * demands.
 *
 * Iterates backwards so a removal cannot skip the next candidate.
 */
function applyNaturalTurnover(dt: number): void {
  const departureChance = dt / NATURAL_LIFESPAN_SECONDS;
  for (let i = entities.length - 1; i >= 0; i--) {
    if (Math.random() >= departureChance) continue;
    entities.splice(i, 1);
    naturalDepartures++;
  }
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
): void {
  resetPopulation();
  for (const entity of restored) entities.push({ ...entity });
  nextEntityId = nextId;
}
