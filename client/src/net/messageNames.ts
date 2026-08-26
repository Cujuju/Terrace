// Colyseus message names.
//
// Terrain never travels as Colyseus schema state (design doc Q7): it is plain
// msgpack messages whose payloads are exactly the interfaces in
// shared/src/protocol.ts. The Colyseus message NAME is the payload's own
// `type` literal, so there is one name per message and no second vocabulary to
// keep in sync.
//
// The annotations below are load-bearing, not decoration: each constant is
// typed as the corresponding payload's `type` field, so renaming a message in
// shared/ fails compilation here instead of silently producing a client that
// listens on a name the server never sends.

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
  WorldPluginSetRequestMessage,
  WorldPurgeRequestMessage,
  ServerRestartNoticeMessage,
  ServerRestartRequestMessage,
  WorldRenameRequestMessage,
  WorldSwitchCancelRequestMessage,
  WorldSwitchNoticeMessage,
  WorldUnarchiveRequestMessage,
  WorldUnloadRequestMessage,
  WorldUnloadedMessage,
} from '@terrace/shared';

/** Server → one joining client: world size + the unlocked chunks only. */
export const MSG_SNAPSHOT: JoinSnapshotMessage['type'] = 'snapshot';

/** Server → clients: newly revealed chunks streaming in. */
export const MSG_CHUNK_UNLOCK: ChunkUnlockMessage['type'] = 'chunkUnlock';

/** Server → clients: cells changed by an applied edit. */
export const MSG_TERRAIN_DIFF: TerrainDiffMessage['type'] = 'terrainDiff';

/** Client → server: a sculpt request. Never heights — direction only. */
export const MSG_SCULPT: SculptIntent['type'] = 'sculpt';

/** Server → the sender only: a plugin denied the intent with this seq. */
export const MSG_SCULPT_DENIED: SculptDeniedMessage['type'] = 'sculptDenied';

/**
 * Server → the sender only: the intent with this seq was applied, and
 * everything describing what it did has already arrived. The other half of the
 * answer contract above — see SculptAppliedMessage in shared/src/protocol.ts.
 */
export const MSG_SCULPT_APPLIED: SculptAppliedMessage['type'] = 'sculptApplied';

// ─────────────────────────────────────────────────────────────────────────────
// WORLD ROLLBACK (2026-08-21). Operator traffic, not gameplay — see the WORLD
// ROLLBACK section in shared/src/protocol.ts. A successful rollback is NOT
// announced with a message of its own: the server re-sends every client a
// plain `snapshot`, which the client already treats as "the world you have has
// been replaced" (the rejoin path in client/src/world.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Client → server: "list the restore points", carrying the operator key. */
export const MSG_RESTORE_POINTS: RestorePointsRequestMessage['type'] = 'restorePoints';

/** Server → the requesting client: the restore points, or why it was refused. */
export const MSG_RESTORE_POINT_LIST: RestorePointListMessage['type'] = 'restorePointList';

/** Client → server: "put the world back to this restore point". */
export const MSG_ROLLBACK: RollbackRequestMessage['type'] = 'rollback';

/** Server → the requesting client: the operator's receipt. */
export const MSG_ROLLBACK_RESULT: RollbackResultMessage['type'] = 'rollbackResult';

// ─────────────────────────────────────────────────────────────────────────────
// WORLD MANAGEMENT (2026-08-22). Operator traffic gated by WORLD_ADMIN_KEY —
// a different key from rollback's, guarding a bigger blast radius. See the
// WORLD MANAGEMENT section in shared/src/protocol.ts.
//
// A world SWITCH is not announced to the panel by its result message: every
// client is sent a fresh `snapshot` for the new world, which the client
// already treats as "the world you have has been replaced". What IS announced
// separately is the COUNTDOWN before it (`worldSwitchNotice`) and the state of
// having no world at all (`worldUnloaded`), because neither is a world the
// client could render.
// ─────────────────────────────────────────────────────────────────────────────

/** Client → server: "list every world you have", carrying the admin key. */
export const MSG_WORLD_LIST: WorldListRequestMessage['type'] = 'worldList';

/** Server → the requesting client: the worlds, or why it was refused. */
export const MSG_WORLD_LISTING: WorldListMessage['type'] = 'worldListing';

/** Server → the requesting client: the receipt for one management action. */
export const MSG_WORLD_ADMIN_RESULT: WorldAdminResultMessage['type'] = 'worldAdminResult';

/** Server → every client: a switch is counting down (or was called off). */
export const MSG_WORLD_SWITCH_NOTICE: WorldSwitchNoticeMessage['type'] = 'worldSwitchNotice';

/** Server → every client: there is no world loaded right now. */
export const MSG_WORLD_UNLOADED: WorldUnloadedMessage['type'] = 'worldUnloaded';

/** Client → server: create a world. */
export const MSG_WORLD_CREATE: WorldCreateRequestMessage['type'] = 'worldCreate';

/** Client → server: make a world live. */
export const MSG_WORLD_LOAD: WorldLoadRequestMessage['type'] = 'worldLoad';

/** Client → server: save and close the live world. */
export const MSG_WORLD_UNLOAD: WorldUnloadRequestMessage['type'] = 'worldUnload';

/** Client → server: rename a world. Never moves its file. */
export const MSG_WORLD_RENAME: WorldRenameRequestMessage['type'] = 'worldRename';

/** Client → server: copy a world, with its whole history. */
export const MSG_WORLD_DUPLICATE: WorldDuplicateRequestMessage['type'] = 'worldDuplicate';

/** Client → server: move a world to the trash. NOT a delete. */
export const MSG_WORLD_ARCHIVE: WorldArchiveRequestMessage['type'] = 'worldArchive';

/** Client → server: take a world back out of the trash. */
export const MSG_WORLD_UNARCHIVE: WorldUnarchiveRequestMessage['type'] = 'worldUnarchive';

/** Client → server: destroy an archived world. The only destructive name here. */
export const MSG_WORLD_PURGE: WorldPurgeRequestMessage['type'] = 'worldPurge';

/** Client → server: pin (or unpin) a restore point against retention. */
export const MSG_WORLD_PIN: WorldPinRequestMessage['type'] = 'worldPin';

/** Client → server: which plugins does one world run, and which are off? */
export const MSG_WORLD_PLUGIN_LIST: WorldPluginListRequestMessage['type'] = 'worldPluginList';

/** Server → the requesting client: one world's installed/disabled plugins. */
export const MSG_WORLD_PLUGIN_LISTING: WorldPluginListMessage['type'] = 'worldPluginListing';

/** Client → server: run (or stop running) one plugin in one world. */
export const MSG_WORLD_PLUGIN_SET: WorldPluginSetRequestMessage['type'] = 'worldPluginSet';

/** Client → server: run one plugin in one world with this setting. */
export const MSG_WORLD_PLUGIN_CONFIGURE: WorldPluginConfigureRequestMessage['type'] =
  'worldPluginConfigure';

/** Client → server: restart the server process so new code becomes live. */
export const MSG_SERVER_RESTART: ServerRestartRequestMessage['type'] = 'serverRestart';

/** Server → every client: the process is about to restart (0 = now). */
export const MSG_SERVER_RESTART_NOTICE: ServerRestartNoticeMessage['type'] =
  'serverRestartNotice';

/** Client → server: call off a counting-down switch. */
export const MSG_WORLD_SWITCH_CANCEL: WorldSwitchCancelRequestMessage['type'] =
  'worldSwitchCancel';
