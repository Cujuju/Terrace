import {
  chunkIndexOfCell,
  chunksPerEdge,
  chunkIndex,
  extractChunkPayload,
  isChunkUnlocked,
  type CellDiff,
  type ChunkPayload,
  type Heightmap,
} from '@terrace/shared';

export interface MaskedTerrain {
  readonly map: Heightmap;
  readonly mask: Uint8Array;
}

export function isCellUnlocked(terrain: MaskedTerrain, x: number, y: number): boolean {
  return isChunkUnlocked(terrain.mask, chunkIndexOfCell(terrain.map.size, x, y));
}

export function filterDiffToUnlocked(
  terrain: MaskedTerrain,
  diff: readonly CellDiff[],
): CellDiff[] {
  const visible: CellDiff[] = [];
  for (const cell of diff) {
    if (isCellUnlocked(terrain, cell.x, cell.y)) visible.push(cell);
  }
  return visible;
}

export interface ViewedTerrain {
  players(): readonly { readonly id: string }[];
  isCellVisibleTo(playerId: string, x: number, y: number): boolean;
}

export interface ViewerDiff {
  readonly playerId: string;
  readonly cells: CellDiff[];
}

export function partitionDiffByViewer(
  terrain: ViewedTerrain,
  diff: readonly CellDiff[],
): ViewerDiff[] {
  const shares: ViewerDiff[] = [];
  for (const player of terrain.players()) {
    const cells: CellDiff[] = [];
    for (const cell of diff) {
      if (terrain.isCellVisibleTo(player.id, cell.x, cell.y)) cells.push(cell);
    }
    if (cells.length > 0) shares.push({ playerId: player.id, cells });
  }
  return shares;
}

export function chunkPayloadOf(terrain: MaskedTerrain, cx: number, cy: number): ChunkPayload {
  return extractChunkPayload(terrain.map, cx, cy);
}

export function collectAllChunkPayloads(map: Heightmap): ChunkPayload[] {
  const edge = chunksPerEdge(map.size);
  const payloads: ChunkPayload[] = [];
  for (let cy = 0; cy < edge; cy++) {
    for (let cx = 0; cx < edge; cx++) payloads.push(extractChunkPayload(map, cx, cy));
  }
  return payloads;
}

export function collectUnlockedChunkPayloads(terrain: MaskedTerrain): ChunkPayload[] {
  const edge = chunksPerEdge(terrain.map.size);
  const payloads: ChunkPayload[] = [];
  for (let cy = 0; cy < edge; cy++) {
    for (let cx = 0; cx < edge; cx++) {
      if (!isChunkUnlocked(terrain.mask, chunkIndex(terrain.map.size, cx, cy))) continue;
      payloads.push(chunkPayloadOf(terrain, cx, cy));
    }
  }
  return payloads;
}
