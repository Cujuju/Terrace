import { cellX, cellY } from '@terrace/shared';
import { chunksDirtiedByCell, type CellWriteSink, type TerrainMirror } from './mirror.ts';

const EMPTY_SPAN_SNAPSHOT: ReadonlyMap<number, Int16Array> = new Map();

function spansEqual(a: Int16Array | undefined, b: Int16Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** The authoritative heights and spans predictions replay onto, and what moved since. */
export interface PredictionLedger {
  readonly noteCell: CellWriteSink;
  noteChanged(i: number): void;
  heightAt(i: number): number;
  hasBaseSpan(i: number): boolean;
  baseSpansAreEmpty(): boolean;
  commit(): void;
  restore(): void;
  beginChangePass(pending: readonly { readonly indices: readonly number[] }[]): void;
  collectChanged(dirty: Set<number>): void;
}

export function createPredictionLedger(mirror: TerrainMirror): PredictionLedger {
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

  return {
    noteCell,

    noteChanged: (i: number): void => {
      candidates.add(i);
    },

    heightAt: (i: number): number => base[i],

    hasBaseSpan: (i: number): boolean => baseSpans.has(i),

    baseSpansAreEmpty: (): boolean => baseSpans.size === 0,

    commit(): void {
      base.set(rendered);
      snapshotBaseSpans();
    },

    restore(): void {
      rendered.set(base);
      restoreBaseSpans();
    },

    beginChangePass(pending): void {
      noteSlotOf.clear();
      noteHeight.length = 0;
      noteSpans.length = 0;
      candidates.clear();
      for (const p of pending) for (const i of p.indices) noteCell(i);
    },

    collectChanged(dirty: Set<number>): void {
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
    },
  };
}
