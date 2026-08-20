// Builds the per-plugin WorldApi view.
//
// One instance per plugin, because the instance carries the plugin's message
// namespace. Everything else delegates straight to the World, so a plugin edit
// is indistinguishable from a player edit as far as sync and anti-cheat are
// concerned — that is the point.

import type { CellDiff, RiverNetwork } from '@terrace/shared';
import type { Player } from '../player.ts';
import type { TerrainChangeListener } from '../world/sculpt-service.ts';
import { applyServerSculpt } from '../world/sculpt-service.ts';
import type { World } from '../world/world.ts';
import type { WorldApi } from './types.ts';

/** Separator between a plugin's name and its message type on the wire. */
export const PLUGIN_MESSAGE_SEPARATOR = ':';

/** `reveal` + `unlocked` → `reveal:unlocked`. */
export function namespacedMessageType(pluginName: string, type: string): string {
  return `${pluginName}${PLUGIN_MESSAGE_SEPARATOR}${type}`;
}

/**
 * The second thing (issue #18, alongside sculpt-service.ts's
 * TerrainChangeListener) a plugin's edits need to reach back into the plugin
 * host for: fanning `onChunkUnlockedForToken` out to every plugin after a
 * successful per-token unlock. Kept as its own interface rather than folded
 * into TerrainChangeListener — that one is sculpt-service.ts's own narrow
 * contract for an unrelated event, and giving it a second, unrelated method
 * would blur what it means to implement it.
 */
export interface ChunkUnlockListener {
  notifyChunkUnlockedForToken(token: string, cx: number, cy: number): void;
}

/**
 * The third reach-back (2026-08-19, alongside terrain changes and per-token
 * unlocks): fanning a plugin's `emitEvent` out to every plugin's
 * `onWorldEvent`. Its own interface for the same reason ChunkUnlockListener
 * is — each listener contract names exactly one event, so an implementer
 * cannot half-implement the pair.
 */
export interface WorldEventListener {
  notifyWorldEvent(event: string, payload: unknown): void;
}

export function createWorldApi(
  world: World,
  listener: TerrainChangeListener & ChunkUnlockListener & WorldEventListener,
  pluginName: string,
): WorldApi {
  return {
    get worldSize(): number {
      return world.size;
    },
    get chunksPerEdge(): number {
      return world.chunksPerEdge;
    },
    // A getter like the rest, though the World's own field is readonly: keeping
    // the whole surface one shape means no reader has to know which of these
    // could move.
    get difficulty(): number {
      return world.difficulty;
    },
    heightAt(x: number, y: number): number {
      return world.heightAt(x, y);
    },
    isCellUnlocked(x: number, y: number): boolean {
      return world.isCellUnlocked(x, y);
    },
    isChunkUnlocked(cx: number, cy: number): boolean {
      return world.isChunkUnlocked(cx, cy);
    },
    riverNetwork(): RiverNetwork {
      return world.riverNetwork();
    },
    isChunkVisibleTo(playerId: string, cx: number, cy: number): boolean {
      return world.isChunkVisibleTo(playerId, cx, cy);
    },
    isCellVisibleTo(playerId: string, x: number, y: number): boolean {
      return world.isCellVisibleTo(playerId, x, y);
    },
    sculpt(x: number, y: number, radius: number, amount: number): CellDiff[] {
      // Same service the intent pipeline uses: filtered broadcast included.
      // No options argument ON PURPOSE — that is the shared library's
      // compatibility default (smooth + soft), which is the behaviour every
      // plugin terraform was tuned against. See WorldApi.sculpt in types.ts.
      return applyServerSculpt(world, listener, x, y, radius, amount);
    },
    unlockChunk(cx: number, cy: number): boolean {
      return world.unlockChunk(cx, cy);
    },
    unlockChunkForToken(token: string, cx: number, cy: number): boolean {
      const unlocked = world.unlockChunkForToken(token, cx, cy);
      // Only on a REAL unlock (see types.ts's doc comment): the World call is
      // already idempotent per token, and re-running every plugin's targeted
      // refresh for a chunk that token already had would be pure waste.
      if (unlocked) listener.notifyChunkUnlockedForToken(token, cx, cy);
      return unlocked;
    },
    players(): readonly Player[] {
      return world.players();
    },
    broadcast(type: string, payload: unknown): void {
      world.broadcastRaw(namespacedMessageType(pluginName, type), payload);
    },
    sendTo(playerId: string, type: string, payload: unknown): void {
      world.sendRawTo(playerId, namespacedMessageType(pluginName, type), payload);
    },
    broadcastVisible<T>(
      type: string,
      items: readonly T[],
      positionOf: (item: T) => { readonly x: number; readonly y: number },
      buildPayload: (visible: readonly T[]) => unknown,
      options?: { readonly skipEmpty?: boolean; readonly onlyPlayerId?: string },
    ): void {
      const skipEmpty = options?.skipEmpty ?? false;
      const onlyPlayerId = options?.onlyPlayerId;
      const wireType = namespacedMessageType(pluginName, type);

      for (const player of world.players()) {
        if (onlyPlayerId !== undefined && player.id !== onlyPlayerId) continue;

        const visible: T[] = [];
        for (const item of items) {
          const { x, y } = positionOf(item);
          if (world.isCellVisibleTo(player.id, x, y)) visible.push(item);
        }
        if (skipEmpty && visible.length === 0) continue;

        world.sendRawTo(player.id, wireType, buildPayload(visible));
      }
    },
    emitEvent(type: string, payload: unknown): void {
      // Namespaced exactly like broadcast/sendTo, and for the same reason: the
      // emitter's name is stamped HERE, so no plugin can forge another's events.
      listener.notifyWorldEvent(namespacedMessageType(pluginName, type), payload);
    },
  };
}
