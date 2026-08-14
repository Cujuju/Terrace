// mana — the second example plugin (design §3.5, MVP criterion 8): proof that
// the plugin API generalizes past the reveal mechanic it was designed around.
//
// It exercises a different quadrant of the contract than reveal does:
//
//   reveal : onWorldCreate + onTerrainChanged + persistence, no player identity
//   mana   : onWorldCreate + onPlayerJoin/Leave + onTick + onIntent (DENY)
//            + namespaced server → client messages
//
// The economy itself is deliberately the simplest thing that is still a real
// veto: every player holds a pool, the pool regenerates on the server's fixed
// tick, and a sculpt intent that cannot pay is DENIED in the interceptor chain —
// the sim is never patched, exactly as design §3.5 requires ("a mana plugin
// vetoes/modifies intents rather than patching the sim").

import type { SculptIntent } from '@terrace/shared';
// Type-only import of the plugin contract (erased at runtime). It reaches into
// server/src because core publishes no plugin-API entry point yet — see the
// API-gap notes in the Phase 2 report.
import type {
  IntentCtx,
  IntentVerdict,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';

/**
 * Full pool, in mana units. Sized against MANA_COST_PER_SCULPT so a rested
 * player gets exactly MANA_CAPACITY / MANA_COST_PER_SCULPT = 8 immediate
 * sculpts — enough to shape one hill in a burst before the economy bites.
 */
export const MANA_CAPACITY = 200;

/**
 * Charged per applied sculpt intent, regardless of brush radius. Flat on
 * purpose: the sculpt amount is already server-fixed (DEFAULT_SCULPT_AMOUNT),
 * so a flat cost makes the rate limit legible to a player — "one sculpt costs
 * one sculpt" — rather than something they have to model.
 */
export const MANA_COST_PER_SCULPT = 25;

/**
 * Regeneration, in mana units per second of simulated time. 20/s = one sculpt
 * every 1.25 s sustained, and a full empty-to-capacity refill in 10 s. Slow
 * enough to be felt, fast enough that a self-hoster poking at a fresh world is
 * never left staring at an empty bar.
 *
 * NOTE: mana is an economy, not terrain math — the determinism contract in
 * CLAUDE.md governs shared/'s heightmap ops and does not apply here, so a
 * fractional pool is fine. State is still reproducible: regen is driven purely
 * by the fixed tick period the host passes in, never by wall-clock time.
 */
export const MANA_REGEN_PER_SECOND = 20;

/** Un-namespaced type of the server → client balance push (`mana:balance`). */
export const MANA_BALANCE_MESSAGE = 'balance';

/** Un-namespaced type of the server → client refusal (`mana:denied`). */
export const MANA_DENIED_MESSAGE = 'denied';

/** Reason string attached to the IntentVerdict, surfaced in server logs. */
export const INSUFFICIENT_MANA_REASON = 'insufficient mana';

interface ManaPool {
  /** Current mana. Fractional between ticks; spent in whole units. */
  balance: number;
  /**
   * Last whole-unit balance pushed to this player, so a 10 Hz tick does not
   * generate 10 messages a second for a bar that only moves in integers.
   * -1 is "nothing sent yet" and can never equal a real floored balance.
   */
  lastSentBalance: number;
}

/** Sentinel for "no balance has been pushed to this player yet". */
const NO_BALANCE_SENT = -1;

/**
 * The WorldApi, captured at onWorldCreate. onPlayerJoin/onPlayerLeave are not
 * handed one, so a plugin that wants to talk to a joining player has no other
 * way to reach `sendTo`. See the API-gap notes in the Phase 2 report.
 */
let api: WorldApi | null = null;

/**
 * Pools keyed by Player.id — currently the Colyseus sessionId, which is
 * per-connection. That is why this plugin has no `persistence` slice: there is
 * no stable player identity to key persisted balances by, so a snapshot of them
 * could not be restored to the right people (design §3.7 defers accounts to a
 * future auth plugin). A reconnecting player starts rested, which is the
 * friendlier of the two wrong answers.
 */
const poolsByPlayer = new Map<string, ManaPool>();

/** The value a HUD would display: whole mana units. */
function displayBalance(pool: ManaPool): number {
  return Math.floor(pool.balance);
}

/** Pushes `mana:balance` to one player and records what was sent. */
function sendBalance(playerId: string, pool: ManaPool): void {
  if (api === null) return;
  const balance = displayBalance(pool);
  pool.lastSentBalance = balance;
  api.sendTo(playerId, MANA_BALANCE_MESSAGE, { balance, capacity: MANA_CAPACITY });
}

/**
 * The pool for a player, created at full capacity if it is missing.
 *
 * Lazy creation is a deliberate belt-and-suspenders guard on the validation
 * path below: if an intent ever reaches onIntent for a player whose join we did
 * not observe (a host-ordering bug, a plugin loaded into a world that already
 * had players), the correct failure mode is "this player can sculpt", not
 * "this player is silently frozen out of the world by our bookkeeping".
 */
function poolFor(playerId: string): ManaPool {
  const existing = poolsByPlayer.get(playerId);
  if (existing !== undefined) return existing;

  const created: ManaPool = { balance: MANA_CAPACITY, lastSentBalance: NO_BALANCE_SENT };
  poolsByPlayer.set(playerId, created);
  return created;
}

/**
 * INTENT VALIDATION PATH — CRITICAL.
 *
 * Runs inside the host's interceptor chain, after core has already established
 * that the intent is structurally valid and that its centre is in an unlocked
 * chunk (server/src/intent/pipeline.ts steps 1–2). Our only job is the economy:
 *
 *   balance < cost  → DENY. The first deny in the chain wins and the intent
 *                     never reaches the terrain; core applies nothing.
 *   otherwise       → charge the cost and allow. We deliberately do NOT return
 *                     a `modify` verdict: the intent is fine as written, and a
 *                     rewrite would force core to re-validate it for nothing.
 *
 * KNOWN RESIDUAL FAILURE MODE (documented rather than papered over): the charge
 * is applied here, before the edit is known to have landed. The current API has
 * no post-apply hook carrying the player, so there is no point at which a
 * charge could be committed or refunded. An intent charged here still fails to
 * apply if (a) a plugin ordered AFTER mana denies it, or (b) a plugin rewrites
 * it into something that fails core's re-validation (pipeline step 4). Neither
 * can happen with the plugins that ship in this repo — load order is
 * alphabetical, `mana` sorts before `reveal`, and reveal does not implement
 * onIntent at all — but a third-party plugin sorting after `mana` would expose
 * it. The fix belongs in core (an `onIntentApplied(intent, ctx, diff)` hook),
 * not in a workaround here; it is written up in the Phase 2 report.
 */
function chargeForSculpt(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
  const pool = poolFor(ctx.player.id);

  if (pool.balance < MANA_COST_PER_SCULPT) {
    // Tell the player why. Core's own rejections are silent on purpose — an
    // error reply would confirm the existence of locked terrain and defeat the
    // mask (pipeline.ts) — but "you are out of mana" leaks nothing about the
    // world, and a player who gets no feedback assumes the server is broken.
    api?.sendTo(ctx.player.id, MANA_DENIED_MESSAGE, {
      balance: displayBalance(pool),
      cost: MANA_COST_PER_SCULPT,
    });
    return { kind: 'deny', reason: INSUFFICIENT_MANA_REASON };
  }

  pool.balance -= MANA_COST_PER_SCULPT;
  sendBalance(ctx.player.id, pool);
  return { kind: 'allow' };
}

/**
 * Regenerates every pool by one tick's worth and pushes the pools whose whole-
 * unit balance actually moved. `dt` is the host's fixed tick period in seconds,
 * so regen is tied to simulated time and a server configured at a different
 * TICK_HZ regenerates at the same rate per second.
 */
function regenerate(dt: number): void {
  const gain = MANA_REGEN_PER_SECOND * dt;

  for (const [playerId, pool] of poolsByPlayer) {
    if (pool.balance >= MANA_CAPACITY) continue;
    pool.balance = Math.min(MANA_CAPACITY, pool.balance + gain);
    if (displayBalance(pool) !== pool.lastSentBalance) sendBalance(playerId, pool);
  }
}

export const plugin: TerracePlugin = {
  name: 'mana',

  onWorldCreate(world: WorldApi): void {
    api = world;
  },

  onPlayerJoin(player: Player): void {
    const pool: ManaPool = { balance: MANA_CAPACITY, lastSentBalance: NO_BALANCE_SENT };
    poolsByPlayer.set(player.id, pool);
    // The room sends the join snapshot before calling this hook, so the client
    // is already sized and listening; this is the first thing its HUD sees.
    sendBalance(player.id, pool);
  },

  onPlayerLeave(player: Player): void {
    poolsByPlayer.delete(player.id);
  },

  onTick(_world: WorldApi, dt: number): void {
    regenerate(dt);
  },

  onIntent(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
    return chargeForSculpt(intent, ctx);
  },
};

/** Test seam: a player's whole-unit balance, or null if they hold no pool. */
export function manaBalanceOf(playerId: string): number | null {
  const pool = poolsByPlayer.get(playerId);
  return pool === undefined ? null : displayBalance(pool);
}

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetManaState(): void {
  api = null;
  poolsByPlayer.clear();
}
