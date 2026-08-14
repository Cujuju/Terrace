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
 * player gets MANA_CAPACITY / MANA_COST_PER_SCULPT = 24 immediate sculpts.
 *
 * Retuned 2026-08-14 (owner request, up from 200/8 sculpts): the held brush
 * emits ~8 intents/s, so 24 is ~3 seconds of continuous sculpting — enough to
 * raise a whole feature in one gesture before the economy bites, where 8
 * emptied in a single second of holding and made denial the COMMON case
 * rather than the limit case. Regen is unchanged (20/s → a full refill in
 * 30 s, ~1.25 s of waiting per additional sculpt when drained).
 */
export const MANA_CAPACITY = 600;

/**
 * Charged per applied sculpt intent, regardless of brush radius. Flat on
 * purpose: the sculpt amount is already server-fixed (DEFAULT_SCULPT_AMOUNT),
 * so a flat cost makes the rate limit legible to a player — "one sculpt costs
 * one sculpt" — rather than something they have to model.
 */
export const MANA_COST_PER_SCULPT = 25;

/**
 * DEFAULT regeneration, in mana units per second of simulated time, for a world
 * whose deployment does not configure one. 20/s = one sculpt every 1.25 s
 * sustained, and a full empty-to-capacity refill in 30 s. Slow enough to be
 * felt, fast enough that a self-hoster poking at a fresh world is never left
 * staring at an empty gauge.
 *
 * Per-world overrides arrive through MANA_REGEN_ENV (see below): the pace of an
 * economy is a property of the world being hosted — a sandbox for two friends
 * and a persistent server for thirty want different answers — not of this
 * plugin, and the client HUD reads the rate off the wire rather than assuming
 * this number.
 *
 * NOTE: mana is an economy, not terrain math — the determinism contract in
 * CLAUDE.md governs shared/'s heightmap ops and does not apply here, so a
 * fractional pool is fine. State is still reproducible: regen is driven purely
 * by the fixed tick period the host passes in, never by wall-clock time.
 */
export const DEFAULT_MANA_REGEN_PER_SECOND = 20;

/**
 * Environment variable naming this world's regen rate, in mana units per
 * second. Read at onWorldCreate (like invite's SHARE_URL) rather than at module
 * load, so tests and a supervisor that restarts the world see the current
 * environment.
 */
export const MANA_REGEN_ENV = 'MANA_REGEN_PER_S';

/**
 * The longest a fully drained player may have to wait for one more sculpt. Sets
 * the FLOOR of the configurable band: a rate slower than "one sculpt a minute"
 * is indistinguishable, from inside the game, from a world where sculpting is
 * broken — the gauge barely moves and the player has no way to tell "wait" from
 * "this server is dead". A host who wants a read-only world should unload this
 * plugin's veto, not starve it.
 */
export const MAX_DRAINED_WAIT_S = 60;

/**
 * The shortest a full empty-to-capacity refill may take. Sets the CEILING:
 * at one refill per second, one sculpt's worth of regen lands every
 * MANA_COST_PER_SCULPT / MANA_CAPACITY = ~42 ms, which is already at the edge
 * of what a person reads as separate events rather than a blur — the HUD gauge
 * derives its pulse period from exactly that quantity. Faster than this the
 * economy has stopped being one (every tick refills everything), so the extra
 * range would buy nothing but a misleading readout.
 */
export const MIN_FULL_REFILL_S = 1;

/** Slowest rate a deployment may configure. See MAX_DRAINED_WAIT_S. */
export const MIN_MANA_REGEN_PER_SECOND = MANA_COST_PER_SCULPT / MAX_DRAINED_WAIT_S;

/** Fastest rate a deployment may configure. See MIN_FULL_REFILL_S. */
export const MAX_MANA_REGEN_PER_SECOND = MANA_CAPACITY / MIN_FULL_REFILL_S;

/** Logged when MANA_REGEN_PER_S is set to something unusable. */
export const MANA_REGEN_INVALID_WARNING = `[mana] ${MANA_REGEN_ENV} is not a positive finite number; falling back to ${DEFAULT_MANA_REGEN_PER_SECOND}/s`;

/** Logged when MANA_REGEN_PER_S is usable but outside the supported band. */
export const MANA_REGEN_CLAMPED_WARNING = `[mana] ${MANA_REGEN_ENV} clamped into [${MIN_MANA_REGEN_PER_SECOND}, ${MAX_MANA_REGEN_PER_SECOND}] mana/s`;

/**
 * UNTRUSTED INPUT (deployment configuration, i.e. a human with a text editor).
 *
 * Resolves the configured regen rate, in three layers, because each failure
 * mode has a different right answer:
 *
 *   unset / blank            → the default. Not configuring is not an error.
 *   not a positive finite    → the default, loudly. NaN or 0 or -5 would freeze
 *     number                   every pool at its starting balance forever (and
 *                              NaN would poison it permanently), so this must
 *                              never be taken at face value.
 *   outside the band         → clamped, loudly. A typo'd extra zero should slow
 *                              or speed the world to its documented limit, not
 *                              silently ship a world nobody can play.
 */
export function resolveManaRegenPerSecond(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return DEFAULT_MANA_REGEN_PER_SECOND;
  }

  // Number() rather than parseFloat(): parseFloat('20abc') is 20, which would
  // accept a value the host plainly did not mean.
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(MANA_REGEN_INVALID_WARNING);
    return DEFAULT_MANA_REGEN_PER_SECOND;
  }

  if (parsed < MIN_MANA_REGEN_PER_SECOND) {
    console.warn(MANA_REGEN_CLAMPED_WARNING);
    return MIN_MANA_REGEN_PER_SECOND;
  }
  if (parsed > MAX_MANA_REGEN_PER_SECOND) {
    console.warn(MANA_REGEN_CLAMPED_WARNING);
    return MAX_MANA_REGEN_PER_SECOND;
  }
  return parsed;
}

/**
 * This world's base regen rate: the default until onWorldCreate resolves the
 * environment. Perks scale it per player (see manaRegenFor).
 */
let regenPerSecond: number = DEFAULT_MANA_REGEN_PER_SECOND;

/** This world's base regen rate, before any player's perk. */
export function manaRegenPerSecond(): number {
  return regenPerSecond;
}

/**
 * What THIS player's pool actually earns per second, perk included — the number
 * the balance push carries so the client gauge can animate at the true rate
 * instead of guessing at a constant it has no business knowing.
 */
export function manaRegenFor(playerId: string): number {
  return regenPerSecond * manaPerkOf(playerId).regenMultiplier;
}

/**
 * Multiplier bounds for a perk (see setManaPerk). A perk may at most quarter a
 * price or quadruple it.
 *
 * The floor is the load-bearing one and it is NOT arbitrary: without it a
 * caller passing 0 — a bug, a bad config, or a hostile third-party plugin —
 * would make sculpting free and delete the economy this plugin exists to
 * provide, silently and for as long as that player is connected. Clamping into
 * a band means a wrong multiplier is a wrong price, never an absent one. The
 * ceiling is the mirror case: a perk cannot be used to freeze a player out.
 * 0.25 / 4 bracket the perks that ship (half cost, double regen) with a factor
 * of two of headroom on each side for plugins that stack them.
 */
export const MANA_PERK_MIN_MULTIPLIER = 0.25;
export const MANA_PERK_MAX_MULTIPLIER = 4;

/** The multiplier of a player holding no perk: prices and regen unchanged. */
export const NEUTRAL_MANA_MULTIPLIER = 1;

// Message names and payload shapes live in ../protocol.ts (shared with the
// client half); re-exported here so existing importers keep working.
import { MANA_BALANCE_MESSAGE, MANA_DENIED_MESSAGE } from '../protocol.ts';

export { MANA_BALANCE_MESSAGE, MANA_DENIED_MESSAGE };

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

// ────────────────────────────────────────────────────────────────────────────
// PERK API — the seam other plugins extend the economy through.
//
// Design §3.5 says the plugin API is right only if a mechanic can be built
// WITHOUT touching core. The relics plugin's mana perks (Azure Heart, Spring of
// Aether) are the first mechanic that has to touch ANOTHER PLUGIN, and this is
// how: mana exports a tiny, total function pair, and relics imports it. Core is
// not involved and does not need to be.
//
// The contract is deliberately "the player's TOTAL perk", not "add a perk":
// mana does not know what a skill is, how many a player may hold, or how two of
// them combine. The caller owns that composition and pushes the product here.
// A per-perk registry inside mana would be mana modelling someone else's
// domain, and would need an eviction rule mana has no basis to choose.
// ────────────────────────────────────────────────────────────────────────────

/**
 * A player's standing modifiers. An omitted field means neutral (1) — this is
 * a whole-state setter, so a call that omits `regenMultiplier` clears any regen
 * perk that player previously had.
 */
export interface ManaPerk {
  /** Scales MANA_COST_PER_SCULPT. Below 1 = cheaper. */
  readonly costMultiplier?: number;
  /** Scales this world's regen rate (manaRegenPerSecond). Above 1 = faster. */
  readonly regenMultiplier?: number;
}

/** A normalized perk: both fields present, both already validated and clamped. */
interface EffectiveManaPerk {
  readonly costMultiplier: number;
  readonly regenMultiplier: number;
}

const NEUTRAL_PERK: EffectiveManaPerk = {
  costMultiplier: NEUTRAL_MANA_MULTIPLIER,
  regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
};

/**
 * Perks by Player.id. Same per-connection keying as the pools above, and the
 * same reason for it: there is no stable player identity yet (design §3.7).
 */
const perksByPlayer = new Map<string, EffectiveManaPerk>();

/**
 * UNTRUSTED INPUT (from another plugin, which may be third-party and buggy).
 *
 * Anything that is not a finite number degrades to neutral rather than
 * poisoning the pool with NaN — a NaN balance compares false against every
 * threshold, so it would make a player permanently unable to sculpt AND
 * permanently unable to notice why. Finite values are clamped into the band
 * documented on MANA_PERK_MIN_MULTIPLIER.
 */
function normalizeMultiplier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NEUTRAL_MANA_MULTIPLIER;
  if (value < MANA_PERK_MIN_MULTIPLIER) return MANA_PERK_MIN_MULTIPLIER;
  if (value > MANA_PERK_MAX_MULTIPLIER) return MANA_PERK_MAX_MULTIPLIER;
  return value;
}

/**
 * Sets a player's total perk, replacing whatever they had. Safe to call for a
 * player mana has never seen: the perk is applied the moment they do sculpt,
 * via the same lazy pool creation the intent path already relies on.
 */
export function setManaPerk(playerId: string, perk: ManaPerk): void {
  perksByPlayer.set(playerId, {
    costMultiplier: normalizeMultiplier(perk.costMultiplier),
    regenMultiplier: normalizeMultiplier(perk.regenMultiplier),
  });
}

/** Drops a player's perk, returning them to standard prices and regen. */
export function clearManaPerk(playerId: string): void {
  perksByPlayer.delete(playerId);
}

/** A player's effective perk — neutral when they hold none. */
export function manaPerkOf(playerId: string): EffectiveManaPerk {
  return perksByPlayer.get(playerId) ?? NEUTRAL_PERK;
}

/**
 * What one sculpt costs this player.
 *
 * Rounded UP: a fractional price would drift the pool away from the whole-unit
 * value the HUD shows, and rounding up rather than down means the floor imposed
 * by MANA_PERK_MIN_MULTIPLIER cannot be undercut into zero by rounding. With
 * the shipped 0.5 perk this is ceil(12.5) = 13 — "about half", by one unit.
 */
export function manaCostFor(playerId: string): number {
  return Math.ceil(MANA_COST_PER_SCULPT * manaPerkOf(playerId).costMultiplier);
}

/** The value a HUD would display: whole mana units. */
function displayBalance(pool: ManaPool): number {
  return Math.floor(pool.balance);
}

/** Pushes `mana:balance` to one player and records what was sent. */
function sendBalance(playerId: string, pool: ManaPool): void {
  if (api === null) return;
  const balance = displayBalance(pool);
  pool.lastSentBalance = balance;
  api.sendTo(playerId, MANA_BALANCE_MESSAGE, {
    balance,
    capacity: MANA_CAPACITY,
    // The perk-adjusted price of this player's next sculpt: what the client's
    // local intent gate compares the balance against (see ../protocol.ts).
    cost: manaCostFor(playerId),
    // The perk-adjusted rate this pool refills at. Display-only on the client
    // (it animates the gauge between pushes); the authoritative arithmetic
    // stays here.
    regenPerSecond: manaRegenFor(playerId),
  });
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
  // The price this player pays, after any perk another plugin has set on them.
  // Read per intent rather than cached: a perk can be granted or revoked at any
  // moment (a relic collected mid-stroke), and a stale price is a wrong charge.
  const cost = manaCostFor(ctx.player.id);

  if (pool.balance < cost) {
    // Tell the player why. Core's own rejections are silent on purpose — an
    // error reply would confirm the existence of locked terrain and defeat the
    // mask (pipeline.ts) — but "you are out of mana" leaks nothing about the
    // world, and a player who gets no feedback assumes the server is broken.
    // The cost travels with it: with perks in play it is no longer a constant
    // the client could have known.
    api?.sendTo(ctx.player.id, MANA_DENIED_MESSAGE, {
      balance: displayBalance(pool),
      cost,
    });
    return { kind: 'deny', reason: INSUFFICIENT_MANA_REASON };
  }

  pool.balance -= cost;
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
  const baseGain = regenPerSecond * dt;

  for (const [playerId, pool] of poolsByPlayer) {
    if (pool.balance >= MANA_CAPACITY) continue;
    // Per-player, because regen is perk-scaled: a Spring of Aether holder earns
    // faster than everyone else in the same tick. Capacity is deliberately NOT
    // scaled — a perk changes the rate you fill at, never how much you can hold,
    // so a burst of sculpts stays worth the same to every player.
    pool.balance = Math.min(
      MANA_CAPACITY,
      pool.balance + baseGain * manaPerkOf(playerId).regenMultiplier,
    );
    if (displayBalance(pool) !== pool.lastSentBalance) sendBalance(playerId, pool);
  }
}

export const plugin: TerracePlugin = {
  name: 'mana',

  onWorldCreate(world: WorldApi): void {
    api = world;
    // Read here, not at module load: a supervisor that recreates the world (and
    // every test that boots one) must see the environment as it is NOW.
    regenPerSecond = resolveManaRegenPerSecond(process.env[MANA_REGEN_ENV]);
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
    // Perks die with the connection, exactly like the pool. Player.id is a
    // per-connection sessionId (design §3.7), so leaving a perk behind would
    // not "remember" that player — it would sit in the map forever, and would
    // apply to whoever the transport eventually hands the same id to. Neither
    // outcome is acceptable, so the plugin that granted it does not have to
    // remember to revoke it: mana forgets on leave, unconditionally.
    clearManaPerk(player.id);
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
  regenPerSecond = DEFAULT_MANA_REGEN_PER_SECOND;
  poolsByPlayer.clear();
  perksByPlayer.clear();
}
