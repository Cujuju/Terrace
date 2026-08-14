// The plugin contract (design §3.5). Core is terrain sim + sync + persistence +
// this host; everything "gamey" lives behind these types.
//
// The acceptance test for this file is the design's own: reveal-of-territory, a
// mana economy, and a follower stub must each be buildable WITHOUT touching
// core. That is why onIntent is an interceptor chain (a mana plugin vetoes or
// rewrites intents instead of patching the sim) and why plugins get namespaced
// messages plus their own persistence slice.

import type { CellDiff, SculptIntent } from '@terrace/shared';
import type { Player } from '../player.ts';

export type { Player };

/**
 * The surface a plugin gets on the world. Deliberately narrow: read heights and
 * the mask, make edits that go through the same authoritative + filtered path
 * as player intents, unlock chunks, and talk to clients. There is no way to
 * write a raw height — plugins cannot bypass the gradient relaxation any more
 * than a client can.
 *
 * Every instance is bound to one plugin: `broadcast`/`sendTo` namespace the
 * message type with that plugin's name, so two plugins cannot collide on a wire
 * name and no plugin can forge a core message.
 */
export interface WorldApi {
  /** Cells per world edge. */
  readonly worldSize: number;
  /** Chunks per world edge. */
  readonly chunksPerEdge: number;

  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
  isChunkUnlocked(cx: number, cy: number): boolean;

  /**
   * Applies an edit through the authoritative path: shared brush + gradient
   * relaxation, full diff kept server-side, mask-filtered diff broadcast.
   * Returns the full (unfiltered) diff — plugins are trusted server code.
   *
   * ALWAYS THE SMOOTH TOOL WITH A SOFT EDGE, deliberately, and unchanged by the
   * 2026-08-14 brush-tool decision. Player intents now default to the stamp
   * tool, but existing plugins' terraforms were shaped and tuned against
   * relaxation — a plugin that raises a hill expects the land to flow. Changing
   * this default would silently re-tune every installed plugin, so it stays,
   * and the signature stays with it. If a plugin ever needs a stamp, that is an
   * additive optional options argument here, decided with the owner then.
   */
  sculpt(x: number, y: number, radius: number, amount: number): CellDiff[];

  /** Unlocks a chunk and streams it to clients. False if already unlocked. */
  unlockChunk(cx: number, cy: number): boolean;

  players(): readonly Player[];

  /** Sends `<pluginName>:<type>` to every client. */
  broadcast(type: string, payload: unknown): void;
  /** Sends `<pluginName>:<type>` to one player. */
  sendTo(playerId: string, type: string, payload: unknown): void;
}

/** Context handed to onIntent alongside the intent itself. */
export interface IntentCtx {
  readonly player: Player;
  readonly world: WorldApi;
}

/**
 * An interceptor's answer. `deny` stops the chain immediately (first deny
 * wins); `modify` replaces the intent and the REPLACEMENT flows to the next
 * interceptor, so plugins compose. A plugin that returns nothing is treated as
 * allow, which keeps trivial hooks trivial.
 */
export type IntentVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'modify'; readonly intent: SculptIntent };

/** Convenience constant for the common case. */
export const ALLOW: IntentVerdict = { kind: 'allow' };

/** Handler for a namespaced client → server plugin message. */
export type PluginMessageHandler = (
  world: WorldApi,
  player: Player,
  payload: unknown,
) => void;

/**
 * Plugin-owned data included in world snapshots and restored on boot.
 * `save()` must return a JSON-serializable value (it is stored as JSON text
 * next to the heightmap blob); `load()` receives back exactly what `save()`
 * produced, or is never called if this plugin had no slice in that snapshot.
 */
export interface PersistenceSlice {
  save(): unknown;
  load(data: unknown): void;
}

export interface TerracePlugin {
  /**
   * Unique, stable identifier. Also the message namespace, so it is restricted
   * to lowercase alphanumerics and dashes (see PLUGIN_NAME_PATTERN).
   */
  readonly name: string;

  /** World is ready — already restored from a snapshot if one existed. */
  onWorldCreate?(world: WorldApi): void;

  /** Fixed-rate sim step. `dt` is the constant tick period in seconds. */
  onTick?(world: WorldApi, dt: number): void;

  /** Interceptor chain: allow / deny / modify. See IntentVerdict. */
  onIntent?(intent: SculptIntent, ctx: IntentCtx): IntentVerdict | void;

  /** Fired after any applied edit, with the FULL server-side diff. */
  onTerrainChanged?(diff: readonly CellDiff[]): void;

  onPlayerJoin?(player: Player): void;
  onPlayerLeave?(player: Player): void;

  /** Namespaced client → server handlers, keyed by the un-namespaced type. */
  readonly messages?: Readonly<Record<string, PluginMessageHandler>>;

  /** Plugin-owned snapshot data. */
  readonly persistence?: PersistenceSlice;

  // state?: SchemaSlice;
  // DELIBERATELY ABSENT IN PHASE 1. The design sketch (§3.5) included a
  // plugin-owned Colyseus schema slice, but decision Q7 (2026-08-13) rules that
  // terrain never travels as schema state, and Phase 1 core has no other
  // synced state to anchor the feature on. Plugins that need synced state today
  // use `messages`. Add this slot when a real plugin needs it, together with the
  // room-side wiring — an untested empty hook is worse than no hook.
}

/** A discovered plugin plus where it came from (used in logs and errors). */
export interface LoadedPlugin {
  readonly plugin: TerracePlugin;
  /** Directory name under plugins/ — also the alphabetical sort key. */
  readonly directory: string;
  /** Absolute path of the server entry module that was imported. */
  readonly entryPath: string;
}
