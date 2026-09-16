import {
  CHUNK_UNLOCK_MANA,
  openedChunkCount,
} from '../../mana/pricing.ts';
import {
  MAX_DRAG_SWEEP_CELLS,
  chunksPerEdge,
  strokeSweep,
  type SculptIntent,
} from '@terrace/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import {
  MANA_CAPACITY,
  manaBalanceOf,
  plugin as manaPlugin,
  resetManaState,
} from '../../mana/server/index.ts';
import { plugin as revealPlugin } from '../server/index.ts';

const WORLD_SIZE = 128;

/** Two chunks of home, side by side: a leg across them starts far from the frontier. */
const HOME_CHUNKS: ReadonlyArray<readonly [number, number]> = [
  [2, 2],
  [3, 2],
];

/** Within reach of where the leg starts, out of reach of where it ends. */
const BEHIND_CHUNK: readonly [number, number] = [1, 2];

const LEG_FROM = { x: 40, y: 40 } as const;

const LEG_TO = { x: LEG_FROM.x + MAX_DRAG_SWEEP_CELLS, y: LEG_FROM.y } as const;

const BRUSH_RADIUS = 1;

const HELD_BAND = 3;

const PLAYER: Player = { id: 'session-a', token: 'token-a', name: 'A' };

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
}

function boot(): Harness {
  resetManaState();

  const world = worldWithUnlockedChunks(WORLD_SIZE, HOME_CHUNKS);
  world.setSink(new RecordingSink());
  const host = new PluginHost(world, [manaPlugin, revealPlugin].map(asLoadedPlugin));
  host.worldCreate();
  world.addPlayer(PLAYER);
  host.playerJoined(PLAYER);
  for (const chunk of HOME_CHUNKS) world.seedChunkForToken(PLAYER.token, ...chunk);

  return { world, host };
}

function leg(from: { x: number; y: number } | null): SculptIntent {
  return {
    type: 'sculpt',
    x: LEG_TO.x,
    y: LEG_TO.y,
    radius: BRUSH_RADIUS,
    dir: 1,
    tool: 'drag',
    targetBand: HELD_BAND,
    ...(from === null ? {} : { fromX: from.x, fromY: from.y }),
    seq: 1,
  };
}

function unlockedChunks(world: World): Set<number> {
  const perEdge = chunksPerEdge(WORLD_SIZE);
  const open = new Set<number>();
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      if (world.isChunkUnlockedForToken(PLAYER.token, cx, cy)) open.add(cy * perEdge + cx);
    }
  }
  return open;
}

describe('a sweep opens every chunk it crosses', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('opens a chunk behind the leg that the disc at its end never reaches', () => {
    expect(harness.world.isChunkUnlockedForToken(PLAYER.token, ...BEHIND_CHUNK)).toBe(false);

    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      leg(null),
    );
    expect(harness.world.isChunkUnlockedForToken(PLAYER.token, ...BEHIND_CHUNK)).toBe(false);

    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      leg(LEG_FROM),
    );
    expect(harness.world.isChunkUnlockedForToken(PLAYER.token, ...BEHIND_CHUNK)).toBe(true);
  });

  it('charges the unlock fee for exactly the chunks it opened', () => {
    const intent = leg(LEG_FROM);
    const quoted = openedChunkCount(WORLD_SIZE, strokeSweep(intent), (cx, cy) =>
      harness.world.isChunkUnlockedForToken(PLAYER.token, cx, cy),
    );
    expect(quoted).toBeGreaterThan(0);

    const before = unlockedChunks(harness.world);
    handleSculptIntent({ world: harness.world, interceptors: harness.host }, PLAYER, intent);
    const after = unlockedChunks(harness.world);

    let newlyOpened = 0;
    for (const index of after) if (!before.has(index)) newlyOpened++;

    expect(newlyOpened).toBe(quoted);
    expect(MANA_CAPACITY - (manaBalanceOf(PLAYER.id) ?? 0)).toBe(quoted * CHUNK_UNLOCK_MANA);
  });
});
