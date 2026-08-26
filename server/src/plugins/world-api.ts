// Builds the per-plugin WorldApi view.
//
// One instance per plugin, because the instance carries the plugin's message
// namespace. Everything else delegates straight to the World, so a plugin edit
// is indistinguishable from a player edit as far as sync and anti-cheat are
// concerned — that is the point.

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
import type { WorldApi } from './types.ts';

/**
 * The sculpt options every plugin terraform runs, via WorldApi.sculpt.
 *
 * Exported so the relics footprint tests can run the EXACT options the
 * production path runs, instead of restating them and drifting (the same
 * one-place argument as sculptOptionsOf in shared/src/protocol.ts).
 */
export const PLUGIN_SCULPT_OPTIONS: SculptOptions = {
  tool: 'smooth',
  profile: 'soft',
  spill: 'banded',
};

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

/**
 * The World + host listener a WorldApi is currently bound to, or null once it
 * has been revoked. Holding BOTH in one cell is what makes revoke a single
 * assignment that provably drops every strong reference the view had.
 */
interface WorldApiBinding {
  readonly world: World;
  readonly listener: TerrainChangeListener & ChunkUnlockListener & WorldEventListener;
}

/**
 * A plugin's view of a world, plus the host's handle to switch it off.
 *
 * WHY THE PAIR EXISTS (issue #164). A WorldApi used to close over one World
 * forever, and several plugins stash theirs at module scope, assigned only in
 * `onWorldCreate`. Once a plugin can be disabled for a world, the disabled
 * plugin never reassigns and its stale module-scope reference pins the World
 * it last saw — heightmap, mask and every per-player token mask, ~12.6 MB at
 * DEFAULT_WORLD_SIZE — for the life of the process. So the World is held in a
 * mutable cell that the owner of the view (the PluginHost, via `closeSession`)
 * can clear: a stale reference then pins this small stub and nothing else.
 *
 * `revoke` is idempotent, because the close path may run more than once for a
 * session that failed halfway.
 */
export interface RevocableWorldApi {
  readonly api: WorldApi;
  /** Unbinds the view from its World. Safe to call more than once. */
  revoke(): void;
}

/**
 * The world-file rows recorded for ONE plugin, keyed by setting key.
 *
 * Handed in already narrowed to the plugin this view belongs to — see
 * `WorldApi.setting` for why a view can never see a sibling's rows.
 */
export type PluginSettings = Readonly<Record<string, string>>;

/** A world nobody has configured: every `setting` read answers undefined. */
export const NO_PLUGIN_SETTINGS: PluginSettings = Object.freeze({});

export function createWorldApi(
  world: World,
  listener: TerrainChangeListener & ChunkUnlockListener & WorldEventListener,
  pluginName: string,
  settings: PluginSettings = NO_PLUGIN_SETTINGS,
): RevocableWorldApi {
  let binding: WorldApiBinding | null = { world, listener };

  /**
   * The bound world/listener, or a throw naming the plugin and the member it
   * reached for.
   *
   * THROWS RATHER THAN NO-OPS (owner decision, 2026-08-25): a plugin touching
   * a world that is no longer loaded is a bug in that plugin, and a silent
   * no-op would let it run on invisibly against nothing. Every plugin call
   * goes through `PluginHost.safely`, which turns the throw into a logged
   * skip — loud in the log, harmless to the world that IS loaded.
   */
  const bound = (member: string): WorldApiBinding => {
    if (binding === null) {
      throw new Error(
        `plugin "${pluginName}" called WorldApi.${member} after its world was closed`,
      );
    }
    return binding;
  };

  const api: WorldApi = {
    get worldSize(): number {
      return bound('worldSize').world.size;
    },
    get chunksPerEdge(): number {
      return bound('chunksPerEdge').world.chunksPerEdge;
    },
    // A getter like the rest, though the World's own field is readonly: keeping
    // the whole surface one shape means no reader has to know which of these
    // could move.
    get difficulty(): number {
      return bound('difficulty').world.difficulty;
    },
    // A GETTER, and here that is load-bearing rather than cosmetic: this one
    // genuinely moves every tick, so a captured value would freeze a plugin's
    // calendar at whatever time it first read.
    get simMillis(): number {
      return bound('simMillis').world.simMillis;
    },
    // A getter for the opposite reason to simMillis's: this one is fixed for
    // the world's whole life, but it is STAMPED at the boot seam after the
    // World is built, so a captured value could be captured before the stamp.
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
    riverNetwork(): RiverNetwork {
      return bound('riverNetwork').world.riverNetwork();
    },
    // A GETTER, so the freshwater map is resolved at the moment a mover asks
    // rather than frozen when this view was built. A WorldApi outlives every
    // sculpt the plugin host will ever see; capturing `world.freshwaterMap()`
    // into a plain property here would hand every plugin the rivers as they
    // stood at plugin-load time and never update them again.
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
      // Same service the intent pipeline uses: filtered broadcast included.
      //
      // Options are EXPLICIT, not the shared library default. The library
      // default is smooth + soft with 'free' (unbounded) spill — and after
      // the 2026-08-20 re-terrace halved MAX_STEP, an unbounded relaxation
      // sweep regrades every now-over-steep pre-existing slope for dozens of
      // cells around a cast: one Genesis cast measurably changed 11,673 cells
      // with a max single-cell delta of 1,772 (a player stroke changes 5–108
      // cells). Banded spill caps every outside-footprint cell to its
      // pre-stroke terrace band (issue #26's fairness rule), which is the
      // same containment every PLAYER sculpt already runs. The old "tuned
      // against free spill" compatibility argument no longer holds — that
      // tuning was invalidated by the re-terrace itself.
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
      // Only on a REAL unlock (see types.ts's doc comment): the World call is
      // already idempotent per token, and re-running every plugin's targeted
      // refresh for a chunk that token already had would be pure waste.
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
          if (live.world.isCellVisibleTo(player.id, x, y)) visible.push(item);
        }
        if (skipEmpty && visible.length === 0) continue;

        live.world.sendRawTo(player.id, wireType, buildPayload(visible));
      }
    },
    setting(key: string): string | undefined {
      // NOT GATED ON `bound`, deliberately, and it is the only member that is
      // not: a setting is the world's CONFIGURATION, captured when this view
      // was built, not a read of the World the view can outlive. Answering it
      // after a close costs nothing and reads nothing that has gone away —
      // whereas throwing here would punish a plugin for asking, in its own
      // close hook, which rule it had been running.
      return Object.hasOwn(settings, key) ? settings[key] : undefined;
    },
    emitEvent(type: string, payload: unknown): void {
      // Namespaced exactly like broadcast/sendTo, and for the same reason: the
      // emitter's name is stamped HERE, so no plugin can forge another's events.
      bound('emitEvent').listener.notifyWorldEvent(
        namespacedMessageType(pluginName, type),
        payload,
      );
    },
  };

  return {
    api,
    // Drops the World and the host listener together. After this the closure
    // holds only `pluginName` and the (now null) cell, so a plugin's stale
    // module-scope reference costs a few bytes instead of a heightmap.
    revoke(): void {
      binding = null;
    },
  };
}
