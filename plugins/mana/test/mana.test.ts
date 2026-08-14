// mana, driven through the REAL intent pipeline and the REAL plugin host with
// both shipped example plugins registered — no stubs for either. If the plugin
// API cannot express a mana economy, these tests are what fails.

import { beforeEach, describe, expect, it } from 'vitest';
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
  INSUFFICIENT_MANA_REASON,
  MANA_CAPACITY,
  MANA_COST_PER_SCULPT,
  MANA_REGEN_PER_SECOND,
  manaBalanceOf,
  plugin as manaPlugin,
  resetManaState,
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
    expect(pushed[0].payload).toEqual({ balance: MANA_CAPACITY, capacity: MANA_CAPACITY });
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
    const ticksToRefundOneSculpt = MANA_COST_PER_SCULPT / (MANA_REGEN_PER_SECOND * TICK_DT);
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

    const ticksToAffordOneSculpt = MANA_COST_PER_SCULPT / (MANA_REGEN_PER_SECOND * TICK_DT);
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
