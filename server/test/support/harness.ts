// Shared test scaffolding: an in-memory World with an exact unlock mask, a
// recording MessageSink, and a one-line plugin wrapper. Nothing here touches
// the network or the filesystem.

import { createChunkMask, createHeightmap, chunkIndex, unlockChunk } from '@terrace/shared';
import type { MessageSink } from '../../src/net/message-sink.ts';
import type { LoadedPlugin, TerracePlugin } from '../../src/plugins/types.ts';
import { World } from '../../src/world/world.ts';

export interface RecordedMessage {
  /** 'broadcast', or the player id for a targeted send. */
  readonly target: string;
  readonly type: string;
  readonly payload: unknown;
}

export class RecordingSink implements MessageSink {
  readonly messages: RecordedMessage[] = [];

  broadcast(type: string, payload: unknown): void {
    this.messages.push({ target: 'broadcast', type, payload });
  }

  sendTo(playerId: string, type: string, payload: unknown): void {
    this.messages.push({ target: playerId, type, payload });
  }

  ofType(type: string): RecordedMessage[] {
    return this.messages.filter((message) => message.type === type);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/** Stands in for the name a real snapshot carries; fixed so tests read stably. */
export const TEST_WORLD_NAME = 'Testfall';

/**
 * A flat world with exactly the listed chunks unlocked — bypassing the fresh
 * world's starter region so tests can put a locked chunk exactly where they
 * need one.
 *
 * `difficulty` is the world's WORLD_DIFFICULTY rating; omitted, it is core's
 * default, exactly as an unconfigured deployment would get. Suites whose
 * arithmetic depends on a plugin's difficulty-derived numbers pass one
 * explicitly rather than inheriting whatever the default happens to be.
 *
 * The world is NAMED, because a real snapshot always carries a name and a
 * restore without one is the legacy-upgrade path: that path deliberately mints
 * a name and marks the world dirty (World.restore), which is not the starting
 * state a pipeline or mask test wants to reason about.
 *
 * `fillHeight` starts every cell at that height instead of at SEA_LEVEL, for
 * the suites whose subject is what happens at a height LIMIT (a stroke that
 * clamps everywhere and therefore changes nothing). It lives here rather than
 * in those suites so the mask construction above stays stated once.
 */
export function worldWithUnlockedChunks(
  size: number,
  chunks: ReadonlyArray<readonly [number, number]>,
  difficulty?: number,
  fillHeight?: number,
): World {
  const mask = createChunkMask(size);
  for (const [cx, cy] of chunks) {
    unlockChunk(mask, chunkIndex(size, cx, cy));
  }
  const cells = createHeightmap(size).cells;
  if (fillHeight !== undefined) cells.fill(fillHeight);
  return World.restore(size, cells, mask, difficulty, TEST_WORLD_NAME);
}

/** Wraps a plugin object as if discovery had loaded it from plugins/<name>. */
export function asLoadedPlugin(plugin: TerracePlugin): LoadedPlugin {
  return { plugin, directory: plugin.name, entryPath: `<test>/${plugin.name}/server/index.ts` };
}

/**
 * Grants ONE token every chunk currently in the world's union mask (issue #18
 * fixture support). Per-player masks (issue #17) mean a token sees nothing
 * until it has personally earned each chunk — but most of this repo's plugin
 * suites were written, and still reason, in terms of one player who can see
 * the whole world they built (`worldWithTerrain`'s or `worldWithUnlockedChunks`'s
 * union mask). Call this once for that player's token, right after
 * `world.addPlayer` and BEFORE `host.playerJoined` — the same order the real
 * join path seeds a token's starter square in (world/initial-unlock.ts's
 * applyInitialUnlockForToken), so a plugin's `onPlayerJoin` fog-of-war
 * filtering (issue #18) sees a mask that already matches the test world's
 * union, exactly as every such suite assumed before per-player masks existed.
 */
export function grantTokenEveryUnlockedChunk(world: World, token: string): void {
  const edge = world.chunksPerEdge;
  for (let cy = 0; cy < edge; cy++) {
    for (let cx = 0; cx < edge; cx++) {
      if (!world.isChunkUnlocked(cx, cy)) continue;
      world.unlockChunkForToken(token, cx, cy);
    }
  }
}
