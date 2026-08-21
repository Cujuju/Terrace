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
  MIN_BRUSH_RADIUS,
  WORLD_UNIT_CELLS,
  applySculpt,
  bandOf,
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
// Four chunks to a side, whatever a chunk is sampled at — the 2026-08-21
// re-sample moved the cell figure and left the geometry this suite asserts on
// exactly where it was.
const WORLD = CHUNK_SIZE * 4;
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

    store.predict({ ...raise(CENTRE.x, CENTRE.y, MIN_BRUSH_RADIUS), tool: 'stamp' }, 0);

    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(mirror.map, CENTRE.x + 1, CENTRE.y)).toBe(0);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y + 1)).toBe(0);
  });

  it('predicts the smooth tool as one crisp terrace, exactly like the server', () => {
    // SUPERSEDES "predicts the smooth tool as the old fabric pull". The client
    // predicts by running shared's own applySculpt, so this test tracks the
    // feel change rather than arguing with it: a click is one band and the
    // gradient limit is one band per WORLD UNIT, so a click with the smallest
    // brush a player holds lands exactly ON the limit and relaxation has no
    // excess to push outward (owner, 2026-08-20 — godus, not populous; the
    // contract itself is pinned in shared's heightmap.test.ts, on the RENDERED
    // band, which is what a player sees).
    //
    // What matters HERE is that prediction and server agree: a client that
    // still slumped would reconcile against an authoritative diff that did
    // not, and every stroke would snap.
    const { mirror, store } = createClient();

    // The ladder's first rung — one world unit (client/src/state/hudState.ts's
    // BRUSH_RADII), not shared's one-CELL protocol floor.
    const pointBrush = WORLD_UNIT_CELLS;
    store.predict({ ...raise(CENTRE.x, CENTRE.y, pointBrush), tool: 'smooth' }, 0);

    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(bandOf(heightAt(mirror.map, CENTRE.x + pointBrush + 1, CENTRE.y))).toBe(0);
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
    // The denied stroke is gone from the rendered map...
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).toBe(0);
    // ...and the surviving prediction still shows.
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

// ─────────────────────────────────────────────────────────────────────────────
// THE FRONTIER REVERT (issue #21) — owner report: "when I am moving land around
// it sometimes goes back and redraws the outline and removes areas that I just
// sculpted".
//
// The fixture is one player's territory (chunk (0,0)) against a world that is
// NOT at sea level behind it. That gap is the whole bug: the mirror holds
// never-received cells at SEA_LEVEL as a rendering choice, and the shared
// sculpt math reads them as if they were terrain.

/** Ground height of the fixture world — one full terrace band above the sea. */
const FRONTIER_GROUND = 160;
/** Column of chunk (0,0)'s last cell; the frontier is between it and x+1. */
const FRONTIER_EDGE_X = CHUNK_SIZE - 1;
/** Row well inside chunk (0,0), so nothing here touches the world edge. */
const FRONTIER_Y = 8;

/**
 * The client sees ONE chunk of a world that is `FRONTIER_GROUND` high
 * everywhere; the server sees all of it. Returns both, so a test can assert
 * the client's rendered map against the server's own cells.
 */
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

/**
 * The server's outgoing diff filter (server/src/world/mask-filter.ts): cells in
 * locked chunks never reach the wire. `unlocked` is the UNION mask — every
 * chunk unlocked for ANYONE — which is deliberately wider than one player's own
 * chunks (issue #17), so this also models a neighbour's territory.
 */
function filterToUnlocked(diff: TerrainDiffMessage, unlocked: ReadonlySet<number>): TerrainDiffMessage {
  return {
    type: 'terrainDiff',
    cells: diff.cells.filter((cell) =>
      unlocked.has(chunkIndex(WORLD, Math.floor(cell.x / CHUNK_SIZE), Math.floor(cell.y / CHUNK_SIZE))),
    ),
  };
}

/** Heights along the fixture's test row, inside the client's own chunk. */
function rowInOwnChunk(cells: Int16Array | Heightmap['cells']): number[] {
  const out: number[] = [];
  for (let x = 0; x <= FRONTIER_EDGE_X; x++) out.push(cells[FRONTIER_Y * WORLD + x]);
  return out;
}

describe('frontier sculpts (issue #21)', () => {
  it('never renders below the authoritative heights after a frontier stroke', () => {
    // THE REPRO. Before the fix this client predicted the smooth tool's
    // relaxation against a phantom sea behind its frontier, "corrected" a cliff
    // that does not exist, and — because that prediction could never be
    // value-confirmed — replayed the drag-down ON TOP of the server's own copy
    // of the edit. The row read 181 where the server said 224: the player
    // watched ground they had just raised sink instead.
    const { mirror, store, server } = frontierFixture();
    const own = new Set([chunkIndex(WORLD, 0, 0)]);

    // A smooth stroke whose radius-3 footprint reaches past the frontier.
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
    // The contract behind the test above: a prediction is only shown when every
    // cell the shared math reads is in a chunk we hold. The stroke still goes
    // to the server — it is the local preview that is skipped, because a
    // preview computed from SEA_LEVEL placeholders is a wrong preview.
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
    // HISTORY: the level-fill brush used to SURVEY its whole footprint for the
    // lowest band, so one unseen cell reading SEA_LEVEL dragged the target to
    // band 0 and the whole visible stroke went missing locally. Since the
    // clicked-cell anchor (2026-08-19) a player fill targets the CENTRE cell's
    // band — a cell the client always holds — so the VISIBLE side of the local
    // math now agrees with the server. What remains, and still justifies the
    // refusal, is the phantom side: the local fill would raise never-received
    // cells from their placeholder SEA_LEVEL, writing fiction into the mirror
    // that the server's diff for those cells would then have to fight. This
    // test pins both halves: the client declines, and the local math's unseen
    // side really does diverge from the server's.
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

    // What the declined prediction WOULD have produced, run on a copy of the
    // client's own mirror. The anchored fill agrees with the server on the
    // ground this client can actually see — and raises the phantom sea beyond
    // the frontier from its placeholder heights, which the server (filling
    // the REAL terrain there) does not reproduce cell for cell.
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
    // Visible side: the two maths now agree (the clicked-cell anchor removed
    // the poisoned survey), so the refusal is not about this half any more.
    expect(localDiff.filter(visible)).toEqual(serverDiff.cells.filter(visible));
    // Phantom side: the local math writes into never-received cells, and what
    // it writes there is fiction the server's own diff does not contain.
    const phantomLocal = localDiff.filter((cell) => !visible(cell));
    expect(phantomLocal.length).toBeGreaterThan(0);
    const serverByCell = new Map(
      serverDiff.cells.map((cell) => [`${cell.x},${cell.y}`, cell.h]),
    );
    expect(
      phantomLocal.some((cell) => serverByCell.get(`${cell.x},${cell.y}`) !== cell.h),
    ).toBe(true);

    // And the authoritative answer still lands intact.
    store.applyAuthoritative(
      (m) => applyTerrainDiff(m, filterToUnlocked(serverDiff, new Set([chunkIndex(WORLD, 0, 0)]))),
      10,
    );
    store.resolveSeq(1);
    expect(rowInOwnChunk(mirror.map.cells)).toEqual(rowInOwnChunk(server.cells));
  });

  it('still predicts a stroke that stays clear of the frontier by the halo', () => {
    // The guard must not cost prediction on ground we fully hold. A radius-3
    // brush whose footprint plus its one-cell relaxation halo stops short of
    // the border is predicted exactly, and confirms by value as it always did.
    const { mirror, store, server } = frontierFixture();
    const intent: SculptIntent = {
      type: 'sculpt',
      x: FRONTIER_EDGE_X - 4,
      y: FRONTIER_Y,
      radius: 3,
      dir: 1,
      tool: 'smooth',
      profile: 'soft',
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
    // The second-order case. The outgoing diff filter is UNION-masked (issue
    // #17), so a diff can legitimately carry cells for a chunk this client was
    // never sent — a neighbour's territory. Those cells land in the mirror's
    // backing array but in no mesh, and the chunk's real heights arrive whole
    // if it is ever unlocked for us. Nothing about that path may disturb the
    // ground we DO hold.
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
    // The neighbour's edit reaches the server first and is broadcast to us
    // with its own chunk's cells included, exactly as the union filter allows.
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
    // The general form of the bug, with the frontier taken out of it: whenever
    // our arithmetic and the server's disagree — here a plugin that rewrote the
    // intent's centre before it was applied, so the diff describes an edit we
    // never predicted — isConfirmed returns false, and a prediction that is
    // never confirmed is drawn ON TOP of the server's own copy of the stroke.
    // The ack is what ends that, one round trip after the stroke instead of one
    // second, and it works because the server echoes the CLIENT's seq rather
    // than the rewritten intent's.
    const { mirror, store } = createClient();
    const server = createHeightmap(WORLD);

    const ours: SculptIntent = { ...raise(), seq: 1 };
    store.predict(ours, 0);
    const rewritten = serverSculpt(server, { ...ours, x: CENTRE.x + 2 });
    store.applyAuthoritative((m) => applyTerrainDiff(m, rewritten), 10);

    // Unrecognised, so still pending and still drawn over the truth — this is
    // the doubled edit, and the state the old code sat in for a full
    // PREDICTION_TTL_MS with no way out but the deadline.
    expect(store.pendingCount()).toBe(1);
    expect(heightAt(mirror.map, CENTRE.x, CENTRE.y)).not.toBe(
      heightAt(server, CENTRE.x, CENTRE.y),
    );

    store.resolveSeq(1);

    expect(store.pendingCount()).toBe(0);
    expect(mirror.map.cells).toEqual(server.cells);
  });
});
