// The anti-cheat boundary. These tests exist because the failure they guard
// against is silent: the server would work perfectly while leaking the shape of
// terrain a player has not unlocked.

import { CHUNK_SIZE, DEFAULT_SCULPT_AMOUNT, chunksPerEdge } from '@terrace/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleSculptIntent } from '../src/intent/pipeline.ts';
import { PluginHost } from '../src/plugins/host.ts';
import { INITIAL_UNLOCK_CHUNK_SPAN } from '../src/world/initial-unlock.ts';
import {
  collectUnlockedChunkPayloads,
  filterDiffToUnlocked,
} from '../src/world/mask-filter.ts';
import { applyServerSculpt } from '../src/world/sculpt-service.ts';
import { World } from '../src/world/world.ts';
import { RecordingSink, worldWithUnlockedChunks } from './support/harness.ts';

const WORLD_SIZE = 64;
const PLAYER = { id: 'session-1', name: 'Tester' };

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

  it('omits cells in locked chunks from a broadcast diff, while keeping them server-side', () => {
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
    applyServerSculpt(world, host, 40, 40, 1, DEFAULT_SCULPT_AMOUNT);

    expect(world.heightAt(40, 40)).not.toBe(0);
    expect(sink.messages).toHaveLength(0);
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
      expect(payload.heights).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
    }
  });

  it('a fresh 512² world exposes only the centred starter region', () => {
    const size = 512;
    const world = World.createFresh(size);
    const edge = chunksPerEdge(size);
    const start = (edge - INITIAL_UNLOCK_CHUNK_SPAN) / 2;

    const payloads = collectUnlockedChunkPayloads(world);

    expect(payloads).toHaveLength(INITIAL_UNLOCK_CHUNK_SPAN * INITIAL_UNLOCK_CHUNK_SPAN);
    expect(world.isChunkUnlocked(start, start)).toBe(true);
    expect(world.isChunkUnlocked(start - 1, start)).toBe(false);
    expect(world.isChunkUnlocked(start + INITIAL_UNLOCK_CHUNK_SPAN, start)).toBe(false);
  });

  it('a fresh 128² world (small-VPS config) unlocks entirely', () => {
    const world = World.createFresh(128);
    expect(collectUnlockedChunkPayloads(world)).toHaveLength(
      chunksPerEdge(128) * chunksPerEdge(128),
    );
  });
});
