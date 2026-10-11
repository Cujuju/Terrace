import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  MAX_HEIGHT,
  type ChunkPayload,
  type SculptIntent,
} from '@terrace/shared';
import { createTerrainMirror } from '../src/terrain/mirror.ts';
import { applySnapshot } from '../src/terrain/mirror.ts';
import {
  MAX_PENDING_PREDICTIONS,
  PREDICTION_TTL_MS,
  createPredictionStore,
  type PredictionStore,
} from '../src/terrain/prediction.ts';

const WORLD = CHUNK_SIZE * 4;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
const CENTRE = { x: 24, y: 24 };

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

function allChunks(fill = 0): ChunkPayload[] {
  const out: ChunkPayload[] = [];
  for (let cy = 0; cy < WORLD / CHUNK_SIZE; cy++) {
    for (let cx = 0; cx < WORLD / CHUNK_SIZE; cx++) out.push(chunkPayload(cx, cy, fill));
  }
  return out;
}

function createClient(chunks: ChunkPayload[] = allChunks()): {
  store: PredictionStore;
} {
  const mirror = createTerrainMirror(WORLD);
  const store = createPredictionStore(mirror);
  store.applyAuthoritative(
    (m) => applySnapshot(m, { type: 'snapshot', worldSize: WORLD, chunks }),
    0,
  );
  return { store };
}

function raise(seq?: number): SculptIntent {
  return { type: 'sculpt', x: CENTRE.x, y: CENTRE.y, radius: 3, dir: 1, ...(seq !== undefined ? { seq } : {}) };
}

describe('ghost seqs — sent strokes that predict no-ops', () => {
  it('ghost-marks a grabbed drag sweep into a chunk never received', () => {
    const { store } = createClient([chunkPayload(0, 0, 0)]);
    const intent: SculptIntent = {
      type: 'sculpt',
      x: CENTRE.x,
      y: CENTRE.y,
      radius: 2,
      dir: 1,
      tool: 'drag',
      targetBand: 4,
      // A drag carries the run's floor on the wire; without it the intent is
      // malformed and never reaches the ghost.
      floorBand: 4,
      seq: 7,
    };
    expect(store.predict(intent, 0).size).toBe(0);
    expect(store.pendingCount()).toBe(0);
    expect(store.ghostSeqs()).toEqual([7]);
  });

  it('ghost-marks a seq-carrying stroke the frontier makes unfaithful', () => {
    const { store } = createClient([chunkPayload(0, 0, 160)]);
    const intent: SculptIntent = {
      type: 'sculpt',
      x: CHUNK_SIZE - 1,
      y: 8,
      radius: 3,
      dir: 1,
      tool: 'smooth',
      profile: 'soft',
      seq: 9,
    };
    expect(store.predict(intent, 0).size).toBe(0);
    expect(store.pendingCount()).toBe(0);
    expect(store.ghostSeqs()).toEqual([9]);
  });

  it('ghost-marks a sent stroke into already-settled ground', () => {
    const { store } = createClient(allChunks(MAX_HEIGHT));
    expect(store.predict(raise(11), 0).size).toBe(0);
    expect(store.pendingCount()).toBe(0);
    expect(store.ghostSeqs()).toEqual([11]);
  });

  it('does not ghost seq-less probes', () => {
    const { store } = createClient([chunkPayload(0, 0, 0)]);
    store.predict({ ...raise(), seq: undefined }, 0);
    expect(store.ghostSeqs()).toEqual([]);
  });

  it('does not ghost a stroke that predicts', () => {
    const { store } = createClient();
    expect(store.predict(raise(13), 0).size).toBeGreaterThan(0);
    expect(store.pendingCount()).toBe(1);
    expect(store.ghostSeqs()).toEqual([]);
  });

  it('the denial fast path settles the ghost', () => {
    const { store } = createClient([chunkPayload(0, 0, 0)]);
    store.predict(raise(15), 0);
    expect(store.ghostSeqs()).toEqual([15]);
    expect(store.resolveSeq(15).size).toBe(0);
    expect(store.ghostSeqs()).toEqual([]);
  });

  it('ghosts expire with the ack window', () => {
    const { store } = createClient([chunkPayload(0, 0, 0)]);
    store.predict(raise(17), 0);
    expect(store.ghostSeqs()).toEqual([17]);
    store.expire(PREDICTION_TTL_MS - 1);
    expect(store.ghostSeqs()).toEqual([17]);
    store.expire(PREDICTION_TTL_MS);
    expect(store.ghostSeqs()).toEqual([]);
  });

  it('authoritative reconciliation prunes stale ghosts', () => {
    const { store } = createClient([chunkPayload(0, 0, 0)]);
    store.predict(raise(19), 0);
    store.applyAuthoritative(() => new Set<number>(), PREDICTION_TTL_MS);
    expect(store.ghostSeqs()).toEqual([]);
  });

  it('caps the ghost set like the pending set', () => {
    const { store } = createClient([chunkPayload(0, 0, 0)]);
    for (let seq = 1; seq <= MAX_PENDING_PREDICTIONS + 5; seq++) {
      store.predict(raise(seq), seq);
    }
    expect(store.ghostSeqs()).toHaveLength(MAX_PENDING_PREDICTIONS);
    expect(store.ghostSeqs()).not.toContain(1);
    expect(store.ghostSeqs()).toContain(MAX_PENDING_PREDICTIONS + 5);
  });
});
