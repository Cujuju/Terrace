// structures — man-made settlements as Conway's Game of Life (classic
// B3/S23), run over the world's buildable ground. A structure exists exactly
// where a live cell exists; its tier is how long it has survived AND how
// crowded its neighbourhood is (tiers.ts). Terrain is the board's walls
// (suitability.ts). The whole mechanic lives in ./life.ts; this file is the
// plugin wiring — the clock, the wire, and the persistence slice.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO PATHS.
//
// THE CA is polled: every CA_GENERATION_INTERVAL_SECONDS the whole board
// steps (amortised across ticks, life.ts's GenerationSurvey) — every birth,
// death and tier change in the plugin's steady state happens here, plus an
// occasional seed pattern to keep a quiet board from staying quiet forever.
//
// DEMOLITION is reactive: onTerrainChanged carries the full server-side
// diff, so an edit under a live cell kills it in the same call that applied
// the edit — before the terrain diff reaches any client. A live cell whose
// NEIGHBOUR was edited (which can silently break its own buildability — see
// life.ts's header) is left for the next generation to notice; that lag is
// named and accepted there.
//
// Both paths write to the same board and emit the same delta message, so a
// client applies "the ground moved, three buildings fell" and "a block
// aged into a hut" through one code path.
// ─────────────────────────────────────────────────────────────────────────────

import type { CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  STRUCTURES_ALL_MESSAGE,
  STRUCTURES_CHANGES_MESSAGE,
  STRUCTURES_PLUGIN_NAME,
  cellOfKey,
  packCells,
  packStructureCells,
  structureKey,
  type StructureCell,
} from '../protocol.ts';
import {
  CA_SEED_PROBABILITY_PER_GENERATION,
  GenerationSurvey,
  attemptSeed,
  generationChunksPerTick,
  type LiveCellRecord,
} from './life.ts';
import { loadStructures, saveStructures } from './persistence.ts';
import { STRUCTURES_RNG_DEFAULT_SEED, createStructuresRng, type StructuresRng } from './rng.ts';

/**
 * Simulated seconds between unsolicited full re-broadcasts.
 *
 * A REPAIR cadence, not a sync mechanism — flora's identical role, at the
 * same 60 s: a delta stream cannot notice it has drifted, so a periodic full
 * snapshot bounds any such divergence at one minute.
 */
export const STRUCTURES_KEEPALIVE_SECONDS = 60;

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching every other plugin's
// shape here. No world-readiness null-guard is needed anymore — the current
// plugin contract hands every hook its own WorldApi directly (issue #15), so
// there is no "did onWorldCreate run yet" stash to check.

/** The board: cellKey → {age, tier}. Swapped wholesale on every generation. */
let live: Map<number, LiveCellRecord> = new Map();

/** Completed generations since the world began — persisted, diagnostic. */
let generation = 0;

let survey = new GenerationSurvey();
let rng: StructuresRng = createStructuresRng(STRUCTURES_RNG_DEFAULT_SEED);

/** Accumulated simulated seconds — the only clock this plugin has. */
let simSeconds = 0;
let lastKeepaliveSeconds = 0;

/** Fractional chunks owed to the CA sweep, carried between ticks. */
let scanCredit = 0;

/** Restored from a snapshot, held until onWorldCreate — flora's identical seam. */
let restoredLive: Map<number, LiveCellRecord> = new Map();
let restoredGeneration = 0;

// ────────────────────────────────────────────────────────────────────────────
// Wire
// ────────────────────────────────────────────────────────────────────────────

function liveCells(): StructureCell[] {
  const cells: StructureCell[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    cells.push({ x: cell.x, y: cell.y, tier: record.tier });
  }
  return cells;
}

function allPayload(): { structures: number[] } {
  return { structures: packStructureCells(liveCells()) };
}

function broadcastAll(world: WorldApi): void {
  world.broadcast(STRUCTURES_ALL_MESSAGE, allPayload());
  lastKeepaliveSeconds = simSeconds;
}

function broadcastChanges(
  world: WorldApi,
  founded: readonly StructureCell[],
  upgraded: readonly StructureCell[],
  demolished: ReadonlyArray<{ x: number; y: number }>,
): void {
  if (founded.length === 0 && upgraded.length === 0 && demolished.length === 0) return;
  world.broadcast(STRUCTURES_CHANGES_MESSAGE, {
    founded: packStructureCells(founded),
    upgraded: packStructureCells(upgraded),
    demolished: packCells(demolished),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// The two paths
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE SIM STEP. Fixed order, once per host tick:
 *
 *   1. advance the clock;
 *   2. advance the CA sweep by this tick's share of the board. On the tick
 *      that completes it: swap in the new generation, maybe seed a fresh
 *      pattern onto the RESULT (so a just-placed seed is evaluated by B3/S23
 *      starting next generation, never the one that just ran), and broadcast
 *      everything that changed;
 *   3. keepalive, on its own independent cadence.
 */
function simulate(world: WorldApi, dt: number): void {
  simSeconds += dt;

  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  scanCredit = Math.min(scanCredit + generationChunksPerTick(world, dt), totalChunks);
  const budget = Math.floor(scanCredit);
  if (budget > 0) {
    scanCredit -= budget;
    const outcome = survey.advance(world, live, budget);
    if (outcome !== null) {
      live = outcome.nextLive;
      generation++;

      let seeded: StructureCell[] = [];
      if (rng.next() < CA_SEED_PROBABILITY_PER_GENERATION) {
        const placement = attemptSeed(world, live, rng);
        if (placement !== null) {
          for (const cell of placement) live.set(structureKey(cell.x, cell.y), { age: 0, tier: 0 });
          seeded = placement;
        }
      }

      broadcastChanges(world, [...outcome.born, ...seeded], outcome.upgraded, outcome.died);
    }
  }

  if (simSeconds - lastKeepaliveSeconds >= STRUCTURES_KEEPALIVE_SECONDS) broadcastAll(world);
}

/**
 * THE REACTIVE PATH. Fired after any applied edit with the FULL server-side
 * diff. A live cell standing exactly on a changed cell is killed immediately
 * — see life.ts's header for why this covers only the direct hit, and why
 * the (rarer) neighbour-invalidation case is left to the next generation.
 */
function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (diff.length === 0) return;

  const demolished: Array<{ x: number; y: number }> = [];
  for (const cell of diff) {
    if (live.delete(structureKey(cell.x, cell.y))) {
      demolished.push({ x: cell.x, y: cell.y });
    }
  }
  broadcastChanges(world, [], [], demolished);
}

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveStructures(live, generation, rng);
  },
  load(data: unknown): void {
    const restored = loadStructures(data);
    restoredLive = restored.live;
    restoredGeneration = restored.generation;
    rng = createStructuresRng(restored.rngState);
  },
};

export const plugin: TerracePlugin = {
  name: STRUCTURES_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    // Any snapshot has already been restored by the time this runs, so the
    // board here is either empty (fresh world) or the persisted one. Cells
    // outside this world (a snapshot restored onto a smaller WORLD_SIZE) die
    // at the very next generation — see life.ts's stepGeneration, which
    // recomputes buildability for the whole board from scratch every time.
    live = restoredLive;
    generation = restoredGeneration;
    restoredLive = new Map();
    restoredGeneration = 0;

    // No players are connected yet — this is only so a client already
    // listening at boot is not left empty for up to a keepalive.
    broadcastAll(world);
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    world.sendTo(player.id, STRUCTURES_ALL_MESSAGE, allPayload());
  },

  persistence,
};

// ────────────────────────────────────────────────────────────────────────────
// Test seams
// ────────────────────────────────────────────────────────────────────────────

export function standingStructures(): StructureCell[] {
  return liveCells();
}

/** The live board's raw records (age AND tier), for suites asserting on the CA's own state. */
export function currentLive(): ReadonlyMap<number, LiveCellRecord> {
  return live;
}

export function currentGeneration(): number {
  return generation;
}

export function resetStructuresState(): void {
  live = new Map();
  generation = 0;
  survey = new GenerationSurvey();
  rng = createStructuresRng(STRUCTURES_RNG_DEFAULT_SEED);
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  scanCredit = 0;
  restoredLive = new Map();
  restoredGeneration = 0;
}
