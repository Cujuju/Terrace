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
//   * bounded cost — WILDLIFE_POPULATION_CAP (100) puts a hard ceiling on the
//     payload, so the bandwidth is a constant, not a function of how long the
//     world has been running.
//
// The price is bandwidth. Per creature the payload is five keys — id, species,
// x, y, heading — which msgpack encodes in roughly 52 B including the key
// strings (Colyseus re-sends keys on every message; there is no schema here).
// 100 creatures ≈ 5.2 KB per broadcast.
//
//   every tick  (10 Hz): 52 KB/s ≈ 420 kbit/s per client
//   every OTHER tick (5 Hz): 26 KB/s ≈ 210 kbit/s per client   ← chosen
//
// 5 Hz is chosen because the extra 210 kbit/s buys nothing a player can see.
// The fastest species cruises at 3 cells/s, so between two 200 ms updates it
// covers 0.6 cells — well under one cell, and the client interpolates across the
// gap (client/interpolation.ts). Even a fleeing fish at ×3 covers 1.8 cells,
// which interpolation still renders as smooth motion. Halving the rate halves
// the steady-state cost of the most expensive thing this plugin does, and the
// remaining budget is what lets a self-hoster on a home connection run ~10
// players. Positions are rounded to WILDLIFE_POSITION_DECIMALS (1/100 cell) on
// the way out — two orders of magnitude finer than the smallest creature.
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
import type { HabitatWorld } from './census.ts';
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
 *   1. population — census (every HABITAT_CENSUS_INTERVAL_SECONDS) and at most
 *      one spawn group, so the world fills and recovers gradually;
 *   2. movement — every creature wanders or flees, steering around anything that
 *      is not its habitat and around locked territory;
 *   3. habitat sweep — anything now standing somewhere invalid despawns with a
 *      respawn credit. Movement cannot produce this on its own (it vetoes bad
 *      steps), so in practice this catches creatures the TERRAIN moved out from
 *      under. It runs anyway, unconditionally: it is 100 height lookups, and it
 *      is the invariant "no creature is ever outside its habitat" made true by
 *      construction rather than by trusting step 2;
 *   4. broadcast, on the cadence.
 *
 * Steps 1–3 are all driven by `dt`; nothing here reads a wall clock.
 */
function simulate(world: WorldApi, dt: number): void {
  advancePopulation(world, dt);
  advanceMovement(world, dt);
  despawnInvalidHabitat(world);

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(WILDLIFE_ENTITIES_MESSAGE, { entities: entityStates() });
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

const persistence: PersistenceSlice = {
  save(): unknown {
    return savePopulation();
  },
  load(data: unknown): void {
    loadPopulation(data);
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
}

// Re-exported so tests and any future HUD can reach the tuning numbers through
// the plugin's own entry point rather than by importing its internals.
export { FLEE_DURATION_SECONDS };
export type { HabitatWorld };
