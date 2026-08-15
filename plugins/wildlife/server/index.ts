// wildlife — ambient + reactive habitat fauna, as a plugin.
//
// Core knows nothing about creatures. This half owns the entire sim (habitat
// classification, population targets, wander, panic, persistence) and publishes
// it on one namespaced message; the client half under ../client draws it.
//
// It exercises a quadrant of the plugin contract that neither shipped example
// does — onTick as a *world* simulation rather than a per-player economy, plus
// onTerrainChanged as a reaction rather than an accumulator — which is the point
// of building it: if the API cannot carry a live entity sim, this is what fails.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, EVERY OTHER TICK.
//
// Every broadcast carries the ENTIRE entity list, not a delta. That is a
// deliberate v1 choice with three consequences worth stating plainly:
//
//   * self-healing — a dropped or reordered message costs one 200 ms frame of
//     staleness and nothing else; there is no diff stream to desynchronise;
//   * no join handshake — a joining client is caught up by the next broadcast,
//     so this plugin needs no onPlayerJoin snapshot path at all;
//   * bounded cost — BROADCAST_ENTITY_CEILING puts a hard ceiling on the
//     payload, so the bandwidth is a constant, not a function of how long the
//     world has been running.  Two independent caps make it up: the habitat
//     population's WILDLIFE_POPULATION_CAP and the sky's MAX_BIRDS_ALOFT.
//
// The price is bandwidth. Per creature the payload is six keys — id, species,
// x, y, heading, size — which msgpack encodes in roughly 58 B including the key
// strings (Colyseus re-sends keys on every message; there is no schema here).
//
// THE BUDGET, RECOMPUTED 2026-08-14 WITH BIRDS (BROADCAST_ENTITY_CEILING). Two
// independent subsystems put creatures in this message and each has its own hard
// ceiling; the total is what a full message actually weighs:
//
//   habitat population   WILDLIFE_POPULATION_CAP   150   (census.ts)
//   birds aloft          MAX_BIRDS_ALOFT            18   (flocks.ts: 2 × 9)
//                                                  ────
//                                                   168 entities
//
//   168 × 58 B                = 9.7 KB per message
//   every tick  (10 Hz)       = 97.4 KB/s ≈ 780 kbit/s per client
//   every OTHER tick (5 Hz)   = 48.7 KB/s ≈ 390 kbit/s per client   ← chosen
//   × ~10 players             ≈ 3.9 Mbit/s of server upstream
//
// 58 B is an upper bound for a bird — `bird` is the shortest species name of the
// five and its `size` is always the default class — so the real figure is a
// little under. Birds cost +12% over the 43.5 KB/s ≈ 348 kbit/s this was before
// them (and 8.7 KB / 348 kbit/s is still exactly what a world with an empty sky
// costs, since the sky is empty about half the time on a small world). Earlier
// recomputes, for the record: 5.2 KB / 210 kbit/s at the old cap of 100, then
// 7.8 KB / 312 kbit/s, then 8.7 KB / 348 kbit/s when `size` was added.
//
// 5 Hz is chosen because the extra 390 kbit/s buys nothing a player can see.
// The fastest HABITAT species cruises at 3 cells/s, so between two 200 ms
// updates it covers 0.6 cells — well under one cell, and the client interpolates
// across the gap (client/interpolation.ts). Even a fleeing fish at ×3 covers 1.8
// cells, which interpolation still renders as smooth motion, and that 1.8 is the
// bound BIRD_CRUISE_SPEED_CELLS_PER_SECOND was chosen under (8 × 0.2 = 1.6), so
// the fastest thing in the world still needs no cadence of its own. Halving the
// rate halves the steady-state cost of the most expensive thing this plugin
// does, and the remaining budget is what lets a self-hoster on a home connection
// run ~10 players. Positions are rounded to WILDLIFE_POSITION_DECIMALS (1/100
// cell) on the way out — two orders of magnitude finer than the smallest
// creature.
// ─────────────────────────────────────────────────────────────────────────────

import { MAX_BRUSH_RADIUS, type CellDiff } from '@terrace/shared';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement the mana and reveal plugins use.
import type {
  PersistenceSlice,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { WILDLIFE_ENTITIES_MESSAGE, WILDLIFE_PLUGIN_NAME } from '../protocol.ts';
import { WILDLIFE_POPULATION_CAP, type HabitatWorld } from './census.ts';
import { MAX_BIRDS_ALOFT, advanceFlocks, birdStates, resetFlocks } from './flocks.ts';
import { FLEE_DURATION_SECONDS, advanceMovement, startleNear } from './movement.ts';
import { loadPopulation, savePopulation } from './persistence.ts';
import {
  advancePopulation,
  despawnInvalidHabitat,
  entityStates,
  resetPopulation,
} from './population.ts';

/**
 * Ticks between broadcasts. 2 → 5 Hz at the shipped TICK_HZ of 10. See the
 * bandwidth analysis in this file's header for why 2 and not 1.
 */
export const BROADCAST_TICK_INTERVAL = 2;

/**
 * Hard ceiling on entities in one broadcast: the standing habitat population
 * plus every bird that can be aloft at once.
 *
 * DERIVED, never written by hand — it is the number the bandwidth arithmetic in
 * this file's header multiplies by 58 B, and the two subsystems that feed it
 * (census.ts and flocks.ts) each cap themselves independently. Naming the sum
 * here is what stops "what does a full message cost" from having two answers
 * neither of which is the real one.
 */
export const BROADCAST_ENTITY_CEILING = WILDLIFE_POPULATION_CAP + MAX_BIRDS_ALOFT;

/**
 * How far a sculpt's disturbance is felt, in cells from the diff's centroid.
 *
 * Three times MAX_BRUSH_RADIUS. The brush itself reaches 4 cells and the
 * gradient relaxation spills a few more, so a single edit's changed cells fill
 * something like a 6–8 cell disc; 12 cells means the ring of creatures just
 * OUTSIDE the actual change reacts too. That is the intended reading — the noise
 * and shadow of someone reshaping the ground scares things off, rather than a
 * suspiciously exact geometric boundary at the edge of the diff.
 */
export const FLEE_RADIUS_CELLS = MAX_BRUSH_RADIUS * 3;

/**
 * The WorldApi, captured at onWorldCreate. onTerrainChanged is not handed one
 * (see the same note in the reveal plugin), and the reactive path needs to
 * re-check habitat validity, so it must be stashed.
 */
let api: WorldApi | null = null;

/** Ticks since boot, for the broadcast cadence. */
let tickCount = 0;

/**
 * THE SIM STEP — CRITICAL PATH.
 *
 * Fixed order, once per host tick:
 *   1. population — natural turnover, the census (every
 *      HABITAT_CENSUS_INTERVAL_SECONDS) and a PROBABILISTIC spawn roll, so the
 *      world fills and recovers gradually and never stops changing;
 *   2. movement — every creature wanders or flees, steering around anything that
 *      is not its habitat and around locked territory;
 *   3. habitat sweep — anything now standing somewhere invalid despawns with a
 *      respawn credit. Movement cannot produce this on its own (it vetoes bad
 *      steps), so in practice this catches creatures the TERRAIN moved out from
 *      under. It runs anyway, unconditionally: it is at most
 *      WILDLIFE_POPULATION_CAP height lookups, and it is the invariant "no
 *      creature is ever outside its habitat" made true by construction rather
 *      than by trusting step 2;
 *   4. flocks — the transient sky: arrivals, flight, departures (flocks.ts).
 *      It runs AFTER the habitat sweep and shares no state with steps 1–3
 *      beyond the entity-id allocator, which is the whole point of the split;
 *   5. broadcast, on the cadence — habitat creatures and birds in one message,
 *      because the client's parser, interpolator and view reconciliation are all
 *      keyed by id and do not care which subsystem produced a row.
 *
 * Steps 1–4 are all driven by `dt`; nothing here reads a wall clock.
 */
function simulate(world: WorldApi, dt: number): void {
  advancePopulation(world, dt);
  advanceMovement(world, dt);
  despawnInvalidHabitat(world);
  advanceFlocks(world, dt);

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(WILDLIFE_ENTITIES_MESSAGE, {
    entities: [...entityStates(), ...birdStates()],
  });
}

/**
 * THE REACTIVE PATH.
 *
 * Fired after any applied edit with the FULL server-side diff. Two effects:
 *
 *   * everything within FLEE_RADIUS_CELLS of the diff's centroid bolts directly
 *     away for FLEE_DURATION_SECONDS;
 *   * anything whose cell has stopped being its habitat — the lake that was just
 *     drained, the bay that was just filled in — despawns with a respawn credit,
 *     so that species reappears elsewhere after a delay instead of vanishing.
 *
 * The centroid is the mean of the changed cells. A diff is always a brush
 * footprint plus its relaxation spill, so it is a single connected blob and its
 * mean is inside it; there is no multi-modal case to worry about.
 *
 * Note this is called from inside the sculpt that caused it. It only reads
 * heights and writes plugin state — it never calls world.sculpt — so it cannot
 * feed the host's terrain-change cascade guard.
 */
function reactToTerrain(diff: readonly CellDiff[]): void {
  if (api === null || diff.length === 0) return;

  let sumX = 0;
  let sumY = 0;
  for (const cell of diff) {
    sumX += cell.x;
    sumY += cell.y;
  }
  startleNear(sumX / diff.length, sumY / diff.length, FLEE_RADIUS_CELLS);

  despawnInvalidHabitat(api);
}

/**
 * PERSISTENCE: THE HABITAT POPULATION ONLY. Birds are deliberately absent from
 * both halves.
 *
 * A flock is a crossing in progress — its entire state is "how far along a path
 * it will have finished in a minute or two", and resuming that after a restart
 * means restoring a journey nobody was watching. The spawner puts a fresh flock
 * in the sky within FLOCK_MEAN_SPAWN_INTERVAL_SECONDS anyway, so persisting them
 * would add a snapshot field, a validation branch and a version question to buy
 * a difference no player can observe. A restarted server has an empty sky for a
 * minute; that is what an empty sky looks like the rest of the time too.
 *
 * `load` clears the sky as well, and that is not tidiness: replacePopulation
 * resets the shared entity-id counter (population.ts), so any flock still aloft
 * would be holding ids the counter is about to hand out again.
 */
const persistence: PersistenceSlice = {
  save(): unknown {
    return savePopulation();
  },
  load(data: unknown): void {
    loadPopulation(data);
    resetFlocks();
  },
};

export const plugin: TerracePlugin = {
  name: WILDLIFE_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    api = world;
    // Any snapshot has already been restored by the time this runs, so the
    // population here is either empty (fresh world) or the persisted one.
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(diff: readonly CellDiff[]): void {
    reactToTerrain(diff);
  },

  persistence,
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetWildlifeState(): void {
  api = null;
  tickCount = 0;
  resetPopulation();
  resetFlocks();
}

// Re-exported so tests and any future HUD can reach the tuning numbers through
// the plugin's own entry point rather than by importing its internals.
export { FLEE_DURATION_SECONDS, MAX_BIRDS_ALOFT, WILDLIFE_POPULATION_CAP };
export type { HabitatWorld };
