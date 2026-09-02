// reveal, driven through the REAL intent pipeline and the REAL plugin host with
// both shipped example plugins registered. This is the reveal contract's test: the
// PLUGIN unlocks territory (core never decides when), and — since issue #17 —
// it does so PER PLAYER: a chunk streams only to the token that earned it.

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

/** 64² cells = 4×4 chunks. */
const WORLD_SIZE = 64;

/** The shared home chunk; cells (16..31, 16..31). Every player starts here. */
const HOME_CHUNK: readonly [number, number] = [1, 1];

/** The locked chunk east of home; cells (32..47, 16..31). */
const FRONTIER_CHUNK: readonly [number, number] = [2, 1];

/** Border column of HOME_CHUNK — sculpting here reaches into FRONTIER_CHUNK. */
const BORDER_CELL = { x: 31, y: 24 } as const;

/** Centre of HOME_CHUNK, 8 cells from every border. */
const INTERIOR_CELL = { x: 24, y: 24 } as const;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

/** Safety cap on the regen wait, so a broken economy fails instead of hanging. */
const MAX_REGEN_TICKS = 1000;

const PLAYER_A: Player = { id: 'session-a', token: 'token-a', name: 'A' };
const PLAYER_B: Player = { id: 'session-b', token: 'token-b', name: 'B' };

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/**
 * Boots both example plugins in real discovery order (mana, then reveal),
 * with every listed player joined AND seeded into HOME_CHUNK's own per-token
 * mask — mirroring what a real join does via applyInitialUnlockForToken
 * (terrace-room.ts), since this harness bypasses the room entirely.
 * `worldWithUnlockedChunks` only sets the union mask, which is deliberately
 * NOT what per-player sculpt-permission or streaming reads (see
 * World.isCellUnlocked's doc comment) — so without this seeding step no
 * listed player could even aim a brush at HOME_CHUNK's cells as themselves.
 */
function boot(players: readonly Player[], extraPlugins: readonly TerracePlugin[] = []): Harness {
  resetManaState();

  const world = worldWithUnlockedChunks(WORLD_SIZE, [HOME_CHUNK]);
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
    world.seedChunkForToken(player.token, ...HOME_CHUNK);
  }

  // The seed above is silent (World.seedChunkForToken never sends), and
  // reveal/mana emit nothing from onPlayerJoin either — but clear anyway so
  // every test starts from a genuinely empty sink, independent of how many
  // players booted.
  sink.clear();

  return { world, host, sink };
}

/**
 * One sculpt, paid for by `player`. The mana plugin is live in this host, so
 * the test ticks the world forward until that player can afford the edit —
 * exactly what a real player does, and proves the two plugins compose rather
 * than merely coexist.
 */
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

      // No threshold: one sculpt that spills into the frontier is enough.
      expect(harness.world.isChunkUnlockedForToken(PLAYER_A.token, ...FRONTIER_CHUNK)).toBe(true);
      expect(harness.world.isChunkUnlocked(...FRONTIER_CHUNK)).toBe(true); // union OR'd too

      const streamed = harness.sink.ofType('chunkUnlock');
      expect(streamed).toHaveLength(1);
      // TARGETED, not a broadcast (issue #17 decision 2).
      expect(streamed[0].target).toBe(PLAYER_A.id);
      expect(streamed[0].payload).toMatchObject({
        type: 'chunkUnlock',
        chunks: [{ cx: FRONTIER_CHUNK[0], cy: FRONTIER_CHUNK[1] }],
      });
    });

    it('reveals nothing when the sculpting stays away from the border', () => {
      expect(paidSculpt(harness, PLAYER_A, INTERIOR_CELL.x, INTERIOR_CELL.y, 4).applied).toBe(true);

      expect(harness.sink.ofType('chunkUnlock')).toHaveLength(0);
      for (let cy = 0; cy < WORLD_SIZE / 16; cy++) {
        for (let cx = 0; cx < WORLD_SIZE / 16; cx++) {
          if (cx === HOME_CHUNK[0] && cy === HOME_CHUNK[1]) continue;
          expect(harness.world.isChunkUnlockedForToken(PLAYER_A.token, cx, cy)).toBe(false);
        }
      }
    });

    it('does not re-stream a chunk the sculptor already has', () => {
      // HOME_CHUNK is already unlocked for A (seeded by boot()) — sculpting
      // deep inside it must not fire a redundant unlockChunkForToken.
      expect(paidSculpt(harness, PLAYER_A, INTERIOR_CELL.x, INTERIOR_CELL.y, 1).applied).toBe(true);
      expect(harness.sink.ofType('chunkUnlock')).toHaveLength(0);
    });

    it('unlocks nothing from an intent another plugin denied', () => {
      // Drain A's wallet completely so mana denies the next sculpt outright.
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

      // Broke: a border sculpt is now denied by mana before it ever reaches
      // the terrain, so onTerrainChanged never fires and nothing unlocks.
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
      // A third plugin, IN THE SAME HOST as reveal, whose own edit reaches
      // into the frontier via WorldApi.sculpt — the same path any other
      // terraforming plugin (weather, structures) uses. That call carries no
      // player, so sculpt-service.ts hands onTerrainChanged `sculptorToken:
      // undefined`, and reveal's own guard clause must treat that as "nobody
      // to creep for" rather than falling back to some default identity.
      let api: WorldApi | undefined;
      const terraformer: TerracePlugin = {
        name: 'terraformer',
        onWorldCreate(world) {
          api = world;
        },
      };
      harness = boot([PLAYER_A], [terraformer]);
      if (api === undefined) throw new Error('onWorldCreate was never called');

      api.sculpt(BORDER_CELL.x, BORDER_CELL.y, 4, 64); // real terrain change, no sculptor

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
      expect(streamed).toHaveLength(1);
      expect(streamed[0].target).toBe(PLAYER_A.id);
      expect(streamed.some((m) => m.target === PLAYER_B.id)).toBe(false);
      expect(streamed.some((m) => m.target === 'broadcast')).toBe(false);
    });

    it('lets B earn the same frontier chunk independently, later, for themselves', () => {
      paidSculpt(harness, PLAYER_A, BORDER_CELL.x, BORDER_CELL.y, 4);
      harness.sink.clear();

      expect(paidSculpt(harness, PLAYER_B, BORDER_CELL.x, BORDER_CELL.y, 4).applied).toBe(true);

      expect(harness.world.isChunkUnlockedForToken(PLAYER_B.token, ...FRONTIER_CHUNK)).toBe(true);
      const streamed = harness.sink.ofType('chunkUnlock');
      expect(streamed).toHaveLength(1);
      expect(streamed[0].target).toBe(PLAYER_B.id);
    });
  });
});
