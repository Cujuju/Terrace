import { MAX_PENDING_PREDICTIONS, PREDICTION_TTL_MS } from './predictionLimits.ts';

export interface GhostLog {
  mark(seq: number | undefined, nowMs: number): void;
  prune(nowMs: number): void;
  settle(seq: number): void;
  seqs(): readonly number[];
}

// Ghost seqs: sent intents (seq-holders) with no visible prediction. Bounded like
// pending and pruned by the same TTL, so a stranded ghost cannot outlive its ack window.
export function createGhostLog(): GhostLog {
  const ghosts = new Map<number, number>();

  return {
    mark(seq: number | undefined, nowMs: number): void {
      if (seq === undefined) return;
      ghosts.delete(seq);
      ghosts.set(seq, nowMs);
      while (ghosts.size > MAX_PENDING_PREDICTIONS) {
        const oldest = ghosts.keys().next();
        if (oldest.done) break;
        ghosts.delete(oldest.value);
      }
    },

    prune(nowMs: number): void {
      for (const [seq, at] of ghosts) {
        if (nowMs - at >= PREDICTION_TTL_MS) ghosts.delete(seq);
      }
    },

    settle(seq: number): void {
      ghosts.delete(seq);
    },

    seqs(): readonly number[] {
      return [...ghosts.keys()];
    },
  };
}
