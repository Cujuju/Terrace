import type { ChunkHeights } from '../chunks.ts';

export interface ChunkLayeredSpans {
  at: number[];
  runs: number[];
}

export interface ChunkPayload {
  cx: number;
  cy: number;
  heights: ChunkHeights;
  layered?: ChunkLayeredSpans;
}

export interface ChunkUnlockMessage {
  type: 'chunkUnlock';
  chunks: ChunkPayload[];
}

export interface JoinSnapshotMessage {
  type: 'snapshot';
  worldSize: number;
  chunks: ChunkPayload[];
  worldName?: string;
  difficulty?: number;
  serverVersion?: string;
  buildIdentity?: string;
  livePlugins?: readonly string[];
  worldGeneration?: number;
}
