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
