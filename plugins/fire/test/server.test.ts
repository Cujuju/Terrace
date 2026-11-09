import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, cellCentre, nearestWithinReach } from '@terrace/shared';
import type { Player, WorldApi } from '../../../server/src/plugins/types.ts';
import { Blaze } from '../server/blaze.ts';
import { EntityBlaze } from '../server/entityBlaze.ts';
import { clearEntityFuelRegistry, registerEntityFuel, type EntityFuelSource } from '../server/entityFuel.ts';
import { clearFuelRegistry, registerFuel } from '../server/fuel.ts';
import { plugin, resetFireState, burningCells, extinguishAt, IGNITE_MANA_COST } from '../server/index.ts';
import { setFireRandomSource } from '../server/rng.ts';
import { spreadOnce } from '../server/spread.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const SOURCE = 'fuel';
const BURN_SECONDS = 22;
const TICK_SECONDS = 1;
const CATCH_EXPOSURE_SECONDS = 6;
const player: Player = { id: 'player', token: 'token', name: 'Player' };
const persistence = plugin.persistence!;

function harness() {
  const events: Array<{ type: string; payload: unknown }> = [];
  let charged = 0;
  const api = {
    worldSize: WORLD_SIZE,
    heightAt: () => 32,
    players: () => [player],
    isCellVisibleTo: (_id: string, x: number, y: number) =>
      x >= 0 && y >= 0 && x < CHUNK_SIZE && y < CHUNK_SIZE,
    broadcastVisible: () => {},
    emitEvent: (type: string, payload: unknown) => events.push({ type, payload }),
    sibling: (name: string) => name === 'weather'
      ? { currentWind: () => ({ heading: 0, speed: 0 }), precipitationAt: () => 0 }
      : name === 'mana'
        ? { spendMana: (_world: WorldApi, _id: string, amount: number) => { charged += amount; return true; } }
        : null,
  } as unknown as WorldApi;
  return { api, events, charged: () => charged };
}

function fire(x: number, y = 10, ageSeconds = 2, burnSeconds = BURN_SECONDS) {
  return { x, y, ageSeconds, burnSeconds, fuelHeight: 1, sourceName: SOURCE };
}

function start(api: WorldApi, fires: ReturnType<typeof fire>[] = [], entities: unknown[] = []): void {
  persistence.load({ fires, entities }, 1);
  plugin.onWorldCreate!(api);
}

function fuel(xs: readonly number[] = [10, 11], y = 10): void {
  registerFuel({ name: SOURCE, fuelAt: (x, cy) => xs.includes(x) && cy === y
    ? { height: 1, burnSeconds: BURN_SECONDS } : null, onBurnedOut: () => {} });
}

function entities(at: Array<{ id: number; x: number; y: number }>, ignorePredicate = false) {
  let queries = 0;
  const source: EntityFuelSource = {
    name: 'movers', idsSurviveRestore: true,
    entityAt: (x, y, accepts) => {
      queries++;
      const candidates = ignorePredicate ? at : at.filter((p) => accepts?.(p.id) !== false);
      const found = nearestWithinReach(candidates, x, y, 2, (p) => p);
      return found === null ? null : {
        id: found.item.id, fuel: { burnSeconds: 8 }, distanceCells: found.distanceCells,
      };
    },
    positionOf: (id) => at.find((p) => p.id === id) ?? null,
    onBurnedOut: () => {},
    flammable: function* () {
      for (const p of at) yield { ...p, sourceName: 'movers', radiusCells: 0, fuel: { burnSeconds: 8 } };
    },
  };
  registerEntityFuel(source);
  return { source, queries: () => queries };
}

beforeEach(() => {
  resetFireState();
  clearFuelRegistry();
  clearEntityFuelRegistry();
  setFireRandomSource(() => 0.5);
});

afterEach(() => {
  plugin.onWorldClose!(harness().api);
  setFireRandomSource(null);
});

describe('manual entity ignition', () => {
  it('rejects a hidden target from an older adapter before charging', () => {
    const h = harness();
    start(h.api);
    entities([{ id: 1, x: CHUNK_SIZE + 0.25, y: 4 }], true);
    plugin.messages!.ignite!(h.api, player, { x: CHUNK_SIZE - 1, y: 4 });
    expect(h.charged()).toBe(0);
    expect(persistence.save()).toMatchObject({ entities: [] });
  });

  it('selects an eligible visible target once and commits that identity', () => {
    const h = harness();
    start(h.api);
    const source = entities([
      { id: 1, x: CHUNK_SIZE + 0.05, y: 4 },
      { id: 2, x: CHUNK_SIZE - 2.5, y: 4 },
    ]);
    plugin.messages!.ignite!(h.api, player, { x: CHUNK_SIZE - 1, y: 4 });
    expect(h.charged()).toBe(IGNITE_MANA_COST);
    expect(source.queries()).toBe(1);
    expect(persistence.save()).toMatchObject({ entities: [{ id: 2 }] });
  });

  it('unmasks the next candidate within the same source', () => {
    entities([{ id: 1, x: 12, y: 12 }, { id: 2, x: 13.5, y: 12 }]);
    const blaze = new EntityBlaze();
    expect(blaze.igniteAtCell(12, 12)?.id).toBe(1);
    expect(blaze.igniteAtCell(12, 12)?.id).toBe(2);
    expect(blaze.igniteAtCell(12, 12)).toBeNull();
  });
});

describe('one coordinate frame for spread', () => {
  it('spreads equally from a cell to creatures in either adjacent cell', () => {
    const h = harness();
    start(h.api);
    entities([{ id: 1, ...cellCentre({ x: 11, y: 10 }) }, { id: 2, ...cellCentre({ x: 9, y: 10 }) }]);
    const cells = new Blaze();
    cells.restore([fire(10)]);
    const movers = new EntityBlaze();
    spreadOnce(h.api, cells, movers, CATCH_EXPOSURE_SECONDS);
    expect(movers.isBurning('movers', 1)).toBe(true);
    expect(movers.isBurning('movers', 2)).toBe(true);
  });

  it('spreads equally from a centered mover to adjacent cell fuel', () => {
    const h = harness();
    start(h.api);
    fuel([9, 11]);
    entities([{ id: 1, ...cellCentre({ x: 10, y: 10 }) }]);
    const cells = new Blaze();
    const movers = new EntityBlaze();
    movers.restore([{ sourceName: 'movers', id: 1, ageSeconds: 2, burnSeconds: 8 }]);
    spreadOnce(h.api, cells, movers, CATCH_EXPOSURE_SECONDS);
    expect(cells.isBurning(9, 10)).toBe(true);
    expect(cells.isBurning(11, 10)).toBe(true);
  });

  it('samples the containing terrain cell for fractional rim positions', () => {
    const h = harness();
    start(h.api);
    entities([{ id: 1, x: WORLD_SIZE - 0.25, y: WORLD_SIZE - 0.25 }]);
    h.api.heightAt = (x, y) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(WORLD_SIZE);
      expect(y).toBeLessThan(WORLD_SIZE);
      return 32;
    };
    const movers = new EntityBlaze();
    movers.restore([{ sourceName: 'movers', id: 1, ageSeconds: 2, burnSeconds: 8 }]);
    expect(() => spreadOnce(h.api, new Blaze(), movers, TICK_SECONDS)).not.toThrow();
  });
});

describe('world replacement and wildfire accounting', () => {
  it.each([false, true])('discards spread heat on restore (close=%s)', (close) => {
    const h = harness();
    start(h.api, [fire(10)]);
    fuel();
    for (let step = 0; step < 4; step++) plugin.onTick!(h.api, TICK_SECONDS);
    expect(burningCells().some((p) => p.x === 11)).toBe(false);
    if (close) plugin.onWorldClose!(h.api);
    start(h.api, [fire(10)]);
    fuel();
    plugin.onTick!(h.api, TICK_SECONDS);
    expect(burningCells().some((p) => p.x === 11)).toBe(false);
  });

  it('persists all eight consumed cells across a restart and emits once', () => {
    const h = harness();
    const prior = Array.from({ length: 7 }, (_, i) => fire(2 * (i + 1), 4, 0.9, 1));
    start(h.api, [...prior, fire(20, 4)]);
    fuel([], 4);
    plugin.onTick!(h.api, 0.2);
    const saved = persistence.save();
    expect(saved).toMatchObject({ episode: { consumed: 7, origin: { x: 2, y: 4 } } });
    plugin.onWorldClose!(h.api);
    persistence.load(saved, persistence.version);
    plugin.onWorldCreate!(h.api);
    fuel([], 4);
    plugin.onTick!(h.api, BURN_SECONDS);
    plugin.onTick!(h.api, TICK_SECONDS);
    expect(h.events.filter((event) => event.type === 'burned')).toEqual([
      { type: 'burned', payload: { consumed: 8, x: 2, y: 4 } },
    ]);
  });

  it('loads legacy slices without carrying a later episode backward', () => {
    const h = harness();
    start(h.api, [fire(10, 10, 0.9, 1), fire(20)]);
    fuel([]);
    plugin.onTick!(h.api, 0.2);
    start(h.api, [fire(20)]);
    plugin.onTick!(h.api, BURN_SECONDS);
    expect(h.events.filter((event) => event.type === 'burned')).toEqual([
      { type: 'burned', payload: { consumed: 1, x: 20, y: 10 } },
    ]);
  });

  it.each([false, true])('waits for burning movers before closing an episode (extinguish=%s)', (extinguish) => {
    const h = harness();
    start(h.api, [fire(10, 10, 0.9, 1), ...(extinguish ? [fire(20)] : [])], [
      { sourceName: 'movers', id: 1, ageSeconds: 1, burnSeconds: 8 },
    ]);
    fuel([]);
    entities([{ id: 1, x: 30.5, y: 30.5 }]);
    plugin.onTick!(h.api, 0.2);
    if (extinguish) extinguishAt([{ x: 20, y: 10 }]);
    expect(h.events.filter((event) => event.type === 'burned')).toEqual([]);
    plugin.onTick!(h.api, 8);
    expect(h.events.filter((event) => event.type === 'burned')).toHaveLength(1);
  });
});
