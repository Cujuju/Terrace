export const MAX_ROLLBACK_KEY_LENGTH = 256;

export interface RestorePoint {
  id: number;
  createdAt: number;
  cellsChanged: number | null;
  maxCellDelta: number | null;
  isCurrent: boolean;
  pinned: boolean;
}

export interface RestorePointsRequestMessage {
  type: 'restorePoints';
  key: string;
}

export type RollbackRefusal =
  | 'disabled'
  | 'badKey'
  | 'throttled'
  | 'unknownRestorePoint'
  | 'sizeMismatch'
  | 'failed';

export interface RestorePointListMessage {
  type: 'restorePointList';
  points: RestorePoint[];
  retention: number;
  intervalS: number;
  refused?: RollbackRefusal;
}

export interface RollbackRequestMessage {
  type: 'rollback';
  key: string;
  toId: number;
}

export interface RollbackResultMessage {
  type: 'rollbackResult';
  ok: boolean;
  toId?: number;
  undoId?: number;
  refused?: RollbackRefusal;
}

function validateRollbackKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_ROLLBACK_KEY_LENGTH) return null;
  return value;
}

export function validateRestorePointsRequest(
  msg: unknown,
): RestorePointsRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'restorePoints') return null;
  const key = validateRollbackKey(m.key);
  if (key === null) return null;
  return { type: 'restorePoints', key };
}

export function validateRollbackRequest(msg: unknown): RollbackRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'rollback') return null;
  const key = validateRollbackKey(m.key);
  if (key === null) return null;
  const { toId } = m;
  if (!Number.isSafeInteger(toId) || (toId as number) <= 0) return null;
  return { type: 'rollback', key, toId: toId as number };
}
