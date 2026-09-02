// The anti-cheat boundary. These tests exist because the failure they guard
// against is silent: the server would work perfectly while leaking the shape of
// terrain a player has not unlocked.

import {
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  NEIGHBOURHOOD_CELLS,
  chunkHeightsAsCells,
  chunksPerEdge,
} from '@terrace/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleSculptIntent } from '../src/intent/pipeline.ts';
import { PluginHost } from '../src/plugins/host.ts';
import { INITIAL_UNLOCK_CHUNK_SPAN } from '../src/world/initial-unlock.ts';
import {
  collectUnlockedChunkPayloads,
  filterDiffToUnlocked,
  partitionDiffByViewer,
} from '../src/world/mask-filter.ts';
import { applyServerSculpt } from '../src/world/sculpt-service.ts';
import { World } from '../src/world/world.ts';
import {
  RecordingSink,
  grantTokenEveryUnlockedChunk,
  worldWithUnlockedChunks,
} from './support/harness.ts';

// Four chunks to a side, whatever a chunk is sampled at (2026-08-21: the
// re-sample kept CHUNK_SIZE at 16 cells and shrank what a chunk covers, so a
// four-chunk world is smaller ground than it was — which is fine here: every
// assertion in this suite is about chunk mechanics, not about distances.)
const WORLD_SIZE = CHUNK_SIZE * 4;
const PLAYER = { id: 'session-1', token: 'token-1', name: 'Tester' };

/** Last cell of chunk (0,0) — a sculpt here provably spills into neighbours. */
const EDGE_CELL = { x: CHUNK_SIZE - 1, y: CHUNK_SIZE - 1 };

describe('outgoing diff filtering', () => {
  let world: World;
  let sink: RecordingSink;

  beforeEach(() => {
    world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    sink = new RecordingSink();
    world.setSink(sink);
  });

  it('omits cells in locked chunks from the sculptor\'s diff, while keeping them server-side', () => {
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    // Max radius on the very corner of the only unlocked chunk: both the brush
    // and the gradient relaxation reach into locked chunks (1,0), (0,1), (1,1).
    const outcome = handleSculptIntent(
      { world, interceptors: new PluginHost(world, []) },
      PLAYER,
      { type: 'sculpt', x: EDGE_CELL.x, y: EDGE_CELL.y, radius: 4, dir: 1 },
    );

    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;

    // Precondition of the test: the spill is real, not hypothetical.
    const spilled = outcome.diff.filter((c) => c.x >= CHUNK_SIZE || c.y >= CHUNK_SIZE);
    expect(spilled.length).toBeGreaterThan(0);
    // ...and the server really did change that locked terrain.
    expect(world.heightAt(spilled[0].x, spilled[0].y)).not.toBe(0);

    const broadcasts = sink.ofType('terrainDiff');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].target).toBe(PLAYER.id);
    const cells = (broadcasts[0].payload as { cells: Array<{ x: number; y: number }> }).cells;
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.x).toBeLessThan(CHUNK_SIZE);
      expect(cell.y).toBeLessThan(CHUNK_SIZE);
    }
    // Nothing was dropped that should have survived.
    expect(cells.length).toBe(outcome.diff.length - spilled.length);
  });

  it('filterDiffToUnlocked keeps the input intact and returns only visible cells', () => {
    const diff = [
      { x: 0, y: 0, h: 1 },
      { x: CHUNK_SIZE, y: 0, h: 2 },
      { x: 0, y: CHUNK_SIZE, h: 3 },
    ];
    const visible = filterDiffToUnlocked(world, diff);

    expect(visible).toEqual([{ x: 0, y: 0, h: 1 }]);
    expect(diff).toHaveLength(3);
  });

  it('broadcasts nothing when an edit is entirely invisible to clients', () => {
    // A plugin may legitimately edit locked terrain (terraforming ahead of a
    // reveal, say). The edit must happen, and clients must hear nothing at all
    // about it — not even an empty message that would confirm activity.
    const host = new PluginHost(world, []);
    // Deep inside chunk (2,2) — a locked chunk at any sampling density, and
    // far enough from its edges that the relaxation spill cannot reach the
    // unlocked chunk (0,0).
    const locked = CHUNK_SIZE * 2 + CHUNK_SIZE / 2;
    applyServerSculpt(world, host, locked, locked, 1, DEFAULT_SCULPT_AMOUNT);

    expect(world.heightAt(locked, locked)).not.toBe(0);
    expect(sink.messages).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-PLAYER DIFF FILTERING (issue #280). The union mask is what the SIMULATION
// has revealed to anyone; a diff filtered by it and broadcast tells every
// client the heights of chunks only some other player earned. Each player must
// receive exactly the cells inside their OWN mask, and nothing when that is
// empty.
describe('per-player diff partition', () => {
  const VIEWER_A = { id: 'session-a', token: 'token-a', name: 'A' };
  const VIEWER_B = { id: 'session-b', token: 'token-b', name: 'B' };
  const IN_CHUNK_00 = { x: 1, y: 1, h: 5 };
  const IN_CHUNK_10 = { x: CHUNK_SIZE + 1, y: 1, h: 6 };
  const IN_CHUNK_11 = { x: CHUNK_SIZE + 1, y: CHUNK_SIZE + 1, h: 7 };
  const DIFF = [IN_CHUNK_00, IN_CHUNK_10, IN_CHUNK_11];

  function twoViewerWorld(): World {
    // Union has (0,0), (1,0), (1,1); A personally has (0,0) and (1,0); B has
    // only (1,1). Nobody's own mask equals the union.
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0], [1, 0], [1, 1]]);
    world.addPlayer(VIEWER_A);
    world.addPlayer(VIEWER_B);
    world.unlockChunkForToken(VIEWER_A.token, 0, 0);
    world.unlockChunkForToken(VIEWER_A.token, 1, 0);
    world.unlockChunkForToken(VIEWER_B.token, 1, 1);
    return world;
  }

  it('gives each player only the cells inside their own mask, never the union', () => {
    const shares = partitionDiffByViewer(twoViewerWorld(), DIFF);
    expect(shares).toEqual([
      { playerId: VIEWER_A.id, cells: [IN_CHUNK_00, IN_CHUNK_10] },
      { playerId: VIEWER_B.id, cells: [IN_CHUNK_11] },
    ]);
  });

  it('omits a player who may see nothing, rather than handing them an empty share', () => {
    const world = twoViewerWorld();
    const shares = partitionDiffByViewer(world, [IN_CHUNK_11]);
    expect(shares).toEqual([{ playerId: VIEWER_B.id, cells: [IN_CHUNK_11] }]);
  });

  it('a chunk in the union but in nobody\'s own mask reaches no one', () => {
    // Possible transiently: a chunk unlocked on the union by the legacy
    // unlockChunk path, or a token that has since disconnected.
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.addPlayer(VIEWER_A);
    expect(partitionDiffByViewer(world, [IN_CHUNK_00])).toEqual([]);
  });

  it('applyServerSculpt sends each connected player their own share and no broadcast', () => {
    const world = twoViewerWorld();
    const sink = new RecordingSink();
    world.setSink(sink);
    // Corner of chunk (1,1) nearest (0,0): the brush reaches (0,0), (1,0),
    // (0,1) and (1,1) — A and B see disjoint parts of the same edit.
    applyServerSculpt(
      world,
      new PluginHost(world, []),
      CHUNK_SIZE,
      CHUNK_SIZE,
      4,
      DEFAULT_SCULPT_AMOUNT,
    );

    const diffs = sink.ofType('terrainDiff');
    expect(diffs.map((m) => m.target).sort()).toEqual([VIEWER_A.id, VIEWER_B.id]);
    for (const message of diffs) {
      const cells = (message.payload as { cells: Array<{ x: number; y: number }> }).cells;
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(world.isCellVisibleTo(message.target, cell.x, cell.y)).toBe(true);
      }
    }
  });
});

describe('join snapshot chunk collection', () => {
  it('returns only unlocked chunks, in deterministic row-major order', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [
      [2, 1],
      [0, 0],
      [1, 1],
    ]);

    const payloads = collectUnlockedChunkPayloads(world);

    expect(payloads.map((p) => [p.cx, p.cy])).toEqual([
      [0, 0],
      [1, 1],
      [2, 1],
    ]);
    for (const payload of payloads) {
      // Through chunkHeightsAsCells: the payload carries little-endian Int16
      // BYTES since issue #272, so its own `.length` is twice the cell count.
      // The contract under test is still "a full chunk of heights".
      expect(chunkHeightsAsCells(payload.heights)).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
    }
  });

  it('a fresh 512² world exposes only the centred starter region', () => {
    const size = 512;
    const world = World.createFresh(size);
    const edge = chunksPerEdge(size);
    // Centred by flooring — the same rule initialUnlockFootprint applies, so
    // this stays correct for odd spans (5 since 2026-08-19) and even ones.
    const start = Math.floor((edge - INITIAL_UNLOCK_CHUNK_SPAN) / 2);

    const payloads = collectUnlockedChunkPayloads(world);

    expect(payloads).toHaveLength(INITIAL_UNLOCK_CHUNK_SPAN * INITIAL_UNLOCK_CHUNK_SPAN);
    expect(world.isChunkUnlocked(start, start)).toBe(true);
    expect(world.isChunkUnlocked(start - 1, start)).toBe(false);
    expect(world.isChunkUnlocked(start + INITIAL_UNLOCK_CHUNK_SPAN, start)).toBe(false);
  });

  it('the smallest supported world (small-VPS config) starts with the same small square', () => {
    // Before 2026-08-19 the 8-chunk span unlocked the smallest world entirely;
    // the owner shrank the starter square (see INITIAL_UNLOCK_CHUNK_SPAN), so
    // the small-VPS world now begins with the same centred 5×5 as any other
    // size and earns the rest by sculpting. Eight chunks a side is the world
    // the design record calls 128²; it is 512² in cells since the 2026-08-21
    // re-sample and the same patch of ground either way.
    const world = World.createFresh(NEIGHBOURHOOD_CELLS * 8);
    expect(collectUnlockedChunkPayloads(world)).toHaveLength(
      INITIAL_UNLOCK_CHUNK_SPAN * INITIAL_UNLOCK_CHUNK_SPAN,
    );
  });
});
