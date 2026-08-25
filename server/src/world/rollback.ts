// WORLD ROLLBACK — putting the world back to a restore point.
//
// CRITICAL CODE. This is the only path in the server that discards live world
// state on purpose, so the guarantees it owns are:
//
//   1. Nothing happens without the operator key (design: v1 has no accounts,
//      §3.7, so a shared secret is the only gate available — see the WORLD
//      ROLLBACK section in shared/src/protocol.ts).
//   2. The state being rolled AWAY from is written as a restore point FIRST.
//      A rollback is therefore itself undoable; a mis-aimed one costs a click.
//   3. The rewind is all-or-nothing. Every size check runs before the first
//      byte is written (World.rewindTo), because a half-rewound world is the
//      one outcome with no way back.
//   4. What lands in memory is what lands on disk, immediately. The rewound
//      world is snapshotted before the call returns, so a crash one second
//      later comes back rolled back rather than silently un-rolled.
//   5. NOBODY IS LEFT LOOKING AT AN EMPTY WORLD. Every connected player's home
//      square is re-seeded before they are re-announced to — see step 4 for
//      the failure that exists to prevent.
//
// WHY IT REPLAYS THE BOOT SEQUENCE. Steps 5–6 below are `restorePersistence`
// then `worldCreate`, in that order — exactly what index.ts does at boot, and
// deliberately not a new "apply a snapshot to a running world" path. It has to
// be both calls: several plugins (flora, structures, chronicle) split their
// restore across the pair, with `load` staging the slice into a module-level
// buffer and `onWorldCreate` consuming it. Calling only the first would leave
// those plugins holding a slice they never applied. Every `onWorldCreate` in
// this repo was checked against this (2026-08-21) and each one RESETS its
// plugin's state — assigning from the staged slice, or zeroing counters — so
// re-running the pair mid-life reproduces the boot outcome rather than
// doubling anything. That is the contract a plugin has to keep to survive a
// rollback, and it is stated on PersistenceSlice in plugins/types.ts.

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

/**
 * Kept as re-exports so the rollback lockout tests — and any self-hoster's
 * script that imported them — keep working after the gate moved to
 * world/operator-gate.ts (2026-08-22). The VALUES live there now, in the one
 * implementation both operator keys share; these names are aliases, not a
 * second policy.
 */
export const ROLLBACK_MAX_FAILED_ATTEMPTS = OPERATOR_MAX_FAILED_ATTEMPTS;
export const ROLLBACK_LOCKOUT_MS = OPERATOR_LOCKOUT_MS;

/** Everything a rollback needs from the process. */
export interface RollbackDeps {
  readonly world: World;
  readonly host: PluginHost;
  readonly store: SnapshotStore;
  /** ROLLBACK_KEY, or null when the feature is off. */
  readonly key: string | null;
  /** Reported to the panel so it can state the real depth of the safety net. */
  readonly retention: number;
  readonly intervalS: number;
  /**
   * Injectable clock. Exists for the lockout tests, which must be able to
   * cross ROLLBACK_LOCKOUT_MS without sleeping for a minute.
   */
  readonly now?: () => number;
}

export class RollbackService {
  private readonly deps: RollbackDeps;
  private readonly now: () => number;
  /**
   * The shared operator gate, constructed with ROLLBACK_KEY. Rollback and
   * world management each hold their own instance with their own key, so a
   * lockout earned against one does not lock the other — they are different
   * secrets guarding different blast radii (see operator-gate.ts).
   */
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

  /** True when ROLLBACK_KEY is configured; the boot log states this, not the key. */
  get enabled(): boolean {
    return this.gate.enabled;
  }

  /** Drops a disconnected connection's attempt record. */
  forgetClient(clientId: string): void {
    this.gate.forgetClient(clientId);
  }

  /**
   * Answers a restore-point listing request.
   *
   * A refusal still returns a well-formed message with an empty list, never a
   * silence: unlike a rejected sculpt — where silence is an anti-cheat
   * requirement because it must stay indistinguishable from a dropped packet
   * (see SculptDeniedMessage) — the operator here needs to be told WHY, or
   * they will retype a key against a server that has none configured.
   */
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

  /**
   * Rolls the live world back to a restore point. See this file's header for
   * the five guarantees; the numbered steps below are that sequence.
   */
  rollback(clientId: string, key: string, toId: number): RollbackResultMessage {
    const refusal = this.authorize(clientId, key);
    if (refusal !== null) return { type: 'rollbackResult', ok: false, refused: refusal };

    const { world, host, store } = this.deps;

    // STEP 1 — read the target, with every validation loadLatest applies at
    // boot (schema version, per-cell height range). A row that fails those
    // throws here, before anything has been touched.
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

    // STEP 2 — save what we are about to discard, UNCONDITIONALLY. Not
    // "if dirty": the whole value of this write is that the operator can undo
    // a mis-aimed rollback, and a world that happens to be clean at this
    // instant is exactly the case where the newest restore point might
    // already be several minutes old.
    let undoId: number;
    try {
      undoId = this.saveCurrent();
    } catch (error) {
      // Refuse rather than proceed. Rolling back without a way back would
      // turn one wrong click into a world nobody can recover.
      logError('rollback aborted: could not save the pre-rollback world', error);
      return { type: 'rollbackResult', ok: false, refused: 'failed' };
    }

    // STEP 3 — the rewind itself. All-or-nothing (World.rewindTo).
    try {
      world.rewindTo(target.cells, target.mask, target.tokenMasks, target.columnSpans);
    } catch (error) {
      logError(`rollback to restore point #${toId} failed; world unchanged`, error);
      return { type: 'rollbackResult', ok: false, refused: 'failed' };
    }

    // STEP 4 — RE-SEED EVERY CONNECTED PLAYER'S HOME SQUARE.
    //
    // Not housekeeping: without it a rollback hands some players an EMPTY
    // WORLD. The rewind replaces the per-token unlock masks with the restore
    // point's (it must — see World.rewindTo), and a token that first joined
    // AFTER that restore point does not appear in them at all. Its mask
    // therefore comes back empty, its next snapshot carries zero chunks, and
    // the client renders open sea. Observed on the first live rollback,
    // 2026-08-21.
    //
    // This is the same call `TerraceRoom.onJoin` makes, for the same reason,
    // and it is idempotent for a token that already holds its home square
    // (World.seedChunkForToken). Territory a player CREPT beyond that square
    // since the restore point is still gone, and that is correct: undoing it
    // is what a rollback is.
    for (const player of world.players()) {
      applyInitialUnlockForToken(world, player.token);
    }

    // STEPS 5 and 6 — replay the boot sequence for plugin state. Neither call
    // throws: PluginHost wraps every plugin hook (its `safely`), so one
    // misbehaving plugin costs its own state, not the rollback.
    host.restorePersistence(target.pluginSlices);
    host.worldCreate();

    // STEP 7 — what is in memory is now on disk. A failure here is logged and
    // survived: the world stays dirty (rewindTo marked it so) and the periodic
    // scheduler writes it within SNAPSHOT_INTERVAL_S.
    try {
      this.saveCurrent();
      world.markSnapshotted();
    } catch (error) {
      logError('rolled-back world could not be snapshotted; scheduler will retry', error);
    }

    // STEP 8 — hand every connected client the world it is now looking at.
    // AFTER the plugin replay above, not before: a client that re-rendered
    // rewound terrain while the plugins still held post-rollback forests and
    // villages would show buildings standing on ground that no longer exists.
    this.announceToAll();

    logInfo(
      `world rolled back to restore point #${toId} ` +
        `(pre-rollback world saved as #${undoId})`,
    );
    return { type: 'rollbackResult', ok: true, toId, undoId };
  }

  /** Writes the live world as a restore point and returns its id. */
  private saveCurrent(): number {
    const { world, host, store } = this.deps;
    return store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.heightsForPersistence(),
      // Layered columns ride along with the heights they complete — the same
      // pairing every other saver uses; see World.spansForPersistence.
      columnSpans: world.spansForPersistence(),
      mask: world.mask,
      pluginSlices: host.collectPersistence(),
      tokenMasks: world.tokenMasks(),
      // A rollback rewinds the TERRAIN, never the calendar: the world does not
      // get younger because its hills moved, and a clock that jumped backwards
      // would replay a week of Mondays.
      simMillis: world.simMillis,
      // And a rollback never re-births the world either: same reasoning, one
      // step stronger — the birthday is what "Day 57" counts from.
      genesisMillis: world.genesisMillis,
      // Rollback writes restore points like any other saver, so it produces a
      // picture like any other saver: a rewound world must not keep wearing
      // the thumbnail of the world it was rolled away from.
      thumbnail: buildThumbnail(world.map.cells, world.size),
    });
  }

  /** Sends every connected player a fresh snapshot of the rewound world. */
  private announceToAll(): void {
    const { world } = this.deps;
    for (const player of world.players()) {
      // Per-token, so the anti-cheat rule that a client is only ever sent its
      // own territory survives the rollback — see buildJoinSnapshot.
      world.sendTo(player.id, buildJoinSnapshot(world, player.token));
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

  /**
   * Delegates to the shared gate; the refusal names it returns are a subset of
   * RollbackRefusal, so no translation is needed (see OperatorRefusal).
   */
  private authorize(clientId: string, key: string): RollbackRefusal | null {
    return this.gate.authorize(clientId, key);
  }
}
