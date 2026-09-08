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

const WORLD_SIZE = CHUNK_SIZE * 4;
const PLAYER = { id: 'session-1', token: 'token-1', name: 'Tester' };

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
    const outcome = handleSculptIntent(
      { world, interceptors: new PluginHost(world, []) },
      PLAYER,
      { type: 'sculpt', x: EDGE_CELL.x, y: EDGE_CELL.y, radius: 4, dir: 1 },
    );

    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;

    const spilled = outcome.diff.filter((c) => c.x >= CHUNK_SIZE || c.y >= CHUNK_SIZE);
    expect(spilled.length).toBeGreaterThan(0);
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
    const host = new PluginHost(world, []);
    const locked = CHUNK_SIZE * 2 + CHUNK_SIZE / 2;
    applyServerSculpt(world, host, locked, locked, 1, DEFAULT_SCULPT_AMOUNT);

    expect(world.heightAt(locked, locked)).not.toBe(0);
    expect(sink.messages).toHaveLength(0);
  });
});

describe('per-player diff partition', () => {
  const VIEWER_A = { id: 'session-a', token: 'token-a', name: 'A' };
  const VIEWER_B = { id: 'session-b', token: 'token-b', name: 'B' };
  const IN_CHUNK_00 = { x: 1, y: 1, h: 5 };
  const IN_CHUNK_10 = { x: CHUNK_SIZE + 1, y: 1, h: 6 };
  const IN_CHUNK_11 = { x: CHUNK_SIZE + 1, y: CHUNK_SIZE + 1, h: 7 };
  const DIFF = [IN_CHUNK_00, IN_CHUNK_10, IN_CHUNK_11];

  function twoViewerWorld(): World {
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
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.addPlayer(VIEWER_A);
    expect(partitionDiffByViewer(world, [IN_CHUNK_00])).toEqual([]);
  });

  it('applyServerSculpt sends each connected player their own share and no broadcast', () => {
    const world = twoViewerWorld();
    const sink = new RecordingSink();
    world.setSink(sink);
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
      expect(chunkHeightsAsCells(payload.heights)).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
    }
  });

  it('a fresh 512² world exposes only the centred starter region', () => {
    const size = 512;
    const world = World.createFresh(size);
    const edge = chunksPerEdge(size);
    const start = Math.floor((edge - INITIAL_UNLOCK_CHUNK_SPAN) / 2);

    const payloads = collectUnlockedChunkPayloads(world);

    expect(payloads).toHaveLength(INITIAL_UNLOCK_CHUNK_SPAN * INITIAL_UNLOCK_CHUNK_SPAN);
    expect(world.isChunkUnlocked(start, start)).toBe(true);
    expect(world.isChunkUnlocked(start - 1, start)).toBe(false);
    expect(world.isChunkUnlocked(start + INITIAL_UNLOCK_CHUNK_SPAN, start)).toBe(false);
  });
});
