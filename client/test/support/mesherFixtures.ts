import { CHUNK_SIZE, chunksPerEdge } from '@terrace/shared';
import {
  GOLDEN_WORLD_NAMES,
  buildGoldenWorld,
  type GoldenWorldName,
} from '../../../shared/test/fixtures/worlds.ts';
import { createDirectChunkBuildSource } from '../../src/render/chunkBuildSource.ts';
import { createTerrainMirror, type TerrainMirror } from '../../src/terrain/mirror.ts';

export { GOLDEN_WORLD_NAMES, type GoldenWorldName };

/** A fixture world as the renderer sees it: every chunk received, nothing fogged. */
export function fixtureMirror(name: GoldenWorldName): TerrainMirror {
  const map = buildGoldenWorld(name);
  const mirror = createTerrainMirror(map.size);
  mirror.map.cells.set(map.cells);
  for (const [index, packed] of map.columnSpans) {
    mirror.map.columnSpans.set(index, new Int16Array(packed));
  }
  const cols = chunksPerEdge(map.size);
  for (let idx = 0; idx < cols * cols; idx++) mirror.received.add(idx);
  return mirror;
}

export function fixtureChunkCount(mirror: TerrainMirror): number {
  const cols = chunksPerEdge(mirror.map.size);
  return cols * cols;
}

export interface ChunkVertexCount {
  readonly chunkIdx: number;
  readonly vertexCount: number;
}

/** The CPU mesher's answer for every chunk, in chunk order. */
export function cpuChunkVertexCounts(mirror: TerrainMirror): ChunkVertexCount[] {
  const source = createDirectChunkBuildSource();
  const out: ChunkVertexCount[] = [];
  for (let chunkIdx = 0; chunkIdx < fixtureChunkCount(mirror); chunkIdx++) {
    const answer = source.build(mirror, chunkIdx, 0);
    if (answer === null || answer instanceof Promise || answer.kind !== 'cpu') {
      throw new Error(`chunk ${String(chunkIdx)} did not build on the CPU`);
    }
    out.push({ chunkIdx, vertexCount: answer.vertexCount });
  }
  source.dispose();
  return out;
}

export const LATTICE_PER_CHUNK = CHUNK_SIZE + 1;
