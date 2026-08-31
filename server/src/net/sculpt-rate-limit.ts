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
 * THE FASTEST AN HONEST CLIENT STREAMS, in intents per second: one per
 * animation frame, at the fastest display refresh this project sizes against.
 *
 * IT IS THE DRAG THAT SETS THIS, NOT THE HELD STAMP. A held stamp is paced by
 * a timer (SCULPT_REPEAT_INTERVAL_MS, 120 ms — client/src/config.ts), but a
 * pull deliberately is not: "A DRAG IS DRIVEN BY MOTION, NOT BY A TIMER"
 * (input/sculptInput.ts's armStroke, owner report 2026-08-23), so `emitDrag`
 * fires straight out of `onPointerMove` and is bounded only by how often the
 * cursor changes CELL — at most once per pointermove, which browsers align to
 * the display refresh. The client's own in-flight bound says the same number
 * from the other side: DRAG_INTENTS_PER_TICK is `ceil(120 ms × 144 Hz)` = 18
 * intents per 120 ms tick, i.e. 144/s sustained.
 *
 * 144 Hz because that is the fastest panel this project is developed and
 * benchmarked against — the same figure, and the same reasoning, as the
 * client's DISPLAY_HZ_CEILING. RESTATED HERE RATHER THAN IMPORTED, and that is
 * the point of a server-side brake: what it must survive is a fact about
 * displays, not a promise from a client, and a limiter that read the client's
 * constant would be trusting the half of the system it exists to bound.
 */
const HONEST_DRAG_INTENTS_PER_SECOND = 144;

/**
 * How far above the honest peak the brake sits.
 *
 * TWO because it is a refresh multiple, not a fudge factor: the honest peak is
 * one intent per frame at 144 Hz, so a headroom of two is exactly "a display
 * up to 288 Hz" — which is the residual DISPLAY_HZ_CEILING's own note names
 * (faster panels exist, and this project does not size for them). A player on
 * one of those keeps their pull; a socket sending faster than any display can
 * drive is not a display.
 */
const SCULPT_RATE_HEADROOM_MULTIPLE = 2;

/**
 * The sustained rate one connection may sculpt at, in intents per second.
 *
 * A held stroke on a stock client repeats no faster than
 * SCULPT_REPEAT_INTERVAL_MS (120 ms — client/src/config.ts), i.e. ~8.3
 * intents/s, and that is the fastest an honest client ever streams. Twenty is
 * ~2.4× that: a player click-spamming on top of a held stroke still cannot
 * reach it, while a hostile socket is held to a small multiple of one honest
 * player's cost instead of whatever the transport will carry.
 *
 * CORRECTED (2026-08-30): the paragraph above measured "one honest player"
 * from the held stamp alone, and the drag tool is not on that timer — see
 * HONEST_DRAG_INTENTS_PER_SECOND. An honest pull streams ~144 intents/s, so a
 * flat 20 shed roughly seven of every eight intents of any pull lasting longer
 * than the burst. Those are intents the client has ALREADY PREDICTED locally,
 * and a prediction the server never answers is torn back off by
 * PREDICTION_TTL_MS — the sculpt reappearing and vanishing that
 * `client/src/net/connection.ts`'s dropped-socket gate was written to stop,
 * arriving instead from the server's own brake. The policy is unchanged (a
 * small multiple of one honest player's cost); only the measurement of that
 * cost is fixed, and both halves are now named rather than folded into a
 * literal.
 *
 * KNOWN RESIDUAL, stated rather than papered over: at this rate the brake is a
 * bound on ABUSE, not a server-cost budget — 288 radius-16 smooth strokes a
 * second is real work, and every one of them is a stroke an unmodified client
 * can legitimately send. Bringing the per-tick cost down means coalescing
 * intents per tick rather than metering them per socket, which changes what a
 * stroke means on the wire and is the owner's call, not this module's.
 */
export const SCULPT_INTENTS_PER_SECOND =
  HONEST_DRAG_INTENTS_PER_SECOND * SCULPT_RATE_HEADROOM_MULTIPLE;

/**
 * How much of the sustained rate the bucket holds, in seconds — see
 * SCULPT_BURST_INTENTS for why a burst allowance is correctness rather than
 * generosity, and why two seconds is the depth.
 */
const SCULPT_BURST_SECONDS = 2;

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
export const SCULPT_BURST_INTENTS = SCULPT_INTENTS_PER_SECOND * SCULPT_BURST_SECONDS;

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
