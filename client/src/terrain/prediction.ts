import {
  DEFAULT_SCULPT_AMOUNT,
  applySculpt,
  cellIndex,
  cellX,
  cellY,
  sculptOptionsOf,
  validateSculptIntent,
  type SculptIntent,
  type TerrainDiffMessage,
} from '@terrace/shared';
import { applyTerrainDiff, hasChunk, type TerrainMirror } from './mirror.ts';
import { createGhostLog } from './predictionGhosts.ts';
import { createPredictionLedger } from './predictionLedger.ts';
import { MAX_PENDING_PREDICTIONS, PREDICTION_TTL_MS } from './predictionLimits.ts';
import { createReachChecks } from './predictionReach.ts';

export {
  MAX_PENDING_PREDICTIONS,
  PREDICTION_HALO_CELLS,
  PREDICTION_TTL_MS,
} from './predictionLimits.ts';

interface PendingPrediction {
  readonly intent: SculptIntent;
  readonly createdAtMs: number;
  indices: number[];
  after: number[];
  touchedLayeredColumn: boolean;
}

export interface PredictionStore {
  predict(intent: SculptIntent, nowMs: number): Set<number>;

  applyAuthoritative(
    mutate: (mirror: TerrainMirror) => Set<number>,
    nowMs: number,
  ): Set<number>;

  applyCellDiff(msg: TerrainDiffMessage, nowMs: number): Set<number>;

  resolveSeq(seq: number): Set<number>;

  expire(nowMs: number): Set<number>;

  nextExpiryAtMs(): number | null;

  pendingCount(): number;

  /**
   * Seqs the client sent that predicted a no-op: unknown chunk, unfaithful
   * footprint, or settled ground. Lane E renders these as a ghost — the intent
   * did leave.
   */
  ghostSeqs(): readonly number[];

  authoritativeHeightAt(x: number, y: number): number;
}

export function createPredictionStore(mirror: TerrainMirror): PredictionStore {
  const size = mirror.map.size;
  const ledger = createPredictionLedger(mirror);
  const reach = createReachChecks(mirror);
  const ghosts = createGhostLog();

  let pending: PendingPrediction[] = [];

  /**
   * The reach a prediction actually had, checked against the same halo. A
   * relaxing tool cascades freely, so only the cells it moved can bound it.
   */
  const reachIsKnown = (p: PendingPrediction): boolean => {
    for (const i of p.indices) {
      if (!reach.cellAndHaloAreKnown(cellX(size, i), cellY(size, i))) return false;
    }
    return true;
  };

  const applyPrediction = (p: PendingPrediction): void => {
    const amount = DEFAULT_SCULPT_AMOUNT * p.intent.dir;
    const diff = applySculpt(
      mirror.map,
      p.intent.x,
      p.intent.y,
      p.intent.radius,
      amount,
      sculptOptionsOf(p.intent),
    );

    p.indices = [];
    p.after = [];
    const live = mirror.map.columnSpans;
    const anyLayered = live.size !== 0 || !ledger.baseSpansAreEmpty();
    p.touchedLayeredColumn = false;
    for (const cell of diff) {
      const i = cellIndex(mirror.map, cell.x, cell.y);
      p.indices.push(i);
      p.after.push(cell.h);
      if (anyLayered && (live.has(i) || ledger.hasBaseSpan(i))) p.touchedLayeredColumn = true;
      ledger.noteChanged(i);
    }
  };

  const restoreToBase = (): void => {
    if (pending.length === 0) return;
    ledger.restore();
  };

  const replayPending = (): void => {
    for (const p of pending) applyPrediction(p);
  };

  const isConfirmed = (p: PendingPrediction): boolean => {
    if (p.touchedLayeredColumn) return false;
    let comparable = 0;
    for (let k = 0; k < p.indices.length; k++) {
      const i = p.indices[k];
      if (!hasChunk(mirror, reach.chunkOfCellIndex(i))) continue;
      if (ledger.heightAt(i) !== p.after[k]) return false;
      comparable++;
    }
    return comparable > 0;
  };

  const reconcile = (
    mutate: (m: TerrainMirror) => Set<number>,
    nowMs: number,
  ): Set<number> => {
    const dirty = new Set<number>();

    ledger.beginChangePass(pending);
    restoreToBase();
    for (const idx of mutate(mirror)) dirty.add(idx);
    ledger.commit();

    pending = pending.filter(
      (p) => !isConfirmed(p) && nowMs - p.createdAtMs < PREDICTION_TTL_MS,
    );
    ghosts.prune(nowMs);
    replayPending();

    ledger.collectChanged(dirty);
    return dirty;
  };

  return {
    predict(intent: SculptIntent, nowMs: number): Set<number> {
      const dirty = new Set<number>();

      const validated = validateSculptIntent(intent, size);
      if (validated === null) return dirty;
      // A grabbed stroke into a chunk never received: ghost, not held-unsent.
      if (!hasChunk(mirror, reach.chunkOfCell(validated.x, validated.y))) {
        ghosts.mark(validated.seq, nowMs);
        return dirty;
      }
      // A sweep whose footprint reads terrain never sent: ghost, not held-unsent.
      if (!reach.canPredictFaithfully(validated)) {
        ghosts.mark(validated.seq, nowMs);
        return dirty;
      }

      ledger.beginChangePass(pending);

      if (pending.length >= MAX_PENDING_PREDICTIONS) {
        restoreToBase();
        pending.shift();
        replayPending();
      }

      const prediction: PendingPrediction = {
        intent: validated,
        createdAtMs: nowMs,
        indices: [],
        after: [],
        touchedLayeredColumn: false,
      };
      pending.push(prediction);
      applyPrediction(prediction);

      // Settled ground: the intent left the client but changes nothing visible.
      if (prediction.indices.length === 0) {
        pending.pop();
        ghosts.mark(validated.seq, nowMs);
      } else if (!reachIsKnown(prediction)) {
        // The cascade ran into ground we were never sent, so it is not what the
        // server will send back: drop it and ghost instead of showing a snap-back.
        restoreToBase();
        pending.pop();
        replayPending();
        ghosts.mark(validated.seq, nowMs);
      }

      ledger.collectChanged(dirty);
      return dirty;
    },

    applyAuthoritative(
      mutate: (m: TerrainMirror) => Set<number>,
      nowMs: number,
    ): Set<number> {
      return reconcile(mutate, nowMs);
    },

    applyCellDiff(msg: TerrainDiffMessage, nowMs: number): Set<number> {
      return reconcile((m) => applyTerrainDiff(m, msg, ledger.noteCell), nowMs);
    },

    resolveSeq(seq: number): Set<number> {
      const dirty = new Set<number>();
      // The server answered (applied or denied): the ghost, if any, is settled.
      ghosts.settle(seq);
      const index = pending.findIndex((p) => p.intent.seq === seq);
      if (index === -1) return dirty;

      ledger.beginChangePass(pending);
      restoreToBase();
      pending.splice(index, 1);
      replayPending();
      ledger.collectChanged(dirty);
      return dirty;
    },

    expire(nowMs: number): Set<number> {
      const dirty = new Set<number>();
      ghosts.prune(nowMs);
      const survivors = pending.filter((p) => nowMs - p.createdAtMs < PREDICTION_TTL_MS);
      if (survivors.length === pending.length) return dirty;

      ledger.beginChangePass(pending);
      restoreToBase();
      pending = survivors;
      replayPending();
      ledger.collectChanged(dirty);
      return dirty;
    },

    nextExpiryAtMs(): number | null {
      return pending.length === 0 ? null : pending[0].createdAtMs + PREDICTION_TTL_MS;
    },

    pendingCount(): number {
      return pending.length;
    },

    ghostSeqs(): readonly number[] {
      return ghosts.seqs();
    },

    authoritativeHeightAt(x: number, y: number): number {
      return ledger.heightAt(cellIndex(mirror.map, x, y));
    },
  };
}
