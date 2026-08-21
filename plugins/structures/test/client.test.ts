// The client half's PURE logic: the wire format, the deterministic per-
// building variation, and vertical placement. No three import here, so this
// runs in the same node environment as the server tests (design §8 — no
// headless GL rig). Mirrors flora/test/client.test.ts's shape.

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

/**
 * The `count` cells of a site's coastal search disc that are nearest to it,
 * nearest first — a patch of water that is guaranteed to be inside the disc
 * and to be exactly as big as the caller asked for.
 *
 * DERIVED FROM THE DISC ITSELF (2026-08-21). The fixtures below used to write
 * a couple of literal neighbours, or a straight column, because
 * COASTAL_MIN_WATER_CELLS was two and the disc's radius four. Both moved with
 * the re-sample, and they moved DIFFERENTLY — the bar is an AREA (32 cells now)
 * and the radius a LENGTH (16) — so a column of the bar's length no longer fits
 * inside the disc. Enumerating the disc is the only statement of "enough water,
 * near enough" that cannot go stale again.
 *
 * The ordering is total (distance, then y, then x), so it is the same list on
 * every run and the "nearest first" test can compare against it.
 */
function nearestWaterCells(
  centreX: number,
  centreY: number,
  count: number,
): Array<[number, number]> {
  const radius = COASTAL_SEARCH_RADIUS_CELLS;
  const threshold = radius * (radius - 1);
  const offsets: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue; // the site's own cell is dry by construction
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
  return offsets.slice(0, count).map(([dx, dy]) => [centreX + dx, centreY + dy]);
}

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
    // Every neighbour of (3, 4) within the coastal search disc is unknown to
    // this sparse fixture, so the site survey defaults to 'inland' — see
    // site.ts's surveySite for the conservative-default contract this
    // exercises (its own describe block below tests the surveying itself).
    // X/Z ARE WORLD UNITS, not the cell (placement.ts multiplies by
    // CELL_WORLD_SIZE): the renderer places a mesh in the scene, and the scene
    // is world space. They read as the bare cell only while a cell was a world
    // unit. groundY is already a world Y and never was a cell.
    expect(placements[0]).toEqual({
      x: 3 * CELL_WORLD_SIZE,
      z: 4 * CELL_WORLD_SIZE,
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
    );
    expect(placements).toHaveLength(1);
    expect(pendingGround).toBe(2);
  });

  it('reports a coastal placement, seeded with skiffs, when its neighbourhood is confirmed water', () => {
    // A tier-2 settlement at (100, 100) with COASTAL_MIN_WATER_CELLS confirmed
    // water cells nearby (band <= -1) and everything else known and dry.
    const ground = new Map<string, number>([['100,100', 3]]);
    const water = nearestWaterCells(100, 100, COASTAL_MIN_WATER_CELLS);
    for (const [wx, wy] of water) ground.set(`${wx},${wy}`, -1);
    const dryGroundAt: GroundLookup = (x, y) => {
      if (ground.has(`${x},${y}`)) return ground.get(`${x},${y}`)!;
      // Every other cell in the search disc is KNOWN and dry, so the survey
      // resolves definitively instead of coming back pending.
      const dx = x - 100;
      const dy = y - 100;
      if (dx * dx + dy * dy < COASTAL_SEARCH_RADIUS_CELLS * (COASTAL_SEARCH_RADIUS_CELLS - 1)) return 4;
      return null;
    };

    const { placements, skiffs, pendingSite } = placementsFor(cells([100, 100, 2]), dryGroundAt);
    expect(pendingSite).toBe(0);
    expect(placements).toHaveLength(1);
    expect(placements[0].site).toBe('coastal');
    expect(skiffs.length).toBeGreaterThan(0);
    expect(skiffs.length).toBeLessThanOrEqual(SKIFF_MAX_PER_SETTLEMENT);
    for (const skiff of skiffs) {
      // Every skiff anchors on a cell this fixture actually marked as water.
      expect(water).toContainEqual([skiff.x, skiff.z]);
    }
  });
});

describe('site survey (card 33, coastal classification)', () => {
  const CENTER = { x: 200, y: 200 };

  /** A GroundLookup where every cell in `waterAt` reads as confirmed water (-1) and everything else is dry (4), fully known. */
  function worldWithWater(waterAt: ReadonlyArray<readonly [number, number]>): GroundLookup {
    const water = new Set(waterAt.map(([x, y]) => `${x},${y}`));
    return (x, y) => (water.has(`${x},${y}`) ? -1 : 4);
  }

  it('classifies a shore site coastal: enough confirmed water nearby', () => {
    // Exactly the bar, and every one of them INSIDE the search disc. A single
    // column of COASTAL_MIN_WATER_CELLS cells was inside it only while the bar
    // was smaller than the disc's radius; the bar is an area and the radius a
    // length, so they stopped fitting that way at the 2026-08-21 re-sample.
    const waterCells = nearestWaterCells(CENTER.x, CENTER.y, COASTAL_MIN_WATER_CELLS);
    const survey = surveySite(worldWithWater(waterCells), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('coastal');
    expect(survey.pending).toBe(false);
    expect(survey.waterCells.length).toBe(COASTAL_MIN_WATER_CELLS);
  });

  it('classifies a fully dry, fully known neighbourhood inland — never pending', () => {
    const survey = surveySite(worldWithWater([]), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('inland');
    expect(survey.pending).toBe(false);
    expect(survey.waterCells).toEqual([]);
  });

  it('a single stray deep cell (a borrow pit, not a coastline) does not qualify', () => {
    // Below COASTAL_MIN_WATER_CELLS by construction.
    const survey = surveySite(worldWithWater([[CENTER.x + 1, CENTER.y]]), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('inland');
    expect(survey.waterCells).toEqual([]);
  });

  it('never counts a band-0 cell (world Y = 0) as water — the ambiguous case', () => {
    // Height 0 renders identically to shallow dry land under band
    // quantisation (see site.ts's file banner); a lookup that always
    // returns 0 must never read as coastal however many such cells surround
    // the site.
    const groundAt: GroundLookup = () => 0;
    const survey = surveySite(groundAt, CENTER.x, CENTER.y);
    expect(survey.kind).toBe('inland');
    expect(survey.pending).toBe(false);
  });

  it('the "lake" edge case: one confirmed-water cell plus unresolved neighbours stays pending, not falsely inland or coastal', () => {
    // One short of COASTAL_MIN_WATER_CELLS confirmed, but with enough
    // still-unknown neighbours that the verdict could still flip once they
    // resolve — the caller (placement.ts) is expected to retry, not to
    // trust this 'inland' as final.
    const groundAt: GroundLookup = (x, y) => (x === CENTER.x + 1 && y === CENTER.y ? -1 : null);
    const survey = surveySite(groundAt, CENTER.x, CENTER.y);
    expect(survey.kind).toBe('inland'); // conservative default while undecided
    expect(survey.pending).toBe(true);
  });

  it('waterCells is sorted nearest first', () => {
    // The site has to clear COASTAL_MIN_WATER_CELLS before it reports any water
    // at all, so the ordering is asserted over a qualifying patch rather than a
    // bare pair: the nearest cells of the disc, handed in FURTHEST first, must
    // come back nearest first.
    const nearestFirst = nearestWaterCells(CENTER.x, CENTER.y, COASTAL_MIN_WATER_CELLS);
    const shuffled = [...nearestFirst].reverse();
    const survey = surveySite(worldWithWater(shuffled), CENTER.x, CENTER.y);
    expect(survey.kind).toBe('coastal');

    const distanceOf = (cell: { x: number; y: number }): number =>
      (cell.x - CENTER.x) ** 2 + (cell.y - CENTER.y) ** 2;
    expect(survey.waterCells.length).toBe(COASTAL_MIN_WATER_CELLS);
    for (let i = 1; i < survey.waterCells.length; i++) {
      expect(distanceOf(survey.waterCells[i]!)).toBeGreaterThanOrEqual(
        distanceOf(survey.waterCells[i - 1]!),
      );
    }
    expect(survey.waterCells[0]).toEqual({ x: nearestFirst[0]![0], y: nearestFirst[0]![1] });
  });

  it('is a pure function of its ground lookup, so every client surveys the same cell identically', () => {
    const groundAt = worldWithWater([[CENTER.x + 1, CENTER.y], [CENTER.x + 1, CENTER.y + 1]]);
    expect(surveySite(groundAt, CENTER.x, CENTER.y)).toEqual(surveySite(groundAt, CENTER.x, CENTER.y));
  });
});

describe('skiffs (card 33)', () => {
  const waterCells = [
    { x: 10, y: 20 },
    { x: 11, y: 20 },
    { x: 12, y: 20 },
    { x: 13, y: 20 },
  ];

  it('a tier-0 camp has not grown a boat yet', () => {
    expect(skiffsForSettlement(0, waterCells)).toEqual([]);
    expect(SKIFF_MIN_TIER).toBeGreaterThan(0);
  });

  it('skiff count scales with tier, capped at SKIFF_MAX_PER_SETTLEMENT', () => {
    expect(skiffsForSettlement(1, waterCells)).toHaveLength(1);
    expect(skiffsForSettlement(2, waterCells)).toHaveLength(2);
    expect(skiffsForSettlement(5, waterCells)).toHaveLength(SKIFF_MAX_PER_SETTLEMENT);
  });

  it('never asks for more skiffs than confirmed water cells exist', () => {
    expect(skiffsForSettlement(5, waterCells.slice(0, 1))).toHaveLength(1);
    expect(skiffsForSettlement(5, [])).toEqual([]);
  });

  it('anchors every skiff on one of the water cells handed in', () => {
    const placements = skiffsForSettlement(3, waterCells);
    for (const placement of placements) {
      expect(waterCells).toContainEqual({ x: placement.x, y: placement.z });
    }
  });

  it('is deterministic: the same water cells produce the same skiff parameters', () => {
    expect(skiffsForSettlement(3, waterCells)).toEqual(skiffsForSettlement(3, waterCells));
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
    // STATED IN DISTRICTS SINCE 2026-08-21, not in cells. The vectors pin the
    // HASH — the thing that must not drift between copies — and a district is
    // sixteen world units of ground, which the re-sample made 64 cells rather
    // than 16. Written as cells they pinned the district SIZE as well, and
    // every one of them named a different district after the change.
    for (const [districtX, districtY, race] of [
      [0, 0, 'rudy'],
      [1, 1, 'uno'],
      [6, 6, 'uno'],
      [15, 1, 'uno'],
      [31, 31, 'rudy'],
    ] as const) {
      // Any cell inside the district; the rule is district-wide by
      // construction (the "every cell of one district" test pins that).
      const x = districtX * SETTLER_DISTRICT_CELLS + 3;
      const y = districtY * SETTLER_DISTRICT_CELLS + 3;
      expect(settlementRace(x, y)).toBe(race);
    }
  });

  it('gives every cell of one district the same race', () => {
    // District ORIGINS, not arbitrary points: a district is
    // SETTLER_DISTRICT_CELLS across, and the probes below step to its far
    // corner, so a base that is not on the grid straddles two districts and
    // the test asks the wrong question. The literals [0,0], [16,16], [240,240]
    // were origins only while a district was 16 CELLS; it is 16 WORLD UNITS
    // (64 cells) since the 2026-08-21 re-sample.
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
    // A 512-WORLD-UNIT world edge — the nominal one — divided by a district's
    // 16 world units. Unchanged by the re-sample, which moved neither.
    const districtsPerEdge = 32;
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
    // Two cells in DIFFERENT districts, so the assertion is about the race
    // travelling with each placement rather than about one constant. [16,16]
    // was a second district only while a district was 16 cells.
    const other: readonly [number, number] = [SETTLER_DISTRICT_CELLS, SETTLER_DISTRICT_CELLS];
    expect(settlementRace(0, 0)).not.toBe(settlementRace(other[0], other[1]));

    const result = placementsFor(cells([0, 0, 0], [other[0], other[1], 2]), () => 5);
    expect(result.placements.map((p) => p.race)).toEqual([
      settlementRace(0, 0),
      settlementRace(other[0], other[1]),
    ]);
  });
});
