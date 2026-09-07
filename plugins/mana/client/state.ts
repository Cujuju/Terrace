// Reactive state shared between the mana plugin's wiring and its HUD panel.
// Module-scope signals, per the client's standing pattern (see hudState.ts).

import { createSignal } from 'solid-js';
import { sculptOptionsOf, sculptProfileOf, sculptSweepSteps, type SculptIntent } from '@terrace/shared';
import { chunkOriginCell, chunkUnlockPenalty, openedChunkCount, sculptManaCost } from '../pricing.ts';
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
   * gauge's smoothing and its pulse period, and NOTHING the gate reads — see
   * `liveBalance` for why that separation is the whole point.
   */
  readonly regenPerSecond: number;
}

/**
 * When the AUTHORITATIVE part of `balance` was last true, as `performance.now()`
 * milliseconds. Set on every server push, and deliberately NOT on a local debit
 * (see `debitLocally`); `liveBalance` measures regen from it.
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
 * THE POOL AS THE GAUGE DRAWS IT: the last known balance plus the regen earned
 * since, capped at capacity. DISPLAY ONLY — `gateLocalSculpt` must not read it,
 * and the reason is the whole of the 2026-09-05 fix below.
 *
 * TWO CONSUMERS, OPPOSITE CORRECTNESS NEEDS. The gauge wants the FRIENDLIEST
 * honest number, so a bar that is refilling looks like it is refilling between
 * pushes. The gate wants the most PESSIMISTIC honest number, because every unit
 * it credits that the server has not actually granted is a stroke it approves,
 * predicts, and then has torn back off when the server refuses it — the
 * land-snaps-back the owner reported on 2026-09-05 ("I don't ever want to see
 * the land snap back because I don't have enough mana"). Regen earned since the
 * last push is exactly such an ungranted unit: the server's own pool advances on
 * its fixed tick, and its answer to "can you pay" is the only one that counts.
 *
 * So the two halves no longer share one number. The gauge reads this; the gate
 * reads `pool.balance` raw, which is a strict lower bound on the authoritative
 * balance (see gateLocalSculpt).
 *
 * SUPERSEDES the 2026-08-24 use of this function as the gate's estimate (owner
 * report: after a drag "it won't let me click and drag any vertices — like
 * we've flipped a flag and it doesn't get flipped back"). That was a stuck gate:
 * a burst of intents drove the local estimate below the truth, the server's pool
 * was already full, `regenerate` skipped a full pool, no push was ever emitted,
 * and the estimate stayed wrong for the rest of the session. Crediting the gate
 * with local regen un-stuck it by making it optimistic, which is what let the
 * snap-back through. The hole is now closed where it actually was — the server
 * re-affirms a pool whose pushed balance has gone stale on a heartbeat
 * (MANA_BALANCE_HEARTBEAT_MS, ../server/index.ts), full pool included — so a
 * pessimistic gate self-corrects without inventing mana.
 */
export function liveBalance(pool: ManaPool, at: number = nowMs()): number {
  const earned = ((at - balanceAsOfMs) / 1000) * pool.regenPerSecond;
  // A backwards or absent clock reading earns nothing rather than draining the
  // bar: the gauge may never read LOWER than the truth, or a full pool would
  // appear to drain while the player stands still.
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
 * The gate's own debit — the ONE write that must not restamp `balanceAsOfMs`.
 *
 * A local debit says nothing about when the server's number was true; it only
 * subtracts from it. Restamping here would tell `liveBalance` that the regen
 * between the last push and this debit had never been earned, and the gauge
 * would visibly step backwards every time the player pressed the brush.
 *
 * Deliberately NOT exported and deliberately not `setManaPool`: those two
 * properties together are what keep "authoritative writes restamp, local debits
 * do not" a rule the type system can hold rather than one every call site has
 * to remember.
 */
function debitLocally(pool: ManaPool, cost: number): void {
  setPoolSignal({ ...pool, balance: pool.balance - cost });
}

/**
 * A LOCAL DEBIT THE SERVER HAS NOT YET ACCOUNTED FOR — one per intent the gate
 * allowed, until a push arrives whose `asOfSeq` covers it.
 *
 * WHY (owner report, 2026-09-05: a large-brush flick "sculpting and then it
 * disappears"). The gate debits each intent as it goes out, but every balance
 * push used to REPLACE the estimate wholesale. The server pushes after each
 * intent it applies, and that number knows nothing of the intents still queued
 * behind it — so with ten expensive drags in flight, the first push erased the
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
 * survives at all (`sculptProfileOf`), and the stamp/smooth/drag choice cannot
 * change the answer beyond that, because the relaxation spill those three
 * differ by is free by design (see sculptDisplacementUnits in
 * shared/src/heightmap.ts). Reactive, like every other read here.
 *
 * PRICED THROUGH THE SHARED NORMALISATION, not off the raw HUD signals. An
 * edgeless tool runs at EDGELESS_SCULPT_PROFILE whatever the Edge row was last
 * left on, so pricing the held Drag at a raw `soft` showed 283 where the gate
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
 * What the gate needs to know about this player's territory — the two reads
 * from ClientPluginCtx that decide how much of the stroke's footprint is
 * still fogged. A structural slice rather than the whole ctx, so the pricing
 * path stays testable and cannot reach for anything else.
 */
export interface LocalTerritory {
  worldSize(): number;
  revealedAt(x: number, y: number): boolean;
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
 * A STRICT LOWER BOUND, NOT AN ESTIMATE (owner, 2026-09-05: "I don't ever want
 * to see the land snap back because I don't have enough mana"). It prices
 * against `pool.balance` RAW — the last pushed balance, less every debit still
 * in flight — and credits itself no regen since that push, because regen the
 * server has not ticked into its own pool is mana the player does not have. The
 * property this buys is the one the owner asked for: the gate can only ever
 * refuse a stroke the server would also refuse, so an approved stroke is never
 * clawed back. The gauge keeps the friendlier `liveBalance` for display; see
 * that function for why the two numbers are deliberately different.
 *
 * The cost of the pessimism is bounded by one round trip, not by the push
 * interval: `commitCharge` pushes a fresh balance after EVERY applied intent
 * (../server/index.ts), so a live stroke is corrected per intent. When nothing
 * is being sent, the server's heartbeat (MANA_BALANCE_HEARTBEAT_MS) re-affirms
 * the pool, so a gate that has drifted low cannot stay low.
 *
 * On allow, the balance is DEBITED locally: the held brush emits ~8 intents
 * between server balance pushes, and without the debit every one of them
 * would pass the gate against the same stale balance — recreating exactly the
 * burst-of-rejections this gate exists to remove. The next authoritative
 * mana:balance replaces the estimate wholesale, so drift (a perk collected
 * mid-stroke, an intent that never landed) self-corrects within one push.
 *
 * With NO pool state at all (server runs no mana plugin, or the first push
 * has not landed), the gate allows: the mana client half must never invent an
 * economy the server did not declare.
 */
export function gateLocalSculpt(intent: SculptIntent, territory: LocalTerritory): boolean {
  const pool = manaPool();
  if (pool === null) return true;

  const options = sculptOptionsOf(intent);
  // THE LAND THIS STROKE WOULD CLAIM, priced exactly as the server prices it
  // (../pricing.ts). The client can answer this without a round trip because
  // its received-chunk set IS its own unlock mask — a locked chunk is never on
  // the wire — so `revealedAt` and the server's per-token mask are the same
  // fact asked two ways.
  //
  // A worldSize of 0 (no snapshot yet) means there is nothing to open and
  // nothing to gate; `openedChunkCount` is not asked, because chunksPerEdge
  // throws on a size that is not a multiple of CHUNK_SIZE.
  const worldSize = territory.worldSize();
  const opened =
    worldSize <= 0
      ? 0
      : openedChunkCount(worldSize, intent.x, intent.y, intent.radius, (cx, cy) => {
          const origin = chunkOriginCell(cx, cy);
          return territory.revealedAt(origin.x, origin.y);
        });
  const cost =
    sculptManaCost(
      pool.manaPerBandCell,
      intent.radius,
      options.profile,
      options.tool,
      sculptSweepSteps(intent),
    ) +
    opened *
      chunkUnlockPenalty(pool.manaPerBandCell, intent.radius, options.profile, options.tool);

  // CONFIRMED MANA ONLY — the pushed balance less the debits already taken
  // against it. No local regen: see this function's doc comment and
  // `liveBalance` for why crediting it is what tore predicted ground back off.
  if (pool.balance < cost) {
    recordDenial();
    return false;
  }
  // Debit THIS intent's price, not a flat one: a held radius-4 hard brush drains
  // the local estimate 45× faster than a point brush, which is what the server
  // is simultaneously doing to the authoritative pool.
  debitLocally(pool, cost);
  inFlight.push({ seq: intent.seq ?? null, cost, debitedAtMs: nowMs() });
  return true;
}
