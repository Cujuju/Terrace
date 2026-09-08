import { describe, expect, it } from 'vitest';
import { CELL_WORLD_SIZE } from '@terrace/shared';
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
import { placementsFor, type GroundLookup } from '../client/placement.ts';
import { DURANDS_SHARE_OF_256, isDurandsCell } from '../client/durands.ts';
import {
  COASTAL_MIN_WATER_CELLS,
  COASTAL_SEARCH_RADIUS_CELLS,
  SKIFF_MOORING_CLEARANCE_CELLS,
  surveySite,
} from '../client/site.ts';
import {
  SKIFF_MAX_PER_SETTLEMENT,
  SKIFF_MIN_TIER,
  skiffsForSettlement,
} from '../client/skiffs.ts';

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
      1, 2, 0,
      -1, 4, 0,
      5, 1.5, 0,
      7, 8, 99,
      9, 9, 5,
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

function nearestWaterCells(
  centreX: number,
  centreY: number,
  count: number,
  keep?: (dx: number, dy: number) => boolean,
): Array<[number, number]> {
  const radius = COASTAL_SEARCH_RADIUS_CELLS;
  const threshold = radius * (radius - 1);
  const offsets: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (dx * dx + dy * dy < threshold) offsets.push([dx, dy]);
    }
  }
  offsets.sort(
    (a, b) =>
      a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0],
  );
  if (offsets.length < count) {
    throw new Error(`search disc holds ${offsets.length} cells, asked for ${count}`);
  }
  return offsets
    .filter(([dx, dy]) => keep === undefined || keep(dx, dy))
    .slice(0, count)
    .map(([dx, dy]) => [centreX + dx, centreY + dy]);
}

function drawnAsLattice(groundAt: GroundLookup): GroundLookup {
  return (x, y) => groundAt(Math.round(x), Math.round(y));
}

const COAST_WATER_MIN_DX = 3;

function coastGroundAt(centreX: number): GroundLookup {
  return (x) => (x - centreX >= COAST_WATER_MIN_DX ? -1 : 4);
}

function isCoastMooring(dx: number): boolean {
  return dx - SKIFF_MOORING_CLEARANCE_CELLS >= COAST_WATER_MIN_DX;
}

const COAST_FIXTURE_MOORINGS = 1;

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
    const { placements, pendingGround } = placementsFor(
      cells([3, 4, 2]),
      groundAt,
      drawnAsLattice(groundAt),
    );
    expect(pendingGround).toBe(0);
    expect(placements).toHaveLength(1);

    const variation = structureVariation(3, 4);
    expect(placements[0]).toEqual({
      x: 3 * CELL_WORLD_SIZE,
      z: 4 * CELL_WORLD_SIZE,
      cellX: 3,
      cellY: 4,
      groundY: 5,
      tier: 2,
      scale: variation.scale,
      yaw: variation.yaw,
      race: settlementRace(3, 4),
      site: 'inland',
    });
  });

  it('omits a building whose ground this client has not been sent', () => {
    const { placements, pendingGround } = placementsFor(
      cells([3, 4, 0], [50, 50, 0], [60, 1, 0]),
      groundAt,
      drawnAsLattice(groundAt),
    );
    expect(placements).toHaveLength(1);
    expect(pendingGround).toBe(2);
  });

  it('reports a coastal placement, seeded with skiffs, when its neighbourhood is confirmed water', () => {
    const groundAt = coastGroundAt(100);

    const { placements, skiffs, pendingSite } = placementsFor(
      cells([100, 100, 2]),
      groundAt,
      drawnAsLattice(groundAt),
    );
    expect(pendingSite).toBe(0);
    expect(placements).toHaveLength(1);
    expect(placements[0].site).toBe('coastal');
    expect(skiffs.length).toBeGreaterThan(0);
    expect(skiffs.length).toBeLessThanOrEqual(SKIFF_MAX_PER_SETTLEMENT);
    for (const skiff of skiffs) {
      expect(groundAt(skiff.x, skiff.z)).toBeLessThanOrEqual(-1);
      expect(isCoastMooring(skiff.x - 100)).toBe(true);
    }
  });
});

describe('site survey (card 33, coastal classification)', () => {
  const CENTER = { x: 200, y: 200 };

  function worldWithWater(waterAt: ReadonlyArray<readonly [number, number]>): GroundLookup {
    const water = new Set(waterAt.map(([x, y]) => `${x},${y}`));
    return (x, y) => (water.has(`${x},${y}`) ? -1 : 4);
  }

  it('classifies a shore site coastal: enough confirmed water nearby', () => {
    const groundAt = coastGroundAt(CENTER.x);
    const survey = surveySite(groundAt, drawnAsLattice(groundAt), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('coastal');
    expect(survey.pending).toBe(false);
    expect(survey.moorings.length).toBe(COAST_FIXTURE_MOORINGS);
  });

  it('classifies a fully dry, fully known neighbourhood inland — never pending', () => {
    const groundAt = worldWithWater([]);
    const survey = surveySite(groundAt, drawnAsLattice(groundAt), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('inland');
    expect(survey.pending).toBe(false);
    expect(survey.moorings).toEqual([]);
  });

  it('a single stray deep cell (a borrow pit, not a coastline) does not qualify', () => {
    const groundAt = worldWithWater([[CENTER.x + 1, CENTER.y]]);
    const survey = surveySite(groundAt, drawnAsLattice(groundAt), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('inland');
    expect(survey.moorings).toEqual([]);
  });

  it('never counts a band-0 cell (world Y = 0) as water — the ambiguous case', () => {
    const groundAt: GroundLookup = () => 0;
    const survey = surveySite(groundAt, drawnAsLattice(groundAt), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('inland');
    expect(survey.pending).toBe(false);
  });

  it('the "lake" edge case: one confirmed-water cell plus unresolved neighbours stays pending, not falsely inland or coastal', () => {
    const groundAt: GroundLookup = (x, y) => (x === CENTER.x + 1 && y === CENTER.y ? -1 : null);
    const survey = surveySite(groundAt, drawnAsLattice(groundAt), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('inland');
    expect(survey.pending).toBe(true);
  });

  it('moorings are sorted nearest first', () => {
    const nearestFirst = nearestWaterCells(
      CENTER.x,
      CENTER.y,
      SKIFF_MAX_PER_SETTLEMENT,
      (dx) => isCoastMooring(dx),
    );
    const groundAt = coastGroundAt(CENTER.x);
    const survey = surveySite(groundAt, drawnAsLattice(groundAt), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('coastal');

    const distanceOf = (cell: { x: number; y: number }): number =>
      (cell.x - CENTER.x) ** 2 + (cell.y - CENTER.y) ** 2;
    expect(survey.moorings.length).toBe(COAST_FIXTURE_MOORINGS);
    for (let i = 1; i < survey.moorings.length; i++) {
      expect(distanceOf(survey.moorings[i]!)).toBeGreaterThanOrEqual(
        distanceOf(survey.moorings[i - 1]!),
      );
    }
    expect(survey.moorings[0]).toEqual({ x: nearestFirst[0]![0], y: nearestFirst[0]![1] });
  });

  it('is a pure function of its ground lookup, so every client surveys the same cell identically', () => {
    const groundAt = worldWithWater([[CENTER.x + 1, CENTER.y], [CENTER.x + 1, CENTER.y + 1]]);
    const drawnAt = drawnAsLattice(groundAt);
    expect(surveySite(groundAt, drawnAt, CENTER.x, CENTER.y)).toEqual(
      surveySite(groundAt, drawnAt, CENTER.x, CENTER.y),
    );
  });
});

describe('skiffs (card 33)', () => {
  const moorings = [
    { x: 10, y: 20 },
    { x: 11, y: 20 },
    { x: 12, y: 20 },
    { x: 13, y: 20 },
  ];

  it('a tier-0 camp has not grown a boat yet', () => {
    expect(skiffsForSettlement(0, moorings)).toEqual([]);
    expect(SKIFF_MIN_TIER).toBeGreaterThan(0);
  });

  it('skiff count scales with tier, capped at SKIFF_MAX_PER_SETTLEMENT', () => {
    expect(skiffsForSettlement(1, moorings)).toHaveLength(1);
    expect(skiffsForSettlement(2, moorings)).toHaveLength(2);
    expect(skiffsForSettlement(5, moorings)).toHaveLength(SKIFF_MAX_PER_SETTLEMENT);
  });

  it('never asks for more skiffs than confirmed water cells exist', () => {
    expect(skiffsForSettlement(5, moorings.slice(0, 1))).toHaveLength(1);
    expect(skiffsForSettlement(5, [])).toEqual([]);
  });

  it('anchors every skiff on one of the water cells handed in', () => {
    const placements = skiffsForSettlement(3, moorings);
    for (const placement of placements) {
      expect(moorings).toContainEqual({ x: placement.x, y: placement.z });
    }
  });

  it('is deterministic: the same water cells produce the same skiff parameters', () => {
    expect(skiffsForSettlement(3, moorings)).toEqual(skiffsForSettlement(3, moorings));
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
    expect(durandsCount / sampleCount).toBeGreaterThan(expectedShare - 0.05);
    expect(durandsCount / sampleCount).toBeLessThan(expectedShare + 0.05);
  });

  it('does not correlate with the yaw/scale roll structureVariation reads from the same hash', () => {
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
    expect(sawDurandsWithMinScale).toBe(true);
    expect(sawDurandsWithMaxScale).toBe(true);
  });
});

describe('settler races', () => {
  it('is deterministic and matches the pinned golden vectors', () => {
    for (const [districtX, districtY, race] of [
      [0, 0, 'rudy'],
      [1, 1, 'uno'],
      [6, 6, 'uno'],
      [15, 1, 'uno'],
      [31, 31, 'rudy'],
    ] as const) {
      const x = districtX * SETTLER_DISTRICT_CELLS + 3;
      const y = districtY * SETTLER_DISTRICT_CELLS + 3;
      expect(settlementRace(x, y)).toBe(race);
    }
  });

  it('gives every cell of one district the same race', () => {
    const D = SETTLER_DISTRICT_CELLS;
    for (const [baseX, baseY] of [
      [0, 0],
      [D, D],
      [15 * D, 15 * D],
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
    const districtsPerEdge = 32;
    for (let dy = 0; dy < districtsPerEdge; dy++) {
      for (let dx = 0; dx < districtsPerEdge; dx++) {
        counts[settlementRace(dx * SETTLER_DISTRICT_CELLS, dy * SETTLER_DISTRICT_CELLS)]++;
      }
    }
    const total = districtsPerEdge * districtsPerEdge;
    expect(counts.rudy + counts.uno).toBe(total);
    expect(counts.rudy).toBeGreaterThan(total * 0.4);
    expect(counts.uno).toBeGreaterThan(total * 0.4);
  });

  it('flows into placements so the renderer tints without re-deriving', () => {
    const other: readonly [number, number] = [SETTLER_DISTRICT_CELLS, SETTLER_DISTRICT_CELLS];
    expect(settlementRace(0, 0)).not.toBe(settlementRace(other[0], other[1]));

    const result = placementsFor(cells([0, 0, 0], [other[0], other[1], 2]), () => 5, () => 5);
    expect(result.placements.map((p) => p.race)).toEqual([
      settlementRace(0, 0),
      settlementRace(other[0], other[1]),
    ]);
  });
});
