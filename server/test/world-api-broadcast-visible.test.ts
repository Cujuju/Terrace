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
      { id: 2, x: -20, y: 8 },
      { id: 3, x: 8, y: -20 },
      { id: 4, x: WORLD_SIZE + 20, y: 8 },
      { id: 5, x: 8, y: WORLD_SIZE + 20 },
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
    expect(sink.ofType('test:all')[0]?.payload).toEqual({ things: [] });
  });
});
