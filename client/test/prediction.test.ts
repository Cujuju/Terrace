// Prediction / reconciliation tests.
//
// The headline test is `no visible snap`: a simulated server runs the shared
// math authoritatively, the client predicts the same intent, and after
// reconciliation the client's rendered heightmap must equal the server's map
// CELL FOR CELL — that is MVP criterion 2 expressed as an assertion.

import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  MAX_HEIGHT,
  applySculpt,
  chunkIndex,
  createHeightmap,
  heightAt,
  sculptOptionsOf,
  type CellDiff,
  type ChunkPayload,
  type Heightmap,
  type SculptIntent,
  type TerrainDiffMessage,
} from '@terrace/shared';
import {
  applySnapshot,
  applyTerrainDiff,
  createTerrainMirror,
} from '../src/terrain/mirror.ts';
import {
  MAX_PENDING_PREDICTIONS,
  PREDICTION_TTL_MS,
  createPredictionStore,
  type PredictionStore,
} from '../src/terrain/prediction.ts';

/** 64 cells = 4×4 chunks — same fixture size as the mirror tests. */
const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
/** Cell well inside chunk (1,1), so a radius-4 brush stays off the world edge. */
const CENTRE = { x: 24, y: 24 };

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

/** Every chunk of the fixture world, i.e. "nothing is locked". */
function allChunks(fill = 0): ChunkPayload[] {
  const out: ChunkPayload[] = [];
  for (let cy = 0; cy < WORLD / CHUNK_SIZE; cy++) {
    for (let cx = 0; cx < WORLD / CHUNK_SIZE; cx++) out.push(chunkPayload(cx, cy, fill));
  }
  return out;
}

/** Client under test: mirror + store, seeded with a fully unlocked snapshot. */
function createClient(chunks: ChunkPayload[] = allChunks()): {
  mirror: ReturnType<typeof createTerrainMirror>;
  store: PredictionStore;
} {
  const mirror = createTerrainMirror(WORLD);
  const store = createPredictionStore(mirror);
  store.applyAuthoritative(
    (m) => applySnapshot(m, { type: 'snapshot', worldSize: WORLD, chunks }),
    0,
  );
  return { mirror, store };
}

/**
 * The authoritative side: the same math the server's sculpt service runs, with
 * the same normalisation the server's intent pipeline applies first — an intent
 * that named no tool/profile means whatever `sculptOptionsOf` says it means,
 * on BOTH sides. Defaulting differently here would make these tests pass while
 * the real client and server disagreed.
 */
function serverSculpt(map: Heightmap, intent: SculptIntent): TerrainDiffMessage {
  const cells: CellDiff[] = applySculpt(
    map,
    intent.x,
    intent.y,
    intent.radius,
    DEFAULT_SCULPT_AMOUNT * intent.dir,
    sculptOptionsOf(intent),
  );
  return { type: 'terrainDiff', cells };
}

function raise(x = CENTRE.x, y = CENTRE.y, radius = 3): SculptIntent {
  return { type: 'sculpt', x, y, radius, dir: 1 };
}

describe('predict', () => {
  it('applies the shared sculpt math immediately and leaves the base untouched', () => {
    const { mirror, store } = createClient();

    const intent = raise();
    const expected = createHeightmap(WORLD);
    applySculpt(
      expected,
      CENTRE.x,
      CENTRE.y,
      3,
      DEFAULT_SCULPT_AMOUNT,
      sculptOptionsOf(intent),
    );

    const dirty = store.predict(intent, 0);

    expect(store.pendingCount()).toBe(1);
    expect(mirror.map.cells).toEqual(expected.cells);
    // Rendered is ahead; the authoritative copy still says sea level.
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(store.authoritativeHeightAt(CENTRE.x, CENTRE.y)).toBe(0);
    expect(dirty.has(chunkIndex(WORLD, 1, 1))).toBe(true);
  });

  it('ignores an intent whose brush centre is in a chunk we never received', () => {
    // Only chunk (0,0) unlocked; (1,1) is locked, exactly as the server sees it.
    const { mirror, store } = createClient([chunkPayload(0, 0, 0)]);

    const dirty = store.predict(raise(), 0);

    expect(store.pendingCount()).toBe(0);
    expect(dirty.size).toBe(0);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(0);
  });

  it('ignores a structurally invalid intent instead of throwing', () => {
    const { store } = createClient();
    expect(store.predict({ ...raise(), x: WORLD + 5 }, 0).size).toBe(0);
    expect(store.predict({ ...raise(), radius: 99 }, 0).size).toBe(0);
    expect(store.pendingCount()).toBe(0);
  });

  it('does not keep a prediction that changed nothing', () => {
    // A world already at MAX_HEIGHT: raising clamps to a no-op, so there is
    // nothing to show and nothing an authoritative diff could ever confirm.
    const { store } = createClient(allChunks(MAX_HEIGHT));
    expect(store.predict(raise(), 0).size).toBe(0);
    expect(store.pendingCount()).toBe(0);
  });

  it('drops the oldest prediction once the in-flight cap is reached', () => {
    const { store } = createClient();
    for (let i = 0; i <= MAX_PENDING_PREDICTIONS; i++) store.predict(raise(), i);
    expect(store.pendingCount()).toBe(MAX_PENDING_PREDICTIONS);
  });
});

describe('reconciliation', () => {
  it('retires the prediction with no visible change when the server agrees', () => {
    const { mirror, store } = createClient();
    const server = createHeightmap(WORLD);

    const intent = raise();
    store.predict(intent, 0);
    const predicted = Int16Array.from(mirror.map.cells);

    // The server applies the same intent to the same starting state, and the
    // client takes the resulting diff through the production path.
    const diff = serverSculpt(server, intent);
    store.applyAuthoritative((m) => applyTerrainDiff(m, diff), 10);

    expect(store.pendingCount()).toBe(0);
    // NO SNAP: the rendered map is bit-identical before and after the
    // authoritative diff landed, and equal to the server's own map.
    expect(mirror.map.cells).toEqual(predicted);
    expect(mirror.map.cells).toEqual(server.cells);
    expect(store.authoritativeHeightAt(CENTRE.x, CENTRE.y)).toBe(
      heightAt(server, CENTRE.x, CENTRE.y),
    );
  });

  it('retires stacked predictions one diff at a time without disturbing the rest', () => {
    const { mirror, store } = createClient();
    const server = createHeightmap(WORLD);

    const intent = raise();
    store.predict(intent, 0);
    store.predict(intent, 1);
    const predictedBoth = Int16Array.from(mirror.map.cells);

    // First diff: only the first of the two intents has been applied server-side.
    const first = serverSculpt(server, intent);
    store.applyAuthoritative((m) => applyTerrainDiff(m, first), 10);

    expect(store.pendingCount()).toBe(1);
    // The second prediction is still shown, replayed on top of the new base —
    // and because the base now matches what it was predicted against, the
    // result is unchanged from before reconciliation.
    expect(mirror.map.cells).toEqual(predictedBoth);

    const second = serverSculpt(server, intent);
    store.applyAuthoritative((m) => applyTerrainDiff(m, second), 20);

    expect(store.pendingCount()).toBe(0);
    expect(mirror.map.cells).toEqual(server.cells);
  });

  it('keeps predicting while an unrelated player edits elsewhere', () => {
    const { mirror, store } = createClient();

    store.predict(raise(), 0);
    const predicted = heightAt(mirror.map, CENTRE.x, CENTRE.y);

    // A remote diff far away must neither confirm nor disturb our prediction.
    const remote: TerrainDiffMessage = {
      type: 'terrainDiff',
      cells: [{ x: 2, y: 2, h: 500 }],
    };
    store.applyAuthoritative((m) => applyTerrainDiff(m, remote), 10);

    expect(store.pendingCount()).toBe(1);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(predicted);
    expect(heightAt(mirror.map, 2, 2)).toBe(500);
    expect(store.authoritativeHeightAt(2, 2)).toBe(500);
  });

  it('does not confirm a prediction the server has not corroborated', () => {
    // Chunk (0,0) only, brush in its corner: the relaxation cascade spills into
    // locked territory this client predicts as sea level while the server knows
    // the real heights. Confirmation is all-or-nothing over the cells the
    // server is allowed to send, so the prediction stays applied until its
    // deadline rather than being retired on partial evidence.
    const { store } = createClient([chunkPayload(0, 0, 0)]);
    store.predict(raise(1, 1, 4), 0);
    expect(store.pendingCount()).toBe(1);

    // An authoritative message that says nothing about those cells is not an
    // acknowledgement.
    store.applyAuthoritative(() => new Set<number>(), 10);
    expect(store.pendingCount()).toBe(1);
  });
});

describe('brush tools and edge profiles (decision 2026-08-14)', () => {
  /**
   * The `no visible snap` assertion, once per tool/profile combination and once
   * for an intent that names NEITHER. Radius 1 is the case that actually
   * separates the tools: a 64-unit spike exceeds MAX_STEP, so the smooth tool
   * relaxes it outward and the stamp tool does not. If the client and the
   * server ever normalised absent fields differently, the last case here would
   * be a mountain on one side and a spire on the other.
   */
  const combinations: Array<{ name: string; intent: SculptIntent }> = [
    { name: 'stamp + soft', intent: { ...raise(CENTRE.x, CENTRE.y, 1), tool: 'stamp', profile: 'soft' } },
    { name: 'stamp + hard', intent: { ...raise(CENTRE.x, CENTRE.y, 4), tool: 'stamp', profile: 'hard' } },
    { name: 'smooth + soft', intent: { ...raise(CENTRE.x, CENTRE.y, 1), tool: 'smooth', profile: 'soft' } },
    { name: 'smooth + hard', intent: { ...raise(CENTRE.x, CENTRE.y, 4), tool: 'smooth', profile: 'hard' } },
    { name: 'neither field named (wire default)', intent: raise(CENTRE.x, CENTRE.y, 1) },
  ];

  for (const { name, intent } of combinations) {
    it(`predicts ${name} cell-for-cell identically to the server`, () => {
      const { mirror, store } = createClient();
      const server = createHeightmap(WORLD);

      store.predict(intent, 0);
      const predicted = Int16Array.from(mirror.map.cells);

      const diff = serverSculpt(server, intent);
      store.applyAuthoritative((m) => applyTerrainDiff(m, diff), 10);

      // Retired by value: the prediction and the authoritative result agree.
      expect(store.pendingCount()).toBe(0);
      expect(mirror.map.cells).toEqual(predicted);
      expect(mirror.map.cells).toEqual(server.cells);
    });
  }

  it('predicts a stamp as a spire: the neighbours never move', () => {
    const { mirror, store } = createClient();

    store.predict({ ...raise(CENTRE.x, CENTRE.y, 1), tool: 'stamp' }, 0);

    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(mirror.map, CENTRE.x + 1, CENTRE.y)).toBe(0);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y + 1)).toBe(0);
  });

  it('predicts the smooth tool as the old fabric pull', () => {
    const { mirror, store } = createClient();

    store.predict({ ...raise(CENTRE.x, CENTRE.y, 1), tool: 'smooth' }, 0);

    // 64 > MAX_STEP, so relaxation must have pushed height outward.
    expect(heightAt(mirror.map, CENTRE.x + 1, CENTRE.y)).toBeGreaterThan(0);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBeLessThan(DEFAULT_SCULPT_AMOUNT);
  });

  it('does not predict an intent whose tool or profile it does not recognise', () => {
    // Same validator as the server: an unknown value fails the whole intent,
    // so the client must not paint an edit the server is about to drop.
    const { store } = createClient();
    expect(store.predict({ ...raise(), tool: 'chisel' } as unknown as SculptIntent, 0).size).toBe(0);
    expect(store.predict({ ...raise(), profile: 'medium' } as unknown as SculptIntent, 0).size).toBe(0);
    expect(store.pendingCount()).toBe(0);
  });
});

describe('expiry', () => {
  it('rolls an unacknowledged prediction back to authoritative truth', () => {
    const { mirror, store } = createClient();

    store.predict(raise(), 0);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(store.nextExpiryAtMs()).toBe(PREDICTION_TTL_MS);

    const dirty = store.expire(PREDICTION_TTL_MS);

    expect(store.pendingCount()).toBe(0);
    expect(store.nextExpiryAtMs()).toBeNull();
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(0);
    expect(mirror.map.cells).toEqual(createHeightmap(WORLD).cells);
    expect(dirty.has(chunkIndex(WORLD, 1, 1))).toBe(true);
  });

  it('expires only what is past the deadline', () => {
    const { mirror, store } = createClient();

    store.predict(raise(), 0);
    store.predict(raise(40, 40, 2), PREDICTION_TTL_MS / 2);
    store.expire(PREDICTION_TTL_MS);

    expect(store.pendingCount()).toBe(1);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(0);
    expect(heightAt(mirror.map, 40, 40)).toBe(DEFAULT_SCULPT_AMOUNT);
  });

  it('drops a stale prediction on the next authoritative message too', () => {
    const { mirror, store } = createClient();

    store.predict(raise(), 0);
    store.applyAuthoritative(() => new Set<number>(), PREDICTION_TTL_MS);

    expect(store.pendingCount()).toBe(0);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(0);
  });
});

describe('authoritative state seeding', () => {
  it('takes chunks streamed in mid-session into the authoritative copy', () => {
    const { mirror, store } = createClient([chunkPayload(0, 0, 0)]);

    store.predict(raise(4, 4, 2), 0);
    const predictedCentre = heightAt(mirror.map, 4, 4);

    store.applyAuthoritative(
      (m) =>
        applySnapshot(m, {
          type: 'snapshot',
          worldSize: WORLD,
          chunks: [chunkPayload(1, 1, 256)],
        }),
      1,
    );

    // The newly revealed chunk is authoritative, and the prediction elsewhere
    // survived the round trip untouched.
    expect(store.authoritativeHeightAt(CENTRE.x, CENTRE.y)).toBe(256);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(256);
    expect(heightAt(mirror.map, 4, 4)).toBe(predictedCentre);
    expect(store.pendingCount()).toBe(1);
  });
});

describe('rejectSeq — the sculptDenied fast path', () => {
  it('rolls back exactly the nacked prediction and keeps the others', () => {
    const { mirror, store } = createClient();

    store.predict({ ...raise(), seq: 1 }, 0);
    store.predict({ ...raise(CENTRE.x + 8), seq: 2 }, 0);
    const deniedHeight = heightAt(mirror.map, CENTRE.x, CENTRE.y);
    expect(deniedHeight).toBeGreaterThan(0);

    const dirty = store.rejectSeq(1);
    expect(dirty.size).toBeGreaterThan(0);
    expect(store.pendingCount()).toBe(1);
    // The denied stroke is gone from the rendered map...
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(0);
    // ...and the surviving prediction still shows.
    expect(heightAt(mirror.map, CENTRE.x + 8, CENTRE.y)).toBeGreaterThan(0);
  });

  it('is a no-op for a seq with no pending prediction', () => {
    const { mirror, store } = createClient();
    store.predict({ ...raise(), seq: 5 }, 0);
    const before = heightAt(mirror.map, CENTRE.x, CENTRE.y);

    expect(store.rejectSeq(999).size).toBe(0);
    expect(store.pendingCount()).toBe(1);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(before);
  });
});
