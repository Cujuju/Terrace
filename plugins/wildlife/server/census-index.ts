// THE INCREMENTAL HABITAT CENSUS (issue #268).
//
// WHAT THIS REPLACES. `census.ts`'s `takeCensus` walks every cell of every
// unlocked chunk. That was written against a 512² world; on a 2048² world
// fully unlocked it is 16 384 chunks × 256 cells = 4 194 304 `heightAt` calls
// on ONE tick every 5 s — measured at 94.6 ms, ~95% of a 100 ms tick, and the
// unlock mask is a one-way ratchet so the cost only ever grows.
//
// WHY AN INDEX IS EXACT HERE. A chunk's habitat counts are a pure function of
// its 256 heights (`habitatOf` reads height and nothing else), and a height
// only ever changes through `World.applySculpt`, which reports the full
// cell-exact diff to every plugin via `onTerrainChanged` (host.ts's
// `notifyTerrainChanged`, the sole caller being sculpt-service.ts). So a
// cached count can only go stale in three ways, and all three are covered:
//
//   1. A SCULPT touched the chunk → `markCensusCellsDirty` from the plugin's
//      `onTerrainChanged`.
//   2. The chunk BECAME UNLOCKED → detected by the reconcile's own sweep over
//      `isChunkUnlocked`. It is not reported: `onChunkUnlockedForToken` fires
//      only for the per-token unlock, never for `WorldApi.unlockChunk`'s
//      world-wide one (plugins/types.ts:611-616, host.ts:426-428), and the
//      census counts the UNION mask, so polling the mask is the only seam that
//      sees every unlock. The sweep is O(chunks), not O(cells) — 16 384
//      `isChunkUnlocked` calls against 4.2 M `heightAt` calls.
//   3. The heights were replaced WITHOUT a diff — the one path that does this
//      is `World.rewindTo` (rollback), which is immediately followed by
//      `host.worldCreate()` (rollback.ts:175,204), so the plugin's
//      `onWorldCreate` calls `invalidateCensusIndex` and the next reconcile
//      rebuilds from scratch.
//
// RESIDUAL, stated rather than hidden: the index is keyed to a world only by
// its size (`ensureSizedFor`), because `HabitatWorld` carries no world
// identity to key on. Replacing the heights of a SAME-SIZED world without
// going through either lifecycle hook would therefore be read against stale
// counts. No server path does that — `closeSession` calls `closeWorld` and
// `openSession`/rollback call `worldCreate` (session.ts:281,220,
// rollback.ts:204), and both ends invalidate — but a caller driving these
// modules directly (a test rig) must call `invalidateCensusIndex` when it
// swaps worlds.
//
// EQUALITY IS THE ACCEPTANCE BAR, not "close enough": the census feeds
// population targets and the spawn-chunk pool, so a reconcile must return
// exactly what a full scan would. Two structural choices buy that rather than
// asserting it. Dirty chunks are re-counted WHOLE, by the same
// `countChunkHabitat` a full scan uses — never adjusted by a per-cell delta,
// which would be a second definition of habitat arithmetic to keep in step.
// And the world totals are summed FRESH from the per-chunk counts on every
// reconcile instead of being carried as running sums, so no add/subtract
// bookkeeping error can accumulate across reconciles; that sum is O(chunks)
// and rides along on the sweep that has to happen anyway.

import { CHUNK_SIZE } from '@terrace/shared';
import {
  HABITAT_CLASS_COUNT,
  HABITAT_CLASS_SLOT,
  countChunkHabitat,
  type Census,
  type HabitatWorld,
} from './census.ts';
import type { Habitat } from './species.ts';

/** One cell of a terrain diff — the shape `CellDiff` (plugins/types.ts) has. */
interface ChangedCell {
  readonly x: number;
  readonly y: number;
}

/**
 * Per-chunk habitat counts, `HABITAT_CLASS_COUNT` Int32s per chunk in
 * row-major chunk order. Only the slice of a chunk marked `counted` below is
 * meaningful.
 */
let counts: Int32Array | null = null;

/**
 * Whether chunk i's slice of `counts` is current: 1 only while the chunk is
 * unlocked, has been counted, and nothing has dirtied it since.
 */
let counted: Uint8Array | null = null;

/** Chunks whose heights moved since the last reconcile. */
const dirtyChunks = new Set<number>();

/**
 * What the unlock mask looked like at the last reconcile, so this one can spot
 * the chunks that have opened since (see reason 2 in the header — no hook
 * reports a world-wide unlock).
 */
let unlockedMirror: Uint8Array | null = null;

/**
 * The unlocked-chunk list handed out by the last reconcile, reused verbatim
 * while the mask has not moved.
 *
 * WHY CACHE IT. It is 16 384 two-element arrays on a fully unlocked world, and
 * rebuilding it per reconcile measured 1.8 ms — the whole remaining cost of
 * the reconcile, spent to produce a list identical to the last one. The mask
 * only changes when a chunk unlocks, which the sweep already detects.
 *
 * SAFE TO SHARE because `Census.chunks` is a `ReadonlyArray` of readonly
 * tuples and its one consumer (population.ts's spawn sampler) only indexes
 * into it. It is never handed out while stale: the sweep rebuilds it in the
 * same row-major order a full scan produces the moment any chunk flips.
 */
let unlockedChunkList: ReadonlyArray<readonly [number, number]> | null = null;

/** The world shape `counts`/`counted` were sized for — 0 when unsized. */
let indexedChunksPerEdge = 0;
let indexedWorldSize = 0;

/**
 * Drops the whole index, so the next reconcile rebuilds from the world as it
 * then is. Called on the plugin's world lifecycle hooks — see reason 3 in this
 * file's header for why `onWorldCreate` in particular is load-bearing.
 */
export function invalidateCensusIndex(): void {
  counts = null;
  counted = null;
  unlockedMirror = null;
  unlockedChunkList = null;
  dirtyChunks.clear();
  indexedChunksPerEdge = 0;
  indexedWorldSize = 0;
}

/**
 * Records that the given cells' heights changed, so the chunks holding them
 * are re-counted at the next reconcile.
 *
 * TAKES THE DIFF, NOT A BRUSH FOOTPRINT: the diff includes relaxation spill,
 * and spill can legitimately land in a chunk the brush never covered (see
 * `WorldApi.sculpt`'s contract) — and in a LOCKED one, which is why the
 * unlocked test is deferred to the reconcile rather than applied here.
 *
 * A no-op before the index exists: a fresh build counts every unlocked chunk
 * from the live world anyway.
 */
export function markCensusCellsDirty(cells: readonly ChangedCell[]): void {
  if (indexedChunksPerEdge === 0) return;

  for (const cell of cells) {
    const cx = Math.floor(cell.x / CHUNK_SIZE);
    const cy = Math.floor(cell.y / CHUNK_SIZE);
    // A diff cell is always inside the world, but this index is the wrong
    // place to learn otherwise: an out-of-range chunk would silently poison a
    // neighbour's counts through a wrapped index.
    if (cx < 0 || cy < 0 || cx >= indexedChunksPerEdge || cy >= indexedChunksPerEdge) continue;
    dirtyChunks.add(cy * indexedChunksPerEdge + cx);
  }
}

/** Sizes (or re-sizes) the arrays for `world`, dropping stale contents. */
function ensureSizedFor(world: HabitatWorld): void {
  if (
    counts !== null &&
    counted !== null &&
    unlockedMirror !== null &&
    indexedChunksPerEdge === world.chunksPerEdge &&
    indexedWorldSize === world.worldSize
  ) {
    return;
  }

  const chunkCount = world.chunksPerEdge * world.chunksPerEdge;
  counts = new Int32Array(chunkCount * HABITAT_CLASS_COUNT);
  counted = new Uint8Array(chunkCount);
  unlockedMirror = new Uint8Array(chunkCount);
  unlockedChunkList = null;
  dirtyChunks.clear();
  indexedChunksPerEdge = world.chunksPerEdge;
  indexedWorldSize = world.worldSize;
}

/**
 * The census, reconciled: identical to `takeCensus(world)` in both fields, at
 * a cost of one pass over the CHUNK grid plus a full re-count of only those
 * chunks that are newly unlocked or newly sculpted.
 *
 * The chunk list is rebuilt in the same row-major order the full scan
 * produces — the spawn sampler indexes into it, so the order is part of the
 * answer, not an implementation detail.
 */
export function reconcileCensus(world: HabitatWorld): Census {
  ensureSizedFor(world);
  const chunkCounts = counts as Int32Array;
  const chunkCounted = counted as Uint8Array;
  const mirror = unlockedMirror as Uint8Array;

  // Accumulated in locals rather than into the record directly: this is the
  // one loop that runs over every chunk on every reconcile, and three plain
  // numbers keep it out of property-lookup territory.
  let land = 0;
  let shallow = 0;
  let deep = 0;
  let maskMoved = unlockedChunkList === null;

  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      const chunk = cy * world.chunksPerEdge + cx;
      const isUnlocked = world.isChunkUnlocked(cx, cy);

      if (isUnlocked !== (mirror[chunk] === 1)) {
        mirror[chunk] = isUnlocked ? 1 : 0;
        maskMoved = true;
        // Unlock is a one-way ratchet today, so the false branch only fires
        // for a chunk that was never counted. Kept anyway: it costs one store,
        // and a world that ever gains a re-locking path must not inherit a
        // phantom count.
        if (!isUnlocked) chunkCounted[chunk] = 0;
      }

      if (!isUnlocked) continue;

      if (chunkCounted[chunk] === 0 || dirtyChunks.has(chunk)) {
        countChunkHabitat(world, cx, cy, chunkCounts, chunk * HABITAT_CLASS_COUNT);
        chunkCounted[chunk] = 1;
      }

      const base = chunk * HABITAT_CLASS_COUNT;
      land += chunkCounts[base + HABITAT_CLASS_SLOT.land];
      shallow += chunkCounts[base + HABITAT_CLASS_SLOT.shallow];
      deep += chunkCounts[base + HABITAT_CLASS_SLOT.deep];
    }
  }

  // Every dirty chunk has now been either re-counted or marked uncounted (the
  // re-lock branch above), so nothing is left owing.
  dirtyChunks.clear();

  if (maskMoved) unlockedChunkList = buildUnlockedChunkList(world.chunksPerEdge, mirror);

  const cellsByHabitat: Record<Habitat, number> = { land, shallow, deep };
  return { cellsByHabitat, chunks: unlockedChunkList as ReadonlyArray<readonly [number, number]> };
}

/**
 * The unlocked chunks in row-major order — the order a full scan produces, and
 * therefore part of the answer rather than an implementation detail: the spawn
 * sampler indexes into this list, so a different order is a different world to
 * spawn into.
 *
 * Read off the mirror rather than the world, so it costs no further
 * `isChunkUnlocked` calls and cannot disagree with the sweep that just ran.
 */
function buildUnlockedChunkList(
  chunksPerEdge: number,
  mirror: Uint8Array,
): ReadonlyArray<readonly [number, number]> {
  const chunks: Array<readonly [number, number]> = [];
  for (let cy = 0; cy < chunksPerEdge; cy++) {
    for (let cx = 0; cx < chunksPerEdge; cx++) {
      if (mirror[cy * chunksPerEdge + cx] === 1) chunks.push([cx, cy]);
    }
  }
  return chunks;
}
