// THE SCULPT RATE LIMIT — the only brake core itself puts on inbound sculpts.
//
// WHY IT EXISTS. A sculpt is the cheapest message a client can send and the
// most expensive one the server can receive: one small inbound frame becomes a
// brush plus (for the smooth tool) a gradient relaxation, and then one
// terrainDiff fanned out to every connected client. Pacing was CLIENT-side
// only (client/src/config.ts's SCULPT_REPEAT_INTERVAL_MS), which paces nobody
// who has edited their client, and the only server-side brake was the mana
// plugin — an OPTIONAL plugin, on a configuration that is supported with it
// switched off. This is the brake that exists whatever is loaded.
//
// DELIBERATELY A TRANSPORT-LAYER CHECK, keyed by CONNECTION id and applied
// before the intent is even parsed: the abuse is "this socket is sending too
// fast", which is a fact about the socket, not about a world, a player or an
// intent. Anything cheaper to reject with, we would still have had to parse.
//
// A shed intent is dropped in SILENCE, like every other rejected intent (see
// intent/pipeline.ts on why telling a client why it was refused is itself a
// leak). No well-behaved client can reach the limit, so silence costs an
// honest player nothing.

/**
 * The sustained rate one connection may sculpt at, in intents per second.
 *
 * A held stroke on a stock client repeats no faster than
 * SCULPT_REPEAT_INTERVAL_MS (120 ms — client/src/config.ts), i.e. ~8.3
 * intents/s, and that is the fastest an honest client ever streams. Twenty is
 * ~2.4× that: a player click-spamming on top of a held stroke still cannot
 * reach it, while a hostile socket is held to a small multiple of one honest
 * player's cost instead of whatever the transport will carry.
 */
export const SCULPT_INTENTS_PER_SECOND = 20;

/**
 * Bucket depth, in intents — two seconds of the sustained rate.
 *
 * A burst allowance is not generosity, it is correctness: a client whose main
 * thread stalled (a GC pause, a backgrounded tab regaining focus) flushes the
 * repeats that queued up behind the stall in one batch, and a bucket with no
 * depth would shed exactly those legitimate intents. Two seconds covers a
 * stall long enough that the player noticed it; a flood lasting longer than
 * the burst is metered at SCULPT_INTENTS_PER_SECOND regardless of depth.
 */
export const SCULPT_BURST_INTENTS = SCULPT_INTENTS_PER_SECOND * 2;

const MILLISECONDS_PER_SECOND = 1000;

/** One connection's bucket: tokens left, and when they were last topped up. */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface SculptRateLimiterOptions {
  /** Injectable clock, so the refill can be tested without sleeping. */
  readonly now?: () => number;
}

/**
 * A token bucket per connection.
 *
 * Refilled LAZILY, on the check itself, rather than by a timer: there is no
 * work to do for a connection that is not sculpting, and a timer over every
 * connected socket would burn tick budget to maintain counters nobody reads.
 */
export class SculptRateLimiter {
  private readonly now: () => number;

  /**
   * Keyed by connection id and pruned only when a connection is forgotten
   * (see forgetClient, called from the room's onLeave) — bounded by the number
   * of connected clients, exactly like OperatorGate's attempt records.
   */
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: SculptRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Spends one token for this connection. False means the intent must be
   * dropped: the socket is over its sustained rate and has spent its burst.
   */
  allow(clientId: string): boolean {
    const nowMs = this.now();
    const bucket = this.buckets.get(clientId);
    if (bucket === undefined) {
      // A connection's first sculpt starts it with a full bucket minus this
      // one, so joining costs nothing and the burst is available immediately.
      this.buckets.set(clientId, { tokens: SCULPT_BURST_INTENTS - 1, lastRefillMs: nowMs });
      return true;
    }

    const elapsedMs = nowMs - bucket.lastRefillMs;
    // A clock that went backwards (or did not move) refills nothing rather
    // than draining the bucket by a negative amount.
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

  /** Drops a disconnected connection's bucket. */
  forgetClient(clientId: string): void {
    this.buckets.delete(clientId);
  }
}
