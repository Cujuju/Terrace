import { describe, expect, it } from 'vitest';
import { applySculpt, BEDROCK_BAND, createHeightmap, setColumn } from '@terrace/shared';
import { createWorldApi, PLUGIN_SCULPT_OPTIONS } from '../src/plugins/world-api.ts';
import { worldWithTerrain } from './support/world.ts';

const SIZE = 64;

function fixture(locked: (cx: number, cy: number) => boolean = () => false) {
  const world = worldWithTerrain(SIZE, () => 0, locked);
  world.markSnapshotted();
  let notifications = 0;
  const { api } = createWorldApi(world, {
    notifyTerrainChanged() { notifications++; },
    notifyChunkUnlockedForToken() {}, notifyWorldEvent() {},
  }, 'transaction');
  return { world, api, notifications: () => notifications };
}

describe('atomic plugin sculpt', () => {
  it('refuses complete settle writes beyond a permitted brush disc without changing terrain or dirty state', () => {
    const { world, api, notifications } = fixture();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) world.map.cells[y * SIZE + x] = 800 - 4 * x;
    }
    const before = world.map.cells.slice();
    const reference = createHeightmap(SIZE);
    reference.cells.set(before);
    const computed = applySculpt(reference, 22, 32, 6, -16, PLUGIN_SCULPT_OPTIONS);
    const outside = computed.find((cell) => Math.abs(cell.x - 22) > 6 || Math.abs(cell.y - 32) > 6);
    expect(outside).toBeDefined();
    expect(api.sculpt(22, 32, 6, -16, (x, y) => x !== outside!.x || y !== outside!.y)).toEqual([]);
    expect(world.map.cells).toEqual(before);
    expect(world.dirty).toBe(false);
    expect(notifications()).toBe(0);
  });

  it('unconditionally refuses locked writes, including those outside the nominal radius', () => {
    const { world, api, notifications } = fixture((cx) => cx === 0);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) world.map.cells[y * SIZE + x] = 800 - 4 * x;
    }
    const before = world.map.cells.slice();
    expect(api.sculpt(22, 32, 6, -16, () => true)).toEqual([]);
    expect(world.map.cells).toEqual(before);
    expect(notifications()).toBe(0);
  });

  it('preserves exact layered columns and resynchronizes after player edits and rewind', () => {
    const { world, api, notifications } = fixture();
    const spans = [{ floorBand: BEDROCK_BAND, ceiling: 0 }, { floorBand: 3, ceiling: 80 }];
    setColumn(world.map, 32, 32, spans);
    const original = world.map.cells.slice();
    const reference = createHeightmap(SIZE);
    reference.cells.set(original);
    setColumn(reference, 32, 32, spans);
    const expected = applySculpt(reference, 32, 32, 2, 16, PLUGIN_SCULPT_OPTIONS);
    expect(api.sculpt(32, 32, 2, 16, () => false)).toEqual([]);
    expect(world.map.columnSpans).not.toEqual(reference.columnSpans);
    expect(api.sculpt(32, 32, 2, 16)).toEqual(expected);
    expect(world.map.columnSpans).toEqual(reference.columnSpans);
    world.applySculpt(12, 12, 2, 16, PLUGIN_SCULPT_OPTIONS);
    applySculpt(reference, 12, 12, 2, 16, PLUGIN_SCULPT_OPTIONS);
    expect(api.sculpt(12, 12, 2, -16)).toEqual(applySculpt(reference, 12, 12, 2, -16, PLUGIN_SCULPT_OPTIONS));
    expect(world.map.cells).toEqual(reference.cells);
    world.rewindTo(original, world.mask, new Map(), new Map([[32 * SIZE + 32, spans]]));
    expect(api.sculpt(32, 32, 2, 16)).toEqual(expected);
    expect(world.dirty).toBe(true);
    expect(notifications()).toBe(3);
  });

  it('commits a batch once, and rejects all earlier steps when a later step is forbidden', () => {
    const { world, api, notifications } = fixture();
    const steps = [
      { x: 16, y: 16, radius: 2, amount: 16 },
      { x: 48, y: 48, radius: 2, amount: 16 },
    ];
    expect(api.sculptBatch!(steps, (x) => x < 40)).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(world.map.cells.some((height) => height !== 0)).toBe(false);
    expect(world.dirty).toBe(false);
    expect(notifications()).toBe(0);
    const reference = createHeightmap(SIZE);
    for (const step of steps) applySculpt(reference, step.x, step.y, step.radius, step.amount, PLUGIN_SCULPT_OPTIONS);
    const result = api.sculptBatch!(steps);
    if (!result.ok) throw new Error('unconstrained batch was refused');
    expect(result.cells.length).toBeGreaterThan(0);
    expect(world.map.cells).toEqual(reference.cells);
    expect(notifications()).toBe(1);
  });

  it('discards scratch after a throwing predicate or invalid later step', () => {
    const { world, api, notifications } = fixture();
    expect(() => api.sculpt(16, 16, 2, 16, () => { throw new Error('permission failed'); })).toThrow('permission failed');
    expect(() => api.sculptBatch!([
      { x: 16, y: 16, radius: 2, amount: 16 },
      { x: 48, y: 48, radius: -1, amount: 16 },
    ])).toThrow();
    expect(world.map.cells.some((height) => height !== 0)).toBe(false);
    expect(notifications()).toBe(0);
    expect(api.sculpt(16, 16, 2, 16).length).toBeGreaterThan(0);
  });

  it('distinguishes accepted zero-effect batches and locked write refusals', () => {
    const { api } = fixture((cx) => cx === 0);
    expect(api.sculptBatch!([])).toEqual({ ok: true, cells: [] });
    expect(api.sculptBatch!([{ x: 32, y: 32, radius: 2, amount: 0 }])).toEqual({ ok: true, cells: [] });
    const result = api.sculptBatch!([{ x: 8, y: 8, radius: 2, amount: 16 }]);
    expect(result).toMatchObject({ ok: false, reason: 'locked' });
    if (result.ok) throw new Error('locked edit was accepted');
    expect(result.cell.x).toBeLessThan(16);
  });
});
