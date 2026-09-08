import type { CellDiff, FreshwaterMap, RiverNetwork, SculptIntent } from '@terrace/shared';
import type { Player } from '../player.ts';

export type { Player };

export type SiblingModule = Readonly<Record<string, unknown>>;

export interface WorldApi {
  readonly worldSize: number;
  readonly chunksPerEdge: number;

  readonly difficulty: number;

  readonly simMillis: number;

  readonly genesisMillis: number;

  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
  isChunkUnlocked(cx: number, cy: number): boolean;
  isChunkUnlockedForToken(token: string, cx: number, cy: number): boolean;

  riverNetwork(): RiverNetwork;

  readonly freshwater: FreshwaterMap;

  isChunkVisibleTo(playerId: string, cx: number, cy: number): boolean;
  isCellVisibleTo(playerId: string, x: number, y: number): boolean;

  sculpt(x: number, y: number, radius: number, amount: number): CellDiff[];

  unlockChunk(cx: number, cy: number): boolean;

  unlockChunkForToken(token: string, cx: number, cy: number): boolean;

  players(): readonly Player[];

  broadcast(type: string, payload: unknown): void;
  sendTo(playerId: string, type: string, payload: unknown): void;

  broadcastVisible<T>(
    type: string,
    items: readonly T[],
    positionOf: (item: T) => { readonly x: number; readonly y: number },
    buildPayload: (visible: readonly T[]) => unknown,
    options?: {
      readonly skipEmpty?: boolean;
      readonly onlyPlayerId?: string;
    },
  ): void;

  emitEvent(type: string, payload: unknown): void;

  setting(key: string): string | undefined;

  sibling(name: string): SiblingModule | null;
}

export interface IntentCtx {
  readonly player: Player;
  readonly world: WorldApi;
}

export type IntentVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'modify'; readonly intent: SculptIntent };

export const ALLOW: IntentVerdict = { kind: 'allow' };

export type PluginMessageHandler = (
  world: WorldApi,
  player: Player,
  payload: unknown,
) => void;

export type SliceLoadOutcome = void | 'refuse';

export interface PersistenceSlice {
  readonly version: number;
  save(): unknown;
  load(data: unknown, fromVersion: number): SliceLoadOutcome;
}

export interface PluginSettingDeclaration {
  readonly key: string;
  readonly values: readonly string[];
  readonly defaultValue: string;
}

export interface PluginActionDeclaration {
  readonly key: string;
  readonly label: string;
  readonly description: string;
}

export interface PluginActionSite {
  readonly x: number;
  readonly y: number;
}

export type PluginActionOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly detail: string };

export interface TerracePlugin {
  readonly name: string;

  readonly actions?: readonly PluginActionDeclaration[];

  readonly archetype?: string;

  onAction?(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome;

  readonly settings?: readonly PluginSettingDeclaration[];

  onWorldCreate?(world: WorldApi): void;

  onWorldClose?(world: WorldApi): void;

  onTick?(world: WorldApi, dt: number): void;

  onIntent?(intent: SculptIntent, ctx: IntentCtx): IntentVerdict | void;

  onIntentApplied?(
    intent: SculptIntent,
    ctx: IntentCtx,
    diff: readonly CellDiff[],
  ): void;

  onIntentDenied?(intent: SculptIntent, ctx: IntentCtx): void;

  onTerrainChanged?(world: WorldApi, diff: readonly CellDiff[], sculptorToken?: string): void;

  onPlayerJoin?(world: WorldApi, player: Player): void;
  onPlayerLeave?(world: WorldApi, player: Player): void;

  onChunkUnlockedForToken?(world: WorldApi, token: string, cx: number, cy: number): void;

  onWorldEvent?(world: WorldApi, event: string, payload: unknown): void;

  readonly messages?: Readonly<Record<string, PluginMessageHandler>>;

  readonly persistence?: PersistenceSlice;

}

export interface LoadedPlugin {
  readonly plugin: TerracePlugin;
  readonly directory: string;
  readonly entryPath: string;
  readonly version: string;
  readonly exports: SiblingModule;
}
