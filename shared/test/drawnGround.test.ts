import { describe, expect, it } from 'vitest';
import {
  applyPackedSpans,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  bandOf,
  cellIndex,
  columnSampleAtBand,
  createHeightmap,
  createSeededRng,
  CHUNK_SIZE,
  drawnGroundChunkBandSpans,
  drawnGroundCoversBand,
  drawnGroundFarHeight,
  drawnGroundHeight,
  drawnGroundLodError,
  drawnGroundSubcell,
  drawnGroundSubcellBands,
  drawnGroundSubcellIsLayered,
  DRAWN_GROUND_COORD_DENOM,
  DRAWN_GROUND_FIXPOINT_STEPS,
  DRAWN_GROUND_LATTICE_N,
  TERRAIN_LOD_FAR_N,
  isSpanDrawn,
  MAX_HEIGHT,
  MAX_SPANS_PER_COLUMN,
  setColumn,
  spanCount,
  TERRAIN_LOD_NEAR_N,
  topSpan,
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
      setHeight(
        map,
        x,
        y,
        Math.floor(rng.next() * (MAX_HEIGHT - BEDROCK_FLOOR)) + BEDROCK_FLOOR + 1,
      );
    }
  }
  return map;
}

function forEachSample(visit: (x: number, y: number) => void): void {
  for (let y = 0; y < WORLD_SIZE; y += SAMPLE_STEP) {
    for (let x = 0; x < WORLD_SIZE; x += SAMPLE_STEP) visit(x, y);
  }
}

const LATTICE_N = DRAWN_GROUND_LATTICE_N;

/** Float distance from a chord below which the exact tie rule, not the float model, decides. */
const CHORD_TIE_MARGIN = 1e-9;

function quantise(coord: number): number {
  return Math.floor(coord * DRAWN_GROUND_COORD_DENOM) / DRAWN_GROUND_COORD_DENOM;
}

/** The unquantised bilinear field, in doubles, straight from the definition. */
function bilinear(map: Heightmap, x: number, y: number): number {
  const clamp = (i: number): number => Math.min(WORLD_SIZE - 1, Math.max(0, i));
  const h = (i: number, j: number): number => map.cells[cellIndex(map, clamp(i), clamp(j))]!;
  const tx = x - 0.5;
  const ty = y - 0.5;
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  const fx = tx - x0;
  const fy = ty - y0;
  const lower = h(x0, y0) * (1 - fx) + h(x0 + 1, y0) * fx;
  const upper = h(x0, y0 + 1) * (1 - fx) + h(x0 + 1, y0 + 1) * fx;
  return lower * (1 - fy) + upper * fy;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Float model of the chord surface: the highest band whose straight-chord
 * region covers the quantised point. Returns null within CHORD_TIE_MARGIN of a chord.
 */
function chordReference(map: Heightmap, x: number, y: number): number | null {
  const qx = quantise(Math.min(WORLD_SIZE, Math.max(0, x)));
  const qy = quantise(Math.min(WORLD_SIZE, Math.max(0, y)));
  const sx = Math.floor(qx * LATTICE_N);
  const sy = Math.floor(qy * LATTICE_N);
  const corners: Point[] = [
    { x: sx / LATTICE_N, y: sy / LATTICE_N },
    { x: sx / LATTICE_N, y: (sy + 1) / LATTICE_N },
    { x: (sx + 1) / LATTICE_N, y: (sy + 1) / LATTICE_N },
    { x: (sx + 1) / LATTICE_N, y: sy / LATTICE_N },
  ];
  const heights = corners.map((c) => bilinear(map, c.x, c.y));
  const bands = heights.map(bandOf);
  const lo = Math.min(...bands);
  const hi = Math.max(...bands);
  const p = { x: qx, y: qy };
  for (let band = hi; band > lo; band--) {
    const threshold = band * BAND_HEIGHT;
    const crossings: { edge: number; at: Point }[] = [];
    for (let edge = 0; edge < 4; edge++) {
      const a = heights[edge]!;
      const b = heights[(edge + 1) % 4]!;
      if (a < threshold === b < threshold) continue;
      const t = (threshold - a) / (b - a);
      const ca = corners[edge]!;
      const cb = corners[(edge + 1) % 4]!;
      crossings.push({
        edge,
        at: { x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t },
      });
    }
    if (crossings.length === 0) {
      if (heights[0]! >= threshold) return band;
      continue;
    }
    let pairs: [number, number][];
    let arcHigh: boolean;
    if (crossings.length === 2) {
      pairs = [[0, 1]];
      arcHigh = heights[(crossings[0]!.edge + 1) % 4]! >= threshold;
    } else {
      const centreHigh = heights[0]! + heights[1]! + heights[2]! + heights[3]! >= 4 * threshold;
      arcHigh = !centreHigh;
      const corner1High = heights[1]! >= threshold;
      pairs =
        corner1High === arcHigh
          ? [
              [0, 1],
              [2, 3],
            ]
          : [
              [1, 2],
              [3, 0],
            ];
    }
    let covered = !arcHigh;
    for (const [ia, ib] of pairs) {
      const a = crossings[ia]!.at;
      const b = crossings[ib]!.at;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < CHORD_TIE_MARGIN) return null;
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (Math.abs(cross) / len < CHORD_TIE_MARGIN) return null;
      if (arcHigh && cross > 0) covered = true;
      if (!arcHigh && cross > 0) covered = false;
    }
    if (covered) return band;
  }
  return lo;
}

function polygonArea(points: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/** Cells 0,0 and 1,1 raised so the bilinear saddle falls inside sub-cell (4, 4). */
function saddleWorld(nearCorner: number): Heightmap {
  const map = flatWorld(0);
  setHeight(map, 0, 0, nearCorner);
  setHeight(map, 1, 1, 96);
  return map;
}

/** Saddle corners 72/60/60/66: the centre averages 64.5, at or above band 4. */
const SADDLE_JOINED_CORNER = 192;

/** Saddle corners 68/58/58/65: the centre averages 62.25, below band 4. */
const SADDLE_SPLIT_CORNER = 176;

const SADDLE_BAND = 4;

const SADDLE_SUBCELL = 4;

const SADDLE_SUBCELL_CENTRE = (SADDLE_SUBCELL + 0.5) / LATTICE_N;

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
    spans.push({
      floor: 4 * k * BAND_HEIGHT,
      ceiling: (4 * k + 2) * BAND_HEIGHT,
    });
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

  it('equals the banded bilinear at every lattice corner', () => {
    const map = roughWorld();
    for (let ly = 0; ly <= WORLD_SIZE * LATTICE_N; ly++) {
      for (let lx = 0; lx <= WORLD_SIZE * LATTICE_N; lx++) {
        const x = lx / LATTICE_N;
        const y = ly / LATTICE_N;
        expect(drawnGroundHeight(map, x, y)).toBe(bandOf(bilinear(map, x, y)) * BAND_HEIGHT);
      }
    }
  });

  it('matches the float chord model away from chord ties on an unlayered world', () => {
    const map = roughWorld();
    const rng = createSeededRng(99);
    let checked = 0;
    for (let i = 0; i < 20000; i++) {
      const x = rng.next() * WORLD_SIZE;
      const y = rng.next() * WORLD_SIZE;
      const expected = chordReference(map, x, y);
      if (expected === null) continue;
      checked++;
      expect(drawnGroundHeight(map, x, y)).toBe(expected * BAND_HEIGHT);
    }
    expect(checked).toBeGreaterThan(19000);
  });

  it('reads the same height anywhere inside one coordinate step', () => {
    const map = roughWorld();
    const rng = createSeededRng(7);
    const step = 1 / DRAWN_GROUND_COORD_DENOM;
    for (let i = 0; i < 5000; i++) {
      const x = rng.next() * WORLD_SIZE;
      const y = rng.next() * WORLD_SIZE;
      const at = drawnGroundHeight(map, x, y);
      expect(drawnGroundHeight(map, quantise(x), quantise(y))).toBe(at);
      expect(drawnGroundHeight(map, quantise(x) + step * 0.999, quantise(y) + step * 0.999)).toBe(
        at,
      );
    }
  });

  it('joins the high corners of a saddle through a high centre', () => {
    const map = saddleWorld(SADDLE_JOINED_CORNER);
    const centre = drawnGroundHeight(map, SADDLE_SUBCELL_CENTRE, SADDLE_SUBCELL_CENTRE);
    expect(centre).toBe(SADDLE_BAND * BAND_HEIGHT);
    const sub = drawnGroundSubcell(map, SADDLE_SUBCELL, SADDLE_SUBCELL);
    expect(sub.treads.find((t) => t.band === SADDLE_BAND)?.pieces).toHaveLength(1);
    expect(sub.treads.find((t) => t.band === SADDLE_BAND - 1)?.pieces).toHaveLength(2);
    expect(sub.risers.filter((r) => r.band === SADDLE_BAND)).toHaveLength(2);
  });

  it('separates the high corners of a saddle across a low centre', () => {
    const map = saddleWorld(SADDLE_SPLIT_CORNER);
    const centre = drawnGroundHeight(map, SADDLE_SUBCELL_CENTRE, SADDLE_SUBCELL_CENTRE);
    expect(centre).toBe((SADDLE_BAND - 1) * BAND_HEIGHT);
    const sub = drawnGroundSubcell(map, SADDLE_SUBCELL, SADDLE_SUBCELL);
    expect(sub.treads.find((t) => t.band === SADDLE_BAND)?.pieces).toHaveLength(2);
    expect(sub.treads.find((t) => t.band === SADDLE_BAND - 1)?.pieces).toHaveLength(1);
    expect(sub.risers.filter((r) => r.band === SADDLE_BAND)).toHaveLength(2);
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
    const corner = drawnGroundHeight(map, 0, 0);
    for (const [x, y] of [
      [-0.125, -0.125],
      [-5, -5],
      [-1000, -1000],
    ] as const) {
      expect(drawnGroundHeight(map, x, y)).toBe(corner);
    }
    const far = drawnGroundHeight(map, WORLD_SIZE, WORLD_SIZE);
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
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(topDrawnBandByScan(map, 4.5, 4.5) * BAND_HEIGHT);
  });

  it('descends past an overhang whose cell height is not a drawn cap', () => {
    const map = flatWorld(0);
    setColumn(map, 4, 4, [
      { floor: BEDROCK_FLOOR, ceiling: CAVE_FLOOR_CAP },
      { floor: 88, ceiling: CAVE_ROOF_CAP },
    ]);
    expect(map.cells[cellIndex(map, 4, 4)]).toBe(CAVE_ROOF_CAP);
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(BAND_HEIGHT);
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(topDrawnBandByScan(map, 4.5, 4.5) * BAND_HEIGHT);
  });

  it('ignores a non-drawn top span that a wire payload seated', () => {
    const map = flatWorld(0);
    const seated = applyPackedSpans(map, 4, 4, [BEDROCK_FLOOR, 32, 65, 79]);
    expect(seated).toBe(true);
    expect(isSpanDrawn(topSpan(map, 4, 4))).toBe(false);
    expect(map.cells[cellIndex(map, 4, 4)]).toBe(79);
    expect(spanCount(map, 4, 4)).toBeGreaterThan(1);
    expect(drawnGroundHeight(map, 4.5, 4.5)).toBe(topDrawnBandByScan(map, 4.5, 4.5) * BAND_HEIGHT);
  });

  it('clamps non-finite coordinates to the border on both axes', () => {
    const map = roughWorld();
    const low = drawnGroundHeight(map, 0, 0);
    const high = drawnGroundHeight(map, WORLD_SIZE, WORLD_SIZE);
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY] as const) {
      expect(drawnGroundHeight(map, bad, 0)).toBe(low);
      expect(drawnGroundHeight(map, 0, bad)).toBe(low);
      expect(drawnGroundHeight(map, bad, bad)).toBe(low);
    }
    expect(drawnGroundHeight(map, Number.POSITIVE_INFINITY, WORLD_SIZE)).toBe(high);
    expect(drawnGroundHeight(map, WORLD_SIZE, Number.POSITIVE_INFINITY)).toBe(high);
    expect(drawnGroundHeight(map, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(high);
    expect(drawnGroundHeight(map, Number.POSITIVE_INFINITY, Number.NaN)).toBe(
      drawnGroundHeight(map, WORLD_SIZE, 0),
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

  it('clamps non-finite coordinates to the border on both axes', () => {
    const map = roughWorld();
    for (let band = FLOOR_BAND; band <= TOP_BAND; band++) {
      const low = drawnGroundCoversBand(map, 0, 0, band);
      const high = drawnGroundCoversBand(map, WORLD_SIZE, WORLD_SIZE, band);
      for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY] as const) {
        expect(drawnGroundCoversBand(map, bad, 0, band)).toBe(low);
        expect(drawnGroundCoversBand(map, 0, bad, band)).toBe(low);
      }
      const far = Number.POSITIVE_INFINITY;
      expect(drawnGroundCoversBand(map, far, WORLD_SIZE, band)).toBe(high);
      expect(drawnGroundCoversBand(map, WORLD_SIZE, far, band)).toBe(high);
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

describe('drawnGroundSubcell', () => {
  it('tiles every sub-cell with its treads', () => {
    const map = roughWorld();
    for (let sy = 0; sy < WORLD_SIZE * LATTICE_N; sy++) {
      for (let sx = 0; sx < WORLD_SIZE * LATTICE_N; sx++) {
        const sub = drawnGroundSubcell(map, sx, sy);
        let area = 0;
        for (const tread of sub.treads)
          for (const piece of tread.pieces) area += polygonArea(piece);
        expect(area).toBeCloseTo(1 / (LATTICE_N * LATTICE_N), 12);
        expect(sub.treads.map((t) => t.band)).toEqual(
          Array.from({ length: sub.highBand - sub.lowBand + 1 }, (_, i) => sub.lowBand + i),
        );
      }
    }
  });

  it('puts every riser end on the sub-cell boundary', () => {
    const map = roughWorld();
    for (let sy = 0; sy < WORLD_SIZE * LATTICE_N; sy++) {
      for (let sx = 0; sx < WORLD_SIZE * LATTICE_N; sx++) {
        const sub = drawnGroundSubcell(map, sx, sy);
        for (const riser of sub.risers) {
          expect(riser.band).toBeGreaterThan(sub.lowBand);
          expect(riser.band).toBeLessThanOrEqual(sub.highBand);
          for (const end of [riser.from, riser.to]) {
            const u = end.x * LATTICE_N - sx;
            const v = end.y * LATTICE_N - sy;
            expect(u).toBeGreaterThanOrEqual(-1e-12);
            expect(u).toBeLessThanOrEqual(1 + 1e-12);
            expect(v).toBeGreaterThanOrEqual(-1e-12);
            expect(v).toBeLessThanOrEqual(1 + 1e-12);
            const onEdge = [u, v].some((c) => Math.abs(c) < 1e-12 || Math.abs(c - 1) < 1e-12);
            expect(onEdge).toBe(true);
          }
        }
      }
    }
  });

  it('reports each near sub-cell band span of a chunk', () => {
    const map = roughWorld();
    const perSide = CHUNK_SIZE * LATTICE_N;
    const spans = drawnGroundChunkBandSpans(map, 0, 0);
    expect(spans).toHaveLength(perSide * perSide);
    for (let sy = 0; sy < perSide; sy++) {
      for (let sx = 0; sx < perSide; sx++) {
        const sub = drawnGroundSubcell(map, sx, sy);
        expect(spans[sy * perSide + sx]).toBe(sub.highBand - sub.lowBand);
      }
    }
  });

  it('describes a far-level sub-cell on the same lattice', () => {
    const map = roughWorld();
    const stride = LATTICE_N / TERRAIN_LOD_FAR_N;
    for (let sy = 0; sy < WORLD_SIZE * TERRAIN_LOD_FAR_N; sy++) {
      for (let sx = 0; sx < WORLD_SIZE * TERRAIN_LOD_FAR_N; sx++) {
        const sub = drawnGroundSubcell(map, sx, sy, TERRAIN_LOD_FAR_N);
        const bands = drawnGroundSubcellBands(map, sx, sy, TERRAIN_LOD_FAR_N);
        expect(bands).toEqual({ lowBand: sub.lowBand, highBand: sub.highBand });
        let area = 0;
        for (const tread of sub.treads)
          for (const piece of tread.pieces) area += polygonArea(piece);
        expect(area).toBeCloseTo(1 / (TERRAIN_LOD_FAR_N * TERRAIN_LOD_FAR_N), 12);
        const corners = [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ] as const;
        const cornerBands = corners.map(([u, v]) =>
          bandOf(bilinear(map, ((sx + u) * stride) / LATTICE_N, ((sy + v) * stride) / LATTICE_N)),
        );
        expect(sub.lowBand).toBe(Math.min(...cornerBands));
        expect(sub.highBand).toBe(Math.max(...cornerBands));
      }
    }
    const farSpans = drawnGroundChunkBandSpans(map, 0, 0, TERRAIN_LOD_FAR_N);
    expect(farSpans).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
    for (let sy = 0; sy < CHUNK_SIZE; sy++) {
      for (let sx = 0; sx < CHUNK_SIZE; sx++) {
        const bands = drawnGroundSubcellBands(map, sx, sy, TERRAIN_LOD_FAR_N);
        expect(farSpans[sy * CHUNK_SIZE + sx]).toBe(bands.highBand - bands.lowBand);
      }
    }
  });

  it('rejects a level off the lattice', () => {
    const map = flatWorld(0);
    expect(() => drawnGroundSubcell(map, 0, 0, 3)).toThrow(RangeError);
    expect(() => drawnGroundSubcellBands(map, 0, 0, 8)).toThrow(RangeError);
  });

  it('flags the sub-cells whose corners blend from a layered column', () => {
    const map = cavedWorld();
    expect(drawnGroundSubcellIsLayered(map, 18, 18)).toBe(true);
    expect(drawnGroundSubcellIsLayered(map, 0, 0)).toBe(false);
    expect(drawnGroundSubcellIsLayered(map, 30, 30)).toBe(false);
    expect(drawnGroundSubcellIsLayered(map, 4, 4, TERRAIN_LOD_FAR_N)).toBe(true);
    expect(drawnGroundSubcellIsLayered(map, 0, 0, TERRAIN_LOD_FAR_N)).toBe(false);
  });
});

describe('drawnGroundFarHeight', () => {
  it('equals the near height at far lattice corners', () => {
    const map = roughWorld();
    const stride = LATTICE_N / TERRAIN_LOD_FAR_N;
    for (let ly = 0; ly <= WORLD_SIZE * LATTICE_N; ly += stride) {
      for (let lx = 0; lx <= WORLD_SIZE * LATTICE_N; lx += stride) {
        const x = lx / LATTICE_N;
        const y = ly / LATTICE_N;
        expect(drawnGroundFarHeight(map, x, y)).toBe(drawnGroundHeight(map, x, y));
      }
    }
  });

  it('is the flat band on a flat world', () => {
    const map = flatWorld(48);
    forEachSample((x, y) => expect(drawnGroundFarHeight(map, x, y)).toBe(48));
  });
});

describe('drawnGroundLodError', () => {
  it('is zero on a flat world', () => {
    expect(drawnGroundLodError(flatWorld(32), 0, 0)).toBe(0);
  });

  it('is the worst near-versus-far gap at the near sub-cell centres', () => {
    for (const map of [roughWorld(), cavedWorld()]) {
      let worst = 0;
      for (let sy = 0; sy < CHUNK_SIZE * LATTICE_N; sy++) {
        for (let sx = 0; sx < CHUNK_SIZE * LATTICE_N; sx++) {
          const x = (sx + 0.5) / LATTICE_N;
          const y = (sy + 0.5) / LATTICE_N;
          worst = Math.max(
            worst,
            Math.abs(drawnGroundHeight(map, x, y) - drawnGroundFarHeight(map, x, y)),
          );
        }
      }
      expect(drawnGroundLodError(map, 0, 0)).toBe(worst);
    }
  });
});
