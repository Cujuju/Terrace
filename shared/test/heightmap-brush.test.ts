import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applySculpt,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  heightAt,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MIN_HEIGHT,
  quantizeToBand,
} from '../src/index.ts';
import {
  footprintOf,
  texturedMap,
} from './support/heightmapFixtures.ts';

describe('applyBrush', () => {
  it('radius 1 is the point brush: exactly one cell, full amount', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    applyBrush(map, 16, 16, 1, 64, changed);
    expect(changed.size).toBe(1);
    expect(heightAt(map, 16, 16)).toBe(64);
  });

  it('radius 2 applies linear falloff (full center, half at distance 1)', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    applyBrush(map, 16, 16, 2, 64, changed);
    expect(heightAt(map, 16, 16)).toBe(64);
    expect(heightAt(map, 17, 16)).toBe(32);
    expect(heightAt(map, 16, 15)).toBe(32);
    expect(heightAt(map, 17, 17)).toBe(0);
    expect(heightAt(map, 18, 16)).toBe(0);
  });

  it('lowering mirrors raising exactly', () => {
    const up = createHeightmap(32);
    const down = createHeightmap(32);
    applyBrush(up, 16, 16, 3, 64, new Set());
    applyBrush(down, 16, 16, 3, -64, new Set());
    for (let i = 0; i < up.cells.length; i++) {
      expect(down.cells[i]).toBe(-up.cells[i] | 0);
    }
  });

  it('clamps to MAX_HEIGHT', () => {
    const map = createHeightmap(16);
    const changed = new Set<number>();
    map.cells[8 * 16 + 8] = MAX_HEIGHT - 10;
    applyBrush(map, 8, 8, 1, 64, changed);
    expect(heightAt(map, 8, 8)).toBe(MAX_HEIGHT);
  });

  it('overhangs the map edge without throwing; off-map cells are skipped', () => {
    const map = createHeightmap(16);
    const changed = new Set<number>();
    applyBrush(map, 0, 0, 4, 64, changed);
    expect(heightAt(map, 0, 0)).toBe(64);
    expect(changed.size).toBeGreaterThan(0);
  });

  it('rejects out-of-bounds centers and invalid radii', () => {
    const map = createHeightmap(16);
    expect(() => applyBrush(map, -1, 0, 1, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, 0, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, MAX_BRUSH_RADIUS + 1, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, 2, 1.5, new Set())).toThrow(RangeError);
  });
});

describe('applySculpt — the stamp tool', () => {
  it('changes ONLY its footprint; every other cell is bit-identical', () => {
    const map = texturedMap(48);
    const before = map.cells.slice();
    const footprint = footprintOf(48, 24, 24, 3);

    applySculpt(map, 24, 24, 3, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });

    for (let i = 0; i < map.cells.length; i++) {
      if (footprint.has(i)) continue;
      expect(map.cells[i]).toBe(before[i]);
    }
    for (const i of footprint) expect(map.cells[i]).toBeGreaterThan(before[i]);
  });

  it('reports a diff confined to the footprint', () => {
    const map = texturedMap(48);
    const footprint = footprintOf(48, 24, 24, 4);
    const diff = applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp' });
    expect(diff.length).toBe(footprint.size);
    for (const c of diff) expect(footprint.has(c.y * 48 + c.x)).toBe(true);
  });

  it('stacks into a true vertical spire: N radius-1 stamps = N × amount', () => {
    const map = createHeightmap(32);
    const stacks = 5;
    for (let k = 0; k < stacks; k++) {
      applySculpt(map, 16, 16, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    }
    expect(heightAt(map, 16, 16)).toBe(stacks * DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 15, 16)).toBe(0);
    expect(heightAt(map, 17, 16)).toBe(0);
    expect(heightAt(map, 16, 15)).toBe(0);
    expect(heightAt(map, 16, 17)).toBe(0);
    expect(heightAt(map, 15, 15)).toBe(0);
  });

  it('digs a sheer pit when lowering', () => {
    const map = createHeightmap(32);
    for (let k = 0; k < 3; k++) {
      applySculpt(map, 16, 16, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'stamp' });
    }
    expect(heightAt(map, 16, 16)).toBe(-3 * DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 17, 16)).toBe(0);
  });

  it('still clamps to the height range', () => {
    const high = createHeightmap(16);
    high.cells.fill(MAX_HEIGHT - 1);
    applySculpt(high, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(heightAt(high, 8, 8)).toBe(MAX_HEIGHT);

    const low = createHeightmap(16);
    low.cells.fill(MIN_HEIGHT);
    applySculpt(low, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(heightAt(low, 8, 8)).toBe(MIN_HEIGHT);
    expect(quantizeToBand(heightAt(low, 8, 8))).toBe(MIN_HEIGHT);
  });
});
