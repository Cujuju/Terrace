// Per-player unlock masks — the core capability issue #17 (per-player
// territory) adds to World/WorldApi. The reveal plugin's OWN policy tests
// (plugins/reveal/test/reveal.test.ts) cover WHEN a chunk unlocks; this file
// covers the primitive itself: per-token mutation, the union side-effect,
// per-player streaming/visibility reads, and persistence across a restart.

import { CHUNK_SIZE, NEIGHBOURHOOD_CELLS, chunksPerEdge } from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import { applyInitialUnlockForToken, initialUnlockFootprint } from '../src/world/initial-unlock.ts';
import { World } from '../src/world/world.ts';
import { RecordingSink, worldWithUnlockedChunks } from './support/harness.ts';

// Four chunks to a side, whatever a chunk is sampled at (2026-08-21: the
// re-sample kept CHUNK_SIZE at 16 cells and shrank what a chunk covers, so a
// four-chunk world is smaller ground than it was — which is fine here: every
// assertion in this suite is about chunk mechanics, not about distances.)
const WORLD_SIZE = CHUNK_SIZE * 4;
const TOKEN_A = 'token-a';
const TOKEN_B = 'token-b';
const CHUNK: readonly [number, number] = [2, 2];

describe('World per-token unlock', () => {
  it('unlockChunkForToken flips the token mask AND the union mask together', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    expect(world.isChunkUnlockedForToken(TOKEN_A, ...CHUNK)).toBe(false);
    expect(world.isChunkUnlocked(...CHUNK)).toBe(false);

    expect(world.unlockChunkForToken(TOKEN_A, ...CHUNK)).toBe(true);

    expect(world.isChunkUnlockedForToken(TOKEN_A, ...CHUNK)).toBe(true);
    expect(world.isChunkUnlocked(...CHUNK)).toBe(true); // union OR'd in
    expect(world.isChunkUnlockedForToken(TOKEN_B, ...CHUNK)).toBe(false); // NOT for an unrelated token
  });

  it('is idempotent per token — a second grant returns false and sends nothing', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    const sink = new RecordingSink();
    world.setSink(sink);

    expect(world.unlockChunkForToken(TOKEN_A, ...CHUNK)).toBe(true);
    sink.clear();
    expect(world.unlockChunkForToken(TOKEN_A, ...CHUNK)).toBe(false);
    expect(sink.messages).toHaveLength(0);
  });

  it('lets a SECOND token earn the same chunk independently, even though the union already has it', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    world.unlockChunkForToken(TOKEN_A, ...CHUNK);

    // Union-unlocked already, but TOKEN_B has never personally earned it.
    expect(world.isChunkUnlocked(...CHUNK)).toBe(true);
    expect(world.isChunkUnlockedForToken(TOKEN_B, ...CHUNK)).toBe(false);

    expect(world.unlockChunkForToken(TOKEN_B, ...CHUNK)).toBe(true);
    expect(world.isChunkUnlockedForToken(TOKEN_B, ...CHUNK)).toBe(true);
  });

  it('streams the chunk ONLY to sessions currently presenting that token — never a broadcast', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer({ id: 'session-a', token: TOKEN_A, name: 'A' });
    world.addPlayer({ id: 'session-b', token: TOKEN_B, name: 'B' });

    world.unlockChunkForToken(TOKEN_A, ...CHUNK);

    const streamed = sink.ofType('chunkUnlock');
    expect(streamed).toHaveLength(1);
    expect(streamed[0].target).toBe('session-a');
    expect(streamed.some((m) => m.target === 'broadcast')).toBe(false);
    expect(streamed.some((m) => m.target === 'session-b')).toBe(false);
  });

  it('streams to EVERY live session presenting the token — a token open in two tabs', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer({ id: 'tab-1', token: TOKEN_A, name: 'A' });
    world.addPlayer({ id: 'tab-2', token: TOKEN_A, name: 'A' });

    world.unlockChunkForToken(TOKEN_A, ...CHUNK);

    const targets = sink.ofType('chunkUnlock').map((m) => m.target);
    expect(targets.sort()).toEqual(['tab-1', 'tab-2']);
  });

  it('seedChunkForToken mutates masks but sends nothing', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer({ id: 'session-a', token: TOKEN_A, name: 'A' });

    expect(world.seedChunkForToken(TOKEN_A, ...CHUNK)).toBe(true);

    expect(world.isChunkUnlockedForToken(TOKEN_A, ...CHUNK)).toBe(true);
    expect(world.isChunkUnlocked(...CHUNK)).toBe(true);
    expect(sink.messages).toHaveLength(0);
  });

  it('chunkPayloadsForToken returns exactly one token\'s own unlocked chunks', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    world.unlockChunkForToken(TOKEN_A, ...CHUNK);

    const payloadsA = world.chunkPayloadsForToken(TOKEN_A);
    expect(payloadsA).toHaveLength(1);
    expect(payloadsA[0]).toMatchObject({ cx: CHUNK[0], cy: CHUNK[1] });

    // An unseen token has nothing yet — not an error, an empty list.
    expect(world.chunkPayloadsForToken(TOKEN_B)).toEqual([]);
  });

  describe('isChunkVisibleTo / isCellVisibleTo (fog-of-war primitive)', () => {
    it('answers from the CONNECTED PLAYER\'s own token mask', () => {
      const world = worldWithUnlockedChunks(WORLD_SIZE, []);
      world.addPlayer({ id: 'session-a', token: TOKEN_A, name: 'A' });
      world.unlockChunkForToken(TOKEN_A, ...CHUNK);

      expect(world.isChunkVisibleTo('session-a', ...CHUNK)).toBe(true);
      expect(
        world.isCellVisibleTo('session-a', CHUNK[0] * CHUNK_SIZE + 3, CHUNK[1] * CHUNK_SIZE + 3),
      ).toBe(true);
      expect(world.isChunkVisibleTo('session-a', 0, 0)).toBe(false);
    });

    it('answers false for a playerId with no connected Player', () => {
      const world = worldWithUnlockedChunks(WORLD_SIZE, []);
      world.unlockChunkForToken(TOKEN_A, ...CHUNK); // unlocked for the TOKEN, but nobody is connected as it
      expect(world.isChunkVisibleTo('nobody-here', ...CHUNK)).toBe(false);
      expect(world.isCellVisibleTo('nobody-here', CHUNK[0] * CHUNK_SIZE, CHUNK[1] * CHUNK_SIZE)).toBe(
        false,
      );
    });

    it('a connected player without this chunk sees false even though the union has it', () => {
      const world = worldWithUnlockedChunks(WORLD_SIZE, []);
      world.addPlayer({ id: 'session-b', token: TOKEN_B, name: 'B' });
      world.unlockChunkForToken(TOKEN_A, ...CHUNK); // union now has it; B never earned it personally

      expect(world.isChunkUnlocked(...CHUNK)).toBe(true);
      expect(world.isChunkVisibleTo('session-b', ...CHUNK)).toBe(false);
    });
  });
});

describe('applyInitialUnlockForToken', () => {
  it('grants a new token exactly the same starter square every fresh world unlocks globally', () => {
    const world = World.createFresh(WORLD_SIZE, undefined, undefined, 1);
    const { startChunk, spanChunks } = initialUnlockFootprint(WORLD_SIZE);

    applyInitialUnlockForToken(world, TOKEN_A);

    for (let cy = 0; cy < chunksPerEdge(WORLD_SIZE); cy++) {
      for (let cx = 0; cx < chunksPerEdge(WORLD_SIZE); cx++) {
        const inStarter =
          cx >= startChunk && cx < startChunk + spanChunks && cy >= startChunk && cy < startChunk + spanChunks;
        expect(world.isChunkUnlockedForToken(TOKEN_A, cx, cy)).toBe(inStarter);
      }
    }
  });

  it('is idempotent — a returning token calling it again changes nothing and sends nothing', () => {
    const world = World.createFresh(WORLD_SIZE, undefined, undefined, 1);
    applyInitialUnlockForToken(world, TOKEN_A);
    const sink = new RecordingSink();
    world.setSink(sink);

    applyInitialUnlockForToken(world, TOKEN_A);

    expect(sink.messages).toHaveLength(0);
  });

  it('a DIFFERENT token starts at the starter square too, independent of an existing token\'s progress', () => {
    // A world big enough that the starter square (up to INITIAL_UNLOCK_CHUNK_
    // SPAN chunks) does NOT cover the whole map — at WORLD_SIZE (64, 4×4
    // chunks) the span clamps to the entire world and there would be no
    // "outside the starter square" chunk left to test against.
    const LARGE_WORLD_SIZE = NEIGHBOURHOOD_CELLS * 16;
    const world = World.createFresh(LARGE_WORLD_SIZE, undefined, undefined, 1);
    const { startChunk, spanChunks } = initialUnlockFootprint(LARGE_WORLD_SIZE);
    const outsideStarter: readonly [number, number] = [startChunk + spanChunks, startChunk]; // just past the starter square's east edge
    expect(startChunk + spanChunks).toBeLessThan(chunksPerEdge(LARGE_WORLD_SIZE)); // precondition: a cell outside really exists

    applyInitialUnlockForToken(world, TOKEN_A);
    world.unlockChunkForToken(TOKEN_A, ...outsideStarter); // A has ranged further than the starter square

    applyInitialUnlockForToken(world, TOKEN_B);

    expect(world.isChunkUnlockedForToken(TOKEN_B, startChunk, startChunk)).toBe(true);
    expect(world.isChunkUnlockedForToken(TOKEN_B, ...outsideStarter)).toBe(false); // B never earned A's extra chunk
  });
});

describe('World.restore with per-token masks', () => {
  it('round-trips a token mask exactly', () => {
    const source = worldWithUnlockedChunks(WORLD_SIZE, []);
    source.unlockChunkForToken(TOKEN_A, ...CHUNK);

    const restored = World.restore(
      WORLD_SIZE,
      source.map.cells,
      source.mask,
      undefined,
      source.name,
      source.tokenMasks(),
    );

    expect(restored.isChunkUnlockedForToken(TOKEN_A, ...CHUNK)).toBe(true);
    expect(restored.isChunkUnlocked(...CHUNK)).toBe(true);
  });

  it('LEGACY RESTORE: an omitted tokenMasks map preserves the union but starts every token empty', () => {
    const source = worldWithUnlockedChunks(WORLD_SIZE, []);
    source.unlockChunkForToken(TOKEN_A, ...CHUNK);

    // No sixth argument — exactly what a pre-#17 snapshot's caller passes.
    const restored = World.restore(WORLD_SIZE, source.map.cells, source.mask, undefined, source.name);

    expect(restored.isChunkUnlocked(...CHUNK)).toBe(true); // union preserved
    expect(restored.isChunkUnlockedForToken(TOKEN_A, ...CHUNK)).toBe(false); // re-creep from nothing
    expect(restored.chunkPayloadsForToken(TOKEN_A)).toEqual([]);
  });

  it('drops a per-token row whose mask length does not match this world, without throwing', () => {
    const source = worldWithUnlockedChunks(WORLD_SIZE, []);
    const corrupt = new Map<string, Uint8Array>([[TOKEN_A, new Uint8Array(3)]]); // wrong length

    const restored = World.restore(
      WORLD_SIZE,
      source.map.cells,
      source.mask,
      undefined,
      source.name,
      corrupt,
    );

    expect(restored.isChunkUnlockedForToken(TOKEN_A, ...CHUNK)).toBe(false);
    expect(restored.chunkPayloadsForToken(TOKEN_A)).toEqual([]);
  });

  it('tokenMasks() hands back every token currently tracked, for the snapshot writer', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    world.unlockChunkForToken(TOKEN_A, ...CHUNK);
    world.unlockChunkForToken(TOKEN_B, 0, 0);

    const masks = world.tokenMasks();
    expect(new Set(masks.keys())).toEqual(new Set([TOKEN_A, TOKEN_B]));
  });
});
