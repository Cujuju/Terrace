// THE OFF-MAP CONTRACT of WorldApi.broadcastVisible (#291), written BEFORE the
// change it covers.
//
// A position outside the world is VISIBLE TO NOBODY: it is filtered out of every
// recipient's subset, and asking about it never throws.
//
// WHY IT HAD TO BE SAID ONCE, IN CORE. Some things a plugin broadcasts are
// legitimately off the map — a cyclone is born over the sea beyond the coast and
// drifts in, a disc drifts out the far side — and `positionOf` hands their cells
// straight to the fog-of-war test. That test resolves a chunk index, and a chunk
// index outside the world is a RangeError (shared/src/chunks.ts, `chunkIndex`),
// thrown from inside onTick. The alternative fix — every plugin clamping its own
// positions before handing them over — is the shape that lets the next plugin
// forget, and a clamped position is also a lie: it says "the storm is at the
// edge" where the truth is "the storm is not on the map".

import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import { createWorldApi } from '../src/plugins/world-api.ts';
import {
  RecordingSink,
  grantTokenEveryUnlockedChunk,
  worldWithUnlockedChunks,
} from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const PLAYER = { id: 'session-1', token: 'token-1', name: 'Tester' };

/** The plugin host's listener half, which this member never reaches for. */
const NO_LISTENER = {
  notifyTerrainChanged(): void {},
  notifyChunkUnlockedForToken(): void {},
  notifyWorldEvent(): void {},
};

interface Thing {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

function worldWithOnePlayer() {
  const world = worldWithUnlockedChunks(
    WORLD_SIZE,
    [0, 1, 2, 3].flatMap((cy) => [0, 1, 2, 3].map((cx) => [cx, cy] as const)),
  );
  const sink = new RecordingSink();
  world.setSink(sink);
  world.addPlayer(PLAYER);
  grantTokenEveryUnlockedChunk(world, PLAYER.token);
  return { world, sink, api: createWorldApi(world, NO_LISTENER, 'test').api };
}

describe('broadcastVisible and the world edge', () => {
  it('sends an off-map item to nobody, and does not throw', () => {
    const { sink, api } = worldWithOnePlayer();
    const onMap: Thing = { id: 1, x: 8, y: 8 };
    const offMap: readonly Thing[] = [
      { id: 2, x: -20, y: 8 }, // west of the map
      { id: 3, x: 8, y: -20 }, // north of it
      { id: 4, x: WORLD_SIZE + 20, y: 8 }, // east
      { id: 5, x: 8, y: WORLD_SIZE + 20 }, // south
    ];

    expect(() => {
      api.broadcastVisible(
        'all',
        [onMap, ...offMap],
        (thing: Thing) => ({ x: thing.x, y: thing.y }),
        (visible) => ({ things: visible }),
      );
    }).not.toThrow();

    const sent = sink.ofType('test:all');
    expect(sent).toHaveLength(1);
    // The on-map thing survives; every off-map one is simply not there. It is
    // FILTERED, not clamped: nothing was moved to the edge to make it visible.
    expect(sent[0]?.payload).toEqual({ things: [onMap] });
  });

  it('still sends the empty payload when everything is off the map', () => {
    const { sink, api } = worldWithOnePlayer();
    api.broadcastVisible(
      'all',
      [{ id: 1, x: -50, y: -50 }],
      (thing: Thing) => ({ x: thing.x, y: thing.y }),
      (visible) => ({ things: visible }),
    );
    // skipEmpty defaults to false, and an off-map item must not turn a
    // full-state replace message into silence — that is how a client would be
    // left rendering a storm that has walked off the map forever.
    expect(sink.ofType('test:all')[0]?.payload).toEqual({ things: [] });
  });
});
