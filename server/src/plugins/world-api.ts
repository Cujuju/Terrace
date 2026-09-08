import type {
  CellDiff,
  FreshwaterMap,
  RiverNetwork,
  SculptOptions,
} from '@terrace/shared';
import type { Player } from '../player.ts';
import type { TerrainChangeListener } from '../world/sculpt-service.ts';
import { applyServerSculpt } from '../world/sculpt-service.ts';
import type { World } from '../world/world.ts';
import type { SiblingModule, WorldApi } from './types.ts';

export const PLUGIN_SCULPT_OPTIONS: SculptOptions = {
  tool: 'smooth',
  profile: 'soft',
  spill: 'banded',
};

export const PLUGIN_MESSAGE_SEPARATOR = ':';

export function namespacedMessageType(pluginName: string, type: string): string {
  return `${pluginName}${PLUGIN_MESSAGE_SEPARATOR}${type}`;
}

export interface ChunkUnlockListener {
  notifyChunkUnlockedForToken(token: string, cx: number, cy: number): void;
}

export interface WorldEventListener {
  notifyWorldEvent(event: string, payload: unknown): void;
}

interface WorldApiBinding {
  readonly world: World;
  readonly listener: TerrainChangeListener & ChunkUnlockListener & WorldEventListener;
}

export interface RevocableWorldApi {
  readonly api: WorldApi;
  revoke(): void;
}

export type PluginSettings = Readonly<Record<string, string>>;

export const NO_PLUGIN_SETTINGS: PluginSettings = Object.freeze({});

export type SiblingResolver = (name: string) => SiblingModule | null;

export const NO_SIBLINGS: SiblingResolver = () => null;

function isInsideWorld(worldSize: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < worldSize && y < worldSize;
}

export function createWorldApi(
  world: World,
  listener: TerrainChangeListener & ChunkUnlockListener & WorldEventListener,
  pluginName: string,
  settings: PluginSettings = NO_PLUGIN_SETTINGS,
  resolveSibling: SiblingResolver = NO_SIBLINGS,
): RevocableWorldApi {
  let binding: WorldApiBinding | null = { world, listener };

  const bound = (member: string): WorldApiBinding => {
    if (binding === null) {
      throw new Error(
        `plugin "${pluginName}" called WorldApi.${member} after its world was closed`,
      );
    }
    return binding;
  };

  const api: WorldApi = {
    worldSize: world.size,
    chunksPerEdge: world.chunksPerEdge,
    difficulty: world.difficulty,
    get simMillis(): number {
      return bound('simMillis').world.simMillis;
    },
    get genesisMillis(): number {
      return bound('genesisMillis').world.genesisMillis;
    },
    heightAt(x: number, y: number): number {
      return bound('heightAt').world.heightAt(x, y);
    },
    isCellUnlocked(x: number, y: number): boolean {
      return bound('isCellUnlocked').world.isCellUnlocked(x, y);
    },
    isChunkUnlocked(cx: number, cy: number): boolean {
      return bound('isChunkUnlocked').world.isChunkUnlocked(cx, cy);
    },
    isChunkUnlockedForToken(token: string, cx: number, cy: number): boolean {
      return bound('isChunkUnlockedForToken').world.isChunkUnlockedForToken(token, cx, cy);
    },
    riverNetwork(): RiverNetwork {
      return bound('riverNetwork').world.riverNetwork();
    },
    get freshwater(): FreshwaterMap {
      return bound('freshwater').world.freshwaterMap();
    },
    isChunkVisibleTo(playerId: string, cx: number, cy: number): boolean {
      return bound('isChunkVisibleTo').world.isChunkVisibleTo(playerId, cx, cy);
    },
    isCellVisibleTo(playerId: string, x: number, y: number): boolean {
      return bound('isCellVisibleTo').world.isCellVisibleTo(playerId, x, y);
    },
    sculpt(x: number, y: number, radius: number, amount: number): CellDiff[] {
      const live = bound('sculpt');
      return applyServerSculpt(
        live.world,
        live.listener,
        x,
        y,
        radius,
        amount,
        PLUGIN_SCULPT_OPTIONS,
      );
    },
    unlockChunk(cx: number, cy: number): boolean {
      return bound('unlockChunk').world.unlockChunk(cx, cy);
    },
    unlockChunkForToken(token: string, cx: number, cy: number): boolean {
      const live = bound('unlockChunkForToken');
      const unlocked = live.world.unlockChunkForToken(token, cx, cy);
      if (unlocked) live.listener.notifyChunkUnlockedForToken(token, cx, cy);
      return unlocked;
    },
    players(): readonly Player[] {
      return bound('players').world.players();
    },
    broadcast(type: string, payload: unknown): void {
      bound('broadcast').world.broadcastRaw(namespacedMessageType(pluginName, type), payload);
    },
    sendTo(playerId: string, type: string, payload: unknown): void {
      bound('sendTo').world.sendRawTo(playerId, namespacedMessageType(pluginName, type), payload);
    },
    broadcastVisible<T>(
      type: string,
      items: readonly T[],
      positionOf: (item: T) => { readonly x: number; readonly y: number },
      buildPayload: (visible: readonly T[]) => unknown,
      options?: { readonly skipEmpty?: boolean; readonly onlyPlayerId?: string },
    ): void {
      const live = bound('broadcastVisible');
      const skipEmpty = options?.skipEmpty ?? false;
      const onlyPlayerId = options?.onlyPlayerId;
      const wireType = namespacedMessageType(pluginName, type);

      for (const player of live.world.players()) {
        if (onlyPlayerId !== undefined && player.id !== onlyPlayerId) continue;

        const visible: T[] = [];
        for (const item of items) {
          const { x, y } = positionOf(item);
          if (!isInsideWorld(live.world.size, x, y)) continue;
          if (live.world.isCellVisibleTo(player.id, x, y)) visible.push(item);
        }
        if (skipEmpty && visible.length === 0) continue;

        live.world.sendRawTo(player.id, wireType, buildPayload(visible));
      }
    },
    setting(key: string): string | undefined {
      return Object.hasOwn(settings, key) ? settings[key] : undefined;
    },
    sibling(name: string): SiblingModule | null {
      bound('sibling');
      return resolveSibling(name);
    },
    emitEvent(type: string, payload: unknown): void {
      bound('emitEvent').listener.notifyWorldEvent(
        namespacedMessageType(pluginName, type),
        payload,
      );
    },
  };

  return {
    api,
    revoke(): void {
      binding = null;
    },
  };
}
