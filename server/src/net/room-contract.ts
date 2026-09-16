import type { Client } from '@colyseus/core';
import type {
  PerfLoggingStateMessage,
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  RestorePointListMessage,
  RollbackResultMessage,
  ServerRestartNoticeMessage,
  TerrainDiffMessage,
  WorldAdminResultMessage,
  WorldListMessage,
  WorldPluginListMessage,
  WorldSwitchNoticeMessage,
  WorldUnloadedMessage,
} from '@terrace/shared';
import type { Player } from '../player.ts';
import type { ServerRestartService } from '../restart.ts';
import type { PerfLoggingSetting } from '../perf-logging-setting.ts';
import type { WorldAdminService } from '../world/world-admin.ts';
import type { WorldManager } from '../world/world-manager.ts';

export const ROOM_NAME = 'world';

export const SCULPT_MESSAGE_TYPE = 'sculpt';

export const RESTORE_POINTS_MESSAGE_TYPE = 'restorePoints';
export const ROLLBACK_MESSAGE_TYPE = 'rollback';

export const WORLD_ADMIN_MESSAGE_TYPES = [
  'worldList',
  'worldCreate',
  'worldLoad',
  'worldUnload',
  'worldRename',
  'worldDuplicate',
  'worldArchive',
  'worldUnarchive',
  'worldPurge',
  'worldPin',
  'worldPluginList',
  'worldPluginSet',
  'worldPluginConfigure',
  'worldPluginAct',
  'worldPluginReload',
  'serverRestart',
  'worldSwitchCancel',
  'worldView',
] as const;

export interface TerraceServerMessages {
  snapshot: JoinSnapshotMessage;
  terrainDiff: TerrainDiffMessage;
  chunkUnlock: ChunkUnlockMessage;
  restorePointList: RestorePointListMessage;
  rollbackResult: RollbackResultMessage;
  worldListing: WorldListMessage;
  worldAdminResult: WorldAdminResultMessage;
  worldPluginListing: WorldPluginListMessage;
  worldSwitchNotice: WorldSwitchNoticeMessage;
  serverRestartNotice: ServerRestartNoticeMessage;
  worldUnloaded: WorldUnloadedMessage;
  perfLoggingState: PerfLoggingStateMessage;
  [pluginMessage: string]: unknown;
}

export type TerraceClient = Client<{
  userData: { player: Player };
  messages: TerraceServerMessages;
}>;

export interface RoomContext {
  readonly manager: WorldManager;
  readonly admin: WorldAdminService;
  readonly restart: ServerRestartService;
  readonly perfLogging: PerfLoggingSetting;
}

let processRoomContext: RoomContext | null = null;

export function bindRoomContext(context: RoomContext): void {
  processRoomContext = context;
}

export function boundRoomContext(): RoomContext | null {
  return processRoomContext;
}
