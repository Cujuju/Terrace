const HONEST_DRAG_INTENTS_PER_SECOND = 144;

const SCULPT_RATE_HEADROOM_MULTIPLE = 2;

export const SCULPT_INTENTS_PER_SECOND =
  HONEST_DRAG_INTENTS_PER_SECOND * SCULPT_RATE_HEADROOM_MULTIPLE;

const SCULPT_BURST_SECONDS = 2;

export const SCULPT_BURST_INTENTS = SCULPT_INTENTS_PER_SECOND * SCULPT_BURST_SECONDS;

const MILLISECONDS_PER_SECOND = 1000;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface SculptRateLimiterOptions {
  readonly now?: () => number;
}

export class SculptRateLimiter {
  private readonly now: () => number;

  private readonly buckets = new Map<string, Bucket>();

  constructor(options: SculptRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  allow(clientId: string): boolean {
    const nowMs = this.now();
    const bucket = this.buckets.get(clientId);
    if (bucket === undefined) {
      this.buckets.set(clientId, { tokens: SCULPT_BURST_INTENTS - 1, lastRefillMs: nowMs });
      return true;
    }

    const elapsedMs = nowMs - bucket.lastRefillMs;
    if (elapsedMs > 0) {
      bucket.tokens = Math.min(
        SCULPT_BURST_INTENTS,
        bucket.tokens + (elapsedMs * SCULPT_INTENTS_PER_SECOND) / MILLISECONDS_PER_SECOND,
      );
      bucket.lastRefillMs = nowMs;
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  forgetClient(clientId: string): void {
    this.buckets.delete(clientId);
  }
}
