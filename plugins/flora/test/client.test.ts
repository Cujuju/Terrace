import { MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, worldUnitsAcross } from '@terrace/shared';
import type { InstancedMesh } from 'three';
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
  treeKindAt,
  treeVariation,
  type TreeCell,
} from '../protocol.ts';
import { placementsFor } from '../client/placement.ts';
import { createFloraModels, type TreePlacement } from '../client/models.ts';

const TWO_PI = Math.PI * 2;

function cells(...pairs: Array<readonly [number, number]>): TreeCell[] {
  return pairs.map(([x, y]) => ({ x, y }));
}

describe('cell keys', () => {
  it('round-trips every corner of the largest world, and tells transposed cells apart', () => {
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511],
      [1, 65535],
    ] as const) {
      expect(treeCellOf(treeKey(x, y))).toEqual({ x, y });
    }

    expect(treeKey(3, 7)).not.toBe(treeKey(7, 3));
  });
});

describe('the wire format', () => {
  it('round-trips a tree list through the flat pair encoding', () => {
    const trees = cells([0, 0], [5, 9], [511, 320]);
    expect(packTreeCells(trees)).toEqual([0, 0, 5, 9, 511, 320]);
    expect(parseTreeCells(packTreeCells(trees))).toEqual(trees);
  });

  it('drops malformed pairs individually, and a payload that is not a list at all entirely', () => {
    const parsed = parseTreeCells([1, 2, -1, 4, 5, 1.5, 'x', 7, 8, 9, 70000, 1, 11]);
    expect(parsed).toEqual(cells([1, 2], [8, 9]));

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
  it('is a pure function of the cell, so every client draws the same tree — but not the same tree across a diagonal', () => {
    for (const [x, y] of [
      [0, 0],
      [17, 4],
      [511, 300],
    ] as const) {
      expect(treeVariation(x, y)).toEqual(treeVariation(x, y));
      expect(hashCell(x, y)).toBe(hashCell(x, y));
    }

    expect(hashCell(3, 7)).not.toBe(hashCell(7, 3));
  });

  it('stays inside its declared ranges, and mixes the two silhouettes at roughly the declared share', () => {
    const edge = 128;
    let conifers = 0;
    for (let x = 0; x < edge; x++) {
      for (let y = 0; y < edge; y++) {
        const variation = treeVariation(x, y);
        expect(FLORA_TREE_KINDS).toContain(variation.kind);
        expect(variation.scale).toBeGreaterThanOrEqual(FLORA_TREE_SCALE_MIN);
        expect(variation.scale).toBeLessThanOrEqual(FLORA_TREE_SCALE_MAX);
        expect(variation.yaw).toBeGreaterThanOrEqual(0);
        expect(variation.yaw).toBeLessThan(TWO_PI);
        if (variation.kind === 'conifer') conifers++;
      }
    }
    const share = conifers / (edge * edge);
    const declared = FLORA_CONIFER_SHARE_OF_256 / 256;
    expect(Math.abs(share - declared)).toBeLessThan(0.05);
  });
});

describe('placement', () => {
  const groundOf = new Map<string, number>([
    ['3,4', 5],
    ['9,9', -2],
    ['7,7', 8],
  ]);
  const groundAt = (x: number, y: number): number | null => groundOf.get(`${x},${y}`) ?? null;

  it('puts a tree on the rendered surface at its own cell, holds back one whose ground has not arrived, and never invents a floor', () => {
    const { placements, pendingCells } = placementsFor(
      cells([3, 4], [9, 9], [7, 7], [50, 50], [60, 1]),
      groundAt,
    );
    expect(pendingCells).toEqual([treeKey(50, 50), treeKey(60, 1)]);
    expect(placements).toHaveLength(3);

    const heightOf = (groundY: number): number =>
      (groundY * MAX_HEIGHT) / MAX_RELIEF_WORLD_UNITS;
    const variation = treeVariation(3, 4);
    expect(treeKindAt(3, 4, heightOf(5))).toBe(variation.kind);
    expect(placements[0]).toEqual({
      x: worldUnitsAcross(3),
      z: worldUnitsAcross(4),
      cellX: 3,
      cellY: 4,
      groundY: 5,
      kind: variation.kind,
      scale: variation.scale,
      yaw: variation.yaw,
    });

    expect(placements[1].groundY).toBe(-2);
    expect(placements[2]?.kind).toBe('pine');
    expect(placements[2]?.groundY).toBe(8);
  });
});

describe('flora models contract', () => {
  it('renders every protocol tree kind: one placement per kind assigns every mesh count and never throws', () => {
    const models = createFloraModels();
    try {
      const placements: TreePlacement[] = FLORA_TREE_KINDS.map((kind, index) => ({
        x: index,
        z: 0,
        cellX: index,
        cellY: 0,
        groundY: 0,
        kind,
        scale: 1,
        yaw: 0,
      }));
      expect(() => models.apply(placements)).not.toThrow();

      const counts = new Map<string, number>();
      for (const child of models.root.children) {
        counts.set(child.name, (child as InstancedMesh).count);
      }
      expect(counts.get('flora:trunks')).toBe(FLORA_TREE_KINDS.length);
      expect(counts.get('flora:conifers')).toBe(1);
      expect(counts.get('flora:pines')).toBe(1);
      expect(counts.get('flora:broadleaves')).toBe(1);
    } finally {
      models.dispose();
    }
  });
});
