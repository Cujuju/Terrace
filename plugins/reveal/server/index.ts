// reveal — the flagship example plugin (design §3.5, MVP criterion 5).
//
// Core knows about the unlocked-chunk mask and streams a chunk the moment its
// bit flips (World.unlockChunk). Core does NOT know *when* territory should
// unlock — that policy lives here, in a plugin, and nothing in server/src had to
// change to make this file work.
//
// ────────────────────────────────────────────────────────────────────────────
// THE POLICY: frontier pressure.
//
//   Sculpting near the edge of your territory physically reshapes the locked
//   land behind it. Once a locked chunk has been reshaped as many times as it
//   has cells, it stops being unknown territory and unlocks.
//
// Mechanically: every applied edit hands this plugin the FULL server-side diff
// (sculpt-service.ts deliberately gives plugins the unfiltered diff, mask and
// all). Neither the brush footprint nor the gradient-limit relaxation that
// follows it stops at a chunk border, so a sculpt near the frontier — and ONLY
// a sculpt near the frontier — produces changed cells inside a locked chunk.
// Each such cell is one unit of "pressure" on that chunk; at
// FRONTIER_PRESSURE_CELLS_PER_UNLOCK the chunk unlocks and streams to every
// client. Measured with the shipped brush: 8 radius-4 sculpts on the border
// column of a chunk unlock its locked neighbour.
//
// Why this policy rather than, say, "count sculpt intents near a border":
//
//   * It is a property of the terrain, not of the message stream, so it cannot
//     be farmed by spamming intents that change nothing (a sculpt that hits the
//     height clamp produces an empty diff and therefore no pressure).
//   * It needs no player identity and no post-apply intent hook, so it observes
//     only what actually happened — an intent denied by another plugin (mana,
//     for instance) never reaches the terrain and therefore never counts.
//   * It is directional and legible in-game: the land you are already pushing
//     into is the land that opens next. Sculpting in the middle of your
//     territory reveals nothing.
//   * It is monotone and deterministic: same edits in the same order → same
//     unlocks, on any machine, on a restored world as much as a fresh one.
// ────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE, chunkIndex, type CellDiff } from '@terrace/shared';
// Type-only import of the plugin contract. It reaches into server/src because
// core publishes no plugin-API entry point yet (see the report accompanying
// this Phase 2 work); `import type` is fully erased, so nothing here depends on
// server code at runtime.
import type { PersistenceSlice, TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';

/**
 * Cell-changes a locked chunk must absorb before it unlocks. One chunk's worth
 * of cells (CHUNK_SIZE² = 256): the frontier chunk has, in aggregate, been
 * reworked as thoroughly as if every one of its cells had been sculpted once.
 *
 * Expressed in terms of CHUNK_SIZE rather than as a bare number so the policy
 * keeps its meaning if chunk granularity is ever retuned (design open question
 * 5). With the shipped brush (radius ≤ 4, one band per click) a border sculpt
 * spills 19–64 cells into the neighbouring chunk — growing as the frontier hill
 * gets taller and its relaxation reaches further — so this is 8 deliberate
 * edits at the frontier: long enough to be earned, short enough that a
 * self-hoster sees it happen in their first session.
 */
export const FRONTIER_PRESSURE_CELLS_PER_UNLOCK = CHUNK_SIZE * CHUNK_SIZE;

/** Schema version of this plugin's persistence slice. */
export const REVEAL_SLICE_VERSION = 1;

/** Persisted shape. Pressure is a sparse list of [chunkIndex, cellChanges]. */
interface RevealSlice {
  readonly version: number;
  readonly pressure: ReadonlyArray<readonly [number, number]>;
}

/**
 * The WorldApi, captured at onWorldCreate.
 *
 * Only onWorldCreate/onTick/onIntent are handed a WorldApi; onTerrainChanged is
 * not, so a plugin that reacts to terrain has no choice but to stash it. See
 * the API-gap notes in the Phase 2 report.
 */
let api: WorldApi | null = null;

/** Accumulated pressure per LOCKED chunk, keyed by flat chunk index. */
const pressureByChunk = new Map<number, number>();

/**
 * Accrues pressure for one applied edit and unlocks whatever crosses the
 * threshold.
 *
 * Cells in already-unlocked chunks are skipped: pressure only ever describes
 * land the players cannot see yet. A chunk that unlocks is removed from the map
 * rather than left at its final count, so the bookkeeping stays proportional to
 * the size of the live frontier, not to the size of the world.
 */
function accruePressure(diff: readonly CellDiff[]): void {
  if (api === null) return;
  const worldSize = api.worldSize;

  for (const cell of diff) {
    const cx = Math.floor(cell.x / CHUNK_SIZE);
    const cy = Math.floor(cell.y / CHUNK_SIZE);
    if (api.isChunkUnlocked(cx, cy)) continue;

    // Diff cells always come from the authoritative heightmap, so they are in
    // bounds and chunkIndex cannot throw here.
    const index = chunkIndex(worldSize, cx, cy);
    const pressure = (pressureByChunk.get(index) ?? 0) + 1;

    if (pressure < FRONTIER_PRESSURE_CELLS_PER_UNLOCK) {
      pressureByChunk.set(index, pressure);
      continue;
    }

    // Threshold crossed. Core flips the mask bit and streams the chunk's
    // heights to every client in one step, so "the chunk is unlocked" and
    // "clients know about it" cannot drift apart. Later cells of this same diff
    // now see an unlocked chunk and are skipped by the check above.
    pressureByChunk.delete(index);
    api.unlockChunk(cx, cy);
  }
}

/**
 * Reads back a persisted slice defensively. The data comes from this server's
 * own SQLite file, but a truncated or hand-edited row must degrade to "no
 * pressure recorded" rather than crash a world on boot — the world itself is
 * still perfectly playable with an empty frontier map.
 */
function loadSlice(data: unknown): void {
  pressureByChunk.clear();
  if (typeof data !== 'object' || data === null) return;

  const slice = data as Partial<RevealSlice>;
  if (slice.version !== REVEAL_SLICE_VERSION) return;
  if (!Array.isArray(slice.pressure)) return;

  for (const entry of slice.pressure) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [index, pressure] = entry as [unknown, unknown];
    if (!Number.isInteger(index) || (index as number) < 0) continue;
    if (!Number.isInteger(pressure) || (pressure as number) <= 0) continue;
    if ((pressure as number) >= FRONTIER_PRESSURE_CELLS_PER_UNLOCK) continue;
    pressureByChunk.set(index as number, pressure as number);
  }
}

const persistence: PersistenceSlice = {
  save(): RevealSlice {
    return { version: REVEAL_SLICE_VERSION, pressure: Array.from(pressureByChunk) };
  },
  load(data: unknown): void {
    loadSlice(data);
  },
};

export const plugin: TerracePlugin = {
  name: 'reveal',

  onWorldCreate(world: WorldApi): void {
    api = world;
  },

  onTerrainChanged(diff: readonly CellDiff[]): void {
    accruePressure(diff);
  },

  persistence,
};

/** Test seam: current pressure on a chunk (0 when none has been recorded). */
export function frontierPressureAt(chunkIdx: number): number {
  return pressureByChunk.get(chunkIdx) ?? 0;
}

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetRevealState(): void {
  api = null;
  pressureByChunk.clear();
}
