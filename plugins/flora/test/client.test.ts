// The client half's PURE logic: the wire format, the deterministic per-tree
// variation, and vertical placement. Rendering is verified by eye per design §8
// ("no headless GL rig"), so nothing here imports three — which is also what
// lets it run in the same node environment as the server tests.

import { worldUnitsAcross } from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import {
  FLORA_CONIFER_SHARE_OF_256,
  FLORA_TREE_CAP,
  FLORA_TREE_KINDS,
  FLORA_TREE_SCALE_MAX,
  FLORA_TREE_SCALE_MIN,
  hashCell,
  packTreeCells,
  parseChangesPayload,
  parseForestPayload,
  parseTreeCells,
  treeCellOf,
  treeKey,
  treeVariation,
  type TreeCell,
} from '../protocol.ts';
import { placementsFor } from '../client/placement.ts';

const TWO_PI = Math.PI * 2;

function cells(...pairs: Array<readonly [number, number]>): TreeCell[] {
  return pairs.map(([x, y]) => ({ x, y }));
}

describe('cell keys', () => {
  it('round-trips every corner of the largest world', () => {
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511],
      [1, 65535],
    ] as const) {
      expect(treeCellOf(treeKey(x, y))).toEqual({ x, y });
    }
  });

  it('gives distinct keys to transposed cells', () => {
    expect(treeKey(3, 7)).not.toBe(treeKey(7, 3));
  });
});

describe('the wire format', () => {
  it('round-trips a tree list through the flat pair encoding', () => {
    const trees = cells([0, 0], [5, 9], [511, 320]);
    expect(packTreeCells(trees)).toEqual([0, 0, 5, 9, 511, 320]);
    expect(parseTreeCells(packTreeCells(trees))).toEqual(trees);
  });

  it('drops malformed pairs individually and keeps the rest', () => {
    // Negative, fractional, non-numeric and out-of-range coordinates, plus a
    // trailing unpaired value.
    const parsed = parseTreeCells([1, 2, -1, 4, 5, 1.5, 'x', 7, 8, 9, 70000, 1, 11]);
    expect(parsed).toEqual(cells([1, 2], [8, 9]));
  });

  it('rejects a payload that is not a list at all', () => {
    expect(parseTreeCells(null)).toBeNull();
    expect(parseTreeCells('trees')).toBeNull();
    expect(parseForestPayload(null)).toBeNull();
    expect(parseForestPayload({})).toBeNull();
    expect(parseChangesPayload(7)).toBeNull();
  });

  it('never lets a payload exceed the cap the client allocated for', () => {
    const flat: number[] = [];
    for (let n = 0; n < FLORA_TREE_CAP + 50; n++) flat.push(n % 512, Math.floor(n / 512));
    expect(parseTreeCells(flat)).toHaveLength(FLORA_TREE_CAP);
  });

  it('reads a delta, treating an absent half as an empty one', () => {
    expect(parseChangesPayload({ grown: [1, 2], felled: [3, 4] })).toEqual({
      grown: cells([1, 2]),
      felled: cells([3, 4]),
    });
    expect(parseChangesPayload({ felled: [3, 4] })).toEqual({
      grown: [],
      felled: cells([3, 4]),
    });
  });
});

describe('per-tree variation', () => {
  it('is a pure function of the cell, so every client draws the same tree', () => {
    for (const [x, y] of [
      [0, 0],
      [17, 4],
      [511, 300],
    ] as const) {
      expect(treeVariation(x, y)).toEqual(treeVariation(x, y));
      expect(hashCell(x, y)).toBe(hashCell(x, y));
    }
  });

  it('does not repeat itself across a diagonal', () => {
    // Two multipliers rather than one is what buys this; with a single one,
    // (3, 7) and (7, 3) would hash alike and a diagonal of clones would appear.
    expect(hashCell(3, 7)).not.toBe(hashCell(7, 3));
  });

  it('stays inside its declared ranges', () => {
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 40; y++) {
        const variation = treeVariation(x, y);
        expect(FLORA_TREE_KINDS).toContain(variation.kind);
        expect(variation.scale).toBeGreaterThanOrEqual(FLORA_TREE_SCALE_MIN);
        expect(variation.scale).toBeLessThanOrEqual(FLORA_TREE_SCALE_MAX);
        expect(variation.yaw).toBeGreaterThanOrEqual(0);
        expect(variation.yaw).toBeLessThan(TWO_PI);
      }
    }
  });

  it('mixes the two silhouettes at roughly the declared share', () => {
    let conifers = 0;
    const total = 128 * 128;
    for (let x = 0; x < 128; x++) {
      for (let y = 0; y < 128; y++) {
        if (treeVariation(x, y).kind === 'conifer') conifers++;
      }
    }
    const share = conifers / total;
    const declared = FLORA_CONIFER_SHARE_OF_256 / 256;
    // Wide bounds on purpose: this asserts "a clear majority of firs with
    // broadleaves through it", which is the design intent, not a hash's exact
    // uniformity.
    expect(Math.abs(share - declared)).toBeLessThan(0.05);
  });
});

describe('placement', () => {
  const groundOf = new Map<string, number>([
    ['3,4', 5],
    ['9,9', -2],
  ]);
  const groundAt = (x: number, y: number): number | null => groundOf.get(`${x},${y}`) ?? null;

  it('puts a tree on the rendered surface at its own cell', () => {
    const { placements, pendingGround } = placementsFor(cells([3, 4]), groundAt);
    expect(pendingGround).toBe(0);
    expect(placements).toHaveLength(1);

    const variation = treeVariation(3, 4);
    expect(placements[0]).toEqual({
      // Cell coordinates scale to world X/Z by CELL_WORLD_SIZE (2026-08-21:
      // it was 1, and this assertion read as an identity).
      x: worldUnitsAcross(3),
      z: worldUnitsAcross(4),
      groundY: 5,
      kind: variation.kind,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  });

  it('omits a tree whose ground this client has not been sent', () => {
    const { placements, pendingGround } = placementsFor(cells([3, 4], [50, 50], [60, 1]), groundAt);
    expect(placements).toHaveLength(1);
    expect(pendingGround).toBe(2);
  });

  it('places a tree below sea level exactly where the terrain says', () => {
    // Not a case the server can produce (band 3 is 192 height units above the
    // waterline) — but the client must not invent a floor of its own, because
    // "the server said so" is the only rule it follows.
    const { placements } = placementsFor(cells([9, 9]), groundAt);
    expect(placements[0].groundY).toBe(-2);
  });
});
