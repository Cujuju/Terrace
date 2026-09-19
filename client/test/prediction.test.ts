import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  MAX_HEIGHT,
  MIN_BRUSH_RADIUS,
  WORLD_UNIT_CELLS,
  applySculpt,
  bandLevelHeight,
  bandOf,
  chunkIndex,
  createHeightmap,
  heightAt,
  sculptOptionsOf,
  sculptReachCells,
  type CellDiff,
  type ChunkPayload,
  type Heightmap,
  type SculptIntent,
  type TerrainDiffMessage,
} from '@terrace/shared';
import {
  applyChunkUnlock,
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
import { createReachChecks } from '../src/terrain/predictionReach.ts';

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
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(bandLevelHeight(0));
    expect(store.authoritativeHeightAt(CENTRE.x, CENTRE.y)).toBe(0);
    expect(dirty.has(chunkIndex(WORLD, 1, 1))).toBe(true);
  });

  it('ignores an intent whose brush centre is in a chunk we never received', () => {
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
    const { store } = createClient(allChunks(MAX_HEIGHT));
    expect(store.predict(raise(), 0).size).toBe(0);
    expect(store.pendingCount()).toBe(0);
  });

  it('drops the oldest prediction once the in-flight cap is reached', () => {
    const { store } = createClient();
    for (let i = 0; i <= MAX_PENDING_PREDICTIONS; i++) {
      store.predict({ ...raise(), dir: i % 2 === 0 ? 1 : -1 }, i);
    }
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

    const diff = serverSculpt(server, intent);
    store.applyAuthoritative((m) => applyTerrainDiff(m, diff), 10);

    expect(store.pendingCount()).toBe(0);
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

    const first = serverSculpt(server, intent);
    store.applyAuthoritative((m) => applyTerrainDiff(m, first), 10);

    expect(store.pendingCount()).toBe(1);
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
    const { store } = createClient([chunkPayload(0, 0, 0)]);
    store.predict(raise(1, 1, 4), 0);
    expect(store.pendingCount()).toBe(1);

    store.applyAuthoritative(() => new Set<number>(), 10);
    expect(store.pendingCount()).toBe(1);
  });
});

describe('brush tools and edge profiles (decision 2026-08-14)', () => {
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

      expect(store.pendingCount()).toBe(0);
      expect(mirror.map.cells).toEqual(predicted);
      expect(mirror.map.cells).toEqual(server.cells);
    });
  }

  it('predicts a stamp as a spire: the neighbours never move', () => {
    const { mirror, store } = createClient();

    store.predict({ ...raise(CENTRE.x, CENTRE.y, MIN_BRUSH_RADIUS), tool: 'stamp' }, 0);

    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(bandLevelHeight(0));
    expect(heightAt(mirror.map, CENTRE.x + 1, CENTRE.y)).toBe(0);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y + 1)).toBe(0);
  });

  it('predicts the smooth tool as a no-op on flat ground, exactly like the server', () => {
    const { mirror, store } = createClient();

    const pointBrush = WORLD_UNIT_CELLS;
    const predicted = store.predict(
      { ...raise(CENTRE.x, CENTRE.y, pointBrush), tool: 'smooth' },
      0,
    );

    expect(predicted.size).toBe(0);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(0);
    expect(bandOf(heightAt(mirror.map, CENTRE.x + pointBrush + 1, CENTRE.y))).toBe(0);
  });

  it('does not predict an intent whose tool or profile it does not recognise', () => {
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
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(bandLevelHeight(0));
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
    expect(heightAt(mirror.map, 40, 40)).toBe(bandLevelHeight(0));
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

    expect(store.authoritativeHeightAt(CENTRE.x, CENTRE.y)).toBe(256);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(256);
    expect(heightAt(mirror.map, 4, 4)).toBe(predictedCentre);
    expect(store.pendingCount()).toBe(1);
  });
});

describe('resolveSeq — the sculptDenied / sculptApplied fast path', () => {
  it('rolls back exactly the nacked prediction and keeps the others', () => {
    const { mirror, store } = createClient();

    store.predict({ ...raise(), seq: 1 }, 0);
    store.predict({ ...raise(CENTRE.x + 8), seq: 2 }, 0);
    const deniedHeight = heightAt(mirror.map, CENTRE.x, CENTRE.y);
    expect(deniedHeight).toBeGreaterThan(0);

    const dirty = store.resolveSeq(1);
    expect(dirty.size).toBeGreaterThan(0);
    expect(store.pendingCount()).toBe(1);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(0);
    expect(heightAt(mirror.map, CENTRE.x + 8, CENTRE.y)).toBeGreaterThan(0);
  });

  it('is a no-op for a seq with no pending prediction', () => {
    const { mirror, store } = createClient();
    store.predict({ ...raise(), seq: 5 }, 0);
    const before = heightAt(mirror.map, CENTRE.x, CENTRE.y);

    expect(store.resolveSeq(999).size).toBe(0);
    expect(store.pendingCount()).toBe(1);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(before);
  });
});

const FRONTIER_GROUND = 160;
const FRONTIER_EDGE_X = CHUNK_SIZE - 1;
const FRONTIER_Y = 8;

function frontierFixture(): {
  mirror: ReturnType<typeof createTerrainMirror>;
  store: PredictionStore;
  server: Heightmap;
} {
  const server = createHeightmap(WORLD);
  server.cells.fill(FRONTIER_GROUND);
  const { mirror, store } = createClient([chunkPayload(0, 0, FRONTIER_GROUND)]);
  return { mirror, store, server };
}

function filterToUnlocked(diff: TerrainDiffMessage, unlocked: ReadonlySet<number>): TerrainDiffMessage {
  return {
    type: 'terrainDiff',
    cells: diff.cells.filter((cell) =>
      unlocked.has(chunkIndex(WORLD, Math.floor(cell.x / CHUNK_SIZE), Math.floor(cell.y / CHUNK_SIZE))),
    ),
  };
}

function rowInOwnChunk(cells: Int16Array | Heightmap['cells']): number[] {
  const out: number[] = [];
  for (let x = 0; x <= FRONTIER_EDGE_X; x++) out.push(cells[FRONTIER_Y * WORLD + x]);
  return out;
}

// A terraced ramp: every riser is a whole band over one cell, which is exactly
// the gradient relaxation cascades along. A smooth on it reaches far past its brush.
const RAMP_TREAD_CELLS = WORLD_UNIT_CELLS;

function rampChunk(cx: number, cy: number): ChunkPayload {
  const heights: number[] = [];
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      heights.push(Math.floor((cx * CHUNK_SIZE + lx) / RAMP_TREAD_CELLS) * BAND_HEIGHT);
    }
  }
  return { cx, cy, heights };
}

function rampWorld(): ChunkPayload[] {
  const out: ChunkPayload[] = [];
  for (let cy = 0; cy < WORLD / CHUNK_SIZE; cy++) {
    for (let cx = 0; cx < WORLD / CHUNK_SIZE; cx++) out.push(rampChunk(cx, cy));
  }
  return out;
}

function smoothAt(x: number, y: number, seq: number): SculptIntent {
  return { type: 'sculpt', x, y, radius: MIN_BRUSH_RADIUS, dir: 1, tool: 'smooth', seq };
}

describe('a relaxing tool is judged by the reach it had, not the brush it used', () => {
  // Close enough that the cascade crosses the frontier even though the brush
  // and its halo do not: the reach guard is the only thing that can catch it.
  const OVER_THE_FRONTIER_X =
    FRONTIER_EDGE_X + 1 - sculptReachCells(MIN_BRUSH_RADIUS, 'hard', 'smooth', 'clicked');

  it('refuses a smooth whose cascade runs into ground it was never sent', () => {
    const { mirror, store } = createClient([rampChunk(0, 0)]);
    const before = Array.from(mirror.map.cells);
    expect(OVER_THE_FRONTIER_X + MIN_BRUSH_RADIUS).toBeLessThanOrEqual(FRONTIER_EDGE_X);

    const dirty = store.predict(smoothAt(OVER_THE_FRONTIER_X, FRONTIER_Y, 1), 0);

    expect(dirty.size).toBe(0);
    expect(store.pendingCount()).toBe(0);
    expect(store.ghostSeqs()).toEqual([1]);
    expect(Array.from(mirror.map.cells)).toEqual(before);
  });

  it('predicts a smooth whose cascade stops short of the frontier', () => {
    const { store } = createClient([rampChunk(0, 0)]);

    const dirty = store.predict(smoothAt(OVER_THE_FRONTIER_X - 1, FRONTIER_Y, 1), 0);

    expect(store.ghostSeqs()).toEqual([]);
    expect(store.pendingCount()).toBe(1);
    expect(dirty.size).toBeGreaterThan(0);
  });

  it('still predicts the same smooth once the world around it is known', () => {
    const { mirror, store } = createClient(rampWorld());
    const before = Array.from(mirror.map.cells);

    const dirty = store.predict(smoothAt(FRONTIER_EDGE_X - 4, FRONTIER_Y, 1), 0);

    expect(dirty.size).toBeGreaterThan(0);
    expect(store.pendingCount()).toBe(1);
    expect(store.ghostSeqs()).toEqual([]);
    expect(Array.from(mirror.map.cells)).not.toEqual(before);
  });

  it('leaves the refused stroke with nothing for the next diff to undo', () => {
    const { mirror, store } = createClient([rampChunk(0, 0)]);
    const before = Array.from(mirror.map.cells);
    store.predict(smoothAt(OVER_THE_FRONTIER_X, FRONTIER_Y, 1), 0);
    expect(Array.from(mirror.map.cells)).toEqual(before);

    store.resolveSeq(1);

    expect(store.ghostSeqs()).toEqual([]);
    expect(Array.from(mirror.map.cells)).toEqual(before);
  });
});

describe('frontier sculpts (issue #21)', () => {
  it('never renders below the authoritative heights after a frontier stroke', () => {
    const { mirror, store, server } = frontierFixture();
    const own = new Set([chunkIndex(WORLD, 0, 0)]);

    const intent: SculptIntent = {
      type: 'sculpt',
      x: FRONTIER_EDGE_X - 1,
      y: FRONTIER_Y,
      radius: 3,
      dir: 1,
      tool: 'smooth',
      profile: 'soft',
      seq: 1,
    };

    store.predict(intent, 0);
    const diff = serverSculpt(server, intent);
    store.applyAuthoritative((m) => applyTerrainDiff(m, filterToUnlocked(diff, own)), 10);
    store.resolveSeq(1);

    expect(rowInOwnChunk(mirror.map.cells)).toEqual(rowInOwnChunk(server.cells));
    expect(store.pendingCount()).toBe(0);
  });

  it('refuses to predict a stroke whose footprint reads terrain it was never sent', () => {
    const { mirror, store } = frontierFixture();

    const dirty = store.predict(
      {
        type: 'sculpt',
        x: FRONTIER_EDGE_X - 1,
        y: FRONTIER_Y,
        radius: 3,
        dir: 1,
        tool: 'smooth',
        profile: 'soft',
      },
      0,
    );

    expect(dirty.size).toBe(0);
    expect(store.pendingCount()).toBe(0);
    expect(rowInOwnChunk(mirror.map.cells).every((h) => h === FRONTIER_GROUND)).toBe(true);
  });

  it('refuses the level-fill brush at the frontier, where unseen cells poison the fill', () => {
    const { mirror, store, server } = frontierFixture();
    const intent: SculptIntent = {
      type: 'sculpt',
      x: FRONTIER_EDGE_X - 1,
      y: FRONTIER_Y,
      radius: 3,
      dir: 1,
      tool: 'stamp',
      profile: 'hard',
      seq: 1,
    };

    expect(store.predict(intent, 0).size).toBe(0);
    expect(store.pendingCount()).toBe(0);

    const wouldHavePredicted = createHeightmap(WORLD);
    wouldHavePredicted.cells.set(mirror.map.cells);
    const localDiff = applySculpt(
      wouldHavePredicted,
      intent.x,
      intent.y,
      intent.radius,
      DEFAULT_SCULPT_AMOUNT,
      sculptOptionsOf(intent),
    );
    const serverDiff = serverSculpt(server, intent);
    const visible = (cell: { x: number }): boolean => cell.x <= FRONTIER_EDGE_X;
    expect(localDiff.filter(visible)).toEqual(serverDiff.cells.filter(visible));
    const phantomLocal = localDiff.filter((cell) => !visible(cell));
    expect(phantomLocal.length).toBeGreaterThan(0);
    const serverByCell = new Map(
      serverDiff.cells.map((cell) => [`${cell.x},${cell.y}`, cell.h]),
    );
    expect(
      phantomLocal.some((cell) => serverByCell.get(`${cell.x},${cell.y}`) !== cell.h),
    ).toBe(true);

    store.applyAuthoritative(
      (m) => applyTerrainDiff(m, filterToUnlocked(serverDiff, new Set([chunkIndex(WORLD, 0, 0)]))),
      10,
    );
    store.resolveSeq(1);
    expect(rowInOwnChunk(mirror.map.cells)).toEqual(rowInOwnChunk(server.cells));
  });

  it('still predicts a stroke that stays clear of the frontier by the halo', () => {
    const { mirror, store, server } = frontierFixture();
    // A hard stamp deposits with the old melt's sweep (soft adds an apron
    // past the halo): the frontier containment does not depend on tool.
    const intent: SculptIntent = {
      type: 'sculpt',
      x: FRONTIER_EDGE_X - 4,
      y: FRONTIER_Y,
      radius: 3,
      dir: 1,
      tool: 'stamp',
      profile: 'hard',
      seq: 1,
    };

    expect(store.predict(intent, 0).size).toBeGreaterThan(0);
    expect(store.pendingCount()).toBe(1);

    const diff = serverSculpt(server, intent);
    store.applyAuthoritative(
      (m) => applyTerrainDiff(m, filterToUnlocked(diff, new Set([chunkIndex(WORLD, 0, 0)]))),
      10,
    );

    expect(rowInOwnChunk(mirror.map.cells)).toEqual(rowInOwnChunk(server.cells));
    expect(store.pendingCount()).toBe(0);
  });

  it('a neighbour sculpting into a chunk we do not hold cannot revert our ground', () => {
    const { mirror, store, server } = frontierFixture();
    const union = new Set([chunkIndex(WORLD, 0, 0), chunkIndex(WORLD, 1, 0)]);

    const neighbour: SculptIntent = {
      type: 'sculpt',
      x: CHUNK_SIZE + 2,
      y: FRONTIER_Y,
      radius: 3,
      dir: 1,
      tool: 'smooth',
      profile: 'soft',
    };
    const ours: SculptIntent = {
      type: 'sculpt',
      x: FRONTIER_EDGE_X - 4,
      y: FRONTIER_Y,
      radius: 3,
      dir: 1,
      tool: 'smooth',
      profile: 'soft',
      seq: 1,
    };

    store.predict(ours, 0);
    store.applyAuthoritative(
      (m) => applyTerrainDiff(m, filterToUnlocked(serverSculpt(server, neighbour), union)),
      5,
    );
    store.applyAuthoritative(
      (m) => applyTerrainDiff(m, filterToUnlocked(serverSculpt(server, ours), union)),
      10,
    );
    store.resolveSeq(1);

    expect(rowInOwnChunk(mirror.map.cells)).toEqual(rowInOwnChunk(server.cells));
    expect(store.pendingCount()).toBe(0);
  });

  it("retires a prediction the value heuristic cannot recognise, on the server's ack", () => {
    const { mirror, store } = createClient();
    const server = createHeightmap(WORLD);

    const ours: SculptIntent = { ...raise(), seq: 1 };
    store.predict(ours, 0);
    const rewritten = serverSculpt(server, { ...ours, x: CENTRE.x + 2 });
    store.applyAuthoritative((m) => applyTerrainDiff(m, rewritten), 10);

    expect(store.pendingCount()).toBe(1);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).not.toBe(
      heightAt(server, CENTRE.x, CENTRE.y),
    );

    store.resolveSeq(1);

    expect(store.pendingCount()).toBe(0);
    expect(mirror.map.cells).toEqual(server.cells);
  });
});

describe('the dirty set reports what the SCREEN needs, and only that', () => {
  it('dirties the −x/−y neighbours of a changed cell on a chunk border', () => {
    const { store } = createClient();

    const dirty = store.predict(raise(CHUNK_SIZE, CHUNK_SIZE, MIN_BRUSH_RADIUS), 0);

    expect(dirty.has(chunkIndex(WORLD, 1, 1))).toBe(true);
    expect(dirty.has(chunkIndex(WORLD, 0, 1))).toBe(true);
    expect(dirty.has(chunkIndex(WORLD, 1, 0))).toBe(true);
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
  });

  it('reports nothing for an authoritative echo that matches the prediction', () => {
    const { store } = createClient();
    const server = createHeightmap(WORLD);

    const intent: SculptIntent = {
      ...raise(CHUNK_SIZE, CHUNK_SIZE, MIN_BRUSH_RADIUS),
      seq: 1,
    };
    expect(store.predict(intent, 0).size).toBeGreaterThan(0);

    const echo = store.applyCellDiff(serverSculpt(server, intent), 10);

    expect(echo.size).toBe(0);
    expect(store.authoritativeHeightAt(CHUNK_SIZE, CHUNK_SIZE)).toBe(
      heightAt(server, CHUNK_SIZE, CHUNK_SIZE),
    );
  });

  it('dirties an unlocked all-sea-level chunk and its three back-neighbours', () => {
    const held = allChunks().filter((c) => !(c.cx === 1 && c.cy === 1));
    const { store } = createClient(held);

    const dirty = store.applyAuthoritative(
      (m) =>
        applyChunkUnlock(m, {
          type: 'chunkUnlock',
          chunks: [chunkPayload(1, 1, 0)],
        }),
      10,
    );

    expect(dirty.has(chunkIndex(WORLD, 1, 1))).toBe(true);
    expect(dirty.has(chunkIndex(WORLD, 0, 1))).toBe(true);
    expect(dirty.has(chunkIndex(WORLD, 1, 0))).toBe(true);
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
  });
});

describe('a prediction is guarded by the whole reach, not a one-cell halo', () => {
  // Chunks 0 and 1 on both axes are received, so cells 0..31 are known and
  // anything from 32 on is ground the client was never sent.
  const KNOWN_CHUNKS = 2;
  const LAST_KNOWN_CELL = KNOWN_CHUNKS * CHUNK_SIZE - 1;
  const RADIUS = 4;
  const STEP_FILL = 5 * BAND_HEIGHT;

  const frontierMirror = (): ReturnType<typeof createTerrainMirror> => {
    const mirror = createTerrainMirror(WORLD);
    const chunks: ChunkPayload[] = [];
    for (let cy = 0; cy < KNOWN_CHUNKS; cy++) {
      for (let cx = 0; cx < KNOWN_CHUNKS; cx++) {
        chunks.push(chunkPayload(cx, cy, cx === 1 && cy === 1 ? STEP_FILL : 0));
      }
    }
    applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks });
    return mirror;
  };

  const smoothAt = (x: number, y: number): SculptIntent =>
    ({ type: 'sculpt', x, y, radius: RADIUS, dir: 1, tool: 'smooth' });

  const hardStampAt = (x: number, y: number): SculptIntent =>
    ({ type: 'sculpt', x, y, radius: RADIUS, dir: 1, tool: 'stamp', profile: 'hard' });

  it('refuses a smooth whose cascade crosses ground the client was never sent', () => {
    const reach = createReachChecks(frontierMirror());
    // Its own brush is entirely inside known ground; its cascade is not.
    const clicked = { x: LAST_KNOWN_CELL - RADIUS - 1, y: LAST_KNOWN_CELL - RADIUS - 1 };
    const extent = sculptReachCells(RADIUS, 'hard', 'smooth', 'clicked');
    expect(clicked.x + extent).toBeGreaterThan(LAST_KNOWN_CELL);
    expect(clicked.x + RADIUS).toBeLessThanOrEqual(LAST_KNOWN_CELL);

    expect(reach.canPredictFaithfully(smoothAt(clicked.x, clicked.y))).toBe(false);
    // The brush alone is known, so a tool that does not cascade still predicts.
    expect(reach.canPredictFaithfully(hardStampAt(clicked.x, clicked.y))).toBe(true);
  });

  it('admits a smooth whose whole reach is known', () => {
    const reach = createReachChecks(frontierMirror());
    const extent = sculptReachCells(RADIUS, 'hard', 'smooth', 'clicked');
    const clicked = { x: LAST_KNOWN_CELL - extent, y: LAST_KNOWN_CELL - extent };

    expect(reach.canPredictFaithfully(smoothAt(clicked.x, clicked.y))).toBe(true);
    expect(reach.canPredictFaithfully(hardStampAt(clicked.x, clicked.y))).toBe(true);
  });

  it('holds at every radius: the guard follows 2 * radius + the margin', () => {
    const reach = createReachChecks(frontierMirror());
    for (const radius of [MIN_BRUSH_RADIUS, 2, RADIUS, 8]) {
      const extent = sculptReachCells(radius, 'hard', 'smooth', 'clicked');
      const inside = { type: 'sculpt', x: LAST_KNOWN_CELL - extent, y: 8, radius, dir: 1, tool: 'smooth' } as const;
      const over = { ...inside, x: LAST_KNOWN_CELL - extent + CHUNK_SIZE };
      expect([radius, reach.canPredictFaithfully(inside)]).toEqual([radius, true]);
      expect([radius, reach.canPredictFaithfully(over)]).toEqual([radius, false]);
    }
  });

  it('ghosts the refused stroke instead of predicting it, and keeps nothing pending', () => {
    const mirror = frontierMirror();
    const store = createPredictionStore(mirror);
    const clicked = { x: LAST_KNOWN_CELL - RADIUS - 1, y: LAST_KNOWN_CELL - RADIUS - 1 };
    const before = Int16Array.from(mirror.map.cells);

    const dirty = store.predict({ ...smoothAt(clicked.x, clicked.y), seq: 7 }, 0);

    expect(dirty.size).toBe(0);
    expect(store.pendingCount()).toBe(0);
    expect(store.ghostSeqs()).toEqual([7]);
    expect(Array.from(mirror.map.cells)).toEqual(Array.from(before));
  });

  it('still predicts a smooth that sits well inside known ground', () => {
    const mirror = frontierMirror();
    const store = createPredictionStore(mirror);
    // On the step between the flat chunk and the raised one, so it has work.
    const clicked = { x: CHUNK_SIZE, y: CHUNK_SIZE };

    const dirty = store.predict({ ...smoothAt(clicked.x, clicked.y), seq: 8 }, 0);

    expect(store.ghostSeqs()).toEqual([]);
    expect(store.pendingCount()).toBe(1);
    expect(dirty.size).toBeGreaterThan(0);
  });
});
