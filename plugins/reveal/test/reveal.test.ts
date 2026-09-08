import type { SculptIntent } from '@terrace/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import {
  MANA_CAPACITY,
  manaCostFor,
  manaBalanceOf,
  plugin as manaPlugin,
  resetManaState,
} from '../../mana/server/index.ts';
import { plugin as revealPlugin } from '../server/index.ts';

const WORLD_SIZE = 128;

const HOME_CHUNKS: ReadonlyArray<readonly [number, number]> = (() => {
  const chunks: Array<readonly [number, number]> = [];
  for (let cy = 1; cy <= 3; cy++) for (let cx = 1; cx <= 3; cx++) chunks.push([cx, cy]);
  return chunks;
})();

const FRONTIER_CHUNK: readonly [number, number] = [4, 2];

const BORDER_CELL = { x: 63, y: 40 } as const;

const BORDER_SCULPT_CHUNKS = 3;

const INTERIOR_CELL = { x: 40, y: 40 } as const;

const TICK_DT = 0.1;

const MAX_REGEN_TICKS = 1000;

const PLAYER_A: Player = { id: 'session-a', token: 'token-a', name: 'A' };
const PLAYER_B: Player = { id: 'session-b', token: 'token-b', name: 'B' };

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

function boot(players: readonly Player[], extraPlugins: readonly TerracePlugin[] = []): Harness {
  resetManaState();

  const world = worldWithUnlockedChunks(WORLD_SIZE, HOME_CHUNKS);
  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(
    world,
    [manaPlugin, revealPlugin, ...extraPlugins].map(asLoadedPlugin),
  );
  host.worldCreate();

  for (const player of players) {
    world.addPlayer(player);
    host.playerJoined(player);
    for (const chunk of HOME_CHUNKS) world.seedChunkForToken(player.token, ...chunk);
  }

  sink.clear();

  return { world, host, sink };
}

function paidSculpt(harness: Harness, player: Player, x: number, y: number, radius: number) {
  const intent: SculptIntent = { type: 'sculpt', x, y, radius, dir: 1 };
  const cost = manaCostFor(player.id, intent);
  let ticks = 0;
  while ((manaBalanceOf(player.id) ?? 0) < cost) {
    harness.host.tick(TICK_DT);
    if (++ticks > MAX_REGEN_TICKS) throw new Error('mana never regenerated');
  }
  return handleSculptIntent(
    { world: harness.world, interceptors: harness.host },
    player,
    intent,
  );
}

describe('reveal plugin', () => {
  let harness: Harness;

  describe('single player', () => {
    beforeEach(() => {
      harness = boot([PLAYER_A]);
    });

    it('unlocks the frontier chunk for the sculptor, instantly, on the very first border sculpt', () => {
      expect(harness.world.isChunkUnlockedForToken(PLAYER_A.token, ...FRONTIER_CHUNK)).toBe(false);

      expect(paidSculpt(harness, PLAYER_A, BORDER_CELL.x, BORDER_CELL.y, 4).applied).toBe(true);

      expect(harness.world.isChunkUnlockedForToken(PLAYER_A.token, ...FRONTIER_CHUNK)).toBe(true);
      expect(harness.world.isChunkUnlocked(...FRONTIER_CHUNK)).toBe(true);

      const streamed = harness.sink.ofType('chunkUnlock');
      expect(streamed).toHaveLength(BORDER_SCULPT_CHUNKS);
      for (const message of streamed) expect(message.target).toBe(PLAYER_A.id);
      expect(
        streamed.some((m) =>
          (m.payload as { chunks: { cx: number; cy: number }[] }).chunks.some(
            (c) => c.cx === FRONTIER_CHUNK[0] && c.cy === FRONTIER_CHUNK[1],
          ),
        ),
      ).toBe(true);
    });

    it('reveals nothing when the sculpting stays away from the border', () => {
      expect(paidSculpt(harness, PLAYER_A, INTERIOR_CELL.x, INTERIOR_CELL.y, 4).applied).toBe(true);

      expect(harness.sink.ofType('chunkUnlock')).toHaveLength(0);
      const home = new Set(HOME_CHUNKS.map(([cx, cy]) => `${cx},${cy}`));
      for (let cy = 0; cy < WORLD_SIZE / 16; cy++) {
        for (let cx = 0; cx < WORLD_SIZE / 16; cx++) {
          if (home.has(`${cx},${cy}`)) continue;
          expect(harness.world.isChunkUnlockedForToken(PLAYER_A.token, cx, cy)).toBe(false);
        }
      }
    });

    it('does not re-stream a chunk the sculptor already has', () => {
      expect(paidSculpt(harness, PLAYER_A, INTERIOR_CELL.x, INTERIOR_CELL.y, 1).applied).toBe(true);
      expect(harness.sink.ofType('chunkUnlock')).toHaveLength(0);
    });

    it('unlocks nothing from an intent another plugin denied', () => {
      const affordable = Math.floor(
        MANA_CAPACITY / manaCostFor(PLAYER_A.id, { type: 'sculpt', ...INTERIOR_CELL, radius: 4, dir: 1 }),
      );
      let drained = 0;
      for (;;) {
        const outcome = handleSculptIntent(
          { world: harness.world, interceptors: harness.host },
          PLAYER_A,
          { type: 'sculpt', x: INTERIOR_CELL.x, y: INTERIOR_CELL.y, radius: 4, dir: drained % 2 === 0 ? 1 : -1 },
        );
        if (!outcome.applied) break;
        expect(++drained).toBeLessThanOrEqual(affordable);
      }

      for (let n = 0; n < 10; n++) {
        const outcome = handleSculptIntent(
          { world: harness.world, interceptors: harness.host },
          PLAYER_A,
          { type: 'sculpt', x: BORDER_CELL.x, y: BORDER_CELL.y, radius: 4, dir: 1 },
        );
        expect(outcome).toMatchObject({ applied: false, reason: 'plugin-denied' });
      }
      expect(harness.world.isChunkUnlockedForToken(PLAYER_A.token, ...FRONTIER_CHUNK)).toBe(false);
    });

    it('does not creep for a plugin-initiated sculpt (no sculptor token)', () => {
      let api: WorldApi | undefined;
      const terraformer: TerracePlugin = {
        name: 'terraformer',
        onWorldCreate(world) {
          api = world;
        },
      };
      harness = boot([PLAYER_A], [terraformer]);
      if (api === undefined) throw new Error('onWorldCreate was never called');

      api.sculpt(BORDER_CELL.x, BORDER_CELL.y, 4, 64);

      expect(harness.world.isChunkUnlockedForToken(PLAYER_A.token, ...FRONTIER_CHUNK)).toBe(false);
      expect(harness.sink.ofType('chunkUnlock')).toHaveLength(0);
    });
  });

  describe('two players (issue #17 decision 2: per-player streaming)', () => {
    beforeEach(() => {
      harness = boot([PLAYER_A, PLAYER_B]);
    });

    it('streams a newly earned chunk to the sculptor only — the other player gets nothing', () => {
      expect(paidSculpt(harness, PLAYER_A, BORDER_CELL.x, BORDER_CELL.y, 4).applied).toBe(true);

      expect(harness.world.isChunkUnlockedForToken(PLAYER_A.token, ...FRONTIER_CHUNK)).toBe(true);
      expect(harness.world.isChunkUnlockedForToken(PLAYER_B.token, ...FRONTIER_CHUNK)).toBe(false);

      const streamed = harness.sink.ofType('chunkUnlock');
      expect(streamed).toHaveLength(BORDER_SCULPT_CHUNKS);
      for (const message of streamed) expect(message.target).toBe(PLAYER_A.id);
      expect(streamed.some((m) => m.target === PLAYER_B.id)).toBe(false);
      expect(streamed.some((m) => m.target === 'broadcast')).toBe(false);
    });

    it('lets B earn the same frontier chunk independently, later, for themselves', () => {
      paidSculpt(harness, PLAYER_A, BORDER_CELL.x, BORDER_CELL.y, 4);
      harness.sink.clear();

      expect(paidSculpt(harness, PLAYER_B, BORDER_CELL.x, BORDER_CELL.y, 4).applied).toBe(true);

      expect(harness.world.isChunkUnlockedForToken(PLAYER_B.token, ...FRONTIER_CHUNK)).toBe(true);
      const streamed = harness.sink.ofType('chunkUnlock');
      expect(streamed).toHaveLength(BORDER_SCULPT_CHUNKS);
      for (const message of streamed) expect(message.target).toBe(PLAYER_B.id);
    });
  });
});
