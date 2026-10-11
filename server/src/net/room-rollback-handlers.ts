import {
  validateRestorePointsRequest,
  validateRollbackRequest,
  type RestorePointListMessage,
  type RollbackResultMessage,
} from '@terrace/shared';
import type { WorldManager } from '../world/world-manager.ts';
import type { TerraceClient } from './room-contract.ts';

const EMPTY_RESTORE_POINT_LIST: RestorePointListMessage = {
  type: 'restorePointList',
  points: [],
  retention: 0,
  intervalS: 0,
};

const FAILED_ROLLBACK_RESULT: RollbackResultMessage = {
  type: 'rollbackResult',
  ok: false,
  refused: 'failed',
};

export interface RollbackHandlerDeps {
  readonly manager: WorldManager;
}

export function handleRestorePointsMessage(
  deps: RollbackHandlerDeps,
  client: TerraceClient,
  message: unknown,
): void {
  const request = validateRestorePointsRequest(message);
  if (request === null) return;
  const session = deps.manager.current;
  if (session === null) {
    client.send('restorePointList', EMPTY_RESTORE_POINT_LIST);
    return;
  }
  client.send(
    'restorePointList',
    session.rollback.listRestorePoints(client.sessionId, request.key),
  );
}

export function refuseRestorePointsMessage(client: TerraceClient): void {
  client.send('restorePointList', EMPTY_RESTORE_POINT_LIST);
}

export function handleRollbackMessage(
  deps: RollbackHandlerDeps,
  client: TerraceClient,
  message: unknown,
): void {
  const request = validateRollbackRequest(message);
  if (request === null) return;
  const session = deps.manager.current;
  if (session === null) {
    client.send('rollbackResult', FAILED_ROLLBACK_RESULT);
    return;
  }
  const result = session.rollback.rollback(
    client.sessionId,
    request.key,
    request.toId,
  );
  client.send('rollbackResult', result);
}

export function refuseRollbackMessage(client: TerraceClient): void {
  client.send('rollbackResult', FAILED_ROLLBACK_RESULT);
}
