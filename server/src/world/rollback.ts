import type {
  RestorePointListMessage,
  RollbackRefusal,
  RollbackResultMessage,
} from '@terrace/shared';
import { logError, logInfo } from '../log.ts';
import {
  OperatorGate,
  OPERATOR_LOCKOUT_MS,
  OPERATOR_MAX_FAILED_ATTEMPTS,
} from './operator-gate.ts';
import { buildJoinSnapshot } from '../net/join-snapshot.ts';
import { buildThumbnail } from '../persistence/thumbnail.ts';
import { applyInitialUnlockForToken } from './initial-unlock.ts';
import type { SnapshotStore } from '../persistence/snapshot-store.ts';
import type { PluginHost } from '../plugins/host.ts';
import type { World } from './world.ts';

export const ROLLBACK_MAX_FAILED_ATTEMPTS = OPERATOR_MAX_FAILED_ATTEMPTS;
export const ROLLBACK_LOCKOUT_MS = OPERATOR_LOCKOUT_MS;

export interface RollbackDeps {
  readonly world: World;
  readonly host: PluginHost;
  readonly store: SnapshotStore;
  readonly key: string | null;
  readonly retention: number;
  readonly intervalS: number;
  readonly now?: () => number;
}

export class RollbackService {
  private readonly deps: RollbackDeps;
  private readonly now: () => number;
  private readonly gate: OperatorGate;

  constructor(deps: RollbackDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.gate = new OperatorGate({
      key: deps.key,
      label: 'rollback',
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      log: logInfo,
    });
  }

  get keyed(): boolean {
    return this.gate.keyed;
  }

  forgetClient(clientId: string): void {
    this.gate.forgetClient(clientId);
  }

  listRestorePoints(clientId: string, key: string): RestorePointListMessage {
    const refusal = this.authorize(clientId, key);
    if (refusal !== null) return this.emptyList(refusal);
    return {
      type: 'restorePointList',
      points: this.deps.store.listRestorePoints(),
      retention: this.deps.retention,
      intervalS: this.deps.intervalS,
    };
  }

  rollback(clientId: string, key: string, toId: number): RollbackResultMessage {
    const refusal = this.authorize(clientId, key);
    if (refusal !== null) return { type: 'rollbackResult', ok: false, refused: refusal };

    const { world, host, store } = this.deps;

    let target;
    try {
      target = store.loadSnapshot(toId);
    } catch (error) {
      logError(`rollback to restore point #${toId} could not be read`, error);
      return { type: 'rollbackResult', ok: false, refused: 'failed' };
    }
    if (target === null) {
      return { type: 'rollbackResult', ok: false, refused: 'unknownRestorePoint' };
    }
    if (target.worldSize !== world.size) {
      return { type: 'rollbackResult', ok: false, refused: 'sizeMismatch' };
    }

    let undoId: number;
    try {
      undoId = this.saveCurrent();
    } catch (error) {
      logError('rollback aborted: could not save the pre-rollback world', error);
      return { type: 'rollbackResult', ok: false, refused: 'failed' };
    }

    try {
      world.rewindTo(target.cells, target.mask, target.tokenMasks, target.columnSpans);
    } catch (error) {
      logError(`rollback to restore point #${toId} failed; world unchanged`, error);
      return { type: 'rollbackResult', ok: false, refused: 'failed' };
    }

    for (const player of world.players()) {
      applyInitialUnlockForToken(world, player.token);
    }

    host.restorePersistence(target.pluginSlices);
    host.worldCreate();

    try {
      this.saveCurrent();
      world.markSnapshotted();
    } catch (error) {
      logError('rolled-back world could not be snapshotted; scheduler will retry', error);
    }

    this.announceToAll();

    logInfo(
      `world rolled back to restore point #${toId} ` +
        `(pre-rollback world saved as #${undoId})`,
    );
    return { type: 'rollbackResult', ok: true, toId, undoId };
  }

  private saveCurrent(): number {
    const { world, host, store } = this.deps;
    return store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.heightsForPersistence(),
      columnSpans: world.spansForPersistence(),
      mask: world.mask,
      pluginSlices: host.collectPersistence(),
      tokenMasks: world.tokenMasks(),
      simMillis: world.simMillis,
      genesisMillis: world.genesisMillis,
      thumbnail: buildThumbnail(world.map.cells, world.size),
    });
  }

  private announceToAll(): void {
    const { world, host } = this.deps;
    for (const player of world.players()) {
      world.sendTo(player.id, buildJoinSnapshot(world, host, player.token));
    }
  }

  private emptyList(refused: RollbackRefusal): RestorePointListMessage {
    return {
      type: 'restorePointList',
      points: [],
      retention: this.deps.retention,
      intervalS: this.deps.intervalS,
      refused,
    };
  }

  private authorize(clientId: string, key: string): RollbackRefusal | null {
    return this.gate.authorize(clientId, key);
  }
}
