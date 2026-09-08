import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  bandOf,
  cellIndex,
  columnSampleAtBand,
  createHeightmap,
  createSeededRng,
  drawnGroundCoversBand,
  drawnGroundHeight,
  DRAWN_GROUND_FIXPOINT_STEPS,
  MAX_HEIGHT,
  MAX_SPANS_PER_COLUMN,
  setColumn,
  TERRAIN_LOD_NEAR_N,
  type Heightmap,
  type Span,
} from '../src/index.ts';

const WORLD_SIZE = 8;

const SAMPLE_STEP = 1 / 8;

const TOP_BAND = bandOf(MAX_HEIGHT);

const FLOOR_BAND = bandOf(BEDROCK_FLOOR);

function world(): Heightmap {
  return createHeightmap(WORLD_SIZE);
}

function setHeight(map: Heightmap, x: number, y: number, h: number): void {
  setColumn(map, x, y, [{ floor: BEDROCK_FLOOR, ceiling: h }]);
}

function flatWorld(h: number): Heightmap {
  const map = world();
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) setHeight(map, x, y, h);
  }
  return map;
}

function roughWorld(): Heightmap {
  const map = world();
  const rng = createSeededRng(1234);
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      setHeight(map, x, y, Math.floor(rng.next() * (MAX_HEIGHT - BEDROCK_FLOOR)) + BEDROCK_FLOOR + 1);
    }
  }
  return map;
}

function forEachSample(visit: (x: number, y: number) => void): void {
  for (let y = 0; y < WORLD_SIZE; y += SAMPLE_STEP) {
    for (let x = 0; x < WORLD_SIZE; x += SAMPLE_STEP) visit(x, y);
  }
}

function unlayeredReference(map: Heightmap, x: number, y: number): number {
  const denom = 2 * TERRAIN_LOD_NEAR_N;
  const qx = 2 * Math.floor(x * TERRAIN_LOD_NEAR_N) + 1 - TERRAIN_LOD_NEAR_N;
  const qy = 2 * Math.floor(y * TERRAIN_LOD_NEAR_N) + 1 - TERRAIN_LOD_NEAR_N;
  const baseX = Math.floor(qx / denom);
  const baseY = Math.floor(qy / denom);
  const fx = qx - baseX * denom;
  const fy = qy - baseY * denom;
  const clamp = (i: number): number => Math.min(WORLD_SIZE - 1, Math.max(0, i));
  const h = (i: number, j: number): number => map.cells[cellIndex(map, clamp(i), clamp(j))]!;
  const lower = h(baseX, baseY) * (denom - fx) + h(baseX + 1, baseY) * fx;
  const upper = h(baseX, baseY + 1) * (denom - fx) + h(baseX + 1, baseY + 1) * fx;
  const numerator = lower * (denom - fy) + upper * fy;
  return Math.floor(numerator / (denom * denom * BAND_HEIGHT)) * BAND_HEIGHT;
}

function topDrawnBandByScan(map: Heightmap, x: number, y: number): number {
  for (let band = TOP_BAND; band >= FLOOR_BAND; band--) {
    if (drawnGroundCoversBand(map, x, y, band)) return band;
  }
  return FLOOR_BAND;
}

const CAVE_FLOOR_CAP = 32;

const CAVE_ROOF_FLOOR = 64;

const CAVE_ROOF_CAP = 96;

function cavedWorld(): Heightmap {
  const map = flatWorld(CAVE_ROOF_CAP);
  for (const [x, y] of [
    [4, 4],
    [5, 4],
    [4, 5],
    [5, 5],
  ] as const) {
    setColumn(map, x, y, [
      { floor: BEDROCK_FLOOR, ceiling: CAVE_FLOOR_CAP },
      { floor: CAVE_ROOF_FLOOR, ceiling: CAVE_ROOF_CAP },
    ]);
  }
  return map;
}

function maximallyLayeredSpans(): Span[] {
  const spans: Span[] = [{ floor: BEDROCK_FLOOR, ceiling: 2 * BAND_HEIGHT }];
  for (let k = 1; k < MAX_SPANS_PER_COLUMN; k++) {
    spans.push({ floor: 4 * k * BAND_HEIGHT, ceiling: (4 * k + 2) * BAND_HEIGHT });
  }
  return spans;
}

describe('drawnGroundHeight', () => {
  it('is deterministic across repeated calls', () => {
    const map = roughWorld();
    forEachSample((x, y) => {
      const first = drawnGroundHeight(map, x, y);
      expect(drawnGroundHeight(map, x, y)).toBe(first);
      expect(drawnGroundHeight(map, x, y)).toBe(first);
    });
  });

  it('matches the integer blend formula on an unlayered world', () => {
    const map = roughWorld();
    forEachSample((x, y) => {
      expect(drawnGroundHeight(map, x, y)).toBe(unlayeredReference(map, x, y));
    });
  });

  it('returns the flat band exactly on a flat world', () => {
    for (const h of [0, 16, 48, 512]) {
      const map = flatWorld(h);
      forEachSample((x, y) => expect(drawnGroundHeight(map, x, y)).toBe(h));
    }
  });

  it('floors negative heights toward minus infinity', () => {
    for (const [h, expected] of [
      [-1, -16],
      [-8, -16],
      [-16, -16],
      [-17, -32],
      [-1520, -1520],
    ] as const) {
      const map = flatWorld(h);
      expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(expected);
    }
  });

  it('always returns a multiple of BAND_HEIGHT', () => {
    const map = roughWorld();
    forEachSample((x, y) => {
      expect(Number.isInteger(drawnGroundHeight(map, x, y) / BAND_HEIGHT)).toBe(true);
    });
  });

  it('clamps to the border instead of reading out of bounds', () => {
    const map = roughWorld();
    const corner = drawnGroundHeight(map, 0.125, 0.125);
    for (const [x, y] of [
      [-0.125, -0.125],
      [-5, -5],
      [-1000, -1000],
    ] as const) {
      expect(drawnGroundHeight(map, x, y)).toBe(corner);
    }
    const far = drawnGroundHeight(map, WORLD_SIZE - 0.125, WORLD_SIZE - 0.125);
    for (const [x, y] of [
      [WORLD_SIZE + 0.125, WORLD_SIZE + 0.125],
      [WORLD_SIZE + 5, WORLD_SIZE + 5],
      [1000, 1000],
    ] as const) {
      expect(drawnGroundHeight(map, x, y)).toBe(far);
    }
  });

  it('returns the top drawn cap over a carved column', () => {
    const map = cavedWorld();
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(CAVE_ROOF_CAP);
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(
      topDrawnBandByScan(map, 4.5, 4.5) * BAND_HEIGHT,
    );
  });

  it('descends past an overhang whose cell height is not a drawn cap', () => {
    const map = flatWorld(0);
    setColumn(map, 4, 4, [
      { floor: BEDROCK_FLOOR, ceiling: CAVE_FLOOR_CAP },
      { floor: 88, ceiling: CAVE_ROOF_CAP },
    ]);
    expect(map.cells[cellIndex(map, 4, 4)]).toBe(CAVE_ROOF_CAP);
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(BAND_HEIGHT);
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(
      topDrawnBandByScan(map, 4.5, 4.5) * BAND_HEIGHT,
    );
  });

  it('reaches the fixpoint within its bound on a maximally layered column', () => {
    const map = flatWorld(0);
    const spans = maximallyLayeredSpans();
    expect(spans.length).toBe(MAX_SPANS_PER_COLUMN);
    setColumn(map, 4, 4, spans);
    forEachSample((x, y) => {
      expect(drawnGroundHeight(map, x, y)).toBe(topDrawnBandByScan(map, x, y) * BAND_HEIGHT);
    });
    expect(DRAWN_GROUND_FIXPOINT_STEPS).toBeGreaterThanOrEqual(4 * MAX_SPANS_PER_COLUMN);
  });
});

describe('drawnGroundCoversBand', () => {
  it('is monotone in band on an unlayered world', () => {
    const map = roughWorld();
    forEachSample((x, y) => {
      let seenTrue = false;
      for (let band = TOP_BAND; band >= FLOOR_BAND; band--) {
        const covers = drawnGroundCoversBand(map, x, y, band);
        if (covers) seenTrue = true;
        else expect(seenTrue).toBe(false);
      }
    });
  });

  it('rests on a sample field that never falls as the band rises', () => {
    const map = cavedWorld();
    setColumn(map, 2, 2, maximallyLayeredSpans());
    for (const [cx, cy] of [
      [2, 2],
      [4, 4],
      [0, 0],
    ] as const) {
      let previous = columnSampleAtBand(map, cx, cy, FLOOR_BAND);
      for (let band = FLOOR_BAND + 1; band <= TOP_BAND; band++) {
        const sample = columnSampleAtBand(map, cx, cy, band);
        expect(sample).toBeGreaterThanOrEqual(previous);
        previous = sample;
      }
    }
  });

  it('covers the cave floor and roof but not the gap between them', () => {
    const map = cavedWorld();
    expect(drawnGroundCoversBand(map, 4.5, 4.5, bandOf(CAVE_FLOOR_CAP))).toBe(true);
    expect(drawnGroundCoversBand(map, 4.5, 4.5, bandOf(CAVE_ROOF_FLOOR))).toBe(true);
    expect(drawnGroundCoversBand(map, 4.5, 4.5, bandOf(CAVE_ROOF_CAP))).toBe(true);
    for (let band = bandOf(CAVE_FLOOR_CAP) + 1; band < bandOf(CAVE_ROOF_FLOOR); band++) {
      expect(drawnGroundCoversBand(map, 4.5, 4.5, band)).toBe(false);
    }
  });

  it('agrees with drawnGroundHeight on an unlayered world', () => {
    const map = roughWorld();
    forEachSample((x, y) => {
      const band = drawnGroundHeight(map, x, y) / BAND_HEIGHT;
      expect(drawnGroundCoversBand(map, x, y, band)).toBe(true);
      expect(drawnGroundCoversBand(map, x, y, band + 1)).toBe(false);
    });
  });
});
