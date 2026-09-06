// Reactive state shared between the mana plugin's wiring and its HUD panel.
// Module-scope signals, per the client's standing pattern (see hudState.ts).

import { createSignal } from 'solid-js';
import { sculptOptionsOf, sculptProfileOf, sculptSweepSteps, type SculptIntent } from '@terrace/shared';
import { sculptManaCost } from '../pricing.ts';
import type { ManaBalanceMessage, ManaDeniedMessage } from '../protocol.ts';
// THE ACCEPTED COUPLING (documented, deliberate): a plugin's client half reaching
// into the core client's HUD state. Both compile into the same browser bundle
// from the same repo — this is not a network hop or a published API — and the
// import is type-safe, so a rename in hudState.ts breaks the build here rather
// than silently mispricing. The alternative, mirroring the brush selection into
// plugin-local state, would mean two sources of truth for "what brush is the
// player holding" and a way for them to disagree, which is exactly the drift the
// single shared pricing function exists to prevent.
import { brushProfile, brushRadius, brushTool } from '../../../client/src/state/hudState.ts';

export interface ManaPool {
  readonly balance: number;
  readonly capacity: number;
  /**
   * Perk-adjusted mana per band-cell (server-pushed). A RATE, not a price: the
   * gate below turns it into the price of a specific intent through the same
   * shared function the server charges by.
   */
  readonly manaPerBandCell: number;
  /**
   * Perk-adjusted refill rate in mana per second (server-pushed). Feeds the
   * gauge's smoothing and its pulse period — AND the gate's own estimate, see
   * `liveBalance`.
   */
  readonly regenPerSecond: number;
}

/**
 * When `balance` was last true, as `performance.now()` milliseconds. Set on
 * every authoritative push and on every local debit; `liveBalance` measures
 * regen from it.
 *
 * Kept beside the pool rather than inside `ManaPool` because `ManaPool` is the
 * parsed shape of a wire message and this is not on the wire — folding a local
 * clock reading into it would invite a reader to think the server sent one.
 */
let balanceAsOfMs = 0;

/**
 * Monotonic clock, for the same reason world.ts uses one: these timestamps are
 * only ever compared with each other, and a wall-clock adjustment must not be
 * able to invent or erase seconds of regen.
 */
const nowMs = (): number => performance.now();

/**
 * THE POOL AS IT ACTUALLY STANDS: the last known balance plus the regen earned
 * since, capped at capacity.
 *
 * WHY THE GATE NEEDS THIS (owner report, 2026-08-24: after a drag "it won't let
 * me click and pull any vertices — like we've flipped a flag and it doesn't get
 * flipped back"). The gate debits its estimate per intent and used to be
 * corrected ONLY by a server push. The server pushes only when ITS OWN balance
 * moves, and `regenerate` skips a pool that is already full — so once a burst
 * of intents drove the local estimate below the truth and the gate began
 * refusing, nothing more was sent, the server's pool stayed full, no push was
 * ever emitted, and the estimate stayed wrong for the rest of the session. The
 * gauge meanwhile read full, because the gauge has always advanced itself at
 * `regenPerSecond`. The two halves disagreeing about the same pool is the bug;
 * they now advance the same way from the same number.
 *
 * A drag is what made it reachable rather than what caused it: it emits intents
 * far faster than a held stamp, so it drains the estimate below the truth in a
 * fraction of a second. Any future tool that emits quickly would have found it.
 */
export function liveBalance(pool: ManaPool, at: number = nowMs()): number {
  const earned = ((at - balanceAsOfMs) / 1000) * pool.regenPerSecond;
  // A backwards or absent clock reading earns nothing rather than draining the
  // pool: this estimate may never be more pessimistic than the truth, which is
  // the whole property the bug above violated.
  const grown = earned > 0 ? pool.balance + earned : pool.balance;
  return grown > pool.capacity ? pool.capacity : grown;
}

/** Null until the first mana:balance arrives (e.g. server runs no mana). */
const [manaPool, setPoolSignal] = createSignal<ManaPool | null>(null);

/**
 * Every write to the pool stamps the moment its balance was true, so
 * `liveBalance` can measure regen from it. Wrapping the setter rather than
 * asking each call site to stamp is the point: a call site that forgot would
 * re-create the stuck-gate bug, and there would be nothing in the type to say
 * it had.
 */
const setManaPool: typeof setPoolSignal = ((value) => {
  balanceAsOfMs = nowMs();
  return setPoolSignal(value as never);
}) as typeof setPoolSignal;

/**
 * A LOCAL DEBIT THE SERVER HAS NOT YET ACCOUNTED FOR — one per intent the gate
 * allowed, until a push arrives whose `asOfSeq` covers it.
 *
 * WHY (owner report, 2026-09-05: a large-brush flick "sculpting and then it
 * disappears"). The gate debits each intent as it goes out, but every balance
 * push used to REPLACE the estimate wholesale. The server pushes after each
 * intent it applies, and that number knows nothing of the intents still queued
 * behind it — so with ten expensive pulls in flight, the first push erased the
 * debits for the other nine, the gate approved more against mana already spent,
 * the server denied them, and the denial tore the predicted ground off. The
 * push now lands as `balance − Σ(debits it cannot yet have seen)`.
 */
interface InFlightDebit {
  /** The intent's seq, or null when it had none (then any push releases it). */
  readonly seq: number | null;
  readonly cost: number;
  readonly debitedAtMs: number;
}

/**
 * How long a debit may stay outstanding before it is presumed lost: the intent
 * never reached a hook (rate-limited, malformed, socket dropped), so no push
 * will ever name its seq. THE SAME DEADLINE THE PREDICTION STORE USES to tear
 * an unanswered intent's ground back off (PREDICTION_TTL_MS,
 * client/src/terrain/prediction.ts) — the two are one contract, "an intent
 * unanswered this long is lost". Restated here rather than imported because
 * that module is browser-only (Vite env reads) and this one runs under Node in
 * the plugin's tests; keep the two equal.
 */
const IN_FLIGHT_DEBIT_TTL_MS = 1000;

let inFlight: InFlightDebit[] = [];

/**
 * Drops every debit the server has accounted for or that has timed out, and
 * returns the sum of what is still owed. `asOfSeq` undefined means the server
 * has not yet seen an intent from us: everything with a seq is still in flight.
 */
function settleInFlight(asOfSeq: number | undefined, at: number): number {
  inFlight = inFlight.filter(
    (debit) =>
      debit.seq !== null &&
      at - debit.debitedAtMs < IN_FLIGHT_DEBIT_TTL_MS &&
      (asOfSeq === undefined || debit.seq > asOfSeq),
  );
  let owed = 0;
  for (const debit of inFlight) owed += debit.cost;
  return owed;
}

/** An authoritative balance push, reconciled against the debits still in flight. */
export function applyBalancePush(msg: ManaBalanceMessage): void {
  const owed = settleInFlight(msg.asOfSeq, nowMs());
  setManaPool({
    balance: Math.max(0, msg.balance - owed),
    capacity: msg.capacity,
    manaPerBandCell: msg.manaPerBandCell,
    regenPerSecond: msg.regenPerSecond,
  });
}

/**
 * A denial carries the authoritative balance too; reconciled the same way.
 * The denied intent's own debit is released by it — its seq is at or below
 * `asOfSeq` — which is right: the server charged nothing for it.
 */
export function applyDenial(denied: ManaDeniedMessage): void {
  const owed = settleInFlight(denied.asOfSeq, nowMs());
  setManaPool((pool) =>
    pool === null ? null : { ...pool, balance: Math.max(0, denied.balance - owed) },
  );
}

/** Test seam: forget every in-flight debit. */
export function clearInFlightDebits(): void {
  inFlight = [];
}

/**
 * Monotonic count of denials, not a boolean: the panel keys its flash off the
 * VALUE CHANGING, so two denials in quick succession restart the flash instead
 * of the second one being swallowed while the first is still showing.
 */
const [deniedCount, setDeniedCount] = createSignal(0);

export { manaPool, setManaPool, deniedCount };

export function recordDenial(): void {
  setDeniedCount((n) => n + 1);
}

/**
 * The mana price of the brush the player is CURRENTLY holding, or 0 when no
 * economy has been declared.
 *
 * REACTIVE — reads the pool signal and the HUD's brush signals, so every caller
 * must invoke it at its use site rather than caching the result in a const (the
 * project's standing Solid rule). The gauge draws this number and derives its
 * grain rhythm from it.
 *
 * It is the same function on the same inputs the gate below uses, one line
 * apart, so what the player is shown is what they will be charged.
 *
 * `brushTool` IS READ, and for two reasons. The carve is the first: it removes
 * a fixed block of bands rather than a brush cone and prices as that block, so
 * the gauge would show the wrong number for it if the signal were not read.
 * The second is the EDGE — the tool decides whether the player's edge choice
 * survives at all (`sculptProfileOf`), and the stamp/smooth/pull choice cannot
 * change the answer beyond that, because the relaxation spill those three
 * differ by is free by design (see sculptDisplacementUnits in
 * shared/src/heightmap.ts). Reactive, like every other read here.
 *
 * PRICED THROUGH THE SHARED NORMALISATION, not off the raw HUD signals. An
 * edgeless tool runs at EDGELESS_SCULPT_PROFILE whatever the Edge row was last
 * left on, so pricing the held Pull at a raw `soft` showed 283 where the gate
 * one function below — and the server — charged 749 for the very same stroke.
 * The gauge and the gate now resolve the profile through one function.
 */
export function currentBrushCost(): number {
  const pool = manaPool();
  if (pool === null) return 0;
  const tool = brushTool();
  return sculptManaCost(
    pool.manaPerBandCell,
    brushRadius(),
    sculptProfileOf(tool, brushProfile()),
    tool,
  );
}

/** The pool's live balance, or null when no economy has been declared. */
export function currentBalance(): number | null {
  const pool = manaPool();
  return pool === null ? null : liveBalance(pool);
}

/**
 * THE LOCAL INTENT GATE (wired to ClientPluginCtx.onLocalIntent).
 *
 * Decides against REPLICATED server state whether the player can pay for THIS
 * sculpt, so an unaffordable one is never sent and never predicted — the
 * refusal happens silently at the source instead of as a phantom stroke that
 * the server's nack has to claw back a round trip later.
 *
 * PRICED FROM THE INTENT, NOT FROM A PUSHED PRICE. The server pushes a rate; the
 * price of this particular sculpt is that rate times the volume this brush
 * displaces, through the ONE shared function the server itself charges with
 * (../pricing.ts) and the SAME option normalisation the terrain math uses
 * (`sculptOptionsOf`). Identical inputs, identical sequence of operations,
 * therefore an identical integer — a gate that computed the price its own way
 * would eventually disagree with the server by one unit and let through exactly
 * the stroke it exists to stop.
 *
 * On allow, the balance is DEBITED locally: the held brush emits ~8 intents
 * between server balance pushes, and without the debit every one of them
 * would pass the gate against the same stale balance — recreating exactly the
 * burst-of-rejections this gate exists to remove. The next authoritative
 * mana:balance replaces the estimate wholesale, so drift (regen between
 * pushes, a perk collected mid-stroke) self-corrects within one push.
 *
 * With NO pool state at all (server runs no mana plugin, or the first push
 * has not landed), the gate allows: the mana client half must never invent an
 * economy the server did not declare.
 */
export function gateLocalSculpt(intent: SculptIntent): boolean {
  const pool = manaPool();
  if (pool === null) return true;

  const options = sculptOptionsOf(intent);
  const cost = sculptManaCost(
    pool.manaPerBandCell,
    intent.radius,
    options.profile,
    options.tool,
    sculptSweepSteps(intent),
  );

  // The balance AS IT STANDS, regen included — not the number the last push
  // carried. See liveBalance for what reading the stale one cost.
  const at = nowMs();
  const balance = liveBalance(pool, at);

  if (balance < cost) {
    recordDenial();
    return false;
  }
  // Debit THIS intent's price, not a flat one: a held radius-4 hard brush drains
  // the local estimate 45× faster than a point brush, which is what the server
  // is simultaneously doing to the authoritative pool. Written back as an
  // absolute balance stamped at `at`, so the regen already counted into
  // `balance` is not counted a second time by the next call.
  setManaPool({ ...pool, balance: balance - cost });
  inFlight.push({ seq: intent.seq ?? null, cost, debitedAtMs: at });
  return true;
}
