// mana — the second example plugin (design doc): proof that
// the plugin API generalizes past the reveal mechanic it was designed around.
//
// It exercises a different quadrant of the contract than reveal does:
//
//   reveal : onWorldCreate + onTerrainChanged + persistence, no player identity
//   mana   : onWorldCreate + onPlayerJoin/Leave + onTick + onIntent (DENY)
//            + onIntentApplied (CHARGE) + namespaced server → client messages
//
// The economy itself is deliberately the simplest thing that is still a real
// veto: every player holds a pool, the pool regenerates on the server's fixed
// tick, and a sculpt intent that cannot pay is DENIED in the interceptor chain —
// the sim is never patched, exactly as design doc requires ("a mana plugin
// vetoes/modifies intents rather than patching the sim").
//
// TWO-PHASE INTENT PROCESSING (issue #19, 2026-08-18): checking affordability
// and charging for it are two different hooks, `onIntent` (verdict) and
// `onIntentApplied` (effect) — see both functions below and their doc
// comments in server/src/plugins/types.ts. This is what makes a later
// interceptor's veto (monsters denying a raise near a living Cthulhu, e.g.)
// cost the player nothing: mana no longer touches the pool until the whole
// intent has cleared every interceptor and actually landed.

import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  WORLD_UNIT_CELLS,
  cellsAcross,
  sculptOptionsOf,
  sculptSweepSteps,
} from '@terrace/shared';
import type { CellDiff, SculptIntent } from '@terrace/shared';
import { chunkUnlockPenalty, openedChunkCount, sculptManaCost } from '../pricing.ts';
// The difficulty band core publishes (WorldApi.difficulty lives inside it). A
// RUNTIME import into core, unlike the type-only one below, and the dependency
// runs the allowed direction — plugins depend on core, never the reverse — so
// this plugin's two anchors stay pinned to the ends of core's own scale instead
// of restating them as literals.
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../../../server/src/config.ts';
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

// ────────────────────────────────────────────────────────────────────────────
// PRICING — VOLUME, NOT PER-CLICK (owner-settled 2026-08-14: "define the cost
// of sculpting in terms of mana").
//
// A sculpt costs mana in proportion to the terrain volume its brush nominally
// displaces, measured in BAND-CELLS: one terrace band of height, moved over one
// cell. The flat MANA_COST_PER_SCULPT this replaces charged a radius-4 hard
// plateau — 45 cells, 45 band-cells of rock — exactly what it charged for
// nudging a single cell, which made the big brushes strictly free money and gave
// the player nothing to weigh.
//
// The arithmetic itself is in ../pricing.ts, because the client half must price
// an intent to the same integer (see the gate in ../client/state.ts).
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE RATE: mana charged per band-cell displaced. This is the ONE number the
 * economy's prices are tuned through, and it is what travels on the wire (the
 * balance push carries it perk-adjusted, so the client can price any intent).
 *
 * DERIVED FROM THE OWNER'S TUNING CONSTRAINT "a radius-1 stamp stays cheap,
 * ≈5–8 mana". A radius-1 brush was the Populous point brush at ONE CELL of
 * ground, moved by exactly DEFAULT_SCULPT_AMOUNT = BAND_HEIGHT, i.e. exactly
 * one band-cell, so its price was the rate itself and the constraint was
 * literally a constraint on this constant: 6, the middle of the band.
 *
 * PRICED BY GROUND, NOT BY SAMPLE (2026-08-21). The cost model is "proportional
 * to the terrain VOLUME the brush nominally displaces", and a volume is
 * height × ground area — so the rate is denominated per band over one SQUARE
 * WORLD UNIT and divided into band-cells here. Left at 6 per band-CELL, the
 * 2026-08-21 re-sample would have multiplied the price of reshaping any given
 * piece of ground by sixteen: the widest hard stamp goes from 37 band-cells to
 * ~590 for the same disc of terrain, so a full pool would have bought a fifth
 * of a stamp and the regen anchors below — absolute mana per second, owner-set
 * — would have meant something entirely different. Everything measured against
 * the ground is therefore unchanged: the widest stamp still costs 222, the pool
 * is still three of them, and a warm world still refills in ~4 s.
 *
 * WHAT DID MOVE, AND IT IS THE OWNER'S ANCHOR ABOVE: the radius-1 brush is now
 * the finest the GRID can express rather than a world unit of ground, so it
 * displaces a sixteenth of what it used to and prices at 0.375, which
 * sculptManaCost's ceil renders as 1 mana. The constraint it was tuned against
 * ("stays cheap") holds a fortiori; the number does not. Re-anchoring the
 * cheapest stamp back to 5–8 mana would mean charging sixteen times the going
 * rate for the finest brush, which is a decision about the economy rather than
 * about the grid — flagged rather than taken here.
 *
 * The tidy-integer property the old rate had (every base price an exact
 * integer, so `ceil` only ever rounded a PERK-adjusted price) is gone with it,
 * for the same reason and by the same sixteenth.
 */
export const MANA_PER_BAND_WORLD_UNIT_SQUARED = 6;
export const MANA_PER_BAND_CELL =
  MANA_PER_BAND_WORLD_UNIT_SQUARED / (WORLD_UNIT_CELLS * WORLD_UNIT_CELLS);

/**
 * The price of the cheapest sculpt a PLAYER can make: the point brush — one
 * world unit of ground, moved one band. Derived rather than written down, so it
 * cannot drift from the rate. It is spelled out because the regen band below is
 * derived from "one more sculpt", and "one more sculpt" means this one.
 *
 * NOT shared's MIN_BRUSH_RADIUS since the 2026-08-21 re-sample. That is the
 * PROTOCOL's floor — one CELL, a sixteenth of this footprint, offered by no UI
 * (see client/src/state/hudState.ts's BRUSH_RADII) — and pricing it comes to
 * 0.375, which sculptManaCost's ceil renders as 1. Anchoring an economy on a
 * brush nobody holds, at a price that is mostly rounding, would have made every
 * number derived from it (the regen floor, the HUD's grain cue) meaningless.
 *
 * Profile is irrelevant at this radius on flat ground; 'soft' is named because
 * it is the wire default.
 */
export const POINT_BRUSH_RADIUS_CELLS = cellsAcross(1);
export const MANA_COST_PER_MIN_RADIUS_SCULPT = sculptManaCost(
  MANA_PER_BAND_CELL,
  POINT_BRUSH_RADIUS_CELLS,
  'soft',
  'stamp',
);

/**
 * The most expensive sculpt that exists: the widest HARD stamp, which moves a
 * full band across every cell of its footprint — 749 band-cells since the
 * 2026-08-21 re-sample (37 before it, on a grid four times coarser; the tight
 * disc is a rounder circle at this density, so the same four world units of
 * reach cover 46.8 square world units rather than 37), ~47× the point
 * brush. DERIVED, so it re-tuned itself when the footprint changed. The pool
 * is sized against this (see MANA_CAPACITY).
 */
export const MANA_COST_PER_MAX_RADIUS_HARD_SCULPT = sculptManaCost(
  MANA_PER_BAND_CELL,
  MAX_BRUSH_RADIUS,
  'hard',
  'stamp',
);

/**
 * The owner's other tuning constraint: how many of those maximum stamps a full
 * pool buys. Stated as "≈3–4"; 3 is taken, and the reason is the conflict below.
 *
 * THE TWO CONSTRAINTS ARE NOT SIMULTANEOUSLY SATISFIABLE, and pretending
 * otherwise would just hide which one was quietly dropped. Under a strictly
 * volume-proportional price the ratio between the two stamps is fixed by
 * GEOMETRY, not by tuning: a radius-4 hard stamp displaces exactly 45 band-cells
 * to the point brush's 1. "≈100 radius-1 stamps" therefore means 100/45 = 2.2
 * big stamps, and "3 big stamps" means 135 point stamps — the same pool cannot
 * be both. Taking 3 (the LOW end of the owner's second range) is the choice that
 * satisfies that range exactly while overshooting the ≈100 by the least possible
 * margin; going the other way — 100 point stamps — would land outside the stated
 * 3–4 entirely, and 4 big stamps would put the point-stamp count at 180.
 *
 * The alternative that would satisfy both is a price that is sub-linear in
 * volume (a discount for big brushes), which is not the model the owner settled:
 * "proportional to the terrain volume its brush nominally displaces".
 */
export const FULL_POOL_MAX_RADIUS_HARD_STAMPS = 3;

/**
 * Full pool, in mana units — DERIVED from the tuning constraint above rather
 * than written down, so the constraint is executable and re-tuning the rate
 * re-sizes the pool with it:
 *
 *   MANA_CAPACITY = 3 × 222 = 666   (3 × 270 = 810 before the 2026-08-19
 *                                    tight-disc footprint shrank the radius-4
 *                                    hard stamp from 45 to 37 band-cells)
 *
 * What that buys, at rate 6 (pinned by a test, so these numbers cannot rot):
 *
 *   radius 1 (either profile)  6 mana   → 111 stamps from a full pool
 *   radius 2 soft / hard      18 / 30   →  37 / 22
 *   radius 3 soft / hard      62 / 126  →  10 /  5
 *   radius 4 soft / hard     108 / 222  →   6 /  3
 *
 * The held brush emits ~8 intents/s, so 111 point stamps is ~14 s of
 * continuous fine detailing before the economy bites, while three big plateaus
 * empty the same pool — which is the point of pricing by volume: the player
 * chooses between reach and stamina instead of always taking the biggest
 * brush.
 */
export const MANA_CAPACITY =
  FULL_POOL_MAX_RADIUS_HARD_STAMPS * MANA_COST_PER_MAX_RADIUS_HARD_SCULPT;

// Regen is interpolated from WorldApi.difficulty: 1 is warm, 100 is punishing.
// Driven by the host's fixed tick period, never wall-clock time.

/** Regen at MIN_WORLD_DIFFICULTY, mana per second of simulated time. */
export const MANA_REGEN_AT_DIFFICULTY_1 = 300;

/** Regen at MAX_WORLD_DIFFICULTY. */
export const MANA_REGEN_AT_DIFFICULTY_100 = 30;

/**
 * Linear between the two anchors, so difficulty 50 gives 166.4/s. Clamped and
 * NaN-guarded: a non-finite rate would freeze a player out permanently.
 */
export function manaRegenForDifficulty(difficulty: number): number {
  const rated = Number.isFinite(difficulty) ? difficulty : DEFAULT_WORLD_DIFFICULTY;
  const span = MAX_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY;
  const t = Math.min(1, Math.max(0, (rated - MIN_WORLD_DIFFICULTY) / span));
  return (
    MANA_REGEN_AT_DIFFICULTY_1 +
    t * (MANA_REGEN_AT_DIFFICULTY_100 - MANA_REGEN_AT_DIFFICULTY_1)
  );
}

/**
 * Environment variable naming this world's regen rate, in mana units per
 * second. Read at onWorldCreate (like invite's SHARE_URL) rather than at module
 * load, so tests and a supervisor that restarts the world see the current
 * environment.
 *
 * PRECEDENCE: an explicitly set MANA_REGEN_PER_S ALWAYS beats the difficulty
 * derivation. A host who writes a number means that number — they are configuring
 * this plugin directly, and having a world-level dial silently overrule them
 * would make the setting a lie. Difficulty is the DEFAULT, i.e. the answer for a
 * deployment that has said nothing about mana specifically.
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
 * The shortest a full empty-to-capacity refill may take. Sets the CEILING, and
 * it stands on its own terms: at one refill per second the pool is back to full
 * within the reaction time of the player who emptied it, so nothing they can do
 * ever meets a limit — the economy has stopped being one (every tick refills
 * everything) and the extra range would buy nothing.
 *
 * WHAT THE GAUGE DOES UP HERE, since the old derivation of this bound leaned on
 * it: at this ceiling one point stamp's worth of regen lands every
 * MANA_COST_PER_MIN_RADIUS_SCULPT / MANA_CAPACITY = 6/666 ≈ 9 ms, far below the
 * gauge's MIN_PULSE_PERIOD_S (0.25 s) floor. The falling-grain cue therefore
 * saturates at its fastest legible rhythm rather than trying to draw ~135 grains
 * a second, which is both a flicker hazard and unreadable. That clamp lives in
 * the gauge (client/gauge.ts) where it belongs; it is not a reason to move this
 * bound, because a rate can be unplayable-fast without being illegible-fast.
 */
export const MIN_FULL_REFILL_S = 1;

/**
 * Slowest rate a deployment may configure: one more sculpt — the CHEAPEST one,
 * the radius-1 point brush — inside MAX_DRAINED_WAIT_S. 6/60 = 0.1 mana/s.
 *
 * The cheapest sculpt is the right one to anchor this to: the promise the floor
 * makes is "a drained player can always do SOMETHING again within a minute", and
 * the thing they can always do is the point brush. Anchoring it to a big brush
 * instead would force every world to regenerate 45× faster to make the same
 * promise about the one edit a player might not want to make.
 */
export const MIN_MANA_REGEN_PER_SECOND =
  MANA_COST_PER_MIN_RADIUS_SCULPT / MAX_DRAINED_WAIT_S;

/** Fastest rate a deployment may configure. See MIN_FULL_REFILL_S. */
export const MAX_MANA_REGEN_PER_SECOND = MANA_CAPACITY / MIN_FULL_REFILL_S;

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY: INSTANT REGEN FOR SCULPT TESTING (owner, 2026-08-24).
//
// THIS IS SCAFFOLDING AND IT IS MEANT TO COME OUT. It exists so the layer-edge
// Drag tool can be exercised without the economy interrupting, and it must be
// removed once that work is done — tracked as its own issue so it cannot be
// forgotten in a comment nobody reads.
//
// WHY AN ENV FLAG RATHER THAN AN EDITED CONSTANT. Re-tuning
// MANA_REGEN_AT_DIFFICULTY_1 or MANA_CAPACITY would change what the shipped
// game is balanced at, and a test setting that lives in the same numbers the
// balance does is a test setting that eventually ships. A flag defaults to off,
// changes nothing for anyone who does not set it, and deleting it is a
// mechanical change rather than a judgement about what the numbers should be.
//
// WHY NOT MANA_REGEN_PER_S, which already exists. That value is clamped into
// [MIN_MANA_REGEN_PER_SECOND, MAX_MANA_REGEN_PER_SECOND], and the ceiling is a
// one-second full refill by design — deliberately short of "never runs out",
// which is the property the sculpt testing actually needs. Raising the clamp to
// reach it would move a bound that states what rates the economy still works
// at, for a reason that has nothing to do with the economy.

/**
 * Environment variable that makes every pool regenerate instantly: set to '1',
 * 'true' or 'yes' and no player ever runs out of mana.
 */
export const MANA_INSTANT_REGEN_ENV = 'MANA_INSTANT_REGEN';

/** The values that turn it on. Anything else — including unset — leaves it off. */
const MANA_INSTANT_REGEN_TRUTHY = new Set(['1', 'true', 'yes']);

/** Whether instant regen is on for this process. Read once: it is a launch switch. */
export function instantRegenEnabled(raw: string | undefined): boolean {
  return raw !== undefined && MANA_INSTANT_REGEN_TRUTHY.has(raw.trim().toLowerCase());
}

/** Logged on startup so a world running with the test switch on says so. */
export const MANA_INSTANT_REGEN_WARNING =
  `[mana] ${MANA_INSTANT_REGEN_ENV} is on — pools never drain. TEST SETTING; must not be on in a shipped world`;

/** Logged when MANA_REGEN_PER_S is set to something unusable. */
export const MANA_REGEN_INVALID_WARNING = `[mana] ${MANA_REGEN_ENV} is not a positive finite number; falling back to this world's difficulty-derived rate`;

/** Logged when MANA_REGEN_PER_S is usable but outside the supported band. */
export const MANA_REGEN_CLAMPED_WARNING = `[mana] ${MANA_REGEN_ENV} clamped into [${MIN_MANA_REGEN_PER_SECOND}, ${MAX_MANA_REGEN_PER_SECOND}] mana/s`;

/**
 * The supported band, applied to WHICHEVER SOURCE WON — explicit environment or
 * difficulty derivation. The derived rates (20…200/s) sit comfortably inside it,
 * so today this only ever bites a hand-configured value; it is applied to both
 * anyway, because the band is the plugin's statement about what rates the
 * economy still works at, not a statement about text parsing. Re-anchor the
 * derivation past a bound one day and it clamps instead of shipping a world
 * nobody can play.
 */
function clampManaRegenPerSecond(rate: number, onClamp?: () => void): number {
  if (rate < MIN_MANA_REGEN_PER_SECOND) {
    onClamp?.();
    return MIN_MANA_REGEN_PER_SECOND;
  }
  if (rate > MAX_MANA_REGEN_PER_SECOND) {
    onClamp?.();
    return MAX_MANA_REGEN_PER_SECOND;
  }
  return rate;
}

/**
 * UNTRUSTED INPUT (deployment configuration, i.e. a human with a text editor).
 *
 * Resolves this world's base regen rate. `raw` is MANA_REGEN_PER_S as the host
 * wrote it; `difficulty` is WorldApi.difficulty.
 *
 * PRECEDENCE, and it is one-way: an EXPLICIT, usable MANA_REGEN_PER_S always
 * wins. Difficulty only supplies the DEFAULT — the answer for a deployment that
 * has configured this plugin not at all.
 *
 * Four layers, because each failure mode has a different right answer:
 *
 *   unset / blank            → the difficulty-derived rate. Not configuring is
 *                              not an error; it is how you opt into the dial.
 *   not a positive finite    → the difficulty-derived rate, loudly. NaN or 0 or
 *     number                   -5 would freeze every pool at its starting
 *                              balance forever (and NaN would poison it
 *                              permanently), so this must never be taken at face
 *                              value. It is treated as "not configured", not as
 *                              a reason to refuse to boot: mana is a plugin, and
 *                              a typo in an optional setting should not cost a
 *                              self-hoster their world.
 *   explicit and usable      → that number, whatever the difficulty says.
 *   outside the band         → clamped, loudly. A typo'd extra zero should slow
 *                              or speed the world to its documented limit, not
 *                              silently ship a world nobody can play.
 */
export function resolveManaRegenPerSecond(raw: string | undefined, difficulty: number): number {
  const derived = manaRegenForDifficulty(difficulty);

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return clampManaRegenPerSecond(derived);
  }

  // Number() rather than parseFloat(): parseFloat('20abc') is 20, which would
  // accept a value the host plainly did not mean.
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(MANA_REGEN_INVALID_WARNING);
    return clampManaRegenPerSecond(derived);
  }

  return clampManaRegenPerSecond(parsed, () => {
    console.warn(MANA_REGEN_CLAMPED_WARNING);
  });
}

/**
 * This world's base regen rate: the rate of a default-difficulty world until
 * onWorldCreate resolves the real one. Perks scale it per player (see
 * manaRegenFor).
 */
let regenPerSecond: number = manaRegenForDifficulty(DEFAULT_WORLD_DIFFICULTY);

/**
 * TEMPORARY: whether this world runs with instant regen (see
 * MANA_INSTANT_REGEN_ENV). Resolved in onWorldCreate beside regenPerSecond, for
 * the same reason — the environment is read when a world is made, not when the
 * module loads, so a test that boots a world sees the environment as it is now.
 */
let instantRegen = false;

/** This world's base regen rate, before any player's perk. */
export function manaRegenPerSecond(): number {
  return regenPerSecond;
}

/** What this player's pool earns per second, perk included. */
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
  /**
   * Simulated milliseconds since the last push to this player, advanced by the
   * regen tick and reset by `sendBalance`. Drives MANA_BALANCE_HEARTBEAT_MS.
   *
   * SIMULATED, not wall-clock, for the same reason regen is: it is accumulated
   * from the host's fixed `dt`, so a server at a different TICK_HZ re-affirms
   * at the same rate per second and a test can advance it by ticking.
   */
  msSinceLastSend: number;
  /**
   * The highest `seq` of this player's intents this plugin has seen, or null
   * before the first. Stamped on every push as `asOfSeq` so the client can
   * tell which of its local debits the push already accounts for
   * (../protocol.ts, ManaBalanceMessage.asOfSeq). Highest, not latest: the
   * client's seq is monotonic, so an intent core dropped before any hook ran
   * (rate limit, malformed) is covered by the next one that gets through.
   */
  lastSeenSeq: number | null;
}

/** Records an intent's seq against its sender's pool — see ManaPool.lastSeenSeq. */
function noteSeq(pool: ManaPool, intent: SculptIntent): void {
  if (intent.seq === undefined) return;
  if (pool.lastSeenSeq === null || intent.seq > pool.lastSeenSeq) pool.lastSeenSeq = intent.seq;
}

/** The `asOfSeq` field for a push to this pool's player, or nothing to add. */
function asOfSeqOf(pool: ManaPool): { asOfSeq?: number } {
  return pool.lastSeenSeq === null ? {} : { asOfSeq: pool.lastSeenSeq };
}

/** Sentinel for "no balance has been pushed to this player yet". */
const NO_BALANCE_SENT = -1;

/**
 * HOW LONG A PLAYER MAY GO WITHOUT HEARING THEIR BALANCE, in simulated
 * milliseconds. Past this, `regenerate` re-affirms the pool even though nothing
 * about it moved.
 *
 * WHY IT EXISTS (owner, 2026-09-05: "I don't ever want to see the land snap
 * back"). The client's gate is now a strict lower bound on this balance — it
 * credits itself no regen the server has not ticked (plugins/mana/client/
 * state.ts) — which is what makes an approved stroke un-clawable. A lower bound
 * only works if it can be RAISED, and the only thing that raises it is a push.
 * Every applied and every denied intent already pushes, so an active stroke is
 * corrected per intent; the hole is the idle player whose pool is FULL, because
 * a full pool regenerates by nothing, moves its whole-unit balance by nothing,
 * and so used to push nothing — leaving a client that had drifted low frozen
 * out for the rest of the session (the 2026-08-24 stuck-gate report). This
 * closes that hole at its source instead of papering it with an optimistic
 * client estimate.
 *
 * THE VALUE is IN_FLIGHT_DEBIT_TTL_MS / PREDICTION_TTL_MS, the deadline both
 * halves already agree means "an intent unanswered this long is lost": a client
 * that drops a phantom debit on that deadline hears an authoritative balance
 * within one further beat, so the two recovery paths run at the same cadence
 * rather than at two numbers that have to be reasoned about separately. It is
 * NOT tuned for how fast regen becomes spendable — below capacity, regen moves
 * the whole-unit balance every tick and pushes on its own, and at capacity there
 * is no regen to withhold.
 *
 * The cost is one message per second per idle player, and only while their pool
 * is unchanged.
 */
export const MANA_BALANCE_HEARTBEAT_MS = 1000;

/**
 * Pools keyed by Player.id — currently the Colyseus sessionId, which is
 * per-connection. That is why this plugin has no `persistence` slice: there is
 * no stable player identity to key persisted balances by, so a snapshot of them
 * could not be restored to the right people (design doc defers accounts to a
 * future auth plugin). A reconnecting player starts rested, which is the
 * friendlier of the two wrong answers.
 */
const poolsByPlayer = new Map<string, ManaPool>();

// ────────────────────────────────────────────────────────────────────────────
// PERK API — the seam other plugins extend the economy through.
//
// Design doc says the plugin API is right only if a mechanic can be built
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
  /**
   * Scales MANA_PER_BAND_CELL — the RATE, not a per-sculpt price. Below 1 =
   * cheaper. Scaling the rate rather than the price is what keeps a perk
   * meaningful under volume pricing: a half-cost holder pays half for every
   * brush they pick up, instead of half for one size of sculpt.
   */
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
 * same reason for it: there is no stable player identity yet (design doc).
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
 * THIS PLAYER'S RATE: mana per band-cell, after whatever cost perk they hold.
 *
 * This — not a price — is what goes on the wire, and it is the whole reason the
 * client can gate an intent the server has never seen: a rate plus the shared
 * volume function prices ANY brush, so the client needs no round trip to learn
 * what the radius-3 hard stamp it is about to send will cost.
 *
 * NOT rounded. Rounding here would quantise the rate (6 × 0.5 = 3 is fine, but
 * 6 × 0.75 = 4.5 would become 4 or 5) and throw away the perk's precision at
 * every brush size; the single rounding happens once, at the end, in
 * sculptManaCost. Keeping exactly one rounding step is also what lets the client
 * reproduce the server's integer exactly.
 */
export function manaPerBandCellFor(playerId: string): number {
  return MANA_PER_BAND_CELL * manaPerkOf(playerId).costMultiplier;
}

/**
 * What THIS INTENT costs THIS player: the perk-adjusted rate times the volume
 * the intent's brush displaces (../pricing.ts).
 *
 * Per intent, not per player: since volume pricing the price is a function of
 * the brush, so there is no such thing as "this player's sculpt cost" without an
 * intent to price. `sculptOptionsOf` resolves the intent's optional profile
 * through the SAME shared normalisation the terrain math uses, so the cell a
 * price is charged for is the cell an edit actually touches — the client gate
 * calls it too, on the same intent.
 *
 * Rounded UP inside sculptManaCost: a fractional price would drift the pool away
 * from the whole-unit value the HUD shows, and rounding up rather than down
 * means the floor imposed by MANA_PERK_MIN_MULTIPLIER cannot be undercut into
 * zero by rounding. With the shipped 0.5 perk a point stamp is ceil(3) = 3 and a
 * radius-3 soft is ceil(34.5) = 35 — "about half", never free.
 */
export function manaCostFor(
  playerId: string,
  intent: SculptIntent,
  openedChunks: number = 0,
): number {
  const options = sculptOptionsOf(intent);
  const rate = manaPerBandCellFor(playerId);
  const stroke = sculptManaCost(
    rate,
    intent.radius,
    options.profile,
    options.tool,
    sculptSweepSteps(intent),
  );
  // THE LAND THIS STROKE CLAIMS, priced at what the full brush would have paid
  // for it (../pricing.ts's chunkUnlockPenalty). Zero for the overwhelming
  // majority of strokes, which open nothing; zero at the full brush whatever
  // they open. Defaulted so a caller pricing a brush with no position in mind
  // — the client's gauge — gets the stroke price it is asking for.
  if (openedChunks === 0) return stroke;
  return (
    stroke +
    openedChunks * chunkUnlockPenalty(rate, intent.radius, options.profile, options.tool)
  );
}

/**
 * How many chunks this intent would OPEN for its sculptor — the footprint's
 * chunks their token has not already earned.
 *
 * ASKED TWICE PER INTENT, in the verdict phase and again in the effect phase,
 * and it must answer the same both times. It does, but only because the reveal
 * plugin opens those chunks from its OWN onIntentApplied and effect hooks run
 * in LOAD ORDER (server/src/plugins/discovery.ts sorts by raw directory name):
 * 'mana' precedes 'reveal', so this plugin charges for the land before that
 * one hands it over. The same ordering already decides that relics' brush
 * widening is billed (see onIntentApplied's doc comment in
 * server/src/plugins/types.ts); this is the second thing it settles.
 */
function openedChunksFor(world: WorldApi, token: string, intent: SculptIntent): number {
  return openedChunkCount(
    world.worldSize,
    intent.x,
    intent.y,
    intent.radius,
    (cx, cy) => world.isChunkUnlockedForToken(token, cx, cy),
  );
}

/** The value a HUD would display: whole mana units. */
function displayBalance(pool: ManaPool): number {
  return Math.floor(pool.balance);
}

/** Pushes `mana:balance` to one player and records what was sent. */
function sendBalance(world: WorldApi, playerId: string, pool: ManaPool): void {
  const balance = displayBalance(pool);
  pool.lastSentBalance = balance;
  pool.msSinceLastSend = 0;
  world.sendTo(playerId, MANA_BALANCE_MESSAGE, {
    balance,
    capacity: MANA_CAPACITY,
    ...asOfSeqOf(pool),
    // The perk-adjusted RATE, not a price: prices depend on the brush the
    // player is holding, which is a client-side fact the server does not track
    // and has no business tracking. Handing over the rate lets the client's
    // local intent gate price the exact intent it is about to send, with the
    // same shared function this server charges by (../pricing.ts).
    manaPerBandCell: manaPerBandCellFor(playerId),
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

  const created: ManaPool = {
    balance: MANA_CAPACITY,
    lastSentBalance: NO_BALANCE_SENT,
    msSinceLastSend: 0,
    lastSeenSeq: null,
  };
  poolsByPlayer.set(playerId, created);
  return created;
}

/**
 * CHARGES A PLAYER FOR A NON-SCULPT ACTION. True if they could afford it and
 * were debited; false leaves the pool untouched.
 *
 * Added 2026-08-24 for fire's ignite (plugins/fire/server/mana-bridge.ts), and
 * it is the first thing to spend mana that is not a sculpt. The split is
 * deliberate:
 *
 *   A SCULPT is priced HERE, because mana knows what terrain costs — the
 *   pricing is shared terrain math (../pricing.ts) and the interceptor chain
 *   already routes every intent through this plugin.
 *   ANY OTHER ACTION is priced by the plugin that owns it. Fire knows what
 *   lighting a fire is worth; mana has no opinion and should not grow one. So
 *   this takes an AMOUNT, not an action — mana stays the ledger and never
 *   becomes a table of what everything in the game costs.
 *
 * Pushes the new balance immediately rather than waiting for the regen tick's
 * next whole-unit change: the caller's client predicted a debit the moment it
 * asked, and a spend it cannot see land reads as the action having failed.
 */
export function spendMana(world: WorldApi, playerId: string, amount: number): boolean {
  // A malformed amount is refused rather than trusted into the pool, where a
  // NaN balance compares false against every threshold and would silently make
  // the player unable to sculpt forever — the exact failure mode this file
  // already guards the regen path against.
  if (!Number.isFinite(amount) || amount < 0) return false;

  const pool = poolFor(playerId);
  if (pool.balance < amount) return false;

  pool.balance -= amount;
  sendBalance(world, playerId, pool);
  return true;
}

/**
 * VERDICT PHASE — CRITICAL, AND READ-ONLY (issue #19).
 *
 * Runs inside the host's interceptor chain (the verdict phase — see onIntent's
 * doc comment in server/src/plugins/types.ts), after core has already
 * established that the intent is structurally valid and that its centre is in
 * an unlocked chunk (server/src/intent/pipeline.ts steps 1–2). Our job here is
 * ONLY to answer "can this player afford this intent" — never to spend
 * anything:
 *
 *   balance < cost  → DENY. The first deny in the chain wins and the intent
 *                     never reaches the terrain; core applies nothing.
 *   otherwise       → ALLOW, and NOTHING ELSE. No deduction, no balance push.
 *                     We deliberately do not return a `modify` verdict either:
 *                     the intent is fine as written, and a rewrite would force
 *                     core to re-validate it for nothing.
 *
 * The deny-side `world.sendTo` is safe to fire from here even though this is
 * the no-side-effects phase: it announces THIS plugin's OWN decision to deny,
 * which first-deny-wins guarantees can never be overturned by a later
 * interceptor — there is nothing for the message to become stale against (see
 * onIntent's doc comment for the general rule this is the one exception to).
 *
 * FIXES ISSUE #19: this function used to also charge the pool on the allow
 * path, which meant a later interceptor's deny (monsters vetoing a raise near
 * a living Cthulhu, say) still cost the player mana — the veto happened after
 * the charge, and nothing existed to refund it. The charge now happens in
 * `commitCharge`, called from the NEW effect phase (`onIntentApplied`), which
 * core reaches only once every interceptor — mana included — has allowed and
 * the edit has actually landed.
 */
function checkAffordability(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  noteSeq(pool, intent);
  // The price of THIS intent for THIS player: the volume its brush displaces at
  // the rate this player pays, after any perk another plugin has set on them.
  // Computed per intent and never cached, for two independent reasons — a perk
  // can be granted or revoked at any moment (a relic collected mid-stroke), and
  // since volume pricing the radius and profile are the intent's own fields, so
  // consecutive intents from the same player legitimately cost different
  // amounts.
  const cost = manaCostFor(
    ctx.player.id,
    intent,
    openedChunksFor(world, ctx.player.token, intent),
  );

  if (pool.balance < cost) {
    // Tell the player why. Core's own rejections are silent on purpose — an
    // error reply would confirm the existence of locked terrain and defeat the
    // mask (pipeline.ts) — but "you are out of mana" leaks nothing about the
    // world, and a player who gets no feedback assumes the server is broken.
    // The CONCRETE cost of the refused intent travels with it — a price, not
    // the rate the balance push carries. The client is being told what this
    // exact sculpt would have cost, which is the number a "you cannot afford
    // that" readout needs; re-deriving it from the rate would work but would
    // make the refusal depend on the client still holding the brush it sent.
    world.sendTo(ctx.player.id, MANA_DENIED_MESSAGE, {
      balance: displayBalance(pool),
      cost,
      ...asOfSeqOf(pool),
    });
    return { kind: 'deny', reason: INSUFFICIENT_MANA_REASON };
  }

  return { kind: 'allow' };
}

/**
 * EFFECT PHASE — where the pool actually moves (issue #19).
 *
 * Called from `onIntentApplied`, which core fires exactly once per intent,
 * strictly after every interceptor (mana's own `checkAffordability` included)
 * allowed AND the edit landed. `intent` is the EFFECTIVE intent — after any
 * later plugin's `modify` — so the price charged here is the price of what was
 * actually built, not of whatever mana glimpsed during the verdict phase. (A
 * NAMED CONSEQUENCE: relics' Titan's Hand widens the brush AFTER mana's own
 * onIntent runs — mana sorts first alphabetically — so before this change that
 * extra area was free; now it is priced like any other radius, because the
 * charge happens after the widening rather than before it. See relics'
 * onIntent doc comment.)
 *
 * Recomputing the cost here rather than caching what `checkAffordability` saw
 * is deliberate, not laziness: caching would require a pending-charge slot
 * keyed by player, which is exactly the kind of cross-call state this economy
 * has otherwise avoided, and `manaCostFor` is a pure, cheap function of
 * (player, intent) — recomputing it is simpler than keeping two numbers in
 * sync and just as correct, since nothing between the two calls can change
 * this player's perk or this intent's shape (the pipeline runs both phases of
 * one intent synchronously, with no other intent able to interleave).
 */
function commitCharge(
  intent: SculptIntent,
  ctx: IntentCtx,
  diff: readonly CellDiff[],
): void {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  noteSeq(pool, intent);

  // CHARGE FOLLOWS EFFECT (owner bug report 2026-08-19: sculpting at the
  // world floor "is not changing the landscape … but it's taking my mana").
  // A stroke whose applied diff is EMPTY built nothing and costs nothing.
  // This is deliberately narrower than making the PRICE terrain-dependent:
  // the price of any stroke that moved at least one cell is still the full
  // nominal volume (the 2026-08-14 decision and both its reasons stand — the
  // client gate and the server must price an intent identically without
  // knowing the terrain, and flatter ground is not a cheaper request). Only
  // the degenerate all-or-nothing case changes, and it is decided HERE, in
  // the effect phase, where the authoritative diff is already in hand — the
  // shared price function stays a pure function of (radius, profile).
  //
  // The balance push still goes out: the client's local gate debited its
  // estimate the moment the intent was sent, and a FULL pool never
  // regen-pushes, so without this push that phantom debit would stand
  // indefinitely — the same standing-phantom failure onIntentDenied closes
  // on the deny path.
  // ...BUT LAND IT CLAIMED IS STILL PAID FOR (2026-09-06). Since the reveal
  // plugin opens the chunks a stroke's FOOTPRINT covers rather than the ones
  // its diff reached, a stroke can move no cell at all and still take
  // territory — clicking at the frontier into ground the anchored brush
  // refuses to move is exactly that case, and it is the case the unlock
  // penalty exists to price.
  //
  // THE TWO RULES COMPOSE RATHER THAN OVERRIDE. The volume price still follows
  // the effect, so the owner's 2026-08-19 report ("not changing the landscape …
  // but it's taking my mana") stays fixed: a stroke that moved nothing is
  // charged nothing FOR THE DIRT. The surcharge is for the land, which it did
  // take, so it stands on its own — and at the full brush it is zero anyway,
  // which leaves that stroke exactly as free as it was before this change.
  const opened = openedChunksFor(world, ctx.player.token, intent);
  const options = sculptOptionsOf(intent);
  const claimed =
    opened *
    chunkUnlockPenalty(
      manaPerBandCellFor(ctx.player.id),
      intent.radius,
      options.profile,
      options.tool,
    );

  if (diff.length === 0) {
    if (claimed > 0) pool.balance -= claimed;
    sendBalance(world, ctx.player.id, pool);
    return;
  }

  const cost = manaCostFor(ctx.player.id, intent, opened);
  pool.balance -= cost;
  sendBalance(world, ctx.player.id, pool);
}

/** Seconds → milliseconds, for MANA_BALANCE_HEARTBEAT_MS against a `dt` in seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Regenerates every pool by one tick's worth and pushes the pools whose whole-
 * unit balance actually moved OR whose last push has gone stale. `dt` is the
 * host's fixed tick period in seconds, so regen is tied to simulated time and a
 * server configured at a different TICK_HZ regenerates at the same rate per
 * second.
 *
 * A FULL POOL IS STILL VISITED (2026-09-05). It gains nothing and its balance
 * does not move, but it still ages toward the heartbeat — which is the entire
 * point of the heartbeat: a full pool is exactly the state that used to emit no
 * push at all and strand a client-side gate that had drifted low. See
 * MANA_BALANCE_HEARTBEAT_MS.
 */
function regenerate(world: WorldApi, dt: number): void {
  const baseGain = regenPerSecond * dt;
  const dtMs = dt * MILLISECONDS_PER_SECOND;

  for (const [playerId, pool] of poolsByPlayer) {
    pool.msSinceLastSend += dtMs;

    if (pool.balance < MANA_CAPACITY) {
      if (instantRegen) {
        // TEMPORARY TEST SWITCH (see MANA_INSTANT_REGEN_ENV) — remove with it.
        // Refilling to capacity every tick rather than skipping the charge is
        // what makes this a change to GENERATION and nothing else: prices, the
        // perk multipliers, the affordability check and the balance push all
        // keep running on the real numbers, so what is being tested is the
        // sculpt and not a second, quieter code path through the economy.
        pool.balance = MANA_CAPACITY;
      } else {
        // Per-player: a regen perk scales the rate you fill at, never capacity.
        pool.balance = Math.min(
          MANA_CAPACITY,
          pool.balance + baseGain * manaPerkOf(playerId).regenMultiplier,
        );
      }
    }

    // ONE push decision for every path above, so no branch can be the one that
    // forgets to re-affirm. Whole-unit movement is what keeps a 10 Hz tick from
    // generating 10 messages a second for a bar that only moves in integers;
    // the heartbeat is what stops a pool that never moves from going silent.
    if (
      displayBalance(pool) !== pool.lastSentBalance ||
      pool.msSinceLastSend >= MANA_BALANCE_HEARTBEAT_MS
    ) {
      sendBalance(world, playerId, pool);
    }
  }
}

export const plugin: TerracePlugin = {
  name: 'mana',

  onWorldCreate(world: WorldApi): void {
    // Read here, not at module load: a supervisor that recreates the world (and
    // every test that boots one) must see the environment as it is NOW.
    // Explicit MANA_REGEN_PER_S if the host set one, otherwise derived from THIS
    // world's difficulty — which is why it is read here, from the WorldApi, and
    // not from a module-level constant.
    regenPerSecond = resolveManaRegenPerSecond(process.env[MANA_REGEN_ENV], world.difficulty);

    // TEMPORARY TEST SWITCH — remove with MANA_INSTANT_REGEN_ENV. Announced on
    // every world create rather than once at boot: a world running with the
    // economy switched off should say so wherever it is switched on, and a
    // silent test flag is the one that survives into a real deployment.
    instantRegen = instantRegenEnabled(process.env[MANA_INSTANT_REGEN_ENV]);
    if (instantRegen) console.warn(MANA_INSTANT_REGEN_WARNING);

    // PER-PLAYER STATE BELONGS TO THE WORLD IT WAS EARNED IN (multi-world,
    // 2026-08-22). onWorldCreate now runs whenever a DIFFERENT world is loaded
    // into this process, not only at boot, and these two maps are module-level
    // — so without clearing them a perk granted in one world would follow its
    // holder into the next one, and a stale pool would be handed to whoever
    // the transport later reuses that session id for.
    //
    // Safe for both callers of onWorldCreate. A world SWITCH re-runs
    // onPlayerJoin for every carried player straight afterwards, which mints a
    // fresh pool anyway; a ROLLBACK does not, and there `poolFor` creates one
    // lazily at capacity on first use. Neither leaves a player unable to
    // sculpt.
    poolsByPlayer.clear();
    perksByPlayer.clear();
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    const pool: ManaPool = {
    balance: MANA_CAPACITY,
    lastSentBalance: NO_BALANCE_SENT,
    msSinceLastSend: 0,
    lastSeenSeq: null,
  };
    poolsByPlayer.set(player.id, pool);
    // The room sends the join snapshot before calling this hook, so the client
    // is already sized and listening; this is the first thing its HUD sees.
    sendBalance(world, player.id, pool);
  },

  onPlayerLeave(_world: WorldApi, player: Player): void {
    poolsByPlayer.delete(player.id);
    // Perks die with the connection, exactly like the pool. Player.id is a
    // per-connection sessionId (design doc), so leaving a perk behind would
    // not "remember" that player — it would sit in the map forever, and would
    // apply to whoever the transport eventually hands the same id to. Neither
    // outcome is acceptable, so the plugin that granted it does not have to
    // remember to revoke it: mana forgets on leave, unconditionally.
    clearManaPerk(player.id);
  },

  onTick(world: WorldApi, dt: number): void {
    regenerate(world, dt);
  },

  onIntent(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
    return checkAffordability(intent, ctx);
  },

  onIntentApplied(intent: SculptIntent, ctx: IntentCtx, diff: readonly CellDiff[]): void {
    commitCharge(intent, ctx, diff);
  },

  /**
   * DENY-SIDE RECONCILIATION (2026-08-19). The client's local gate debits its
   * balance ESTIMATE the moment an intent is sent (client/state.ts's
   * gateLocalSculpt); when the intent is then refused — by this plugin OR any
   * other interceptor (monsters vetoing a raise near its lair, chiefly) —
   * that estimate is a phantom. Below capacity the next regen push overwrote
   * it within a tick, but a FULL pool never regenerates and therefore never
   * pushed, so the phantom debit stood indefinitely: sculpt fails, "mana not
   * refunded". Pushing the authoritative balance on every refusal closes
   * that: the wholesale replacement the client already performs on every
   * mana:balance erases the phantom, whoever denied and whatever the pool
   * level. (On mana's OWN denial this doubles the balance already carried by
   * mana:denied — harmless, and cheaper than tracking who denied.)
   */
  onIntentDenied(intent: SculptIntent, ctx: IntentCtx): void {
    const pool = poolFor(ctx.player.id);
    noteSeq(pool, intent);
    sendBalance(ctx.world, ctx.player.id, pool);
  },
};

/** Test seam: a player's whole-unit balance, or null if they hold no pool. */
export function manaBalanceOf(playerId: string): number | null {
  const pool = poolsByPlayer.get(playerId);
  return pool === undefined ? null : displayBalance(pool);
}

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetManaState(): void {
  // Back to the pre-onWorldCreate value: the rate of a default-difficulty world.
  regenPerSecond = manaRegenForDifficulty(DEFAULT_WORLD_DIFFICULTY);
  poolsByPlayer.clear();
  perksByPlayer.clear();
}
