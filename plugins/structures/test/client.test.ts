// The client half's PURE logic: the wire format, the deterministic per-
// building variation, and vertical placement. No three import here, so this
// runs in the same node environment as the server tests (design §8 — no
// headless GL rig). Mirrors flora/test/client.test.ts's shape.

import { describe, expect, it } from 'vitest';
import {
  MAX_STRUCTURE_TIER,
  SETTLER_DISTRICT_CELLS,
  STRUCTURES_CAP,
  STRUCTURE_SCALE_MAX,
  STRUCTURE_SCALE_MIN,
  STRUCTURE_TIER_COUNT,
  cellOfKey,
  hashStructureCell,
  settlementRace,
  type SettlerRace,
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
import { DURANDS_SHARE_OF_256, isDurandsCell } from '../client/durands.ts';

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
      race: settlementRace(3, 4),
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

describe("Durand's variant selection", () => {
  it('is a pure function of tier and cell, so every client renders the same choice', () => {
    for (const [x, y] of [
      [0, 0],
      [17, 4],
      [511, 300],
    ] as const) {
      expect(isDurandsCell(MAX_STRUCTURE_TIER, x, y)).toBe(isDurandsCell(MAX_STRUCTURE_TIER, x, y));
    }
  });

  it('never fires below the top tier, whatever the cell', () => {
    // Sweep every tier below the top one, over a wide enough patch of cells
    // that if the tier gate were missing, some cell in this sweep would be
    // all but guaranteed to roll Durand's by chance (DURANDS_SHARE_OF_256 is
    // ~1 in 6, and this sweep covers 40 * 40 = 1600 cells per tier).
    for (let tier = 0; tier < MAX_STRUCTURE_TIER; tier++) {
      for (let x = 0; x < 40; x++) {
        for (let y = 0; y < 40; y++) {
          expect(isDurandsCell(tier, x, y)).toBe(false);
        }
      }
    }
  });

  it('only ever returns true at the top tier, and only for its declared share of cells', () => {
    let durandsCount = 0;
    let sampleCount = 0;
    for (let x = 0; x < 100; x++) {
      for (let y = 0; y < 100; y++) {
        sampleCount++;
        if (isDurandsCell(MAX_STRUCTURE_TIER, x, y)) durandsCount++;
      }
    }
    const expectedShare = DURANDS_SHARE_OF_256 / 256;
    // A tolerance band around the expected share, not an exact count: this is
    // a hash's distribution over a finite sample, not a controlled random
    // draw, so some variance around the mean is normal — the test asserts
    // the roll is landing near ~1-in-6, not landing on a to-the-cell count.
    expect(durandsCount / sampleCount).toBeGreaterThan(expectedShare - 0.05);
    expect(durandsCount / sampleCount).toBeLessThan(expectedShare + 0.05);
  });

  it('does not correlate with the yaw/scale roll structureVariation reads from the same hash', () => {
    // structureVariation spends bits 0-23; isDurandsCell reads bits 24-31.
    // This does not prove independence, but it does prove the two are not
    // reading the SAME bits, which would be the actual bug this guards
    // against (e.g. a copy-paste that reused structureVariation's mask).
    let sawDurandsWithMinScale = false;
    let sawDurandsWithMaxScale = false;
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 200; y++) {
        if (!isDurandsCell(MAX_STRUCTURE_TIER, x, y)) continue;
        const { scale } = structureVariation(x, y);
        if (scale < STRUCTURE_SCALE_MIN + (STRUCTURE_SCALE_MAX - STRUCTURE_SCALE_MIN) * 0.5) {
          sawDurandsWithMinScale = true;
        } else {
          sawDurandsWithMaxScale = true;
        }
      }
    }
    // Both halves of the scale range appear among Durand's cells — if the
    // selection roll were secretly reading the same bits as the scale roll,
    // Durand's would cluster entirely on one side.
    expect(sawDurandsWithMinScale).toBe(true);
    expect(sawDurandsWithMaxScale).toBe(true);
  });
});

describe('settler races', () => {
  it('is deterministic and matches the pinned golden vectors', () => {
    // Golden values computed from the shipped hash — a change to the hash,
    // the district size, or the bit slice shows up here as a diff, which is
    // the point: race placement is a WORLD fact players will name on maps,
    // so it must never drift silently between builds (or between this
    // function and any other plugin's documented copy of it).
    for (const [x, y, race] of [
      [0, 0, 'rudy'],
      [8, 12, 'rudy'],
      [16, 16, 'uno'],
      [100, 100, 'uno'],
      [255, 17, 'uno'],
      [511, 511, 'rudy'],
    ] as const) {
      expect(settlementRace(x, y)).toBe(race);
    }
  });

  it('gives every cell of one district the same race', () => {
    for (const [baseX, baseY] of [
      [0, 0],
      [16, 16],
      [240, 240],
    ] as const) {
      const district = settlementRace(baseX, baseY);
      for (const [dx, dy] of [
        [0, 0],
        [SETTLER_DISTRICT_CELLS - 1, 0],
        [0, SETTLER_DISTRICT_CELLS - 1],
        [SETTLER_DISTRICT_CELLS - 1, SETTLER_DISTRICT_CELLS - 1],
        [7, 9],
      ] as const) {
        expect(settlementRace(baseX + dx, baseY + dy)).toBe(district);
      }
    }
  });

  it('splits a full world of districts roughly evenly between the peoples', () => {
    const counts: Record<SettlerRace, number> = { rudy: 0, uno: 0 };
    const districtsPerEdge = 32; // a 512-cell world edge
    for (let dy = 0; dy < districtsPerEdge; dy++) {
      for (let dx = 0; dx < districtsPerEdge; dx++) {
        counts[settlementRace(dx * SETTLER_DISTRICT_CELLS, dy * SETTLER_DISTRICT_CELLS)]++;
      }
    }
    const total = districtsPerEdge * districtsPerEdge;
    // 529 / 495 with the shipped hash; the assertion is the property (no
    // race owns more than ~60% of the world), not the exact split.
    expect(counts.rudy + counts.uno).toBe(total);
    expect(counts.rudy).toBeGreaterThan(total * 0.4);
    expect(counts.uno).toBeGreaterThan(total * 0.4);
  });

  it('flows into placements so the renderer tints without re-deriving', () => {
    const result = placementsFor(cells([0, 0, 0], [16, 16, 2]), () => 5);
    expect(result.placements.map((p) => p.race)).toEqual(['rudy', 'uno']);
  });
});
