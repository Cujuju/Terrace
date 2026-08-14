// Builds the per-plugin WorldApi view.
//
// One instance per plugin, because the instance carries the plugin's message
// namespace. Everything else delegates straight to the World, so a plugin edit
// is indistinguishable from a player edit as far as sync and anti-cheat are
// concerned — that is the point.

import type { CellDiff } from '@terrace/shared';
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

export function createWorldApi(
  world: World,
  listener: TerrainChangeListener,
  pluginName: string,
): WorldApi {
  return {
    get worldSize(): number {
      return world.size;
    },
    get chunksPerEdge(): number {
      return world.chunksPerEdge;
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
    players(): readonly Player[] {
      return world.players();
    },
    broadcast(type: string, payload: unknown): void {
      world.broadcastRaw(namespacedMessageType(pluginName, type), payload);
    },
    sendTo(playerId: string, type: string, payload: unknown): void {
      world.sendRawTo(playerId, namespacedMessageType(pluginName, type), payload);
    },
  };
}
