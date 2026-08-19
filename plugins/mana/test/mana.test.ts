// mana, driven through the REAL intent pipeline and the REAL plugin host with
// both shipped example plugins registered — no stubs for either. If the plugin
// API cannot express a mana economy, these tests are what fails.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAND_HEIGHT,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  type SculptProfile,
  sculptDisplacementUnits,
  sculptOptionsOf,
  type SculptIntent,
} from '@terrace/shared';
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../../../server/src/config.ts';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { ALLOW, type IntentVerdict, type TerracePlugin } from '../../../server/src/plugins/types.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import { plugin as revealPlugin } from '../../reveal/server/index.ts';
import { sculptManaCost } from '../pricing.ts';
import {
  FULL_POOL_MAX_RADIUS_HARD_STAMPS,
  INSUFFICIENT_MANA_REASON,
  MANA_BALANCE_MESSAGE,
  MANA_CAPACITY,
  MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
  MANA_COST_PER_MIN_RADIUS_SCULPT,
  MANA_DENIED_MESSAGE,
  MANA_PER_BAND_CELL,
  MANA_PERK_MAX_MULTIPLIER,
  MANA_PERK_MIN_MULTIPLIER,
  MANA_REGEN_AT_DIFFICULTY_1,
  MANA_REGEN_AT_DIFFICULTY_100,
  MANA_REGEN_ENV,
  MAX_DRAINED_WAIT_S,
  MAX_MANA_REGEN_PER_SECOND,
  MIN_MANA_REGEN_PER_SECOND,
  NEUTRAL_MANA_MULTIPLIER,
  clearManaPerk,
  manaBalanceOf,
  manaCostFor,
  manaPerBandCellFor,
  manaPerkOf,
  manaRegenFor,
  manaRegenForDifficulty,
  manaRegenPerSecond,
  plugin as manaPlugin,
  resetManaState,
  resolveManaRegenPerSecond,
  setManaPerk,
} from '../server/index.ts';

/** 64² cells = 4×4 chunks — small enough to reason about cell by cell. */
const WORLD_SIZE = 64;

/** The one unlocked chunk; cells (16..31, 16..31). */
const HOME_CHUNK: readonly [number, number] = [1, 1];

/** Well inside HOME_CHUNK, far enough from every border to spill nowhere. */
const INTERIOR_CELL = { x: 24, y: 24 } as const;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

/**
 * The difficulty every test in this file boots at unless it says otherwise.
 *
 * MAX_WORLD_DIFFICULTY, deliberately: regen is now DERIVED from the world's
 * difficulty (see manaRegenForDifficulty), and the hardest world's anchor is
 * exactly MANA_REGEN_AT_DIFFICULTY_100 = 20 mana/s — a whole number that divides
 * the tick period and the point-stamp price evenly, so every "ticks to earn one
 * sculpt back" count in this suite stays an exact integer instead of an IEEE
 * near-miss. That was true of the flat 20/s default this replaced, so the suite's
 * arithmetic is unchanged; what changed is that the rate is now stated rather
 * than inherited. The derivation itself is tested at all three anchors in the
 * "difficulty-derived regen" block below.
 */
const SUITE_DIFFICULTY = MAX_WORLD_DIFFICULTY;

/** The regen rate SUITE_DIFFICULTY produces. Exact, by the anchor above. */
const SUITE_REGEN_PER_SECOND = MANA_REGEN_AT_DIFFICULTY_100;

const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

/**
 * The cheapest sculpt there is: the radius-1 point brush, one band over one
 * cell. Most of this suite drains a pool one of these at a time, so its price is
 * named once here and never spelled as a literal.
 */
const POINT_INTENT: SculptIntent = {
  type: 'sculpt',
  x: INTERIOR_CELL.x,
  y: INTERIOR_CELL.y,
  radius: MIN_BRUSH_RADIUS,
  dir: 1,
};

/** Price of POINT_INTENT at the standard (unperked) rate. */
const POINT_COST = MANA_COST_PER_MIN_RADIUS_SCULPT;

/** How many point stamps a full, unperked pool buys. */
const POINT_STAMPS_PER_POOL = MANA_CAPACITY / POINT_COST;

/**
 * Cells in a radius-4 footprint (45). A HARD stamp moves a full band over every
 * one of them, so this is also the ratio between the most and least expensive
 * sculpt — geometry, not tuning, which is why it is derived here rather than
 * written down.
 */
const MAX_RADIUS_HARD_FOOTPRINT_CELLS =
  sculptDisplacementUnits(MAX_BRUSH_RADIUS, 'hard') / BAND_HEIGHT;

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/**
 * Boots a world with both example plugins in their real load order (discovery
 * sorts directories alphabetically: mana, then reveal) and walks the same boot
 * sequence server/src/index.ts does.
 */
function boot(difficulty: number = SUITE_DIFFICULTY): Harness {
  resetManaState();
  nextHelperDir = 1;
  // reveal is stateless since issue #17 (2026-08-19) — no reset needed.

  const world = worldWithUnlockedChunks(WORLD_SIZE, [HOME_CHUNK], difficulty);
  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [manaPlugin, revealPlugin].map(asLoadedPlugin));
  host.worldCreate();

  world.addPlayer(PLAYER);
  host.playerJoined(PLAYER);
  // A real join seeds the starter square into the joining token's OWN mask
  // (terrace-room.ts's applyInitialUnlockForToken) before this harness's
  // equivalent of the join snapshot is ever read; this harness never builds
  // one, so nothing here depends on PLAYER's per-token mask — only the union
  // mask worldWithUnlockedChunks sets up, which every existing assertion in
  // this file already reasons about.

  return { world, host, sink };
}

/**
 * Direction for the next helper-sent stroke, ALTERNATING raise/lower per call
 * (reset in boot() so every test sees the same sequence). WHY (charge-follows-
 * effect, 2026-08-19): a stroke that moves nothing is free, so the old
 * raise-forever drain loops would saturate one cell at the anchor ceiling
 * (~64 raises from height 0) and then spin on free strokes instead of
 * draining. An up-down alternation always moves terrain, so every helper
 * stroke is charged — which is the property all of this file's balance
 * arithmetic actually relies on. Price is direction-independent, so no
 * assertion changes meaning. Tests that care about direction pass it
 * explicitly.
 */
let nextHelperDir: 1 | -1 = 1;
function helperDir(): 1 | -1 {
  const dir = nextHelperDir;
  nextHelperDir = dir === 1 ? -1 : 1;
  return dir;
}

function sculptAt(
  harness: Harness,
  x: number,
  y: number,
  radius = MIN_BRUSH_RADIUS,
  profile?: SculptProfile,
) {
  return handleSculptIntent(
    { world: harness.world, interceptors: harness.host },
    PLAYER,
    { type: 'sculpt', x, y, radius, dir: helperDir(), ...(profile !== undefined ? { profile } : {}) },
  );
}

describe('mana plugin', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('loads in the interceptor order discovery would produce', () => {
    expect(harness.host.pluginNames).toEqual(['mana', 'reveal']);
  });

  it('pushes a namespaced balance to a joining player', () => {
    const pushed = harness.sink.ofType('mana:balance');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].target).toBe(PLAYER.id);
    expect(pushed[0].payload).toEqual({
      balance: MANA_CAPACITY,
      capacity: MANA_CAPACITY,
      // A RATE, not a price: the client prices its own intents with it.
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
  });

  it('charges every applied sculpt and denies once the pool cannot pay', () => {
    const affordable = POINT_STAMPS_PER_POOL;
    expect(Number.isInteger(affordable)).toBe(true);

    for (let n = 1; n <= affordable; n++) {
      const outcome = sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
      expect(outcome.applied).toBe(true);
      expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - n * POINT_COST);
    }

    expect(manaBalanceOf(PLAYER.id)).toBe(0);

    const denied = sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    expect(denied).toEqual({
      applied: false,
      reason: 'plugin-denied',
      detail: INSUFFICIENT_MANA_REASON,
    });
  });

  it('leaves the terrain untouched when it denies', () => {
    for (let n = 0; n < POINT_STAMPS_PER_POOL; n++) {
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    }

    const heightBefore = harness.world.heightAt(INTERIOR_CELL.x, INTERIOR_CELL.y);
    harness.sink.clear();

    expect(sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(false);

    // The veto happened in the interceptor chain, so core applied nothing and
    // broadcast nothing — the deny is not a cosmetic rejection after the fact.
    expect(harness.world.heightAt(INTERIOR_CELL.x, INTERIOR_CELL.y)).toBe(heightBefore);
    expect(harness.sink.ofType('terrainDiff')).toHaveLength(0);
  });

  it('tells the denied player why, on its own namespaced channel', () => {
    for (let n = 0; n < POINT_STAMPS_PER_POOL; n++) {
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    }
    harness.sink.clear();

    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);

    const refusals = harness.sink.ofType('mana:denied');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].target).toBe(PLAYER.id);
    // The refusal names THE REFUSED INTENT'S price, not the rate.
    expect(refusals[0].payload).toEqual({ balance: 0, cost: POINT_COST });
  });

  it('regenerates on the tick and never past capacity', () => {
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - POINT_COST);

    // Exactly enough simulated time to earn one sculpt back.
    const ticksToRefundOneSculpt = POINT_COST / (SUITE_REGEN_PER_SECOND * TICK_DT);
    for (let n = 0; n < ticksToRefundOneSculpt; n++) harness.host.tick(TICK_DT);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);

    for (let n = 0; n < 100; n++) harness.host.tick(TICK_DT);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);
  });

  it('recovers from an empty pool and sculpts again', () => {
    for (let n = 0; n < POINT_STAMPS_PER_POOL; n++) {
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    }
    expect(sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(false);

    const ticksToAffordOneSculpt = POINT_COST / (SUITE_REGEN_PER_SECOND * TICK_DT);
    for (let n = 0; n < ticksToAffordOneSculpt; n++) harness.host.tick(TICK_DT);

    expect(sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(true);
  });

  it('does not spam a balance message on every tick', () => {
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    harness.sink.clear();

    // Two ticks at 10 Hz earn 4 mana — 4 whole-unit steps, so at most 4
    // messages, and certainly not one per tick per unchanged pool afterwards.
    harness.host.tick(TICK_DT);
    harness.host.tick(TICK_DT);
    const duringRegen = harness.sink.ofType('mana:balance').length;
    expect(duringRegen).toBeGreaterThan(0);

    // Refill completely, then keep ticking: a capped pool sends nothing.
    for (let n = 0; n < 200; n++) harness.host.tick(TICK_DT);
    harness.sink.clear();
    for (let n = 0; n < 50; n++) harness.host.tick(TICK_DT);
    expect(harness.sink.ofType('mana:balance')).toHaveLength(0);
  });

  it('drops a pool when its player leaves', () => {
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);
    harness.world.removePlayer(PLAYER.id);
    harness.host.playerLeft(PLAYER);
    expect(manaBalanceOf(PLAYER.id)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The perk API: the seam another plugin (relics) extends this economy through.
// Tested here at the contract level — what setManaPerk promises anyone who
// calls it — rather than at the relics call site, which is covered by that
// plugin's own suite.
// ────────────────────────────────────────────────────────────────────────────

/** A second connection, so perked and unperked players can be compared. */
const OTHER_PLAYER: Player = { id: 'session-2', token: 'token-2', name: 'Control' };

describe('mana perks', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
    harness.world.addPlayer(OTHER_PLAYER);
    harness.host.playerJoined(OTHER_PLAYER);
    harness.sink.clear();
  });

  function sculptAs(player: Player) {
    return handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      player,
      // Alternating direction — see helperDir(): a drain loop must never
      // saturate the cell into free (zero-effect) strokes.
      { type: 'sculpt', x: INTERIOR_CELL.x, y: INTERIOR_CELL.y, radius: 1, dir: helperDir() },
    );
  }

  it('defaults every player to neutral', () => {
    expect(manaPerkOf(PLAYER.id)).toEqual({
      costMultiplier: NEUTRAL_MANA_MULTIPLIER,
      regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
    });
    expect(manaPerBandCellFor(PLAYER.id)).toBe(MANA_PER_BAND_CELL);
    expect(manaCostFor(PLAYER.id, POINT_INTENT)).toBe(POINT_COST);
  });

  it('scales the RATE, so a perk discounts every brush and not just one', () => {
    // The perk multiplies mana-per-band-cell, which is what makes it composable
    // with volume pricing: a half-cost holder pays half for the point brush AND
    // half for the radius-4 plateau, rather than half for one size of sculpt.
    setManaPerk(PLAYER.id, { costMultiplier: 0.5 });
    expect(manaPerBandCellFor(PLAYER.id)).toBe(MANA_PER_BAND_CELL * 0.5);

    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      for (const profile of SCULPT_PROFILES) {
        const intent: SculptIntent = { ...POINT_INTENT, radius, profile };
        expect(manaCostFor(PLAYER.id, intent)).toBe(
          sculptManaCost(MANA_PER_BAND_CELL * 0.5, radius, profile),
        );
        // Half price, to within the single rounding-up step.
        expect(manaCostFor(PLAYER.id, intent) * 2).toBeGreaterThanOrEqual(
          manaCostFor(OTHER_PLAYER.id, intent),
        );
      }
    }
  });

  it('charges the perked price on the intent path', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0.5 });
    const discounted = manaCostFor(PLAYER.id, POINT_INTENT);
    expect(discounted).toBe(Math.ceil(POINT_COST * 0.5));

    expect(sculptAs(PLAYER).applied).toBe(true);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - discounted);

    // The unperked player in the same world still pays full price.
    expect(sculptAs(OTHER_PLAYER).applied).toBe(true);
    expect(manaBalanceOf(OTHER_PLAYER.id)).toBe(MANA_CAPACITY - POINT_COST);
  });

  it('buys a cheaper player strictly more sculpts before the veto', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0.5 });

    let perked = 0;
    while (sculptAs(PLAYER).applied) perked++;
    let plain = 0;
    while (sculptAs(OTHER_PLAYER).applied) plain++;

    expect(plain).toBe(POINT_STAMPS_PER_POOL);
    expect(perked).toBeGreaterThan(plain);
  });

  it('reports the perked price in the refusal it sends', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0.5 });
    while (sculptAs(PLAYER).applied) {
      /* drain */
    }
    harness.sink.clear();

    sculptAs(PLAYER);
    const refusals = harness.sink.ofType(`mana:${MANA_DENIED_MESSAGE}`);
    expect(refusals).toHaveLength(1);
    expect((refusals[0].payload as { cost: number }).cost).toBe(
      manaCostFor(PLAYER.id, POINT_INTENT),
    );
  });

  it('regenerates a perked player faster, and still caps at capacity', () => {
    setManaPerk(PLAYER.id, { regenMultiplier: 2 });

    // Spend enough that a second of DOUBLED regen still fits under the cap —
    // otherwise both players simply refill to capacity and the perk is
    // invisible. Derived, not guessed: enough point stamps to leave more room
    // than the perked player can earn in the second that follows, plus one.
    const sculptsToDrain = Math.ceil((SUITE_REGEN_PER_SECOND * 2) / POINT_COST) + 1;
    for (let n = 0; n < sculptsToDrain; n++) {
      sculptAs(PLAYER);
      sculptAs(OTHER_PLAYER);
    }
    const spent = sculptsToDrain * POINT_COST;
    expect(manaBalanceOf(PLAYER.id)).toBe(manaBalanceOf(OTHER_PLAYER.id));

    // One second of simulated time.
    for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);

    const perkedGain = (manaBalanceOf(PLAYER.id) ?? 0) - (MANA_CAPACITY - spent);
    const plainGain = (manaBalanceOf(OTHER_PLAYER.id) ?? 0) - (MANA_CAPACITY - spent);
    expect(plainGain).toBe(SUITE_REGEN_PER_SECOND);
    expect(perkedGain).toBe(SUITE_REGEN_PER_SECOND * 2);

    // Capacity is deliberately NOT scaled by the perk.
    for (let n = 0; n < 100; n++) harness.host.tick(TICK_DT);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);
  });

  it('is whole-state: a later call replaces rather than merges', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0.5, regenMultiplier: 2 });
    setManaPerk(PLAYER.id, { regenMultiplier: 2 });

    expect(manaPerkOf(PLAYER.id)).toEqual({
      costMultiplier: NEUTRAL_MANA_MULTIPLIER,
      regenMultiplier: 2,
    });
  });

  it('clears on request', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0.5 });
    clearManaPerk(PLAYER.id);
    expect(manaCostFor(PLAYER.id, POINT_INTENT)).toBe(POINT_COST);
    // Clearing a player who has no perk is a no-op, not an error.
    expect(() => clearManaPerk('never-seen')).not.toThrow();
  });

  it('clears on leave, so a recycled session id inherits nothing', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0.5, regenMultiplier: 2 });
    harness.world.removePlayer(PLAYER.id);
    harness.host.playerLeft(PLAYER);

    expect(manaPerkOf(PLAYER.id)).toEqual({
      costMultiplier: NEUTRAL_MANA_MULTIPLIER,
      regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
    });
    expect(manaCostFor(PLAYER.id, POINT_INTENT)).toBe(POINT_COST);
  });

  it('clamps a multiplier into the documented band', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0, regenMultiplier: 1000 });
    expect(manaPerkOf(PLAYER.id)).toEqual({
      costMultiplier: MANA_PERK_MIN_MULTIPLIER,
      regenMultiplier: MANA_PERK_MAX_MULTIPLIER,
    });

    // The floor is what stops a zero multiplier from deleting the economy: a
    // perked player is still charged, and can still run out.
    expect(manaCostFor(PLAYER.id, POINT_INTENT)).toBeGreaterThan(0);
    let sculpts = 0;
    while (sculptAs(PLAYER).applied) sculpts++;
    expect(sculpts).toBeGreaterThan(0);
    expect(sculptAs(PLAYER)).toEqual({
      applied: false,
      reason: 'plugin-denied',
      detail: INSUFFICIENT_MANA_REASON,
    });
  });

  it('degrades a non-numeric multiplier to neutral rather than to NaN', () => {
    // A NaN balance compares false against every threshold, which would leave
    // the player permanently unable to sculpt and unable to see why.
    setManaPerk(PLAYER.id, {
      costMultiplier: Number.NaN,
      regenMultiplier: 'fast' as unknown as number,
    });
    expect(manaPerkOf(PLAYER.id)).toEqual({
      costMultiplier: NEUTRAL_MANA_MULTIPLIER,
      regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
    });

    expect(sculptAs(PLAYER).applied).toBe(true);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - POINT_COST);
  });

  it('may be set before mana has ever seen the player', () => {
    // relics can grant a perk from a message handler that runs before this
    // plugin's lazily-created pool exists; the perk must survive that.
    const latecomer: Player = { id: 'session-3', token: 'token-3', name: 'Late' };
    setManaPerk(latecomer.id, { costMultiplier: 0.5 });

    harness.world.addPlayer(latecomer);
    harness.host.playerJoined(latecomer);
    harness.sink.clear();

    expect(sculptAs(latecomer).applied).toBe(true);
    expect(manaBalanceOf(latecomer.id)).toBe(
      MANA_CAPACITY - manaCostFor(latecomer.id, POINT_INTENT),
    );
    expect(harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`).length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PER-WORLD REGEN RATE. The rate is deployment configuration (MANA_REGEN_PER_S)
// over a difficulty-derived default, so the things worth pinning down are: an
// unconfigured world still works, a configured one is obeyed WHATEVER the
// difficulty says, and a MIS-configured one can neither freeze the economy nor
// delete it.
// ────────────────────────────────────────────────────────────────────────────

describe('mana regen configuration', () => {
  const originalEnv = process.env[MANA_REGEN_ENV];

  beforeEach(() => {
    delete process.env[MANA_REGEN_ENV];
    // The resolver warns on every rejected/clamped value by design; silence it
    // so a suite full of deliberately bad input is still readable.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env[MANA_REGEN_ENV];
    else process.env[MANA_REGEN_ENV] = originalEnv;
  });

  it('falls back to the difficulty-derived rate when unset or blank', () => {
    expect(resolveManaRegenPerSecond(undefined, SUITE_DIFFICULTY)).toBe(SUITE_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('', SUITE_DIFFICULTY)).toBe(SUITE_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('   ', SUITE_DIFFICULTY)).toBe(SUITE_REGEN_PER_SECOND);
    expect(console.warn).not.toHaveBeenCalled(); // not configuring is not an error

    const harness = boot();
    expect(manaRegenPerSecond()).toBe(SUITE_REGEN_PER_SECOND);
    expect(harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`)[0].payload).toMatchObject({
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
  });

  it('accepts a valid rate, whitespace and all, and regenerates at it', () => {
    const configured = 5;
    process.env[MANA_REGEN_ENV] = `  ${configured}  `;

    const harness = boot();
    expect(manaRegenPerSecond()).toBe(configured);

    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    const afterSpend = manaBalanceOf(PLAYER.id) ?? 0;
    for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT); // one second
    expect((manaBalanceOf(PLAYER.id) ?? 0) - afterSpend).toBe(configured);
  });

  it('rejects anything that is not a positive finite number', () => {
    for (const bad of ['abc', '0', '-5', 'NaN', 'Infinity', '20abc', 'true']) {
      expect(resolveManaRegenPerSecond(bad, SUITE_DIFFICULTY)).toBe(SUITE_REGEN_PER_SECOND);
    }
    expect(console.warn).toHaveBeenCalledTimes(7);

    // End to end: a garbage value must leave a WORKING world, not a frozen one.
    process.env[MANA_REGEN_ENV] = 'twenty';
    const harness = boot();
    expect(manaRegenPerSecond()).toBe(SUITE_REGEN_PER_SECOND);
    // Spend on the biggest brush, so a full second of regen fits in the hole it
    // leaves rather than being clipped by the capacity cap.
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y, MAX_BRUSH_RADIUS, 'hard');
    const afterSpend = manaBalanceOf(PLAYER.id) ?? 0;
    for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);
    expect((manaBalanceOf(PLAYER.id) ?? 0) - afterSpend).toBe(SUITE_REGEN_PER_SECOND);
  });

  it('clamps a rate outside the supported band into it', () => {
    expect(resolveManaRegenPerSecond('0.0001', SUITE_DIFFICULTY)).toBe(MIN_MANA_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('1e9', SUITE_DIFFICULTY)).toBe(MAX_MANA_REGEN_PER_SECOND);
    // The band's own edges are configurable values, not rejected ones.
    expect(resolveManaRegenPerSecond(String(MIN_MANA_REGEN_PER_SECOND), SUITE_DIFFICULTY)).toBe(
      MIN_MANA_REGEN_PER_SECOND,
    );
    expect(resolveManaRegenPerSecond(String(MAX_MANA_REGEN_PER_SECOND), SUITE_DIFFICULTY)).toBe(
      MAX_MANA_REGEN_PER_SECOND,
    );

    // Even at the floor the economy still moves: a drained player recovers a
    // sculpt inside MAX_DRAINED_WAIT_S, which is what the floor is chosen for.
    process.env[MANA_REGEN_ENV] = '0.0001';
    const harness = boot();
    expect(manaRegenPerSecond()).toBe(MIN_MANA_REGEN_PER_SECOND);
    while (sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied) {
      /* drain */
    }
    // One tick of slack on top of the minute: the floor is
    // MANA_COST_PER_MIN_RADIUS_SCULPT / MAX_DRAINED_WAIT_S = 6/60 mana per
    // second, and accumulating that in 0.1 s steps lands a hair under 6 in IEEE
    // arithmetic. The claim under test is the wait, not the last ULP.
    for (let n = 0; n <= MAX_DRAINED_WAIT_S / TICK_DT; n++) harness.host.tick(TICK_DT);
    expect(sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(true);
  });

  it('pushes the PERK-ADJUSTED rate, per player', () => {
    const configured = 8;
    process.env[MANA_REGEN_ENV] = String(configured);

    const harness = boot();
    setManaPerk(PLAYER.id, { regenMultiplier: 2 });
    expect(manaRegenFor(PLAYER.id)).toBe(configured * 2);
    expect(manaRegenFor('never-seen')).toBe(configured); // no perk: world rate

    // The push a spend triggers carries this player's own rate, not the world's.
    harness.sink.clear();
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    expect(harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`)[0].payload).toMatchObject({
      regenPerSecond: configured * 2,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DIFFICULTY-DERIVED REGEN (owner-settled 2026-08-14: "warm maps 200/s,
// difficult maps 20/s"). Core publishes a neutral 1–100 scalar and attaches no
// mechanic to it; mana's interpretation is the pace of the economy. What has to
// hold: both anchors are exact, the middle is the documented interpolation, an
// explicit MANA_REGEN_PER_S outranks the whole thing, and the supported band
// still contains whichever source won.
// ────────────────────────────────────────────────────────────────────────────

describe('difficulty-derived regen', () => {
  const originalEnv = process.env[MANA_REGEN_ENV];

  beforeEach(() => {
    delete process.env[MANA_REGEN_ENV];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env[MANA_REGEN_ENV];
    else process.env[MANA_REGEN_ENV] = originalEnv;
  });

  /** The rate the joining player was actually told, off the wire. */
  function pushedRegen(harness: Harness): number {
    const pushes = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
    expect(pushes.length).toBeGreaterThan(0);
    return (pushes[0].payload as { regenPerSecond: number }).regenPerSecond;
  }

  it('anchors the scale where the owner set it, and names the anchors correctly', () => {
    expect(MANA_REGEN_AT_DIFFICULTY_1).toBe(200);
    expect(MANA_REGEN_AT_DIFFICULTY_100).toBe(20);
    // The names claim these sit at difficulty 1 and 100. Assert that against
    // CORE's band, so rescaling WORLD_DIFFICULTY cannot leave them misnamed —
    // the same plugin-side relation check wildlife uses for the seabed depth.
    expect(MIN_WORLD_DIFFICULTY).toBe(1);
    expect(MAX_WORLD_DIFFICULTY).toBe(100);
  });

  it('gives a WARM world 200/s, on the wire', () => {
    const harness = boot(MIN_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MANA_REGEN_AT_DIFFICULTY_1);
    expect(pushedRegen(harness)).toBe(MANA_REGEN_AT_DIFFICULTY_1);
  });

  it('gives a PUNISHING world 20/s, on the wire', () => {
    const harness = boot(MAX_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MANA_REGEN_AT_DIFFICULTY_100);
    expect(pushedRegen(harness)).toBe(MANA_REGEN_AT_DIFFICULTY_100);
  });

  it('gives the default world the documented midpoint, ≈110.9/s', () => {
    // The formula stated independently of the implementation:
    //   regen(d) = 200 + (d − 1)/(100 − 1) × (20 − 200)
    const expected =
      MANA_REGEN_AT_DIFFICULTY_1 +
      ((DEFAULT_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY) /
        (MAX_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY)) *
        (MANA_REGEN_AT_DIFFICULTY_100 - MANA_REGEN_AT_DIFFICULTY_1);

    const harness = boot(DEFAULT_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(expected);
    expect(pushedRegen(harness)).toBe(expected);
    // The number the comments and .env.example quote to self-hosters.
    expect(expected).toBeCloseTo(110.909, 3);
  });

  it('interpolates linearly and monotonically across the whole scale', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let difficulty = MIN_WORLD_DIFFICULTY; difficulty <= MAX_WORLD_DIFFICULTY; difficulty++) {
      const rate = manaRegenForDifficulty(difficulty);
      // Harder is never faster, and every rate lies between the two anchors...
      expect(rate).toBeLessThan(previous);
      expect(rate).toBeLessThanOrEqual(MANA_REGEN_AT_DIFFICULTY_1);
      expect(rate).toBeGreaterThanOrEqual(MANA_REGEN_AT_DIFFICULTY_100);
      // ...and inside the band the economy is documented to work at, so the
      // derivation never needs the clamp to save it.
      expect(rate).toBeGreaterThanOrEqual(MIN_MANA_REGEN_PER_SECOND);
      expect(rate).toBeLessThanOrEqual(MAX_MANA_REGEN_PER_SECOND);
      previous = rate;
    }
  });

  it('lets a warm world actually outspend a punishing one', () => {
    // Not just a number on the wire: the same second of simulated time buys ten
    // times as much sculpting at difficulty 1 as at difficulty 100.
    function earnedInOneSecond(difficulty: number): number {
      const harness = boot(difficulty);
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y, MAX_BRUSH_RADIUS, 'hard');
      const afterSpend = manaBalanceOf(PLAYER.id) ?? 0;
      for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);
      return (manaBalanceOf(PLAYER.id) ?? 0) - afterSpend;
    }

    expect(earnedInOneSecond(MIN_WORLD_DIFFICULTY)).toBe(MANA_REGEN_AT_DIFFICULTY_1);
    expect(earnedInOneSecond(MAX_WORLD_DIFFICULTY)).toBe(MANA_REGEN_AT_DIFFICULTY_100);
  });

  it('lets an EXPLICIT MANA_REGEN_PER_S beat the difficulty, in both directions', () => {
    // A host who writes a number means that number: the world dial supplies the
    // default and nothing more.
    const configured = 7;
    process.env[MANA_REGEN_ENV] = String(configured);

    for (const difficulty of [MIN_WORLD_DIFFICULTY, DEFAULT_WORLD_DIFFICULTY, MAX_WORLD_DIFFICULTY]) {
      const harness = boot(difficulty);
      expect(manaRegenPerSecond()).toBe(configured);
      expect(pushedRegen(harness)).toBe(configured);
    }

    // Explicitly FASTER than the warmest world's default is honoured too — the
    // anchors bound the derivation, not the setting.
    process.env[MANA_REGEN_ENV] = String(MANA_REGEN_AT_DIFFICULTY_1 * 2);
    boot(MAX_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MANA_REGEN_AT_DIFFICULTY_1 * 2);
  });

  it('still clamps an explicit rate, whatever the difficulty', () => {
    // The band applies to whichever source wins.
    process.env[MANA_REGEN_ENV] = '1e9';
    boot(MIN_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MAX_MANA_REGEN_PER_SECOND);

    process.env[MANA_REGEN_ENV] = '0.0001';
    boot(MIN_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MIN_MANA_REGEN_PER_SECOND);
  });

  it('falls back to the DIFFICULTY rate when the explicit value is junk', () => {
    process.env[MANA_REGEN_ENV] = 'twenty';
    const harness = boot(MIN_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MANA_REGEN_AT_DIFFICULTY_1);
    expect(pushedRegen(harness)).toBe(MANA_REGEN_AT_DIFFICULTY_1);
    expect(console.warn).toHaveBeenCalled();
  });

  it('is total on a difficulty core could never hand it', () => {
    // WorldApi.difficulty is already clamped to the band; this is the second
    // layer, so a direct caller cannot poison every pool with NaN.
    expect(manaRegenForDifficulty(Number.NaN)).toBe(
      manaRegenForDifficulty(DEFAULT_WORLD_DIFFICULTY),
    );
    expect(manaRegenForDifficulty(-100)).toBe(MANA_REGEN_AT_DIFFICULTY_1);
    expect(manaRegenForDifficulty(10_000)).toBe(MANA_REGEN_AT_DIFFICULTY_100);
  });
});

describe('protocol parse (client half)', () => {
  it('accepts proper payloads and rejects malformed ones', async () => {
    const { parseManaBalancePayload, parseManaDeniedPayload } = await import('../protocol.ts');
    expect(
      parseManaBalancePayload({
        balance: 150,
        capacity: 810,
        manaPerBandCell: 6,
        regenPerSecond: 20,
      }),
    ).toEqual({
      balance: 150,
      capacity: 810,
      manaPerBandCell: 6,
      regenPerSecond: 20,
    });
    // Both rates may be fractional: regen's band floor is 6/60, and a perked
    // mana-per-band-cell is the base rate times a multiplier as low as 0.25.
    expect(
      parseManaBalancePayload({
        balance: 0,
        capacity: 810,
        manaPerBandCell: 1.5,
        regenPerSecond: 0.4,
      }),
    ).toEqual({ balance: 0, capacity: 810, manaPerBandCell: 1.5, regenPerSecond: 0.4 });
    for (const bad of [
      null,
      'x',
      {},
      { balance: 1 },
      { balance: -1, capacity: 810, manaPerBandCell: 6, regenPerSecond: 20 },
      { balance: 1, capacity: 0, manaPerBandCell: 6, regenPerSecond: 20 },
      { balance: Number.NaN, capacity: 810, manaPerBandCell: 6, regenPerSecond: 20 },
      { balance: 1, capacity: 810, regenPerSecond: 20 },
      // The rate field: missing, zero (which would make every sculpt free on the
      // client only), negative, and not a number at all.
      { balance: 1, capacity: 810, regenPerSecond: 20 },
      { balance: 1, capacity: 810, manaPerBandCell: 0, regenPerSecond: 20 },
      { balance: 1, capacity: 810, manaPerBandCell: -6, regenPerSecond: 20 },
      { balance: 1, capacity: 810, manaPerBandCell: Number.NaN, regenPerSecond: 20 },
      { balance: 1, capacity: 810, manaPerBandCell: '6', regenPerSecond: 20 },
      // The regen field: missing, zero (an infinite pulse period), negative, and
      // not a number at all. All-or-nothing — see parseManaBalancePayload.
      { balance: 1, capacity: 810, manaPerBandCell: 6 },
      { balance: 1, capacity: 810, manaPerBandCell: 6, regenPerSecond: 0 },
      { balance: 1, capacity: 810, manaPerBandCell: 6, regenPerSecond: -20 },
      { balance: 1, capacity: 810, manaPerBandCell: 6, regenPerSecond: Number.NaN },
      {
        balance: 1,
        capacity: 810,
        manaPerBandCell: 6,
        regenPerSecond: Number.POSITIVE_INFINITY,
      },
      { balance: 1, capacity: 810, manaPerBandCell: 6, regenPerSecond: '20' },
    ]) {
      expect(parseManaBalancePayload(bad)).toBeNull();
    }
    // The refusal still carries a concrete PRICE — the refused intent's.
    expect(parseManaDeniedPayload({ balance: 3, cost: 270 })).toEqual({ balance: 3, cost: 270 });
    for (const bad of [null, {}, { balance: 3 }, { cost: 25 }, { balance: 3, cost: 'x' }]) {
      expect(parseManaDeniedPayload(bad)).toBeNull();
    }
  });
});

describe('client local intent gate', () => {
  it('allows with no pool state, debits the intent, denies when broke', async () => {
    const { gateLocalSculpt, setManaPool, manaPool, deniedCount } = await import(
      '../client/state.ts'
    );

    setManaPool(null);
    expect(gateLocalSculpt(POINT_INTENT)).toBe(true); // no economy: never veto

    // 30 mana at rate 6: five point stamps' worth.
    setManaPool({
      balance: 30,
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
    expect(gateLocalSculpt(POINT_INTENT)).toBe(true); // 30 -> 24, affordable
    expect(manaPool()?.balance).toBe(30 - POINT_COST);

    const denialsBefore = deniedCount();
    // The SAME balance that pays for a point stamp cannot pay for the radius-4
    // hard plateau — the gate prices the intent it was handed, not a constant.
    const bigStamp: SculptIntent = {
      ...POINT_INTENT,
      radius: MAX_BRUSH_RADIUS,
      profile: 'hard',
    };
    expect(gateLocalSculpt(bigStamp)).toBe(false);
    expect(deniedCount()).toBe(denialsBefore + 1); // ...flash...
    expect(manaPool()?.balance).toBe(30 - POINT_COST); // ...and no debit on a veto

    // ...while the point brush it can still afford goes through, and debits its
    // own (smaller) price.
    expect(gateLocalSculpt(POINT_INTENT)).toBe(true);
    expect(manaPool()?.balance).toBe(30 - 2 * POINT_COST);
  });

  it('debits a big brush far faster than a point brush', async () => {
    const { gateLocalSculpt, setManaPool, manaPool } = await import('../client/state.ts');

    const fullPool = {
      balance: MANA_CAPACITY,
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    };

    setManaPool(fullPool);
    let points = 0;
    while (gateLocalSculpt(POINT_INTENT)) points++;
    expect(points).toBe(POINT_STAMPS_PER_POOL);

    setManaPool(fullPool);
    const bigStamp: SculptIntent = {
      ...POINT_INTENT,
      radius: MAX_BRUSH_RADIUS,
      profile: 'hard',
    };
    let plateaus = 0;
    while (gateLocalSculpt(bigStamp)) plateaus++;
    expect(plateaus).toBe(FULL_POOL_MAX_RADIUS_HARD_STAMPS);
    expect(manaPool()?.balance).toBeLessThan(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// VOLUME PRICING (owner-settled 2026-08-14). A sculpt costs mana in proportion
// to the terrain volume its brush displaces, so the price is a property of the
// INTENT and no longer a constant. Three things have to hold: the tuning numbers
// are what the owner asked for, the server charges the right amount for each
// brush, and the client's local gate agrees with it exactly.
// ────────────────────────────────────────────────────────────────────────────

describe('the price of a sculpt', () => {
  it('pins the tuning constants and the constraints they were derived from', () => {
    // The rate IS the price of a point stamp, because a radius-1 brush moves
    // exactly one band over exactly one cell. Owner's constraint: ≈5–8 mana.
    expect(MANA_PER_BAND_CELL).toBe(6);
    expect(MANA_COST_PER_MIN_RADIUS_SCULPT).toBe(MANA_PER_BAND_CELL);
    expect(MANA_COST_PER_MIN_RADIUS_SCULPT).toBeGreaterThanOrEqual(5);
    expect(MANA_COST_PER_MIN_RADIUS_SCULPT).toBeLessThanOrEqual(8);

    // The most expensive brush: 37 band-cells since the 2026-08-19 tight-disc
    // footprint (45 before), 37× the point stamp. The pool is
    // three of those, the low end of the owner's "≈3–4" — see the derivation on
    // FULL_POOL_MAX_RADIUS_HARD_STAMPS for why the other constraint ("≈100
    // point stamps") cannot be met at the same time.
    expect(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT).toBe(222);
    expect(FULL_POOL_MAX_RADIUS_HARD_STAMPS).toBe(3);
    expect(MANA_CAPACITY).toBe(666);
    expect(MANA_CAPACITY).toBe(
      FULL_POOL_MAX_RADIUS_HARD_STAMPS * MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
    );
    expect(POINT_STAMPS_PER_POOL).toBe(111);

    // Radius-4 soft lands proportionally between the two, by volume alone.
    const softPlateau = sculptManaCost(MANA_PER_BAND_CELL, MAX_BRUSH_RADIUS, 'soft');
    expect(softPlateau).toBe(108);
    expect(softPlateau).toBeGreaterThan(MANA_COST_PER_MIN_RADIUS_SCULPT);
    expect(softPlateau).toBeLessThan(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT);

    // The regen band is re-derived from the CHEAPEST sculpt: one more point
    // stamp within a minute at the floor.
    expect(MIN_MANA_REGEN_PER_SECOND).toBe(MANA_COST_PER_MIN_RADIUS_SCULPT / MAX_DRAINED_WAIT_S);
    expect(MAX_MANA_REGEN_PER_SECOND).toBe(MANA_CAPACITY);
  });

  it('is the displaced volume at the payer’s rate, for every brush', () => {
    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      for (const profile of SCULPT_PROFILES) {
        const intent: SculptIntent = { ...POINT_INTENT, radius, profile };
        // Spelled out the long way here, from shared's volume function, rather
        // than by calling the pricing helper the implementation calls: this test
        // is the independent statement of the formula.
        const expected = Math.ceil(
          (MANA_PER_BAND_CELL * sculptDisplacementUnits(radius, profile)) / BAND_HEIGHT,
        );
        expect(manaCostFor(PLAYER.id, intent)).toBe(expected);
      }
    }
  });

  it('resolves an intent’s ABSENT profile through the shared normalisation', () => {
    // An older client sends neither tool nor profile. It must be charged for the
    // brush the server will actually run — WIRE_DEFAULT_SCULPT_OPTIONS — and
    // sculptOptionsOf is the one place that decides what absent means.
    const bare: SculptIntent = { type: 'sculpt', x: 1, y: 1, radius: 3, dir: 1 };
    expect(manaCostFor(PLAYER.id, bare)).toBe(
      sculptManaCost(MANA_PER_BAND_CELL, 3, sculptOptionsOf(bare).profile),
    );
  });

  it('charges direction-blind: lowering costs what raising costs', () => {
    const raise: SculptIntent = { ...POINT_INTENT, radius: 3, profile: 'hard', dir: 1 };
    const lower: SculptIntent = { ...raise, dir: -1 };
    expect(manaCostFor(PLAYER.id, lower)).toBe(manaCostFor(PLAYER.id, raise));
  });
});

describe('charging per intent, through the real pipeline', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  function sculptWith(radius: number, profile: SculptProfile, dir?: 1 | -1) {
    return handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: INTERIOR_CELL.x, y: INTERIOR_CELL.y, radius, dir: dir ?? helperDir(), profile },
    );
  }

  it('charges a radius-4 hard stamp far more than a point stamp', () => {
    expect(sculptWith(MIN_BRUSH_RADIUS, 'soft').applied).toBe(true);
    const pointFee = MANA_CAPACITY - (manaBalanceOf(PLAYER.id) ?? 0);

    const before = manaBalanceOf(PLAYER.id) ?? 0;
    expect(sculptWith(MAX_BRUSH_RADIUS, 'hard').applied).toBe(true);
    const plateauFee = before - (manaBalanceOf(PLAYER.id) ?? 0);

    expect(pointFee).toBe(MANA_COST_PER_MIN_RADIUS_SCULPT);
    expect(plateauFee).toBe(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT);
    // 45 cells of a full band versus one: the ratio is geometry, not tuning.
    expect(plateauFee).toBe(pointFee * MAX_RADIUS_HARD_FOOTPRINT_CELLS);
  });

  it('charges hard more than soft at the same radius', () => {
    for (let radius = MIN_BRUSH_RADIUS + 1; radius <= MAX_BRUSH_RADIUS; radius++) {
      const beforeSoft = manaBalanceOf(PLAYER.id) ?? 0;
      expect(sculptWith(radius, 'soft').applied).toBe(true);
      const softFee = beforeSoft - (manaBalanceOf(PLAYER.id) ?? 0);

      const beforeHard = manaBalanceOf(PLAYER.id) ?? 0;
      expect(sculptWith(radius, 'hard').applied).toBe(true);
      const hardFee = beforeHard - (manaBalanceOf(PLAYER.id) ?? 0);

      expect(hardFee).toBeGreaterThan(softFee);
    }
  });

  it('denies at the threshold of THE INTENT’S cost, not a flat one', () => {
    // Drain to a balance that can still pay for a point stamp but not for a
    // radius-4 hard plateau. The old flat price could not tell these apart.
    // (Helper strokes alternate raise/lower — see helperDir() — so the drain
    // can never saturate the cell into free zero-effect strokes.)
    while ((manaBalanceOf(PLAYER.id) ?? 0) >= MANA_COST_PER_MAX_RADIUS_HARD_SCULPT) {
      expect(sculptWith(MIN_BRUSH_RADIUS, 'soft').applied).toBe(true);
    }
    const stranded = manaBalanceOf(PLAYER.id) ?? 0;
    expect(stranded).toBeGreaterThanOrEqual(MANA_COST_PER_MIN_RADIUS_SCULPT);

    harness.sink.clear();
    expect(sculptWith(MAX_BRUSH_RADIUS, 'hard')).toEqual({
      applied: false,
      reason: 'plugin-denied',
      detail: INSUFFICIENT_MANA_REASON,
    });
    // The refusal names the price of the intent that was refused.
    const refusals = harness.sink.ofType(`mana:${MANA_DENIED_MESSAGE}`);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].payload).toEqual({
      balance: stranded,
      cost: MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
    });
    // Nothing was charged for the refused edit, and the brush they CAN afford
    // still works — the veto is per intent, not a lock-out.
    expect(manaBalanceOf(PLAYER.id)).toBe(stranded);
    expect(sculptWith(MIN_BRUSH_RADIUS, 'soft').applied).toBe(true);
  });

  it('affords exactly the pool the tuning constraint promises', () => {
    let plateaus = 0;
    while (sculptWith(MAX_BRUSH_RADIUS, 'hard').applied) plateaus++;
    expect(plateaus).toBe(FULL_POOL_MAX_RADIUS_HARD_STAMPS);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CHARGE FOLLOWS EFFECT (owner bug report 2026-08-19): sculpting at the world
// floor "is not changing the landscape … but it's taking my mana". A stroke
// whose applied diff is EMPTY costs nothing; a stroke that moved even one cell
// still costs the full nominal price (the 2026-08-14 terrain-independent
// pricing decision stands — only the degenerate zero-effect case changes, and
// it is decided in the effect phase, where the authoritative diff is in hand).
// ────────────────────────────────────────────────────────────────────────────
describe('charge follows effect — a stroke that changes nothing costs nothing', () => {
  /** A world already at the absolute floor everywhere: every lowering stroke
   *  is a genuine terrain no-op, whatever the brush. */
  function bootAtWorldFloor(): Harness {
    resetManaState();
    const world = worldWithUnlockedChunks(WORLD_SIZE, [HOME_CHUNK], SUITE_DIFFICULTY, MIN_HEIGHT);
    const sink = new RecordingSink();
    world.setSink(sink);
    const host = new PluginHost(world, [manaPlugin, revealPlugin].map(asLoadedPlugin));
    host.worldCreate();
    world.addPlayer(PLAYER);
    host.playerJoined(PLAYER);
    return { world, host, sink };
  }

  function lowerAt(harness: Harness, radius: number, tool: string, profile: string) {
    return handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: INTERIOR_CELL.x, y: INTERIOR_CELL.y, radius, dir: -1, tool, profile },
    );
  }

  it('a zero-effect stroke is applied, costs zero, and still pushes the balance — every tool × profile', () => {
    for (const tool of SCULPT_TOOLS) {
      for (const profile of SCULPT_PROFILES) {
        const harness = bootAtWorldFloor();
        harness.sink.clear();

        const outcome = lowerAt(harness, MAX_BRUSH_RADIUS, tool, profile);
        // The intent is legal and APPLIED (not denied) — it simply moved
        // nothing, so the diff is empty and the charge is zero.
        expect(outcome.applied).toBe(true);
        if (outcome.applied) expect(outcome.diff).toEqual([]);
        expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);

        // The balance push still goes out: the client's local gate debited
        // its estimate on send, and a full pool never regen-pushes, so this
        // push is what erases the phantom (same shape as the deny path).
        const pushes = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
        expect(pushes.length).toBeGreaterThan(0);
        const last = pushes[pushes.length - 1].payload as { balance: number };
        expect(last.balance).toBe(MANA_CAPACITY);
      }
    }
  });

  it('a stroke that moves even one cell still costs the full nominal price', () => {
    // Floor world, but RAISING: every footprint cell can move, and the price
    // must be the same nominal volume as anywhere else — no discount for the
    // clamps and anchors the terrain applies (the 2026-08-14 decision).
    const harness = bootAtWorldFloor();
    const outcome = handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      {
        type: 'sculpt',
        x: INTERIOR_CELL.x,
        y: INTERIOR_CELL.y,
        radius: MIN_BRUSH_RADIUS,
        dir: 1,
        tool: 'stamp',
        profile: 'soft',
      },
    );
    expect(outcome.applied).toBe(true);
    if (outcome.applied) expect(outcome.diff.length).toBeGreaterThan(0);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - MANA_COST_PER_MIN_RADIUS_SCULPT);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ISSUE #19 — TWO-PHASE INTENT PROCESSING. mana used to charge in the same
// verdict pass a later interceptor could still veto (monsters denying a raise
// near a living Cthulhu was the real-world case the issue was filed for).
// mana now only checks affordability in onIntent and only spends in
// onIntentApplied, which core fires exclusively after every interceptor in
// the chain — including a plugin loaded AFTER mana — has allowed. These tests
// exercise that through the REAL mana plugin and the real pipeline, with a
// minimal stand-in for "some later plugin vetoes it", so the contract is
// pinned independent of any one denying plugin's own reasons.
// ────────────────────────────────────────────────────────────────────────────

describe('issue #19 — a later interceptor’s deny costs zero mana', () => {
  /** Denies every intent it sees. Stands in for monsters/relics/any plugin. */
  const laterDenier: TerracePlugin = {
    name: 'zzz-later-denier',
    onIntent(): IntentVerdict {
      return { kind: 'deny', reason: 'vetoed by a later plugin' };
    },
  };

  /** Boots mana with an extra plugin appended AFTER it in the chain. */
  function bootWithLaterPlugin(laterPlugin: TerracePlugin): Harness {
    resetManaState();
    const world = worldWithUnlockedChunks(WORLD_SIZE, [HOME_CHUNK], SUITE_DIFFICULTY);
    const sink = new RecordingSink();
    world.setSink(sink);

    // manaPlugin FIRST, laterPlugin SECOND — this is the exact ordering
    // relationship the bug depended on (mana sorts before every other shipped
    // plugin alphabetically), reproduced explicitly rather than relying on
    // directory names.
    const host = new PluginHost(world, [manaPlugin, laterPlugin].map(asLoadedPlugin));
    host.worldCreate();
    world.addPlayer(PLAYER);
    host.playerJoined(PLAYER);

    return { world, host, sink };
  }

  it('charges NOTHING when a plugin ordered after mana denies the intent', () => {
    const harness = bootWithLaterPlugin(laterDenier);
    const before = manaBalanceOf(PLAYER.id);
    expect(before).toBe(MANA_CAPACITY);

    const outcome = sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('plugin-denied');
    // The load-bearing assertion: mana's own onIntent allowed (it never got a
    // chance to deny), yet the pool is untouched because it never charges
    // until the effect phase, which a deny skips entirely.
    expect(manaBalanceOf(PLAYER.id)).toBe(before);
    expect(harness.world.heightAt(INTERIOR_CELL.x, INTERIOR_CELL.y)).toBe(0);
  });

  it('charges exactly the shared price when every interceptor — including a later one — allows', () => {
    const allower: TerracePlugin = { name: 'zzz-later-allower', onIntent: () => ALLOW };
    const harness = bootWithLaterPlugin(allower);

    const outcome = sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);

    expect(outcome.applied).toBe(true);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - POINT_COST);
  });

  it('the same intent costs zero when denied and exactly POINT_COST when allowed — same pool, same brush', () => {
    // Denied first, so a bug that charged anyway would be visible as a balance
    // drop the very next assertion catches.
    const denyHarness = bootWithLaterPlugin(laterDenier);
    expect(sculptAt(denyHarness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(false);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);

    const allowHarness = bootWithLaterPlugin({ name: 'zzz-later-allower', onIntent: () => ALLOW });
    expect(sculptAt(allowHarness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(true);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - POINT_COST);
  });

  it('a later interceptor’s deny still pushes the authoritative balance to the sender (phantom-debit fix, 2026-08-19)', () => {
    // THE BUG THIS PINS: the client debits its balance estimate on SEND
    // (gateLocalSculpt) and relies on an authoritative message to correct it.
    // When a NON-mana plugin denied while the pool sat at FULL capacity,
    // nothing ever arrived — mana:denied is only mana's own, and regen skips
    // full pools so no balance push fires — leaving the phantom debit standing
    // ("sculpt failed and my mana was not refunded"). The deny-side effect
    // phase (onIntentDenied) must now push the untouched balance.
    const harness = bootWithLaterPlugin(laterDenier);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY); // full pool: the regen path can never rescue the client
    harness.sink.clear();

    expect(sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(false);

    // No mana:denied — mana itself allowed; the refusal was someone else's.
    expect(harness.sink.ofType('mana:denied')).toHaveLength(0);
    // But exactly the authoritative balance, pushed to the sender, uncharged.
    const pushes = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].target).toBe(PLAYER.id);
    expect(pushes[0].payload).toMatchObject({ balance: MANA_CAPACITY });

    // And ticking on changes nothing: a full pool stays silent, so the push
    // above was genuinely the only correction the client will ever get.
    harness.sink.clear();
    for (let n = 0; n < 50; n++) harness.host.tick(TICK_DT);
    expect(harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`)).toHaveLength(0);
  });
});

describe('gate / server parity — the same intent, the same fee', () => {
  /**
   * THE PROPERTY: for every brush the game can send, and every perk rate the
   * economy can produce, the fee the server takes off the authoritative pool and
   * the fee the client's local gate takes off its replica are the SAME INTEGER.
   *
   * This is the invariant the shared pricing function (../pricing.ts) exists to
   * guarantee. If it ever fails, the client is letting through strokes the
   * server will nack — the phantom-stroke bug the local gate was added to fix.
   *
   * The multipliers cover neutral, the shipped half-cost relic, and one that
   * lands the rate on a non-integer (6 × 0.3 = 1.8) so the single rounding step
   * is exercised on both sides rather than being trivially absent.
   */
  const PARITY_MULTIPLIERS = [NEUTRAL_MANA_MULTIPLIER, 0.5, 0.3] as const;

  it('charges the same fee on both sides for every radius × profile × perk', async () => {
    const { gateLocalSculpt, setManaPool, manaPool } = await import('../client/state.ts');

    for (const multiplier of PARITY_MULTIPLIERS) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        for (const profile of SCULPT_PROFILES) {
          const harness = boot();
          if (multiplier !== NEUTRAL_MANA_MULTIPLIER) {
            setManaPerk(PLAYER.id, { costMultiplier: multiplier });
          }
          const intent: SculptIntent = { ...POINT_INTENT, radius, profile };

          // SERVER: the real pipeline, the real interceptor chain.
          const serverBefore = manaBalanceOf(PLAYER.id) ?? 0;
          const outcome = handleSculptIntent(
            { world: harness.world, interceptors: harness.host },
            PLAYER,
            intent,
          );
          expect(outcome.applied).toBe(true);
          const serverFee = serverBefore - (manaBalanceOf(PLAYER.id) ?? 0);

          // CLIENT: seeded from the balance push the server actually emitted, so
          // the rate under test is the one that really travels.
          const pushes = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
          const pushed = pushes[pushes.length - 1].payload as {
            manaPerBandCell: number;
            regenPerSecond: number;
          };
          setManaPool({
            balance: MANA_CAPACITY,
            capacity: MANA_CAPACITY,
            manaPerBandCell: pushed.manaPerBandCell,
            regenPerSecond: pushed.regenPerSecond,
          });
          expect(gateLocalSculpt(intent)).toBe(true);
          const clientFee = MANA_CAPACITY - (manaPool()?.balance ?? 0);

          expect(clientFee).toBe(serverFee);
        }
      }
    }
  });

  it('refuses the same intent at the same balance on both sides', async () => {
    const { gateLocalSculpt, setManaPool } = await import('../client/state.ts');
    const harness = boot();
    const plateau: SculptIntent = {
      ...POINT_INTENT,
      radius: MAX_BRUSH_RADIUS,
      profile: 'hard',
    };

    // Drain the server pool to just under the plateau's price.
    while ((manaBalanceOf(PLAYER.id) ?? 0) >= MANA_COST_PER_MAX_RADIUS_HARD_SCULPT) {
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    }
    const stranded = manaBalanceOf(PLAYER.id) ?? 0;

    // Same balance, same rate, same intent → the client vetoes it locally, so
    // the request the server would have denied is never sent.
    setManaPool({
      balance: stranded,
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
    expect(gateLocalSculpt(plateau)).toBe(false);
    expect(
      handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        plateau,
      ).applied,
    ).toBe(false);

    // And the other side of the threshold: at exactly the price, both allow.
    setManaPool({
      balance: MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
    expect(gateLocalSculpt(plateau)).toBe(true);
  });
});
