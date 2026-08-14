// mana, driven through the REAL intent pipeline and the REAL plugin host with
// both shipped example plugins registered — no stubs for either. If the plugin
// API cannot express a mana economy, these tests are what fails.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import { plugin as revealPlugin, resetRevealState } from '../../reveal/server/index.ts';
import {
  DEFAULT_MANA_REGEN_PER_SECOND,
  INSUFFICIENT_MANA_REASON,
  MANA_BALANCE_MESSAGE,
  MANA_CAPACITY,
  MANA_COST_PER_SCULPT,
  MANA_DENIED_MESSAGE,
  MANA_PERK_MAX_MULTIPLIER,
  MANA_PERK_MIN_MULTIPLIER,
  MANA_REGEN_ENV,
  MAX_DRAINED_WAIT_S,
  MAX_MANA_REGEN_PER_SECOND,
  MIN_MANA_REGEN_PER_SECOND,
  NEUTRAL_MANA_MULTIPLIER,
  clearManaPerk,
  manaBalanceOf,
  manaCostFor,
  manaPerkOf,
  manaRegenFor,
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

const PLAYER: Player = { id: 'session-1', name: 'Tester' };

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
function boot(): Harness {
  resetManaState();
  resetRevealState();

  const world = worldWithUnlockedChunks(WORLD_SIZE, [HOME_CHUNK]);
  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [manaPlugin, revealPlugin].map(asLoadedPlugin));
  host.worldCreate();

  world.addPlayer(PLAYER);
  host.playerJoined(PLAYER);

  return { world, host, sink };
}

function sculptAt(harness: Harness, x: number, y: number, radius = 1) {
  return handleSculptIntent(
    { world: harness.world, interceptors: harness.host },
    PLAYER,
    { type: 'sculpt', x, y, radius, dir: 1 },
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
      cost: MANA_COST_PER_SCULPT,
      regenPerSecond: DEFAULT_MANA_REGEN_PER_SECOND,
    });
  });

  it('charges every applied sculpt and denies once the pool cannot pay', () => {
    const affordable = MANA_CAPACITY / MANA_COST_PER_SCULPT;
    expect(Number.isInteger(affordable)).toBe(true);

    for (let n = 1; n <= affordable; n++) {
      const outcome = sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
      expect(outcome.applied).toBe(true);
      expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - n * MANA_COST_PER_SCULPT);
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
    for (let n = 0; n < MANA_CAPACITY / MANA_COST_PER_SCULPT; n++) {
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
    for (let n = 0; n < MANA_CAPACITY / MANA_COST_PER_SCULPT; n++) {
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    }
    harness.sink.clear();

    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);

    const refusals = harness.sink.ofType('mana:denied');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].target).toBe(PLAYER.id);
    expect(refusals[0].payload).toEqual({ balance: 0, cost: MANA_COST_PER_SCULPT });
  });

  it('regenerates on the tick and never past capacity', () => {
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - MANA_COST_PER_SCULPT);

    // Exactly enough simulated time to earn one sculpt back.
    const ticksToRefundOneSculpt = MANA_COST_PER_SCULPT / (DEFAULT_MANA_REGEN_PER_SECOND * TICK_DT);
    for (let n = 0; n < ticksToRefundOneSculpt; n++) harness.host.tick(TICK_DT);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);

    for (let n = 0; n < 100; n++) harness.host.tick(TICK_DT);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);
  });

  it('recovers from an empty pool and sculpts again', () => {
    for (let n = 0; n < MANA_CAPACITY / MANA_COST_PER_SCULPT; n++) {
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    }
    expect(sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(false);

    const ticksToAffordOneSculpt = MANA_COST_PER_SCULPT / (DEFAULT_MANA_REGEN_PER_SECOND * TICK_DT);
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
const OTHER_PLAYER: Player = { id: 'session-2', name: 'Control' };

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
      { type: 'sculpt', x: INTERIOR_CELL.x, y: INTERIOR_CELL.y, radius: 1, dir: 1 },
    );
  }

  it('defaults every player to neutral', () => {
    expect(manaPerkOf(PLAYER.id)).toEqual({
      costMultiplier: NEUTRAL_MANA_MULTIPLIER,
      regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
    });
    expect(manaCostFor(PLAYER.id)).toBe(MANA_COST_PER_SCULPT);
  });

  it('charges the perked price on the intent path', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0.5 });
    const discounted = manaCostFor(PLAYER.id);
    expect(discounted).toBe(Math.ceil(MANA_COST_PER_SCULPT * 0.5));

    expect(sculptAs(PLAYER).applied).toBe(true);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - discounted);

    // The unperked player in the same world still pays full price.
    expect(sculptAs(OTHER_PLAYER).applied).toBe(true);
    expect(manaBalanceOf(OTHER_PLAYER.id)).toBe(MANA_CAPACITY - MANA_COST_PER_SCULPT);
  });

  it('buys a cheaper player strictly more sculpts before the veto', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0.5 });

    let perked = 0;
    while (sculptAs(PLAYER).applied) perked++;
    let plain = 0;
    while (sculptAs(OTHER_PLAYER).applied) plain++;

    expect(plain).toBe(MANA_CAPACITY / MANA_COST_PER_SCULPT);
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
    expect((refusals[0].payload as { cost: number }).cost).toBe(manaCostFor(PLAYER.id));
  });

  it('regenerates a perked player faster, and still caps at capacity', () => {
    setManaPerk(PLAYER.id, { regenMultiplier: 2 });

    // Spend enough that a second of doubled regen still fits under the cap —
    // otherwise both players simply refill to capacity and the perk is
    // invisible. Four sculpts each leaves 100 of 200.
    const sculptsToDrain = 4;
    for (let n = 0; n < sculptsToDrain; n++) {
      sculptAs(PLAYER);
      sculptAs(OTHER_PLAYER);
    }
    const spent = sculptsToDrain * MANA_COST_PER_SCULPT;
    expect(manaBalanceOf(PLAYER.id)).toBe(manaBalanceOf(OTHER_PLAYER.id));

    // One second of simulated time.
    for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);

    const perkedGain = (manaBalanceOf(PLAYER.id) ?? 0) - (MANA_CAPACITY - spent);
    const plainGain = (manaBalanceOf(OTHER_PLAYER.id) ?? 0) - (MANA_CAPACITY - spent);
    expect(plainGain).toBe(DEFAULT_MANA_REGEN_PER_SECOND);
    expect(perkedGain).toBe(DEFAULT_MANA_REGEN_PER_SECOND * 2);

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
    expect(manaCostFor(PLAYER.id)).toBe(MANA_COST_PER_SCULPT);
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
    expect(manaCostFor(PLAYER.id)).toBe(MANA_COST_PER_SCULPT);
  });

  it('clamps a multiplier into the documented band', () => {
    setManaPerk(PLAYER.id, { costMultiplier: 0, regenMultiplier: 1000 });
    expect(manaPerkOf(PLAYER.id)).toEqual({
      costMultiplier: MANA_PERK_MIN_MULTIPLIER,
      regenMultiplier: MANA_PERK_MAX_MULTIPLIER,
    });

    // The floor is what stops a zero multiplier from deleting the economy: a
    // perked player is still charged, and can still run out.
    expect(manaCostFor(PLAYER.id)).toBeGreaterThan(0);
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
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - MANA_COST_PER_SCULPT);
  });

  it('may be set before mana has ever seen the player', () => {
    // relics can grant a perk from a message handler that runs before this
    // plugin's lazily-created pool exists; the perk must survive that.
    const latecomer: Player = { id: 'session-3', name: 'Late' };
    setManaPerk(latecomer.id, { costMultiplier: 0.5 });

    harness.world.addPlayer(latecomer);
    harness.host.playerJoined(latecomer);
    harness.sink.clear();

    expect(sculptAs(latecomer).applied).toBe(true);
    expect(manaBalanceOf(latecomer.id)).toBe(MANA_CAPACITY - manaCostFor(latecomer.id));
    expect(harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`).length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PER-WORLD REGEN RATE. The rate is deployment configuration (MANA_REGEN_PER_S)
// with a default, so the three things worth pinning down are: an unconfigured
// world still works, a configured one is obeyed, and a MIS-configured one can
// neither freeze the economy nor delete it.
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

  it('falls back to the default when unset or blank', () => {
    expect(resolveManaRegenPerSecond(undefined)).toBe(DEFAULT_MANA_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('')).toBe(DEFAULT_MANA_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('   ')).toBe(DEFAULT_MANA_REGEN_PER_SECOND);
    expect(console.warn).not.toHaveBeenCalled(); // not configuring is not an error

    const harness = boot();
    expect(manaRegenPerSecond()).toBe(DEFAULT_MANA_REGEN_PER_SECOND);
    expect(harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`)[0].payload).toMatchObject({
      regenPerSecond: DEFAULT_MANA_REGEN_PER_SECOND,
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
      expect(resolveManaRegenPerSecond(bad)).toBe(DEFAULT_MANA_REGEN_PER_SECOND);
    }
    expect(console.warn).toHaveBeenCalledTimes(7);

    // End to end: a garbage value must leave a WORKING world, not a frozen one.
    process.env[MANA_REGEN_ENV] = 'twenty';
    const harness = boot();
    expect(manaRegenPerSecond()).toBe(DEFAULT_MANA_REGEN_PER_SECOND);
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    const afterSpend = manaBalanceOf(PLAYER.id) ?? 0;
    for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);
    expect((manaBalanceOf(PLAYER.id) ?? 0) - afterSpend).toBe(DEFAULT_MANA_REGEN_PER_SECOND);
  });

  it('clamps a rate outside the supported band into it', () => {
    expect(resolveManaRegenPerSecond('0.0001')).toBe(MIN_MANA_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('1e9')).toBe(MAX_MANA_REGEN_PER_SECOND);
    // The band's own edges are configurable values, not rejected ones.
    expect(resolveManaRegenPerSecond(String(MIN_MANA_REGEN_PER_SECOND))).toBe(
      MIN_MANA_REGEN_PER_SECOND,
    );
    expect(resolveManaRegenPerSecond(String(MAX_MANA_REGEN_PER_SECOND))).toBe(
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
    // One tick of slack on top of the minute: the floor is 25/60 mana per
    // second, and accumulating that in 0.1 s steps lands a hair under 25 in
    // IEEE arithmetic. The claim under test is the wait, not the last ULP.
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

describe('protocol parse (client half)', () => {
  it('accepts proper payloads and rejects malformed ones', async () => {
    const { parseManaBalancePayload, parseManaDeniedPayload } = await import('../protocol.ts');
    expect(
      parseManaBalancePayload({ balance: 150, capacity: 600, cost: 25, regenPerSecond: 20 }),
    ).toEqual({
      balance: 150,
      capacity: 600,
      cost: 25,
      regenPerSecond: 20,
    });
    // A fractional rate is legal — the configurable band's floor is 25/60.
    expect(
      parseManaBalancePayload({ balance: 0, capacity: 600, cost: 25, regenPerSecond: 0.4 }),
    ).toEqual({ balance: 0, capacity: 600, cost: 25, regenPerSecond: 0.4 });
    for (const bad of [
      null,
      'x',
      {},
      { balance: 1 },
      { balance: -1, capacity: 600, cost: 25, regenPerSecond: 20 },
      { balance: 1, capacity: 0, cost: 25, regenPerSecond: 20 },
      { balance: Number.NaN, capacity: 600, cost: 25, regenPerSecond: 20 },
      { balance: 1, capacity: 600, regenPerSecond: 20 },
      // The new field: missing, zero (an infinite pulse period), negative, and
      // not a number at all. All-or-nothing — see parseManaBalancePayload.
      { balance: 1, capacity: 600, cost: 25 },
      { balance: 1, capacity: 600, cost: 25, regenPerSecond: 0 },
      { balance: 1, capacity: 600, cost: 25, regenPerSecond: -20 },
      { balance: 1, capacity: 600, cost: 25, regenPerSecond: Number.NaN },
      { balance: 1, capacity: 600, cost: 25, regenPerSecond: Number.POSITIVE_INFINITY },
      { balance: 1, capacity: 600, cost: 25, regenPerSecond: '20' },
    ]) {
      expect(parseManaBalancePayload(bad)).toBeNull();
    }
    expect(parseManaDeniedPayload({ balance: 3, cost: 25 })).toEqual({ balance: 3, cost: 25 });
    for (const bad of [null, {}, { balance: 3 }, { cost: 25 }, { balance: 3, cost: 'x' }]) {
      expect(parseManaDeniedPayload(bad)).toBeNull();
    }
  });
});

describe('client local intent gate', () => {
  it('allows with no pool state, debits when allowed, denies when broke', async () => {
    const { gateLocalSculpt, setManaPool, manaPool, deniedCount } = await import(
      '../client/state.ts'
    );

    setManaPool(null);
    expect(gateLocalSculpt()).toBe(true); // no economy declared: never veto

    setManaPool({ balance: 30, capacity: 600, cost: 25, regenPerSecond: 20 });
    expect(gateLocalSculpt()).toBe(true); // 30 -> 5, affordable
    expect(manaPool()?.balance).toBe(5);

    const denialsBefore = deniedCount();
    expect(gateLocalSculpt()).toBe(false); // 5 < 25: veto...
    expect(deniedCount()).toBe(denialsBefore + 1); // ...flash...
    expect(manaPool()?.balance).toBe(5); // ...and no debit on a veto
  });
});
