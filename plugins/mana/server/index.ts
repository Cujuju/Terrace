// mana — the second example plugin (design §3.5, MVP criterion 8): proof that
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
// the sim is never patched, exactly as design §3.5 requires ("a mana plugin
// vetoes/modifies intents rather than patching the sim").
//
// TWO-PHASE INTENT PROCESSING (issue #19, 2026-08-18): checking affordability
// and charging for it are two different hooks, `onIntent` (verdict) and
// `onIntentApplied` (effect) — see both functions below and their doc
// comments in server/src/plugins/types.ts. This is what makes a later
// interceptor's veto (monsters denying a raise near a living Cthulhu, e.g.)
// cost the player nothing: mana no longer touches the pool until the whole
// intent has cleared every interceptor and actually landed.

import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS, sculptOptionsOf } from '@terrace/shared';
import type { SculptIntent } from '@terrace/shared';
import { sculptManaCost } from '../pricing.ts';
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
 * ≈5–8 mana". A radius-1 brush is the Populous point brush: one cell, moved by
 * exactly DEFAULT_SCULPT_AMOUNT = BAND_HEIGHT, i.e. exactly ONE band-cell. Its
 * price is therefore the rate itself, so the constraint is literally a
 * constraint on this constant, and 6 is the middle of the band.
 *
 * A pleasant property of 6 that is an OBSERVATION, not a law: every shipped
 * radius × profile displaces a multiple of 32 height units, so at rate 6 every
 * base price comes out an exact integer (6, 30/54, 69/150, 120/270 — see the
 * literal table in the tests) and the `ceil` in sculptManaCost only ever rounds
 * a PERK-adjusted price. Change the rate and that stays correct, just less tidy.
 */
export const MANA_PER_BAND_CELL = 6;

/**
 * The price of the cheapest sculpt that exists: the radius-1 point brush, one
 * band over one cell. Derived rather than written down, so it cannot drift from
 * the rate. Equal to MANA_PER_BAND_CELL by construction — it is spelled out
 * because the regen band below is derived from "one more sculpt", and "one more
 * sculpt" means this one, the cheapest.
 *
 * Profile is irrelevant at radius 1 (soft and hard are the same single cell);
 * 'soft' is named because it is the wire default.
 */
export const MANA_COST_PER_MIN_RADIUS_SCULPT = sculptManaCost(
  MANA_PER_BAND_CELL,
  MIN_BRUSH_RADIUS,
  'soft',
);

/**
 * The most expensive sculpt that exists: a radius-4 HARD stamp, which moves a
 * full band across all 45 cells of its footprint — 45 band-cells, 45× the point
 * brush. The pool is sized against this (see MANA_CAPACITY).
 */
export const MANA_COST_PER_MAX_RADIUS_HARD_SCULPT = sculptManaCost(
  MANA_PER_BAND_CELL,
  MAX_BRUSH_RADIUS,
  'hard',
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
 *   MANA_CAPACITY = 3 × 270 = 810
 *
 * What that buys, at rate 6 (pinned by a test, so these numbers cannot rot):
 *
 *   radius 1 (either profile)  6 mana   → 135 stamps from a full pool
 *   radius 2 soft / hard      30 / 54   →  27 / 15
 *   radius 3 soft / hard      69 / 150  →  11 /  5
 *   radius 4 soft / hard     120 / 270  →   6 /  3
 *
 * Up from 600 with the flat 25-per-sculpt price (24 sculpts of any size). The
 * held brush emits ~8 intents/s, so 135 point stamps is ~17 s of continuous
 * fine detailing before the economy bites, while three big plateaus empty the
 * same pool — which is the point of pricing by volume: the player now chooses
 * between reach and stamina instead of always taking the biggest brush.
 */
export const MANA_CAPACITY =
  FULL_POOL_MAX_RADIUS_HARD_STAMPS * MANA_COST_PER_MAX_RADIUS_HARD_SCULPT;

// ────────────────────────────────────────────────────────────────────────────
// REGEN IS DERIVED FROM THE WORLD'S DIFFICULTY (owner-settled 2026-08-14: "warm
// maps regenerate 200/s, difficult maps 20/s").
//
// Core owns a neutral per-world scalar — WorldApi.difficulty, an integer in
// [1, 100] where 1 is warm/forgiving and 100 is punishing — and attaches no
// mechanic to it whatsoever. mana is its first consumer, and this is the whole
// of mana's interpretation: the pace of the economy IS what "difficulty" means
// to a plugin whose only mechanic is a spending limit. A warm world hands the
// player mana faster than they can plausibly spend it, so the veto is nearly
// never felt; a punishing one makes every sculpt a decision.
//
// This replaces a FLAT default of 20/s. A world that leaves both settings alone
// therefore regenerates faster than it used to (110.9/s at the default
// difficulty of 50, up from 20/s) — intended, and the mid-scale answer to the
// owner's two anchors rather than a retune of the old number.
//
// NOTE: mana is an economy, not terrain math — the determinism contract in
// CLAUDE.md governs shared/'s heightmap ops and does not apply here, so a
// fractional rate and a fractional pool are both fine. State is still
// reproducible: regen is driven purely by the fixed tick period the host passes
// in, never by wall-clock time.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The WARM anchor: regen at MIN_WORLD_DIFFICULTY, in mana units per second of
 * simulated time. The owner's number for an easy map.
 *
 * What it buys, at the shipped prices: 200/s is 33 point stamps a second
 * (MANA_COST_PER_MIN_RADIUS_SCULPT = 6) against a held brush that emits ~8
 * intents/s, and a full empty-to-capacity refill in MANA_CAPACITY / 200 ≈ 4 s.
 * Fine detailing is effectively free at this end of the scale and only the
 * biggest brushes are ever rationed, which is what "warm" is meant to feel like.
 * It sits well inside the configurable band (MAX_MANA_REGEN_PER_SECOND = 810).
 */
export const MANA_REGEN_AT_DIFFICULTY_1 = 200;

/**
 * The PUNISHING anchor: regen at MAX_WORLD_DIFFICULTY. The owner's number for a
 * difficult map, and — not by coincidence — the flat default this derivation
 * replaces: 3.3 point stamps a second sustained, a full refill in
 * MANA_CAPACITY / 20 = 40.5 s, an economy that is felt continuously.
 */
export const MANA_REGEN_AT_DIFFICULTY_100 = 20;

/**
 * This world's DEFAULT regen rate, derived from its difficulty by linear
 * interpolation between the two anchors above:
 *
 *   t         = (difficulty − 1) / (100 − 1)
 *   regen(d)  = MANA_REGEN_AT_DIFFICULTY_1
 *               + t × (MANA_REGEN_AT_DIFFICULTY_100 − MANA_REGEN_AT_DIFFICULTY_1)
 *             = 200 − 180 × (d − 1) / 99
 *
 * so regen(1) = 200/s exactly, regen(100) = 20/s exactly, and the default
 * difficulty of 50 gives 200 − 180 × 49/99 = 110.909…/s — the documented
 * midpoint an unconfigured world runs at. Linear because the scalar is a
 * dimensionless 1–100 dial with no natural curve to it: any easing would be a
 * second tuning decision hidden inside a first one, and a plugin author reading
 * "difficulty 25" should be able to predict the rate.
 *
 * The endpoints are read from core's band rather than written as 1 and 100, so
 * the two anchors stay pinned to the ends of whatever that band is; the test
 * suite asserts the names still match (MANA_REGEN_AT_DIFFICULTY_1 ↔
 * MIN_WORLD_DIFFICULTY) so a rescale in core cannot leave these misnamed.
 *
 * Defensive on input: a non-finite difficulty degrades to core's own default
 * rather than propagating NaN into every pool (a NaN balance compares false
 * against every threshold, which freezes a player out permanently and silently),
 * and the interpolation parameter is clamped so an out-of-band difficulty cannot
 * extrapolate past the anchors. WorldApi.difficulty already guarantees both;
 * this function is exported and cheap to make total.
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
 * MANA_COST_PER_MIN_RADIUS_SCULPT / MANA_CAPACITY = 6/810 ≈ 7 ms, far below the
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
export function manaCostFor(playerId: string, intent: SculptIntent): number {
  return sculptManaCost(
    manaPerBandCellFor(playerId),
    intent.radius,
    sculptOptionsOf(intent).profile,
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
  world.sendTo(playerId, MANA_BALANCE_MESSAGE, {
    balance,
    capacity: MANA_CAPACITY,
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

  const created: ManaPool = { balance: MANA_CAPACITY, lastSentBalance: NO_BALANCE_SENT };
  poolsByPlayer.set(playerId, created);
  return created;
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
  // The price of THIS intent for THIS player: the volume its brush displaces at
  // the rate this player pays, after any perk another plugin has set on them.
  // Computed per intent and never cached, for two independent reasons — a perk
  // can be granted or revoked at any moment (a relic collected mid-stroke), and
  // since volume pricing the radius and profile are the intent's own fields, so
  // consecutive intents from the same player legitimately cost different
  // amounts.
  const cost = manaCostFor(ctx.player.id, intent);

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
function commitCharge(intent: SculptIntent, ctx: IntentCtx): void {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  const cost = manaCostFor(ctx.player.id, intent);

  pool.balance -= cost;
  sendBalance(world, ctx.player.id, pool);
}

/**
 * Regenerates every pool by one tick's worth and pushes the pools whose whole-
 * unit balance actually moved. `dt` is the host's fixed tick period in seconds,
 * so regen is tied to simulated time and a server configured at a different
 * TICK_HZ regenerates at the same rate per second.
 */
function regenerate(world: WorldApi, dt: number): void {
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
    if (displayBalance(pool) !== pool.lastSentBalance) sendBalance(world, playerId, pool);
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
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    const pool: ManaPool = { balance: MANA_CAPACITY, lastSentBalance: NO_BALANCE_SENT };
    poolsByPlayer.set(player.id, pool);
    // The room sends the join snapshot before calling this hook, so the client
    // is already sized and listening; this is the first thing its HUD sees.
    sendBalance(world, player.id, pool);
  },

  onPlayerLeave(_world: WorldApi, player: Player): void {
    poolsByPlayer.delete(player.id);
    // Perks die with the connection, exactly like the pool. Player.id is a
    // per-connection sessionId (design §3.7), so leaving a perk behind would
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

  onIntentApplied(intent: SculptIntent, ctx: IntentCtx): void {
    commitCharge(intent, ctx);
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
  onIntentDenied(_intent: SculptIntent, ctx: IntentCtx): void {
    sendBalance(ctx.world, ctx.player.id, poolFor(ctx.player.id));
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
