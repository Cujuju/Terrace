import {
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  applySculpt,
  cellIndex,
  cellX,
  cellY,
  chunkIndex,
  forEachFootprintOffset,
  forEachLineCell,
  sculptOptionsOf,
  sculptSweepRadius,
  validateSculptIntent,
  type SculptIntent,
  type TerrainDiffMessage,
} from '@terrace/shared';
import { DRAG_INTENTS_PER_TICK, SCULPT_REPEAT_INTERVAL_MS } from '../config.ts';
import {
  applyTerrainDiff,
  chunksDirtiedByCell,
  hasChunk,
  type CellWriteSink,
  type TerrainMirror,
} from './mirror.ts';

export const PREDICTION_TTL_MS = 1000;

export const MAX_PENDING_PREDICTIONS =
  Math.ceil(PREDICTION_TTL_MS / SCULPT_REPEAT_INTERVAL_MS) * DRAG_INTENTS_PER_TICK;

export const PREDICTION_HALO_CELLS = 1;

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
   * Seqs the client sent (they hold a seq the server will ack/nack) that predicted
   * a no-op: unknown chunk, unfaithful footprint, or settled ground. Lane E renders
   * these as a ghost — deliberately not a held-unsent brush, because the intent did
   * leave the client; there is just nothing to show until the server answers.
   */
  ghostSeqs(): readonly number[];

  authoritativeHeightAt(x: number, y: number): number;
}

const EMPTY_SPAN_SNAPSHOT: ReadonlyMap<number, Int16Array> = new Map();

export function createPredictionStore(mirror: TerrainMirror): PredictionStore {
  const size = mirror.map.size;
  const rendered = mirror.map.cells;
  const base = new Int16Array(rendered);

  let baseSpans = EMPTY_SPAN_SNAPSHOT;

  const snapshotBaseSpans = (): void => {
    const live = mirror.map.columnSpans;
    if (live.size === 0) {
      baseSpans = EMPTY_SPAN_SNAPSHOT;
      return;
    }
    const snapshot = new Map<number, Int16Array>();
    for (const [i, packed] of live) snapshot.set(i, new Int16Array(packed));
    baseSpans = snapshot;
  };

  const restoreBaseSpans = (): void => {
    const live = mirror.map.columnSpans;
    if (live.size === 0 && baseSpans.size === 0) return;
    live.clear();
    for (const [i, packed] of baseSpans) live.set(i, new Int16Array(packed));
  };

  let pending: PendingPrediction[] = [];

  // Ghost seqs: sent intents (seq-holders) with no visible prediction. Bounded like
  // pending and pruned by the same TTL, so a stranded ghost cannot outlive its ack window.
  const ghosts = new Map<number, number>();

  const markGhost = (seq: number | undefined, nowMs: number): void => {
    if (seq === undefined) return;
    ghosts.delete(seq);
    ghosts.set(seq, nowMs);
    while (ghosts.size > MAX_PENDING_PREDICTIONS) {
      const oldest = ghosts.keys().next();
      if (oldest.done) break;
      ghosts.delete(oldest.value);
    }
  };

  const pruneGhosts = (nowMs: number): void => {
    for (const [seq, at] of ghosts) {
      if (nowMs - at >= PREDICTION_TTL_MS) ghosts.delete(seq);
    }
  };

  const chunkOfCell = (x: number, y: number): number =>
    chunkIndex(size, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));

  const chunkOfCellIndex = (i: number): number =>
    chunkOfCell(cellX(size, i), cellY(size, i));

  const cellIsKnown = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= size || y >= size || hasChunk(mirror, chunkOfCell(x, y));

  const discIsKnown = (cx: number, cy: number, radius: number): boolean => {
    let known = true;
    forEachFootprintOffset(radius, (dx, dy) => {
      if (!known) return;
      const x = cx + dx;
      const y = cy + dy;
      if (
        !cellIsKnown(x, y) ||
        !cellIsKnown(x - PREDICTION_HALO_CELLS, y) ||
        !cellIsKnown(x + PREDICTION_HALO_CELLS, y) ||
        !cellIsKnown(x, y - PREDICTION_HALO_CELLS) ||
        !cellIsKnown(x, y + PREDICTION_HALO_CELLS)
      ) {
        known = false;
      }
    });
    return known;
  };
  const canPredictFaithfully = (intent: SculptIntent): boolean => {
    const { x, y } = intent;
    const options = sculptOptionsOf(intent);
    const radius = sculptSweepRadius(
      intent.radius,
      options.profile,
      options.tool,
      options.anchor,
    );
    if (intent.fromX === undefined || intent.fromY === undefined) return discIsKnown(x, y, radius);
    let known = true;
    forEachLineCell(intent.fromX, intent.fromY, x, y, (sx, sy) => {
      if (known && !discIsKnown(sx, sy, radius)) known = false;
    });
    return known;
  };

  const noteSlotOf = new Map<number, number>();
  const noteHeight: number[] = [];
  const noteSpans: (Int16Array | undefined)[] = [];
  const candidates = new Set<number>();

  const noteCell: CellWriteSink = (i: number): void => {
    candidates.add(i);
    if (noteSlotOf.has(i)) return;
    noteSlotOf.set(i, noteHeight.length);
    noteHeight.push(rendered[i]);
    const live = mirror.map.columnSpans;
    const packed = live.size === 0 ? undefined : live.get(i);
    noteSpans.push(packed === undefined ? undefined : new Int16Array(packed));
  };

  const beginChangePass = (): void => {
    noteSlotOf.clear();
    noteHeight.length = 0;
    noteSpans.length = 0;
    candidates.clear();
    for (const p of pending) for (const i of p.indices) noteCell(i);
  };

  const spansEqual = (
    a: Int16Array | undefined,
    b: Int16Array | undefined,
  ): boolean => {
    if (a === undefined || b === undefined) return a === b;
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
    return true;
  };

  const collectChanged = (dirty: Set<number>): void => {
    const live = mirror.map.columnSpans;
    for (const i of candidates) {
      const slot = noteSlotOf.get(i);
      const beforeHeight = slot === undefined ? base[i] : noteHeight[slot];
      let changed = beforeHeight !== rendered[i];
      if (!changed) {
        const beforeSpans = slot === undefined ? baseSpans.get(i) : noteSpans[slot];
        changed = !spansEqual(beforeSpans, live.get(i));
      }
      if (!changed) continue;
      for (const idx of chunksDirtiedByCell(mirror, cellX(size, i), cellY(size, i))) {
        dirty.add(idx);
      }
    }
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
    const anyLayered = live.size !== 0 || baseSpans.size !== 0;
    p.touchedLayeredColumn = false;
    for (const cell of diff) {
      const i = cellIndex(mirror.map, cell.x, cell.y);
      p.indices.push(i);
      p.after.push(cell.h);
      if (anyLayered && (live.has(i) || baseSpans.has(i))) p.touchedLayeredColumn = true;
      candidates.add(i);
    }
  };

  const restoreToBase = (): void => {
    if (pending.length === 0) return;
    rendered.set(base);
    restoreBaseSpans();
  };

  const replayPending = (): void => {
    for (const p of pending) applyPrediction(p);
  };

  const isConfirmed = (p: PendingPrediction): boolean => {
    if (p.touchedLayeredColumn) return false;
    let comparable = 0;
    for (let k = 0; k < p.indices.length; k++) {
      const i = p.indices[k];
      if (!hasChunk(mirror, chunkOfCellIndex(i))) continue;
      if (base[i] !== p.after[k]) return false;
      comparable++;
    }
    return comparable > 0;
  };

  const reconcile = (
    mutate: (m: TerrainMirror) => Set<number>,
    nowMs: number,
  ): Set<number> => {
    const dirty = new Set<number>();

    beginChangePass();
    restoreToBase();
    for (const idx of mutate(mirror)) dirty.add(idx);
    base.set(rendered);
    snapshotBaseSpans();

    pending = pending.filter(
      (p) => !isConfirmed(p) && nowMs - p.createdAtMs < PREDICTION_TTL_MS,
    );
    pruneGhosts(nowMs);
    replayPending();

    collectChanged(dirty);
    return dirty;
  };

  return {
    predict(intent: SculptIntent, nowMs: number): Set<number> {
      const dirty = new Set<number>();

      const validated = validateSculptIntent(intent, size);
      if (validated === null) return dirty;
      // A grabbed stroke into a chunk never received: ghost, not held-unsent.
      if (!hasChunk(mirror, chunkOfCell(validated.x, validated.y))) {
        markGhost(validated.seq, nowMs);
        return dirty;
      }
      // A sweep whose footprint reads terrain never sent: ghost, not held-unsent.
      if (!canPredictFaithfully(validated)) {
        markGhost(validated.seq, nowMs);
        return dirty;
      }

      beginChangePass();

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
        markGhost(validated.seq, nowMs);
      }

      collectChanged(dirty);
      return dirty;
    },

    applyAuthoritative(
      mutate: (m: TerrainMirror) => Set<number>,
      nowMs: number,
    ): Set<number> {
      return reconcile(mutate, nowMs);
    },

    applyCellDiff(msg: TerrainDiffMessage, nowMs: number): Set<number> {
      return reconcile((m) => applyTerrainDiff(m, msg, noteCell), nowMs);
    },

    resolveSeq(seq: number): Set<number> {
      const dirty = new Set<number>();
      // The server answered (applied or denied): the ghost, if any, is settled.
      ghosts.delete(seq);
      const index = pending.findIndex((p) => p.intent.seq === seq);
      if (index === -1) return dirty;

      beginChangePass();
      restoreToBase();
      pending.splice(index, 1);
      replayPending();
      collectChanged(dirty);
      return dirty;
    },

    expire(nowMs: number): Set<number> {
      const dirty = new Set<number>();
      pruneGhosts(nowMs);
      const survivors = pending.filter((p) => nowMs - p.createdAtMs < PREDICTION_TTL_MS);
      if (survivors.length === pending.length) return dirty;

      beginChangePass();
      restoreToBase();
      pending = survivors;
      replayPending();
      collectChanged(dirty);
      return dirty;
    },

    nextExpiryAtMs(): number | null {
      return pending.length === 0 ? null : pending[0].createdAtMs + PREDICTION_TTL_MS;
    },

    pendingCount(): number {
      return pending.length;
    },

    ghostSeqs(): readonly number[] {
      return [...ghosts.keys()];
    },

    authoritativeHeightAt(x: number, y: number): number {
      return base[cellIndex(mirror.map, x, y)];
    },
  };
}
