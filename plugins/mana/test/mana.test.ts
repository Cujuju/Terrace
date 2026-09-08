import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  WORLD_UNIT_CELLS,
  MIN_HEIGHT,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  type SculptOptions,
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
import { createWorldApi } from '../../../server/src/plugins/world-api.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import { RIVER_RECOMPUTE_INTERVAL_MS } from '../../../server/src/world/world.ts';
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
  MANA_BALANCE_HEARTBEAT_MS,
  MANA_BALANCE_MESSAGE,
  MANA_CAPACITY,
  MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
  MANA_COST_PER_MIN_RADIUS_SCULPT,
  MANA_PER_BAND_WORLD_UNIT_SQUARED,
  POINT_BRUSH_RADIUS_CELLS,
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

const ALL_REVEALED = { worldSize: () => 0, revealedAt: () => true };

const WORLD_SIZE = 64;

const HOME_CHUNK: readonly [number, number] = [1, 1];

const EVERY_CHUNK: ReadonlyArray<readonly [number, number]> = (() => {
  const edge = WORLD_SIZE / CHUNK_SIZE;
  const chunks: Array<readonly [number, number]> = [];
  for (let cy = 0; cy < edge; cy++) for (let cx = 0; cx < edge; cx++) chunks.push([cx, cy]);
  return chunks;
})();

const INTERIOR_CELL = { x: 24, y: 24 } as const;

const TICK_DT = 0.1;

const MILLISECONDS_PER_SECOND = 1000;

const TICKS_PER_HEARTBEAT =
  MANA_BALANCE_HEARTBEAT_MS / MILLISECONDS_PER_SECOND / TICK_DT;

const SUITE_DIFFICULTY = MAX_WORLD_DIFFICULTY;

const SUITE_REGEN_PER_SECOND = MANA_REGEN_AT_DIFFICULTY_100;

const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

const POINT_INTENT: SculptIntent = {
  type: 'sculpt',
  x: INTERIOR_CELL.x,
  y: INTERIOR_CELL.y,
  radius: POINT_BRUSH_RADIUS_CELLS,
  dir: 1,
};

const POINT_COST = MANA_COST_PER_MIN_RADIUS_SCULPT;

const POINT_STAMPS_PER_POOL = Math.floor(MANA_CAPACITY / POINT_COST);

const GATE_FIXTURE_BALANCE = 5 * POINT_COST;

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

function seedTerritory(world: World, token: string = PLAYER.token): void {
  const edge = world.chunksPerEdge;
  for (let cy = 0; cy < edge; cy++) {
    for (let cx = 0; cx < edge; cx++) {
      if (world.isChunkUnlocked(cx, cy)) world.seedChunkForToken(token, cx, cy);
    }
  }
}

function boot(difficulty: number = SUITE_DIFFICULTY): Harness {
  resetManaState();
  nextHelperDir = 1;

  const world = worldWithUnlockedChunks(WORLD_SIZE, EVERY_CHUNK, difficulty);
  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [manaPlugin, revealPlugin].map(asLoadedPlugin));
  host.worldCreate();

  world.addPlayer(PLAYER);
  seedTerritory(world);
  host.playerJoined(PLAYER);

  return { world, host, sink };
}

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
  radius = POINT_BRUSH_RADIUS_CELLS,
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
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
  });

  it('charges every applied sculpt and denies once the pool cannot pay', () => {
    const affordable = POINT_STAMPS_PER_POOL;
    expect(affordable).toBeGreaterThan(0);

    for (let n = 1; n <= affordable; n++) {
      const outcome = sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
      expect(outcome.applied).toBe(true);
      expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - n * POINT_COST);
    }

    expect(manaBalanceOf(PLAYER.id)).toBeLessThan(POINT_COST);

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
    expect(refusals[0].payload).toEqual({
      balance: MANA_CAPACITY - POINT_STAMPS_PER_POOL * POINT_COST,
      cost: POINT_COST,
    });
  });

  it('regenerates on the tick and never past capacity', () => {
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - POINT_COST);

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

    harness.host.tick(TICK_DT);
    harness.host.tick(TICK_DT);
    const duringRegen = harness.sink.ofType('mana:balance').length;
    expect(duringRegen).toBeGreaterThan(0);

    for (let n = 0; n < 200; n++) harness.host.tick(TICK_DT);
    harness.sink.clear();
    const ticks = 50;
    for (let n = 0; n < ticks; n++) harness.host.tick(TICK_DT);
    expect(harness.sink.ofType('mana:balance')).toHaveLength(ticks / TICKS_PER_HEARTBEAT);
    expect(TICKS_PER_HEARTBEAT).toBeGreaterThan(1);
  });

  it('drops a pool when its player leaves', () => {
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);
    harness.world.removePlayer(PLAYER.id);
    harness.host.playerLeft(PLAYER);
    expect(manaBalanceOf(PLAYER.id)).toBeNull();
  });
});

const OTHER_PLAYER: Player = { id: 'session-2', token: 'token-2', name: 'Control' };

describe('mana perks', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
    harness.world.addPlayer(OTHER_PLAYER);
    seedTerritory(harness.world, OTHER_PLAYER.token);
    harness.host.playerJoined(OTHER_PLAYER);
    harness.sink.clear();
  });

  function sculptAs(player: Player) {
    return handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      player,
      {
        type: 'sculpt',
        x: INTERIOR_CELL.x,
        y: INTERIOR_CELL.y,
        radius: POINT_BRUSH_RADIUS_CELLS,
        dir: helperDir(),
      },
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
    setManaPerk(PLAYER.id, { costMultiplier: 0.5 });
    expect(manaPerBandCellFor(PLAYER.id)).toBe(MANA_PER_BAND_CELL * 0.5);

    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      for (const profile of SCULPT_PROFILES) {
        const intent: SculptIntent = { ...POINT_INTENT, radius, profile };
        expect(manaCostFor(PLAYER.id, intent)).toBe(
          sculptManaCost(MANA_PER_BAND_CELL * 0.5, radius, profile, 'stamp'),
        );
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

    const sculptsToDrain = Math.ceil((SUITE_REGEN_PER_SECOND * 2) / POINT_COST) + 1;
    for (let n = 0; n < sculptsToDrain; n++) {
      sculptAs(PLAYER);
      sculptAs(OTHER_PLAYER);
    }
    const spent = sculptsToDrain * POINT_COST;
    expect(manaBalanceOf(PLAYER.id)).toBe(manaBalanceOf(OTHER_PLAYER.id));

    for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);

    const perkedGain = (manaBalanceOf(PLAYER.id) ?? 0) - (MANA_CAPACITY - spent);
    const plainGain = (manaBalanceOf(OTHER_PLAYER.id) ?? 0) - (MANA_CAPACITY - spent);
    expect(plainGain).toBe(SUITE_REGEN_PER_SECOND);
    expect(perkedGain).toBe(SUITE_REGEN_PER_SECOND * 2);

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
    const latecomer: Player = { id: 'session-3', token: 'token-3', name: 'Late' };
    setManaPerk(latecomer.id, { costMultiplier: 0.5 });

    harness.world.addPlayer(latecomer);
    seedTerritory(harness.world, latecomer.token);
    harness.host.playerJoined(latecomer);
    harness.sink.clear();

    expect(sculptAs(latecomer).applied).toBe(true);
    expect(manaBalanceOf(latecomer.id)).toBe(
      MANA_CAPACITY - manaCostFor(latecomer.id, POINT_INTENT),
    );
    expect(harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`).length).toBeGreaterThan(0);
  });
});

describe('mana regen configuration', () => {
  const originalEnv = process.env[MANA_REGEN_ENV];

  beforeEach(() => {
    delete process.env[MANA_REGEN_ENV];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalEnv === undefined) delete process.env[MANA_REGEN_ENV];
    else process.env[MANA_REGEN_ENV] = originalEnv;
  });

  it('falls back to the difficulty-derived rate when unset or blank', () => {
    expect(resolveManaRegenPerSecond(undefined, SUITE_DIFFICULTY)).toBe(SUITE_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('', SUITE_DIFFICULTY)).toBe(SUITE_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('   ', SUITE_DIFFICULTY)).toBe(SUITE_REGEN_PER_SECOND);
    expect(console.warn).not.toHaveBeenCalled();

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
    for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);
    expect((manaBalanceOf(PLAYER.id) ?? 0) - afterSpend).toBe(configured);
  });

  it('rejects anything that is not a positive finite number', () => {
    for (const bad of ['abc', '0', '-5', 'NaN', 'Infinity', '20abc', 'true']) {
      expect(resolveManaRegenPerSecond(bad, SUITE_DIFFICULTY)).toBe(SUITE_REGEN_PER_SECOND);
    }
    expect(console.warn).toHaveBeenCalledTimes(7);

    process.env[MANA_REGEN_ENV] = 'twenty';
    const harness = boot();
    expect(manaRegenPerSecond()).toBe(SUITE_REGEN_PER_SECOND);
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y, MAX_BRUSH_RADIUS, 'hard');
    const afterSpend = manaBalanceOf(PLAYER.id) ?? 0;
    for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);
    expect((manaBalanceOf(PLAYER.id) ?? 0) - afterSpend).toBe(SUITE_REGEN_PER_SECOND);
  });

  it('clamps a rate outside the supported band into it', () => {
    expect(resolveManaRegenPerSecond('0.0001', SUITE_DIFFICULTY)).toBe(MIN_MANA_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond('1e9', SUITE_DIFFICULTY)).toBe(MAX_MANA_REGEN_PER_SECOND);
    expect(resolveManaRegenPerSecond(String(MIN_MANA_REGEN_PER_SECOND), SUITE_DIFFICULTY)).toBe(
      MIN_MANA_REGEN_PER_SECOND,
    );
    expect(resolveManaRegenPerSecond(String(MAX_MANA_REGEN_PER_SECOND), SUITE_DIFFICULTY)).toBe(
      MAX_MANA_REGEN_PER_SECOND,
    );

    process.env[MANA_REGEN_ENV] = '0.0001';
    const harness = boot();
    expect(manaRegenPerSecond()).toBe(MIN_MANA_REGEN_PER_SECOND);
    while (sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied) {
    }
    for (let n = 0; n <= MAX_DRAINED_WAIT_S / TICK_DT; n++) harness.host.tick(TICK_DT);
    expect(sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(true);
  });

  it('pushes the PERK-ADJUSTED rate, per player', () => {
    const configured = 8;
    process.env[MANA_REGEN_ENV] = String(configured);

    const harness = boot();
    setManaPerk(PLAYER.id, { regenMultiplier: 2 });
    expect(manaRegenFor(PLAYER.id)).toBe(configured * 2);
    expect(manaRegenFor('never-seen')).toBe(configured);

    harness.sink.clear();
    sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    expect(harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`)[0].payload).toMatchObject({
      regenPerSecond: configured * 2,
    });
  });

});

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

  function pushedRegen(harness: Harness): number {
    const pushes = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
    expect(pushes.length).toBeGreaterThan(0);
    return (pushes[0].payload as { regenPerSecond: number }).regenPerSecond;
  }

  it('anchors the scale where the owner set it, and names the anchors correctly', () => {
    expect(MANA_REGEN_AT_DIFFICULTY_1).toBe(300);
    expect(MANA_REGEN_AT_DIFFICULTY_100).toBe(30);
    expect(MIN_WORLD_DIFFICULTY).toBe(1);
    expect(MAX_WORLD_DIFFICULTY).toBe(100);
  });

  it('gives a WARM world 300/s, on the wire', () => {
    const harness = boot(MIN_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MANA_REGEN_AT_DIFFICULTY_1);
    expect(pushedRegen(harness)).toBe(MANA_REGEN_AT_DIFFICULTY_1);
  });

  it('gives a PUNISHING world 30/s, on the wire', () => {
    const harness = boot(MAX_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MANA_REGEN_AT_DIFFICULTY_100);
    expect(pushedRegen(harness)).toBe(MANA_REGEN_AT_DIFFICULTY_100);
  });

  it('gives the default world the documented midpoint, ≈166.4/s', () => {
    const expected =
      MANA_REGEN_AT_DIFFICULTY_1 +
      ((DEFAULT_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY) /
        (MAX_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY)) *
        (MANA_REGEN_AT_DIFFICULTY_100 - MANA_REGEN_AT_DIFFICULTY_1);

    const harness = boot(DEFAULT_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(expected);
    expect(pushedRegen(harness)).toBe(expected);
    expect(expected).toBeCloseTo(166.364, 3);
  });

  it('interpolates linearly and monotonically across the whole scale', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let difficulty = MIN_WORLD_DIFFICULTY; difficulty <= MAX_WORLD_DIFFICULTY; difficulty++) {
      const rate = manaRegenForDifficulty(difficulty);
      expect(rate).toBeLessThan(previous);
      expect(rate).toBeLessThanOrEqual(MANA_REGEN_AT_DIFFICULTY_1);
      expect(rate).toBeGreaterThanOrEqual(MANA_REGEN_AT_DIFFICULTY_100);
      expect(rate).toBeGreaterThanOrEqual(MIN_MANA_REGEN_PER_SECOND);
      expect(rate).toBeLessThanOrEqual(MAX_MANA_REGEN_PER_SECOND);
      previous = rate;
    }
  });

  it('lets a warm world actually outspend a punishing one', () => {
    function earnedInOneSecond(difficulty: number): number {
      const harness = boot(difficulty);
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y, MAX_BRUSH_RADIUS, 'hard');
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y, MAX_BRUSH_RADIUS, 'hard');
      const afterSpend = manaBalanceOf(PLAYER.id) ?? 0;
      for (let n = 0; n < 1 / TICK_DT; n++) harness.host.tick(TICK_DT);
      return (manaBalanceOf(PLAYER.id) ?? 0) - afterSpend;
    }

    expect(earnedInOneSecond(MIN_WORLD_DIFFICULTY)).toBe(MANA_REGEN_AT_DIFFICULTY_1);
    expect(earnedInOneSecond(MAX_WORLD_DIFFICULTY)).toBe(MANA_REGEN_AT_DIFFICULTY_100);
  });

  it('lets an EXPLICIT MANA_REGEN_PER_S beat the difficulty, in both directions', () => {
    const configured = 7;
    process.env[MANA_REGEN_ENV] = String(configured);

    for (const difficulty of [MIN_WORLD_DIFFICULTY, DEFAULT_WORLD_DIFFICULTY, MAX_WORLD_DIFFICULTY]) {
      const harness = boot(difficulty);
      expect(manaRegenPerSecond()).toBe(configured);
      expect(pushedRegen(harness)).toBe(configured);
    }

    process.env[MANA_REGEN_ENV] = String(MANA_REGEN_AT_DIFFICULTY_1 * 2);
    boot(MAX_WORLD_DIFFICULTY);
    expect(manaRegenPerSecond()).toBe(MANA_REGEN_AT_DIFFICULTY_1 * 2);
  });

  it('still clamps an explicit rate, whatever the difficulty', () => {
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
      { balance: 1, capacity: 810, regenPerSecond: 20 },
      { balance: 1, capacity: 810, manaPerBandCell: 0, regenPerSecond: 20 },
      { balance: 1, capacity: 810, manaPerBandCell: -6, regenPerSecond: 20 },
      { balance: 1, capacity: 810, manaPerBandCell: Number.NaN, regenPerSecond: 20 },
      { balance: 1, capacity: 810, manaPerBandCell: '6', regenPerSecond: 20 },
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
    expect(parseManaDeniedPayload({ balance: 3, cost: 270 })).toEqual({ balance: 3, cost: 270 });
    for (const bad of [null, {}, { balance: 3 }, { cost: 25 }, { balance: 3, cost: 'x' }]) {
      expect(parseManaDeniedPayload(bad)).toBeNull();
    }
  });
});

describe('balance pushes name the last intent seq they account for (2026-09-05)', () => {
  it('stamps asOfSeq on the push that follows an applied intent, and on a denial', () => {
    const harness = boot();
    harness.sink.clear();
    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { ...POINT_INTENT, dir: helperDir(), seq: 7 },
    );
    const pushes = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes[pushes.length - 1].payload).toMatchObject({ asOfSeq: 7 });

    while (sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied) {
    }
    harness.sink.clear();
    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { ...POINT_INTENT, dir: helperDir(), seq: 900 },
    );
    expect(harness.sink.ofType(`mana:${MANA_DENIED_MESSAGE}`)[0].payload).toMatchObject({ asOfSeq: 900 });
  });
});

describe('client local intent gate', () => {
  it('allows with no pool state, debits the intent, denies when broke', async () => {
    const { gateLocalSculpt, setManaPool, manaPool, deniedCount } = await import(
      '../client/state.ts'
    );

    setManaPool(null);
    expect(gateLocalSculpt(POINT_INTENT, ALL_REVEALED)).toBe(true);

    setManaPool({
      balance: GATE_FIXTURE_BALANCE,
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
    expect(gateLocalSculpt(POINT_INTENT, ALL_REVEALED)).toBe(true);
    expect(manaPool()?.balance).toBe(GATE_FIXTURE_BALANCE - POINT_COST);

    const denialsBefore = deniedCount();
    const bigStamp: SculptIntent = {
      ...POINT_INTENT,
      radius: MAX_BRUSH_RADIUS,
      profile: 'hard',
    };
    expect(gateLocalSculpt(bigStamp, ALL_REVEALED)).toBe(false);
    expect(deniedCount()).toBe(denialsBefore + 1);
    expect(manaPool()?.balance).toBe(GATE_FIXTURE_BALANCE - POINT_COST);

    expect(gateLocalSculpt(POINT_INTENT, ALL_REVEALED)).toBe(true);
    expect(manaPool()?.balance).toBe(GATE_FIXTURE_BALANCE - 2 * POINT_COST);
  });

  it('a balance push keeps the debits for intents the server has not yet accounted for', async () => {
    const { gateLocalSculpt, setManaPool, manaPool, applyBalancePush, applyDenial, clearInFlightDebits } =
      await import('../client/state.ts');
    clearInFlightDebits();
    const rate = {
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    };
    setManaPool({ balance: GATE_FIXTURE_BALANCE, ...rate });
    expect(gateLocalSculpt({ ...POINT_INTENT, seq: 1 }, ALL_REVEALED)).toBe(true);
    expect(gateLocalSculpt({ ...POINT_INTENT, seq: 2 }, ALL_REVEALED)).toBe(true);

    applyBalancePush({ balance: GATE_FIXTURE_BALANCE - POINT_COST, asOfSeq: 1, ...rate });
    expect(manaPool()?.balance).toBe(GATE_FIXTURE_BALANCE - 2 * POINT_COST);

    applyBalancePush({ balance: GATE_FIXTURE_BALANCE - 2 * POINT_COST, asOfSeq: 2, ...rate });
    expect(manaPool()?.balance).toBe(GATE_FIXTURE_BALANCE - 2 * POINT_COST);

    expect(gateLocalSculpt({ ...POINT_INTENT, seq: 3 }, ALL_REVEALED)).toBe(true);
    expect(gateLocalSculpt({ ...POINT_INTENT, seq: 4 }, ALL_REVEALED)).toBe(true);
    applyDenial({ balance: GATE_FIXTURE_BALANCE - 2 * POINT_COST, cost: POINT_COST, asOfSeq: 3 });
    expect(manaPool()?.balance).toBe(GATE_FIXTURE_BALANCE - 3 * POINT_COST);
  });

  it('credits itself no regen between pushes — the gate is a LOWER BOUND', async () => {
    const { gateLocalSculpt, setManaPool, manaPool, liveBalance, clearInFlightDebits } =
      await import('../client/state.ts');
    clearInFlightDebits();

    const rate = {
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    };
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    setManaPool({ balance: POINT_COST - 1, ...rate });

    const A_MINUTE_MS = 60_000;
    now.mockReturnValue(A_MINUTE_MS);

    expect(liveBalance(manaPool()!)).toBeGreaterThan(POINT_COST);
    expect(gateLocalSculpt(POINT_INTENT, ALL_REVEALED)).toBe(false);

    now.mockRestore();
  });

  it('a local debit does not rewind the gauge’s regen clock', async () => {
    const { gateLocalSculpt, setManaPool, manaPool, liveBalance, clearInFlightDebits } =
      await import('../client/state.ts');
    clearInFlightDebits();

    const HALF_A_POOL = MANA_CAPACITY / 2;
    const HALF_SECOND_MS = 500;
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    setManaPool({
      balance: HALF_A_POOL,
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });

    now.mockReturnValue(HALF_SECOND_MS);
    const shownBeforePress = liveBalance(manaPool()!);
    expect(shownBeforePress).toBeGreaterThan(HALF_A_POOL);

    expect(gateLocalSculpt(POINT_INTENT, ALL_REVEALED)).toBe(true);
    expect(liveBalance(manaPool()!)).toBeCloseTo(shownBeforePress - POINT_COST);

    now.mockRestore();
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
    while (gateLocalSculpt(POINT_INTENT, ALL_REVEALED)) points++;
    expect(points).toBe(POINT_STAMPS_PER_POOL);

    setManaPool(fullPool);
    const bigStamp: SculptIntent = {
      ...POINT_INTENT,
      radius: MAX_BRUSH_RADIUS,
      profile: 'hard',
    };
    let plateaus = 0;
    while (gateLocalSculpt(bigStamp, ALL_REVEALED)) plateaus++;
    expect(plateaus).toBe(FULL_POOL_MAX_RADIUS_HARD_STAMPS);
    expect(manaPool()?.balance).toBeLessThan(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT);
  });
});

describe('the price of a sculpt', () => {
  it('pins the tuning constants and the constraints they were derived from', () => {
    expect(MANA_PER_BAND_WORLD_UNIT_SQUARED).toBe(6);
    expect(MANA_PER_BAND_CELL).toBe(
      MANA_PER_BAND_WORLD_UNIT_SQUARED / (WORLD_UNIT_CELLS * WORLD_UNIT_CELLS),
    );
    expect(MANA_COST_PER_MIN_RADIUS_SCULPT).toBe(14);

    expect(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT).toBe(281);
    expect(MANA_CAPACITY).toBe(5000);
    expect(FULL_POOL_MAX_RADIUS_HARD_STAMPS).toBe(17);
    expect(FULL_POOL_MAX_RADIUS_HARD_STAMPS).toBe(
      Math.floor(MANA_CAPACITY / MANA_COST_PER_MAX_RADIUS_HARD_SCULPT),
    );
    expect(POINT_STAMPS_PER_POOL).toBe(357);

    const softPlateau = sculptManaCost(MANA_PER_BAND_CELL, MAX_BRUSH_RADIUS, 'soft', 'stamp');
    expect(softPlateau).toBeGreaterThan(MANA_COST_PER_MIN_RADIUS_SCULPT);
    expect(softPlateau).toBe(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT);

    expect(MIN_MANA_REGEN_PER_SECOND).toBe(MANA_COST_PER_MIN_RADIUS_SCULPT / MAX_DRAINED_WAIT_S);
    expect(MAX_MANA_REGEN_PER_SECOND).toBe(MANA_CAPACITY);
  });

  it('is the displaced volume at the payer’s rate, for every brush', () => {
    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      for (const profile of SCULPT_PROFILES) {
        const intent: SculptIntent = { ...POINT_INTENT, radius, profile };
        const expected = Math.ceil(
          (MANA_PER_BAND_CELL * sculptDisplacementUnits(radius, profile, 'stamp')) / BAND_HEIGHT,
        );
        expect(manaCostFor(PLAYER.id, intent)).toBe(expected);
      }
    }
  });

  it('resolves an intent’s ABSENT profile through the shared normalisation', () => {
    const bare: SculptIntent = { type: 'sculpt', x: 1, y: 1, radius: 3, dir: 1 };
    expect(manaCostFor(PLAYER.id, bare)).toBe(
      sculptManaCost(MANA_PER_BAND_CELL, 3, sculptOptionsOf(bare).profile, sculptOptionsOf(bare).tool),
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

  it('charges the widest hard stamp far more than a point stamp', () => {
    expect(sculptWith(POINT_BRUSH_RADIUS_CELLS, 'soft').applied).toBe(true);
    const pointFee = MANA_CAPACITY - (manaBalanceOf(PLAYER.id) ?? 0);

    const before = manaBalanceOf(PLAYER.id) ?? 0;
    expect(sculptWith(MAX_BRUSH_RADIUS, 'hard').applied).toBe(true);
    const plateauFee = before - (manaBalanceOf(PLAYER.id) ?? 0);

    expect(pointFee).toBe(MANA_COST_PER_MIN_RADIUS_SCULPT);
    expect(plateauFee).toBe(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT);
  });

  it('denies at the threshold of THE INTENT’S cost, not a flat one', () => {
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
    const refusals = harness.sink.ofType(`mana:${MANA_DENIED_MESSAGE}`);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].payload).toEqual({
      balance: stranded,
      cost: MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
    });
    expect(manaBalanceOf(PLAYER.id)).toBe(stranded);
    expect(sculptWith(MIN_BRUSH_RADIUS, 'soft').applied).toBe(true);
  });

  it('affords exactly the pool the tuning constraint promises', () => {
    let plateaus = 0;
    while (sculptWith(MAX_BRUSH_RADIUS, 'hard').applied) plateaus++;
    expect(plateaus).toBe(FULL_POOL_MAX_RADIUS_HARD_STAMPS);
  });
});

describe('charge follows effect — a stroke that changes nothing costs nothing', () => {
  function bootAtWorldFloor(): Harness {
    resetManaState();
    const world = worldWithUnlockedChunks(WORLD_SIZE, EVERY_CHUNK, SUITE_DIFFICULTY, MIN_HEIGHT);
    const sink = new RecordingSink();
    world.setSink(sink);
    const host = new PluginHost(world, [manaPlugin, revealPlugin].map(asLoadedPlugin));
    host.worldCreate();
    world.addPlayer(PLAYER);
    seedTerritory(world);
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
        expect(outcome.applied).toBe(true);
        if (outcome.applied) expect(outcome.diff).toEqual([]);
        expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);

        const pushes = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
        expect(pushes.length).toBeGreaterThan(0);
        const last = pushes[pushes.length - 1].payload as { balance: number };
        expect(last.balance).toBe(MANA_CAPACITY);
      }
    }
  });

  it('a stroke that moves even one cell still costs the full nominal price', () => {
    const harness = bootAtWorldFloor();
    const outcome = handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      {
        type: 'sculpt',
        x: INTERIOR_CELL.x,
        y: INTERIOR_CELL.y,
        radius: POINT_BRUSH_RADIUS_CELLS,
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

describe('issue #19 — a later interceptor’s deny costs zero mana', () => {
  const laterDenier: TerracePlugin = {
    name: 'zzz-later-denier',
    onIntent(): IntentVerdict {
      return { kind: 'deny', reason: 'vetoed by a later plugin' };
    },
  };

  function bootWithLaterPlugin(laterPlugin: TerracePlugin): Harness {
    resetManaState();
    const world = worldWithUnlockedChunks(WORLD_SIZE, EVERY_CHUNK, SUITE_DIFFICULTY);
    const sink = new RecordingSink();
    world.setSink(sink);

    const host = new PluginHost(world, [manaPlugin, laterPlugin].map(asLoadedPlugin));
    host.worldCreate();
    world.addPlayer(PLAYER);
    seedTerritory(world);
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
    const denyHarness = bootWithLaterPlugin(laterDenier);
    expect(sculptAt(denyHarness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(false);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);

    const allowHarness = bootWithLaterPlugin({ name: 'zzz-later-allower', onIntent: () => ALLOW });
    expect(sculptAt(allowHarness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(true);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY - POINT_COST);
  });

  it('a later interceptor’s deny still pushes the authoritative balance to the sender (phantom-debit fix, 2026-08-19)', () => {
    const harness = bootWithLaterPlugin(laterDenier);
    expect(manaBalanceOf(PLAYER.id)).toBe(MANA_CAPACITY);
    harness.sink.clear();

    expect(sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y).applied).toBe(false);

    expect(harness.sink.ofType('mana:denied')).toHaveLength(0);
    const pushes = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].target).toBe(PLAYER.id);
    expect(pushes[0].payload).toMatchObject({ balance: MANA_CAPACITY });

    harness.sink.clear();
    for (let n = 0; n < TICKS_PER_HEARTBEAT; n++) harness.host.tick(TICK_DT);
    const beats = harness.sink.ofType(`mana:${MANA_BALANCE_MESSAGE}`);
    expect(beats).toHaveLength(1);
    expect(beats[0].payload).toMatchObject({ balance: MANA_CAPACITY });
  });
});

describe('gate / server parity — the same intent, the same fee', () => {
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

          const serverBefore = manaBalanceOf(PLAYER.id) ?? 0;
          const outcome = handleSculptIntent(
            { world: harness.world, interceptors: harness.host },
            PLAYER,
            intent,
          );
          expect(outcome.applied).toBe(true);
          const serverFee = serverBefore - (manaBalanceOf(PLAYER.id) ?? 0);

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
          expect(gateLocalSculpt(intent, ALL_REVEALED)).toBe(true);
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

    while ((manaBalanceOf(PLAYER.id) ?? 0) >= MANA_COST_PER_MAX_RADIUS_HARD_SCULPT) {
      sculptAt(harness, INTERIOR_CELL.x, INTERIOR_CELL.y);
    }
    const stranded = manaBalanceOf(PLAYER.id) ?? 0;

    setManaPool({
      balance: stranded,
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
    expect(gateLocalSculpt(plateau, ALL_REVEALED)).toBe(false);
    expect(
      handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        plateau,
      ).applied,
    ).toBe(false);

    setManaPool({
      balance: MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
      capacity: MANA_CAPACITY,
      manaPerBandCell: MANA_PER_BAND_CELL,
      regenPerSecond: SUITE_REGEN_PER_SECOND,
    });
    expect(gateLocalSculpt(plateau, ALL_REVEALED)).toBe(true);
  });
});
