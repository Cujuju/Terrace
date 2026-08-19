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
//
// FOG OF WAR (added issue #18). Every send — the CA's own delta, the join
// snapshot, the keepalive — is now per RECIPIENT: a player is sent only the
// structures inside chunks they have personally unlocked (WorldApi.
// broadcastVisible), and a recipient whose own subset is empty is sent
// nothing at all rather than an empty message (STRUCTURES_SKIP_EMPTY is safe
// for the same reason flora's identical flag is — see its doc comment). The
// one gap a 60 s keepalive cannot close fast enough — a player creeping into
// a chunk that already has buildings standing in it — gets its own targeted
// push instead of waiting: see onChunkUnlockedForToken / refreshUnlockedChunk
// below, flora's identical mechanism applied to this plugin's own wire shape.
// ─────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE, type CellDiff } from '@terrace/shared';
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
import { isBuildableCell as isBuildableCellDev } from './suitability.ts';
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

/** TEMPORARY VERIFICATION SEED — reverted before commit. */
let devSeeded = false;

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

/** A structure cell's own position — what `WorldApi.broadcastVisible` gates visibility by. */
function structurePosition(cell: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return { x: cell.x, y: cell.y };
}

/**
 * FOG OF WAR (issue #18). Every broadcastVisible call this plugin makes
 * passes `skipEmpty: true` — safe for the identical reason flora's own
 * FLORA_SKIP_EMPTY is: per-player masks only ever GROW (issue #17), so a
 * structure invisible to a player right now was equally invisible to them
 * whenever it last changed. See WorldApi.broadcastVisible's doc comment for
 * the general rule.
 */
const STRUCTURES_SKIP_EMPTY = { skipEmpty: true } as const;

function broadcastAll(world: WorldApi): void {
  world.broadcastVisible(
    STRUCTURES_ALL_MESSAGE,
    liveCells(),
    structurePosition,
    (visible) => ({ structures: packStructureCells(visible) }),
    STRUCTURES_SKIP_EMPTY,
  );
  lastKeepaliveSeconds = simSeconds;
}

/** One cell tagged with which of `structures:changes`' three lists it belongs to. */
interface TaggedStructureChange {
  readonly kind: 'founded' | 'upgraded' | 'demolished';
  readonly x: number;
  readonly y: number;
  /** Only meaningful for founded/upgraded; demolished carries no tier on the wire. */
  readonly tier: number;
}

/**
 * Sends one delta. Silent when nothing changed anywhere — the common case by
 * far between generations. Per RECIPIENT, silence is more common still:
 * broadcastVisible additionally skips any player whose own subset of THIS
 * delta is empty (STRUCTURES_SKIP_EMPTY) — the ordinary case for a change
 * happening in someone else's territory.
 */
function broadcastChanges(
  world: WorldApi,
  founded: readonly StructureCell[],
  upgraded: readonly StructureCell[],
  demolished: ReadonlyArray<{ x: number; y: number }>,
): void {
  if (founded.length === 0 && upgraded.length === 0 && demolished.length === 0) return;

  const tagged: TaggedStructureChange[] = [
    ...founded.map((c): TaggedStructureChange => ({ kind: 'founded', x: c.x, y: c.y, tier: c.tier })),
    ...upgraded.map((c): TaggedStructureChange => ({ kind: 'upgraded', x: c.x, y: c.y, tier: c.tier })),
    ...demolished.map((c): TaggedStructureChange => ({ kind: 'demolished', x: c.x, y: c.y, tier: 0 })),
  ];
  world.broadcastVisible(
    STRUCTURES_CHANGES_MESSAGE,
    tagged,
    structurePosition,
    (visible) => ({
      founded: packStructureCells(visible.filter((c) => c.kind === 'founded')),
      upgraded: packStructureCells(visible.filter((c) => c.kind === 'upgraded')),
      demolished: packCells(visible.filter((c) => c.kind === 'demolished')),
    }),
    STRUCTURES_SKIP_EMPTY,
  );
}

/**
 * THE TARGETED-REFRESH PATH (issue #18) — flora's identical mechanism
 * (server/index.ts's refreshUnlockedChunk), for the same reason: the 60 s
 * keepalive is a REPAIR cadence, far too slow for "a player just earned a
 * chunk that already has buildings in it" to feel instant. Fired once per
 * successful per-token unlock. Sent as a `founded` DELTA, not a
 * `structures:all` snapshot — the client's ALL-message handler REPLACES its
 * whole board (see ../client/index.ts), which would wipe out every other
 * chunk this player already knows about, whereas `founded` is additive.
 */
function refreshUnlockedChunk(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: StructureCell[] = [];
  for (const cell of liveCells()) {
    if (cell.x >= x0 && cell.x < x0 + CHUNK_SIZE && cell.y >= y0 && cell.y < y0 + CHUNK_SIZE) {
      inChunk.push(cell);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { founded: packStructureCells(inChunk), upgraded: [], demolished: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, STRUCTURES_CHANGES_MESSAGE, payload);
  }
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

    // TEMPORARY VERIFICATION SEED — reverted before commit. Plants a lattice
    // of structures across every buildable cell so all six tiers stand at
    // once, instead of waiting ~4 simulated minutes on the CA.
    // No players are connected yet — this is only so a client already
    // listening at boot is not left empty for up to a keepalive.
    broadcastAll(world);
  },

  onTick(world: WorldApi, dt: number): void {
    // TEMPORARY VERIFICATION SEED — reverted before commit. Plants a lattice
    // of structures across every buildable cell so all six tiers stand at
    // once, instead of waiting ~4 simulated minutes on the CA.
    if (process.env.STRUCTURES_DEV_SEED === '1' && !devSeeded) {
      devSeeded = true;
      // A fresh world is entirely below sea level, so raise a LUMPY island
      // first: a broad dome for the land, then dozens of small overlapping
      // raises so the terraced renderer cuts many band steps through it — the
      // point of the verification world is buildings standing NEXT TO terrace
      // edges, which a single smooth dome never produces.
      const dome = (limit: number, amount: number, step: number, radius: number): void => {
        for (let y = 6; y < 74; y += step) {
          for (let x = 6; x < 74; x += step) {
            if (Math.hypot(x - 40, y - 40) > limit) continue;
            world.sculpt(x, y, radius, amount);
          }
        }
      };
      dome(32, 260, 3, 4); // lift the whole island clear of the sea
      dome(32, 200, 3, 4);
      dome(24, 150, 3, 4); // second terrace
      dome(14, 150, 3, 4); // third terrace
      // Lumps: small raises on a coprime-stride lattice, amounts cycling
      // through a spread of band fractions so steps land at many heights.
      for (let i = 0; i < 260; i++) {
        const x = 8 + ((i * 17) % 64);
        const y = 8 + ((i * 29) % 64);
        world.sculpt(x, y, 2 + (i % 3), 40 + (i % 7) * 30);
      }
      let n = 0;
      // A DENSE core first — adjacent cells, the shape a Game-of-Life
      // settlement actually makes — so neighbouring buildings are seen
      // shoulder to shoulder, then a sparser lattice over the rest of the
      // island for isolated-building and terrace-edge cases.
      for (let y = 30; y < 46; y++) {
        for (let x = 30; x < 46; x++) {
          if (!isBuildableCellDev(world, x, y)) continue;
          live.set(structureKey(x, y), { age: 99, tier: n % 6 });
          n++;
        }
      }
      for (let y = 0; y < world.worldSize; y += 2) {
        for (let x = 0; x < world.worldSize; x += 2) {
          if (n >= 500) break;
          if (live.has(structureKey(x, y))) continue;
          if (!isBuildableCellDev(world, x, y)) continue;
          live.set(structureKey(x, y), { age: 99, tier: n % 6 });
          n++;
        }
      }
      console.log('DEV SEED planted', n, 'structures');
      broadcastAll(world);
      return;
    }
    if (process.env.STRUCTURES_DEV_SEED === '1') return; // freeze the CA so the seed stays put
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // TEMPORARY VERIFICATION SEED — reverted before commit. Unlocks the whole
    // board for this player so the seeded lattice is actually visible; the
    // per-chunk unlock hook broadcasts each chunk's structures on its own.
    if (process.env.STRUCTURES_DEV_SEED === '1') {
      const chunks = Math.ceil(world.worldSize / CHUNK_SIZE);
      let granted = 0;
      for (let cy = 0; cy < chunks; cy++) {
        for (let cx = 0; cx < chunks; cx++) if (world.unlockChunkForToken(player.token, cx, cy)) granted++;
      }
      console.log('DEV SEED join: chunks', chunks, 'granted', granted, 'live', live.size);
    }
    // FOG OF WAR (issue #18): filtered to the structures inside THIS player's
    // own unlocked view (onlyPlayerId), same skipEmpty rule as every other
    // send in this plugin — a player who has just joined and unlocked
    // nothing of their own yet is sent nothing, which is exactly what their
    // client already renders by default.
    world.broadcastVisible(
      STRUCTURES_ALL_MESSAGE,
      liveCells(),
      structurePosition,
      (visible) => ({ structures: packStructureCells(visible) }),
      { ...STRUCTURES_SKIP_EMPTY, onlyPlayerId: player.id },
    );
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
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
