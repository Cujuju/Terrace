import type { SculptIntent } from './protocol/sculpt.ts';
import type {
  RestorePointListMessage,
  RestorePointsRequestMessage,
  RollbackRequestMessage,
  RollbackResultMessage,
} from './protocol/rollback.ts';
import type { ChunkUnlockMessage, JoinSnapshotMessage } from './protocol/chunkPayload.ts';
import type {
  SculptAppliedMessage,
  SculptDeniedMessage,
  TerrainDiffMessage,
} from './protocol/sculpt.ts';

export * from './protocol/sculpt.ts';
export * from './protocol/chunkPayload.ts';
export * from './protocol/rollback.ts';
export * from './protocol/world.ts';
export * from './protocol/worldAdmin.ts';
export * from './protocol/worldAdminValidate.ts';
export * from './protocol/perfLogging.ts';

export interface StackRestartRequestMessage {
  type: 'stackRestart';
}

export const STACK_RESTART_MESSAGE_TYPE: StackRestartRequestMessage['type'] = 'stackRestart';

export function validateStackRestartRequest(msg: unknown): StackRestartRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== STACK_RESTART_MESSAGE_TYPE) return null;
  return { type: STACK_RESTART_MESSAGE_TYPE };
}

export type ClientMessage =
  | SculptIntent
  | RestorePointsRequestMessage
  | RollbackRequestMessage
  | StackRestartRequestMessage;
export type ServerMessage =
  | TerrainDiffMessage
  | ChunkUnlockMessage
  | JoinSnapshotMessage
  | SculptAppliedMessage
  | SculptDeniedMessage
  | RestorePointListMessage
  | RollbackResultMessage;
