// The client half's PURE logic: the wire format, the deterministic per-
// building variation, and vertical placement. No three import here, so this
// runs in the same node environment as the server tests (design §8 — no
// headless GL rig). Mirrors flora/test/client.test.ts's shape.

import { describe, expect, it } from 'vitest';
import {
  STRUCTURES_CAP,
  STRUCTURE_SCALE_MAX,
  STRUCTURE_SCALE_MIN,
  STRUCTURE_TIER_COUNT,
  cellOfKey,
  hashStructureCell,
  packCells,
  packStructureCells,
  parseAllPayload,
  parseCells,
  parseChangesPayload,
  parseStructureCells,
  structureKey,
  structureVariation,
  type StructureCell,
} from '../protocol.ts';
import { placementsFor } from '../client/placement.ts';

const TWO_PI = Math.PI * 2;

function cells(...triples: Array<readonly [number, number, number]>): StructureCell[] {
  return triples.map(([x, y, tier]) => ({ x, y, tier }));
}

describe('cell keys', () => {
  it('round-trips every corner of the largest world', () => {
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511],
    ] as const) {
      expect(cellOfKey(structureKey(x, y))).toEqual({ x, y });
    }
  });

  it('gives distinct keys to transposed cells', () => {
    expect(structureKey(3, 7)).not.toBe(structureKey(7, 3));
  });
});

describe('the wire format', () => {
  it('round-trips a structure list through the flat triple encoding', () => {
    const list = cells([0, 0, 0], [5, 9, 3], [511, 320, 5]);
    expect(packStructureCells(list)).toEqual([0, 0, 0, 5, 9, 3, 511, 320, 5]);
    expect(parseStructureCells(packStructureCells(list))).toEqual(list);
  });

  it('drops malformed triples individually and keeps the rest', () => {
    const parsed = parseStructureCells([
      1, 2, 0, // ok
      -1, 4, 0, // negative x
      5, 1.5, 0, // fractional y
      7, 8, 99, // out-of-range tier
      9, 9, 5, // ok
    ]);
    expect(parsed).toEqual(cells([1, 2, 0], [9, 9, 5]));
  });

  it('rejects a payload that is not a list at all', () => {
    expect(parseStructureCells(null)).toBeNull();
    expect(parseStructureCells('nope')).toBeNull();
    expect(parseAllPayload(null)).toBeNull();
    expect(parseAllPayload({})).toBeNull();
    expect(parseChangesPayload(7)).toBeNull();
  });

  it('never lets a payload exceed the cap the client allocated for', () => {
    const flat: number[] = [];
    for (let n = 0; n < STRUCTURES_CAP + 50; n++) flat.push(n % 512, Math.floor(n / 512), 0);
    expect(parseStructureCells(flat)).toHaveLength(STRUCTURES_CAP);
  });

  it('reads a delta, treating an absent field as empty', () => {
    expect(parseChangesPayload({ founded: [1, 2, 0], upgraded: [], demolished: [3, 4] })).toEqual({
      founded: cells([1, 2, 0]),
      upgraded: [],
      demolished: [{ x: 3, y: 4 }],
    });
    expect(parseChangesPayload({ demolished: [3, 4] })).toEqual({
      founded: [],
      upgraded: [],
      demolished: [{ x: 3, y: 4 }],
    });
  });

  it('round-trips bare cells (the demolished half)', () => {
    const bare = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    expect(parseCells(packCells(bare))).toEqual(bare);
  });
});

describe('per-building variation', () => {
  it('is a pure function of the cell, so every client draws the same building', () => {
    for (const [x, y] of [
      [0, 0],
      [17, 4],
      [511, 300],
    ] as const) {
      expect(structureVariation(x, y)).toEqual(structureVariation(x, y));
      expect(hashStructureCell(x, y)).toBe(hashStructureCell(x, y));
    }
  });

  it('does not repeat itself across a diagonal', () => {
    expect(hashStructureCell(3, 7)).not.toBe(hashStructureCell(7, 3));
  });

  it('stays inside its declared ranges', () => {
    for (let x = 0; x < 30; x++) {
      for (let y = 0; y < 30; y++) {
        const variation = structureVariation(x, y);
        expect(variation.scale).toBeGreaterThanOrEqual(STRUCTURE_SCALE_MIN);
        expect(variation.scale).toBeLessThanOrEqual(STRUCTURE_SCALE_MAX);
        expect(variation.yaw).toBeGreaterThanOrEqual(0);
        expect(variation.yaw).toBeLessThan(TWO_PI);
      }
    }
  });
});

describe('tier table', () => {
  it('has at least four and at most six tiers, as the brief asks for', () => {
    expect(STRUCTURE_TIER_COUNT).toBeGreaterThanOrEqual(4);
    expect(STRUCTURE_TIER_COUNT).toBeLessThanOrEqual(6);
  });
});

describe('placement', () => {
  const groundOf = new Map<string, number>([
    ['3,4', 5],
    ['9,9', -2],
  ]);
  const groundAt = (x: number, y: number): number | null => groundOf.get(`${x},${y}`) ?? null;

  it('puts a building on the rendered surface at its own cell, carrying its tier', () => {
    const { placements, pendingGround } = placementsFor(cells([3, 4, 2]), groundAt);
    expect(pendingGround).toBe(0);
    expect(placements).toHaveLength(1);

    const variation = structureVariation(3, 4);
    expect(placements[0]).toEqual({
      x: 3,
      z: 4,
      groundY: 5,
      tier: 2,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  });

  it('omits a building whose ground this client has not been sent', () => {
    const { placements, pendingGround } = placementsFor(
      cells([3, 4, 0], [50, 50, 0], [60, 1, 0]),
      groundAt,
    );
    expect(placements).toHaveLength(1);
    expect(pendingGround).toBe(2);
  });
});
