import type {
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  RestorePointListMessage,
  RestorePointsRequestMessage,
  RollbackRequestMessage,
  RollbackResultMessage,
  SculptAppliedMessage,
  SculptDeniedMessage,
  SculptIntent,
  TerrainDiffMessage,
  WorldAdminResultMessage,
  WorldArchiveRequestMessage,
  WorldCreateRequestMessage,
  WorldDuplicateRequestMessage,
  WorldListMessage,
  WorldListRequestMessage,
  WorldLoadRequestMessage,
  WorldPinRequestMessage,
  WorldPluginListMessage,
  WorldPluginListRequestMessage,
  WorldPluginConfigureRequestMessage,
  WorldPluginReloadRequestMessage,
  WorldPluginSetRequestMessage,
  WorldPurgeRequestMessage,
  ServerRestartNoticeMessage,
  ServerRestartRequestMessage,
  StackRestartRequestMessage,
  WorldRenameRequestMessage,
  WorldSwitchCancelRequestMessage,
  WorldSwitchNoticeMessage,
  WorldUnarchiveRequestMessage,
  WorldUnloadRequestMessage,
  WorldUnloadedMessage,
} from '@terrace/shared';

export const MSG_SNAPSHOT: JoinSnapshotMessage['type'] = 'snapshot';

export const MSG_CHUNK_UNLOCK: ChunkUnlockMessage['type'] = 'chunkUnlock';

export const MSG_TERRAIN_DIFF: TerrainDiffMessage['type'] = 'terrainDiff';

export const MSG_SCULPT: SculptIntent['type'] = 'sculpt';

export const MSG_SCULPT_DENIED: SculptDeniedMessage['type'] = 'sculptDenied';

export const MSG_SCULPT_APPLIED: SculptAppliedMessage['type'] = 'sculptApplied';

export const MSG_RESTORE_POINTS: RestorePointsRequestMessage['type'] = 'restorePoints';

export const MSG_RESTORE_POINT_LIST: RestorePointListMessage['type'] = 'restorePointList';

export const MSG_ROLLBACK: RollbackRequestMessage['type'] = 'rollback';

export const MSG_ROLLBACK_RESULT: RollbackResultMessage['type'] = 'rollbackResult';

export const MSG_WORLD_LIST: WorldListRequestMessage['type'] = 'worldList';

export const MSG_WORLD_LISTING: WorldListMessage['type'] = 'worldListing';

export const MSG_WORLD_ADMIN_RESULT: WorldAdminResultMessage['type'] = 'worldAdminResult';

export const MSG_WORLD_SWITCH_NOTICE: WorldSwitchNoticeMessage['type'] = 'worldSwitchNotice';

export const MSG_WORLD_UNLOADED: WorldUnloadedMessage['type'] = 'worldUnloaded';

export const MSG_WORLD_CREATE: WorldCreateRequestMessage['type'] = 'worldCreate';

export const MSG_WORLD_LOAD: WorldLoadRequestMessage['type'] = 'worldLoad';

export const MSG_WORLD_UNLOAD: WorldUnloadRequestMessage['type'] = 'worldUnload';

export const MSG_WORLD_RENAME: WorldRenameRequestMessage['type'] = 'worldRename';

export const MSG_WORLD_DUPLICATE: WorldDuplicateRequestMessage['type'] = 'worldDuplicate';

export const MSG_WORLD_ARCHIVE: WorldArchiveRequestMessage['type'] = 'worldArchive';

export const MSG_WORLD_UNARCHIVE: WorldUnarchiveRequestMessage['type'] = 'worldUnarchive';

export const MSG_WORLD_PURGE: WorldPurgeRequestMessage['type'] = 'worldPurge';

export const MSG_WORLD_PIN: WorldPinRequestMessage['type'] = 'worldPin';

export const MSG_WORLD_PLUGIN_LIST: WorldPluginListRequestMessage['type'] = 'worldPluginList';

export const MSG_WORLD_PLUGIN_LISTING: WorldPluginListMessage['type'] = 'worldPluginListing';

export const MSG_WORLD_PLUGIN_SET: WorldPluginSetRequestMessage['type'] = 'worldPluginSet';

export const MSG_WORLD_PLUGIN_CONFIGURE: WorldPluginConfigureRequestMessage['type'] =
  'worldPluginConfigure';

export const MSG_WORLD_PLUGIN_RELOAD: WorldPluginReloadRequestMessage['type'] =
  'worldPluginReload';

export const MSG_SERVER_RESTART: ServerRestartRequestMessage['type'] = 'serverRestart';

export const MSG_STACK_RESTART: StackRestartRequestMessage['type'] = 'stackRestart';

export const MSG_SERVER_RESTART_NOTICE: ServerRestartNoticeMessage['type'] =
  'serverRestartNotice';

export const MSG_WORLD_SWITCH_CANCEL: WorldSwitchCancelRequestMessage['type'] =
  'worldSwitchCancel';
