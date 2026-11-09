import type { SculptIntent } from '@terrace/shared';
import { dryRunSculpt, sampleSculpt, type LocalHeights, type QuoteReply, type SculptMeasurement } from './quote.ts';

interface Entry {
  readonly key: string;
  readonly terrain: LocalHeights;
  readonly intent: SculptIntent;
  measurement: SculptMeasurement | null;
  requested: boolean;
}

function quoteWorker(): Worker | null {
  return typeof Worker === 'undefined' ? null
    : new Worker(new URL('./quoteWorker.ts', import.meta.url), { type: 'module' });
}

/** One active worker request and the newest desired quote; intermediate aims never queue. */
export function createHoverQuoteCache(changed: () => void, makeWorker: () => Worker | null = quoteWorker) {
  let entry: Entry | null = null;
  let active: { readonly id: number; readonly entry: Entry } | null = null;
  let worker: Worker | null = null;
  let unavailable = false;
  let nextId = 0;

  const stopWorker = (): void => {
    if (worker !== null) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }
    active = null;
  };

  const start = (wanted: Entry): void => {
    if (unavailable || wanted.requested || active !== null) return;
    wanted.requested = true;
    try {
      if (worker === null) {
        worker = makeWorker();
        if (worker === null) { unavailable = true; return; }
        worker.onerror = (): void => {
          stopWorker();
          unavailable = true;
          changed();
        };
        worker.onmessage = ({ data }: MessageEvent<QuoteReply>): void => {
          if (active === null || data.id !== active.id) return;
          const completed = active.entry;
          active = null;
          if (entry === completed) {
            completed.measurement = data.measurement;
            changed();
          }
          if (entry !== null) start(entry);
        };
      }
      const sample = sampleSculpt(wanted.terrain, wanted.intent);
      if (sample === null) return;
      active = { id: ++nextId, entry: wanted };
      worker.postMessage({ id: active.id, sample });
    } catch (error) {
      console.error('[mana] hover quote worker unavailable', error);
      stopWorker();
      unavailable = true;
    }
  };

  return {
    read(terrain: LocalHeights, intent: SculptIntent): SculptMeasurement | null {
      const key = JSON.stringify(intent);
      if (entry?.key === key && entry.terrain === terrain) return entry.measurement;
      entry = { key, terrain, intent, measurement: null, requested: false };
      if (intent.tool === 'smooth' || intent.tool === 'nudge') start(entry);
      else {
        entry.requested = true;
        entry.measurement = dryRunSculpt(terrain, intent);
      }
      return entry.measurement;
    },
    invalidate(): void {
      entry = null;
      changed();
    },
    dispose(): void {
      entry = null;
      stopWorker();
      unavailable = false;
      changed();
    },
  };
}
