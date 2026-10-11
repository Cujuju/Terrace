import { CHUNK_SIZE } from '@terrace/shared';
import { WILDLIFE_HABITAT_SPECIES } from '../protocol.ts';
import {
  CENSUS_SLOT_COUNT,
  emptySpeciesCounts,
  countChunkHabitat,
  type Census,
  type HabitatWorld,
} from './census.ts';

interface ChangedCell {
  readonly x: number;
  readonly y: number;
}

let counts: Int32Array | null = null;

let counted: Uint8Array | null = null;

const dirtyChunks = new Set<number>();

let unlockedMirror: Uint8Array | null = null;

let unlockedChunkList: ReadonlyArray<readonly [number, number]> | null = null;

let indexedChunksPerEdge = 0;
let indexedWorldSize = 0;

export function invalidateCensusIndex(): void {
  counts = null;
  counted = null;
  unlockedMirror = null;
  unlockedChunkList = null;
  dirtyChunks.clear();
  indexedChunksPerEdge = 0;
  indexedWorldSize = 0;
}

export function markCensusCellsDirty(cells: readonly ChangedCell[]): void {
  if (indexedChunksPerEdge === 0) return;

  for (const cell of cells) {
    const cx = Math.floor(cell.x / CHUNK_SIZE);
    const cy = Math.floor(cell.y / CHUNK_SIZE);
    if (cx < 0 || cy < 0 || cx >= indexedChunksPerEdge || cy >= indexedChunksPerEdge) continue;
    dirtyChunks.add(cy * indexedChunksPerEdge + cx);
  }
}

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
  counts = new Int32Array(chunkCount * CENSUS_SLOT_COUNT);
  counted = new Uint8Array(chunkCount);
  unlockedMirror = new Uint8Array(chunkCount);
  unlockedChunkList = null;
  dirtyChunks.clear();
  indexedChunksPerEdge = world.chunksPerEdge;
  indexedWorldSize = world.worldSize;
}

export function reconcileCensus(world: HabitatWorld): Census {
  ensureSizedFor(world);
  const chunkCounts = counts as Int32Array;
  const chunkCounted = counted as Uint8Array;
  const mirror = unlockedMirror as Uint8Array;

  const cellsBySpecies = emptySpeciesCounts();
  let maskMoved = unlockedChunkList === null;

  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      const chunk = cy * world.chunksPerEdge + cx;
      const isUnlocked = world.isChunkUnlocked(cx, cy);

      if (isUnlocked !== (mirror[chunk] === 1)) {
        mirror[chunk] = isUnlocked ? 1 : 0;
        maskMoved = true;
        if (!isUnlocked) chunkCounted[chunk] = 0;
      }

      if (!isUnlocked) continue;

      if (chunkCounted[chunk] === 0 || dirtyChunks.has(chunk)) {
        countChunkHabitat(world, cx, cy, chunkCounts, chunk * CENSUS_SLOT_COUNT);
        chunkCounted[chunk] = 1;
      }

      const base = chunk * CENSUS_SLOT_COUNT;
      for (let slot = 0; slot < CENSUS_SLOT_COUNT; slot++) {
        cellsBySpecies[WILDLIFE_HABITAT_SPECIES[slot]!] += chunkCounts[base + slot]!;
      }
    }
  }

  dirtyChunks.clear();

  if (maskMoved) unlockedChunkList = buildUnlockedChunkList(world.chunksPerEdge, mirror);

  return { cellsBySpecies, chunks: unlockedChunkList as ReadonlyArray<readonly [number, number]> };
}

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
