import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  DEFAULT_WORLD_SIZE,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  NEIGHBOURHOOD_CELLS,
  SEA_LEVEL,
  WORLD_UNIT_CELLS,
  applySculpt,
  createHeightmap,
  heightAt,
  quantizeToBand,
  CONTOUR_CELL_CENTRE_GUARD,
  DRAWN_GROUND_BAND_BIAS,
  ISOLINE_SAMPLES_PER_CELL,
  drawnBandOfSample,
  type ChunkPayload,
  type SculptAnchor,
  type SculptProfile,
} from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  CHUNK_TRIANGLE_BUDGET,
  CHUNK_POLYGON_WORK_BUDGET,
  CHUNK_TRIANGULATION_WORK_BUDGET,
  FALLBACK_MAX_TRIANGLES,
  INITIAL_CHUNK_TRIANGLE_CAPACITY,
  LATTICE_PER_CHUNK,
  LIT_BY_SCENE,
  SEABED_RISER_BORDER_WORLD_HEIGHT,
  SELF_LIT_ALPHA_BYTE,
  SKIRT_PICK_INSET,
  COLOR_ALPHA_INDEX,
  COMPONENTS_PER_COLOR,
  // COMPONENTS_PER_NORMAL,
  VERTICES_PER_TRIANGLE,
  chunkCapTriangles,
  chunkContourLoops,
  createChunkGeometryBuffers,
  writeChunkVertexData,
  type ChunkGeometryBuffers,
  type ChunkGeometryCounts,
  type ChunkPalettes,
} from '../src/terrain/vertexGrid.ts';
import {
  CLIFF_PALETTE,
  FIRST_LAND_PALETTE_INDEX,
  TERRAIN_PALETTE,
  bandPaletteIndex,
  type Rgb,
} from '../src/terrain/bandColors.ts';
import { worldPointToCell } from '../src/terrain/picking.ts';
import {
  BAND_WORLD_HEIGHT,
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
} from '../src/config.ts';

const WORLD = NEIGHBOURHOOD_CELLS * 4;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

const EDGE_CHUNK = WORLD / CHUNK_SIZE - 1;
const EDGE_ORIGIN = EDGE_CHUNK * CHUNK_SIZE;

const FIXTURE_CHUNK = NEIGHBOURHOOD_CELLS / CHUNK_SIZE;
const FIXTURE_ORIGIN = FIXTURE_CHUNK * CHUNK_SIZE;

const PALETTES: ChunkPalettes = { top: TERRAIN_PALETTE, cliff: CLIFF_PALETTE };

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

function chunkPayloadFrom(
  cx: number,
  cy: number,
  height: (x: number, y: number) => number,
): ChunkPayload {
  const heights: number[] = [];
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      heights.push(height(cx * CHUNK_SIZE + i, cy * CHUNK_SIZE + j));
    }
  }
  return { cx, cy, heights };
}

function edgeChunk(height: (i: number, j: number) => number): ChunkPayload {
  return chunkPayloadFrom(EDGE_CHUNK, EDGE_CHUNK, (x, y) =>
    height(x - EDGE_ORIGIN, y - EDGE_ORIGIN),
  );
}

interface Vertex {
  x: number;
  y: number;
  z: number;
}

interface Triangle {
  a: Vertex;
  b: Vertex;
  c: Vertex;
  normal: Vertex;
  color: number[];
  selfLit: number;
}

function vertexAt(buffers: ChunkGeometryBuffers, index: number): Vertex {
  const base = index * 3;
  return {
    x: buffers.positions[base],
    y: buffers.positions[base + 1],
    z: buffers.positions[base + 2],
  };
}

// const SIGNED_BYTE_SCALE = 127;
const UNSIGNED_BYTE_SCALE = 255;

// What flat shading derives: the winding's face normal.
function faceNormal(a: Vertex, b: Vertex, c: Vertex): Vertex {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z);
  if (length === 0) return { x: 0, y: 0, z: 0 };
  return { x: x / length + 0, y: y / length + 0, z: z / length + 0 };
}

function trianglesOf(
  buffers: ChunkGeometryBuffers,
  counts: ChunkGeometryCounts,
): Triangle[] {
  const out: Triangle[] = [];
  for (let t = 0; t < counts.triangleCount; t++) {
    const base = t * VERTICES_PER_TRIANGLE;
    const a = vertexAt(buffers, base);
    const b = vertexAt(buffers, base + 1);
    const c = vertexAt(buffers, base + 2);
    out.push({
      a,
      b,
      c,
      normal: faceNormal(a, b, c),
      // normal: {
      //   x: buffers.normals[base * COMPONENTS_PER_NORMAL] / SIGNED_BYTE_SCALE,
      //   y: buffers.normals[base * COMPONENTS_PER_NORMAL + 1] / SIGNED_BYTE_SCALE,
      //   z: buffers.normals[base * COMPONENTS_PER_NORMAL + 2] / SIGNED_BYTE_SCALE,
      // },
      color: [
        buffers.colors[base * COMPONENTS_PER_COLOR] / UNSIGNED_BYTE_SCALE,
        buffers.colors[base * COMPONENTS_PER_COLOR + 1] / UNSIGNED_BYTE_SCALE,
        buffers.colors[base * COMPONENTS_PER_COLOR + 2] / UNSIGNED_BYTE_SCALE,
      ],
      selfLit: selfLitOf(buffers, base),
    });
  }
  return out;
}

function colorAlphaOf(buffers: ChunkGeometryBuffers, vertex: number): number {
  return buffers.colors[vertex * COMPONENTS_PER_COLOR + COLOR_ALPHA_INDEX];
}

function colorAlphasFrom(buffers: ChunkGeometryBuffers, fromVertex: number): number[] {
  const alphas: number[] = [];
  for (let v = fromVertex; v * COMPONENTS_PER_COLOR < buffers.colors.length; v++) {
    alphas.push(colorAlphaOf(buffers, v));
  }
  return alphas;
}

function selfLitOf(buffers: ChunkGeometryBuffers, base: number): number {
  const value = colorAlphaOf(buffers, base);
  expect(colorAlphaOf(buffers, base + 1)).toBe(value);
  expect(colorAlphaOf(buffers, base + 2)).toBe(value);
  return value;
}

const capsOf = (triangles: Triangle[]): Triangle[] =>
  triangles.filter((t) => t.normal.y === 1);
const skirtsOf = (triangles: Triangle[]): Triangle[] =>
  triangles.filter((t) => t.normal.y === 0);

const asStoredBytes = (rgb: readonly number[]): number[] =>
  [0, 1, 2].map((ch) => Math.round(rgb[ch] * UNSIGNED_BYTE_SCALE));

function expectColor(actual: readonly number[], expected: Rgb): void {
  expect(asStoredBytes(actual)).toEqual(asStoredBytes(expected));
}

function coversXZ(t: Triangle, x: number, z: number): boolean {
  const area =
    (t.b.x - t.a.x) * (t.c.z - t.a.z) - (t.b.z - t.a.z) * (t.c.x - t.a.x);
  if (Math.abs(area) < 1e-12) return false;
  const sign = (px: number, pz: number, a: Vertex, b: Vertex): number =>
    (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
  const d1 = sign(x, z, t.a, t.b);
  const d2 = sign(x, z, t.b, t.c);
  const d3 = sign(x, z, t.c, t.a);
  const anyNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const anyPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(anyNegative && anyPositive);
}

function topmostCapY(triangles: Triangle[], cellX: number, cellZ: number): number | null {
  const x = cellX * CELL_WORLD_SIZE;
  const z = cellZ * CELL_WORLD_SIZE;
  let best: number | null = null;
  for (const cap of capsOf(triangles)) {
    if (!coversXZ(cap, x, z)) continue;
    if (best === null || cap.a.y > best) best = cap.a.y;
  }
  return best;
}

function write(
  mirror: ReturnType<typeof createTerrainMirror>,
  cx: number,
  cy: number,
): { buffers: ChunkGeometryBuffers; counts: ChunkGeometryCounts; triangles: Triangle[] } {
  const buffers = createChunkGeometryBuffers();
  const counts = writeChunkVertexData(mirror, cx, cy, buffers, PALETTES);
  return { buffers, counts, triangles: trianglesOf(buffers, counts) };
}

function mirrorWith(chunks: ChunkPayload[]) {
  const mirror = createTerrainMirror(WORLD);
  applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks });
  return mirror;
}

function writeEdge(height: (i: number, j: number) => number) {
  return write(mirrorWith([edgeChunk(height)]), EDGE_CHUNK, EDGE_CHUNK);
}

interface Stroke {
  dx: number;
  dy: number;
  radius: number;
  clicks: number;
  up?: boolean;
  profile?: SculptProfile;
  anchor?: SculptAnchor;
}

const SCULPT_CENTRE = FIXTURE_ORIGIN + CHUNK_SIZE / 2;

const CRATER_STROKES: readonly Stroke[] = [
  { dx: 0, dy: 0, radius: 4, clicks: 4 },
  { dx: 2, dy: 1, radius: 4, clicks: 3 },
  { dx: -2, dy: 2, radius: 4, clicks: 3 },
  { dx: 1, dy: -3, radius: 3, clicks: 3 },
  { dx: -3, dy: -1, radius: 3, clicks: 3 },
  { dx: 0, dy: 3, radius: 2, clicks: 4 },
  { dx: 0, dy: 0, radius: 2, clicks: 6 },
  { dx: -1, dy: 0, radius: 1, clicks: 4 },
  { dx: 2, dy: -1, radius: 1, clicks: 3 },
  { dx: 1, dy: 1, radius: 1, clicks: 4, up: true },
  { dx: -2, dy: -2, radius: 1, clicks: 6, up: true },
  { dx: 3, dy: -2, radius: 1, clicks: 3, up: true },
  { dx: -3, dy: 3, radius: 1, clicks: 5, up: true },
  { dx: 2, dy: 3, radius: 1, clicks: 2, up: true },
];

const SPIRE_STROKES: readonly Stroke[] = [
  { dx: -4, dy: -4, radius: 1, clicks: 7, up: true },
  { dx: 4, dy: -3, radius: 1, clicks: 5, up: true },
  { dx: -3, dy: 4, radius: 1, clicks: 9, up: true },
  { dx: 5, dy: 4, radius: 1, clicks: 4, up: true },
  { dx: 0, dy: -6, radius: 1, clicks: 6, up: true },
  { dx: 6, dy: 0, radius: 2, clicks: 3, up: true },
];

const offsetStrokes = (strokes: readonly Stroke[], dx: number, dy: number): Stroke[] =>
  strokes.map((s) => ({ ...s, dx: s.dx + dx, dy: s.dy + dy }));

const pitsEveryCells = (stepCells: number, radiusCells = MIN_BRUSH_RADIUS): Stroke[] => {
  const out: Stroke[] = [];
  const step = stepCells / WORLD_UNIT_CELLS;
  const radius = radiusCells / WORLD_UNIT_CELLS;
  for (let dx = -8; dx <= 8; dx += step) {
    for (let dy = -8; dy <= 8; dy += step) out.push({ dx, dy, radius, clicks: 3 });
  }
  return out;
};

const PLAYER_FINEST_BRUSH_CELLS = WORLD_UNIT_CELLS;

const spireField = (): Stroke[] =>
  pitsEveryCells(2 * WORLD_UNIT_CELLS, PLAYER_FINEST_BRUSH_CELLS).map((s) => ({
    ...s,
    up: true as const,
  }));

const SHELF_BASE = -2 * BAND_HEIGHT;

const scaledStrokes = (strokes: readonly Stroke[], factor: number): Stroke[] =>
  strokes.map((s) => ({ ...s, clicks: s.clicks * factor }));

const asDeepPlay = (strokes: readonly Stroke[]): Stroke[] =>
  strokes.map((s) => ({ ...s, anchor: 'clicked' as const }));

const SHELF_TO_FLOOR_BANDS = (SHELF_BASE - MIN_HEIGHT) / BAND_HEIGHT;

const AUTHORED_SHELF_TO_FLOOR_BANDS = 22;

const DEEP_DIG_SCALE = Math.ceil(SHELF_TO_FLOOR_BANDS / AUTHORED_SHELF_TO_FLOOR_BANDS);

const DEEP_PIT_STROKES: readonly Stroke[] = asDeepPlay(
  scaledStrokes(
    [
      { dx: 0, dy: 0, radius: 4, clicks: 10, profile: 'hard' },
      { dx: 1, dy: 1, radius: 4, clicks: 8, profile: 'hard' },
      { dx: -1, dy: 0, radius: 4, clicks: 8, profile: 'hard' },
      { dx: 0, dy: -2, radius: 3, clicks: 6, profile: 'hard' },
      { dx: 2, dy: 2, radius: 3, clicks: 4, profile: 'hard' },
    ],
    DEEP_DIG_SCALE,
  ),
);

const DEEP_CRATER_STROKES: readonly Stroke[] = asDeepPlay(
  scaledStrokes(
    [
      ...scaledStrokes(CRATER_STROKES, 3),
      { dx: 0, dy: 0, radius: 3, clicks: 10 },
      { dx: 1, dy: -1, radius: 2, clicks: 8 },
    ],
    DEEP_DIG_SCALE,
  ),
);

function sculptedWorld(strokes: readonly Stroke[], base: number): ChunkPayload[] {
  const map = createHeightmap(WORLD);
  map.cells.fill(base);
  for (const stroke of strokes) {
    for (let click = 0; click < stroke.clicks; click++) {
      applySculpt(
        map,
        SCULPT_CENTRE + stroke.dx * WORLD_UNIT_CELLS,
        SCULPT_CENTRE + stroke.dy * WORLD_UNIT_CELLS,
        stroke.radius * WORLD_UNIT_CELLS,
        stroke.up ? DEFAULT_SCULPT_AMOUNT : -DEFAULT_SCULPT_AMOUNT,
        {
          tool: 'stamp',
          profile: stroke.profile ?? 'soft',
          anchor: stroke.anchor ?? 'free',
        },
      );
    }
  }
  const chunks: ChunkPayload[] = [];
  const perEdge = WORLD / CHUNK_SIZE;
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      chunks.push(
        chunkPayloadFrom(cx, cy, (x, y) => heightAt(map, x, y)),
      );
    }
  }
  return chunks;
}

function writeSculpted(strokes: readonly Stroke[], base = 8 * BAND_HEIGHT) {
  const mirror = mirrorWith(sculptedWorld(strokes, base));
  return write(mirror, FIXTURE_CHUNK, FIXTURE_CHUNK);
}

function worstSculptedChunk(strokes: readonly Stroke[], base = 8 * BAND_HEIGHT) {
  const mirror = mirrorWith(sculptedWorld(strokes, base));
  const perEdge = WORLD / CHUNK_SIZE;
  let anyFallback = false;
  let maxTriangles = 0;
  let maxWork = 0;
  let maxPolygon = 0;
  let skirtTriangles = 0;
  let capTriangles = 0;
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      const { counts } = write(mirror, cx, cy);
      if (counts.usedFallback) anyFallback = true;
      if (counts.triangleCount > maxTriangles) maxTriangles = counts.triangleCount;
      if (counts.triangulationWork > maxWork) maxWork = counts.triangulationWork;
      if (counts.maxPolygonWork > maxPolygon) maxPolygon = counts.maxPolygonWork;
      skirtTriangles += counts.skirtTriangleCount;
      capTriangles += counts.capTriangleCount;
    }
  }
  return { anyFallback, maxTriangles, maxWork, maxPolygon, skirtTriangles, capTriangles };
}

describe('flat terrain', () => {
  it('draws a whole-chunk cap for the one band present, and nothing else', () => {
    const { counts, triangles } = writeEdge(() => BAND_HEIGHT);
    expect(counts.skirtTriangleCount).toBe(0);
    expect(counts.capTriangleCount).toBe(2);
    for (const cap of capsOf(triangles)) {
      for (const corner of [cap.a, cap.b, cap.c]) {
        expect(corner.y).toBeCloseTo(BAND_WORLD_HEIGHT);
      }
    }
  });

  it('covers the chunk domain exactly: cell centres in, the next chunk out', () => {
    const { triangles } = writeEdge(() => BAND_HEIGHT);
    expect(topmostCapY(triangles, EDGE_ORIGIN, EDGE_ORIGIN)).toBeCloseTo(
      BAND_WORLD_HEIGHT,
    );
    expect(
      topmostCapY(triangles, EDGE_ORIGIN + CHUNK_SIZE, EDGE_ORIGIN + CHUNK_SIZE),
    ).toBeCloseTo(BAND_WORLD_HEIGHT);
    expect(topmostCapY(triangles, EDGE_ORIGIN - 0.5, EDGE_ORIGIN + 4)).toBeNull();
  });

  it('points every cap straight up and every skirt sideways', () => {
    const { triangles } = writeEdge((i) => (i < 8 ? 0 : 256));
    for (const cap of capsOf(triangles)) {
      expect(cap.normal).toEqual({ x: 0, y: 1, z: 0 });
    }
    const skirts = skirtsOf(triangles);
    expect(skirts.length).toBeGreaterThan(0);
    for (const skirt of skirts) {
      expect(skirt.normal.y).toBe(0);
      expect(Math.hypot(skirt.normal.x, skirt.normal.z)).toBeCloseTo(1, 6);
    }
  });

  it('winds caps so they face up (+Y)', () => {
    const { triangles } = write(mirrorWith([chunkPayload(0, 0, 0)]), 0, 0);
    const cap = capsOf(triangles)[0];
    const e1 = { x: cap.b.x - cap.a.x, z: cap.b.z - cap.a.z };
    const e2 = { x: cap.c.x - cap.a.x, z: cap.c.z - cap.a.z };
    expect(e1.z * e2.x - e1.x * e2.z).toBeGreaterThan(0);
  });
});

describe('the waterline', () => {
  it('keeps DRY band-0 land at exactly y = 0, so the sea cannot z-fight it', () => {
    const { triangles } = write(mirrorWith([chunkPayload(0, 0, SEA_LEVEL + 1)]), 0, 0);
    const shore = capsOf(triangles).filter((t) => t.a.y === 0);
    expect(shore.length).toBeGreaterThan(0);
    expectColor(shore[0].color, TERRAIN_PALETTE[bandPaletteIndex(SEA_LEVEL + 1)]);
  });

  it('paints a freshly generated (all-zero) world as seabed a band down, never at the waterline', () => {
    const { triangles } = write(mirrorWith([chunkPayload(0, 0, 0)]), 0, 0);
    const caps = capsOf(triangles);
    expect(caps.length).toBe(2);
    for (const cap of caps) {
      expectColor(cap.color, TERRAIN_PALETTE[bandPaletteIndex(-BAND_HEIGHT)]);
      expect(cap.a.y).toBeCloseTo(-BAND_WORLD_HEIGHT);
    }
  });
});

describe('organic outlines', () => {
  it('puts a one-band step on the boundary between the two cells', () => {
    const mirror = mirrorWith([edgeChunk((i) => (i < 8 ? 0 : BAND_HEIGHT))]);
    const loops = chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, BAND_HEIGHT);
    expect(loops).toHaveLength(1);
    const interior = loops[0].filter(
      (p) => p.x > EDGE_ORIGIN && p.x < EDGE_ORIGIN + CHUNK_SIZE,
    );
    expect(interior.length).toBeGreaterThan(0);
    const expected = EDGE_ORIGIN + 7.5;
    for (const p of interior) expect(p.x).toBeCloseTo(expected, 6);
  });

  it('stacks a multi-band drop as a staircase of contours, not one wall', () => {
    const mirror = mirrorWith([edgeChunk((i) => (i < 8 ? 0 : 4 * BAND_HEIGHT))]);
    const positions: number[] = [];
    for (let k = 1; k <= 4; k++) {
      const loops = chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, k * BAND_HEIGHT);
      const interior = loops[0].filter(
        (p) => p.x > EDGE_ORIGIN && p.x < EDGE_ORIGIN + CHUNK_SIZE,
      );
      positions.push(interior[0].x - EDGE_ORIGIN);
    }
    for (let k = 1; k < positions.length; k++) {
      expect(positions[k]).toBeGreaterThan(positions[k - 1]);
    }
    expect(positions[0]).toBeCloseTo(7.125, 6);
    expect(positions[3]).toBeCloseTo(7.875, 6);
  });

  it('follows a gradient diagonally instead of stepping around cells', () => {
    const { triangles } = writeEdge((i, j) => (i + j) * 12);
    const angled = skirtsOf(triangles).filter((t) => {
      const dx = Math.abs(t.b.x - t.a.x);
      const dz = Math.abs(t.b.z - t.a.z);
      return dx > 1e-6 && dz > 1e-6;
    });
    expect(angled.length).toBeGreaterThan(0);
  });

  it('rounds the outline: isoline samples, no 90° turns left', () => {
    const mirror = mirrorWith([edgeChunk((i, j) => (i > 4 && j > 4 ? 128 : 0))]);
    const loops = chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, BAND_HEIGHT);
    const corner = loops[0].filter((p) => !p.onBorder);
    expect(ISOLINE_SAMPLES_PER_CELL).toBe(4);
    let squareTurns = 0;
    for (let i = 1; i + 1 < corner.length; i++) {
      const ax = corner[i].x - corner[i - 1].x;
      const az = corner[i].z - corner[i - 1].z;
      const bx = corner[i + 1].x - corner[i].x;
      const bz = corner[i + 1].z - corner[i].z;
      const dot = ax * bx + az * bz;
      if (Math.abs(dot) < 1e-9 && Math.hypot(ax, az) > 1e-9) squareTurns++;
    }
    expect(squareTurns).toBe(0);
  });
});

describe('single-cell features', () => {
  const distanceTo = (p: { x: number; z: number }, cx: number, cz: number): number =>
    Math.hypot(p.x - cx, p.z - cz);

  it('renders a one-cell spire as a small rounded column', () => {
    const spire = { i: 5, j: 6 };
    const mirror = mirrorWith([
      edgeChunk((i, j) => (i === spire.i && j === spire.j ? BAND_HEIGHT : 0)),
    ]);
    const loops = chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, BAND_HEIGHT);
    expect(loops).toHaveLength(1);
    const centreX = EDGE_ORIGIN + spire.i;
    const centreZ = EDGE_ORIGIN + spire.j;

    expect(loops[0].length).toBeGreaterThan(8);
    for (const p of loops[0]) {
      const d = distanceTo(p, centreX, centreZ);
      expect(d).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(d).toBeGreaterThanOrEqual(CONTOUR_CELL_CENTRE_GUARD - 1e-9);
    }

    const { triangles } = write(mirror, EDGE_CHUNK, EDGE_CHUNK);
    expect(topmostCapY(triangles, centreX, centreZ)).toBeCloseTo(BAND_WORLD_HEIGHT);
    expect(skirtsOf(triangles).length).toBeGreaterThan(8);
  });

  it('renders a one-cell pit as a rounded well, as a hole in the plateau', () => {
    const pit = { i: 9, j: 4 };
    const mirror = mirrorWith([
      edgeChunk((i, j) => (i === pit.i && j === pit.j ? 0 : BAND_HEIGHT)),
    ]);
    const loops = chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, BAND_HEIGHT);
    expect(loops).toHaveLength(2);
    const well = loops.find((loop) => loop.every((p) => !p.onBorder));
    expect(well).toBeDefined();
    const centreX = EDGE_ORIGIN + pit.i;
    const centreZ = EDGE_ORIGIN + pit.j;
    expect(well!.length).toBeGreaterThan(8);
    for (const p of well!) {
      const d = distanceTo(p, centreX, centreZ);
      expect(d).toBeGreaterThan(0.25);
      expect(d).toBeLessThanOrEqual(0.5 + 1e-9);
    }

    const { triangles } = write(mirror, EDGE_CHUNK, EDGE_CHUNK);
    expect(topmostCapY(triangles, centreX, centreZ)).toBeCloseTo(-BAND_WORLD_HEIGHT);
  });
});

describe('honesty — the render never lies about the heightmap', () => {
  function expectHonest(
    height: (i: number, j: number) => number,
    probeRadius = 0,
  ): ChunkGeometryCounts {
    const { triangles, counts } = writeEdge(height);
    for (let j = 1; j < CHUNK_SIZE; j++) {
      for (let i = 1; i < CHUNK_SIZE; i++) {
        const expected = drawnBandOfSample(height(i, j)) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
        const x = EDGE_ORIGIN + i;
        const z = EDGE_ORIGIN + j;
        const probes: [number, number][] = [[x, z]];
        if (probeRadius > 0) {
          probes.push(
            [x + probeRadius, z],
            [x - probeRadius, z],
            [x, z + probeRadius],
            [x, z - probeRadius],
          );
        }
        for (const [px, pz] of probes) {
          const actual = topmostCapY(triangles, px, pz);
          expect(actual, `cell (${i},${j}) at (${px},${pz})`).not.toBeNull();
          const tolerance = 1e-6;
          expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);
        }
      }
    }
    return counts;
  }

  it('holds over a stamped, terraced landscape', () => {
    expectHonest((i, j) => ((i * 37 + j * 11) % 5) * BAND_HEIGHT);
  });

  it('holds over a smooth landscape with mid-band gradients', () => {
    expectHonest((i, j) => Math.round(i * 13 + j * 29 + Math.sin(i * j) * 40));
  });

  it('holds under water as well as above it', () => {
    expectHonest((i, j) => ((i + j) % 4) * BAND_HEIGHT - 2 * BAND_HEIGHT);
  });

  it('holds over a whole guard disc around each centre, not just the point', () => {
    expectHonest(
      (i, j) => (((i * 7 + j * 3) % 3) + 1) * BAND_HEIGHT,
      CONTOUR_CELL_CENTRE_GUARD / 2,
    );
  });

  it('holds over a fixture whose every cell sits at a different point in its band', () => {
    expectHonest((i, j) => Math.round(i * 19 + j * 7 + ((i * j) % 13) * 5));
  });

  it('keeps the sample clearance from swamping a real gradient', () => {
    expect(DRAWN_GROUND_BAND_BIAS).toBe(BAND_HEIGHT / 2);
  });
});

describe('triangulation', () => {
  const doubleArea = (t: { x: number; z: number }[]): number =>
    (t[1].x - t[0].x) * (t[2].z - t[0].z) - (t[1].z - t[0].z) * (t[2].x - t[0].x);

  const loopArea = (loop: { x: number; z: number }[]): number => {
    let sum = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      sum += a.x * b.z - b.x * a.z;
    }
    return sum / 2;
  };

  function expectPartition(
    height: (i: number, j: number) => number,
    threshold: number,
  ): void {
    const mirror = mirrorWith([edgeChunk(height)]);
    const triangles = chunkCapTriangles(mirror, EDGE_CHUNK, EDGE_CHUNK, threshold);
    expect(triangles.length).toBeGreaterThan(0);

    let triangleArea = 0;
    for (const triangle of triangles) {
      const twice = doubleArea(triangle);
      expect(twice).toBeGreaterThanOrEqual(0);
      triangleArea += twice / 2;
    }

    let regionArea = 0;
    for (const loop of chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, threshold)) {
      regionArea += loopArea(loop);
    }
    const SLIT_AREA_TOLERANCE = 1e-3;
    expect(Math.abs(triangleArea - regionArea)).toBeLessThan(SLIT_AREA_TOLERANCE);
  }

  it('partitions a plain region', () => {
    expectPartition((i, j) => (i > 4 && j > 4 ? 2 * BAND_HEIGHT : 0), BAND_HEIGHT);
  });

  it('partitions a region with a hole in it', () => {
    expectPartition(
      (i, j) => (i === 9 && j === 4 ? 0 : 2 * BAND_HEIGHT),
      2 * BAND_HEIGHT,
    );
  });

  it('partitions a region with SEVERAL holes, which is where bridges pile up', () => {
    expectPartition(
      (i, j) => Math.round(i * 13 + j * 29 + Math.sin(i * j) * 40),
      4 * BAND_HEIGHT,
    );
  });
});

describe('the blocky fallback', () => {
  const checkerboard = (i: number, j: number): number => ((i + j) % 2) * BAND_HEIGHT;

  it('takes over when a chunk blows the contour budget, and stays bounded', () => {
    const { counts } = writeEdge(checkerboard);
    expect(counts.usedFallback).toBe(true);
    expect(counts.triangleCount).toBeLessThanOrEqual(FALLBACK_MAX_TRIANGLES);
    expect(FALLBACK_MAX_TRIANGLES).toBeLessThan(CHUNK_TRIANGLE_BUDGET);
  });

  it('leaves ordinary sculpted terrain alone', () => {
    const hill = writeEdge((i, j) => Math.round(360 - 3 * ((i - 8) ** 2 + (j - 8) ** 2)));
    expect(hill.counts.usedFallback).toBe(false);
    const blobs = writeEdge((i, j) =>
      Math.round(Math.max(0, 300 - 20 * Math.hypot(i - 5, j - 5))),
    );
    expect(blobs.counts.usedFallback).toBe(false);
  });

  describe('and the sculpted terrain it must NOT take over from', () => {
    it('draws a stamped crater organically', () => {
      const { counts } = writeSculpted(CRATER_STROKES);
      expect(counts.usedFallback).toBe(false);
      expect(counts.capTriangleCount).toBeGreaterThan(500);
      expect(counts.skirtTriangleCount).toBeGreaterThan(500);
    });

    it('draws a crater dug into the sea floor organically too', () => {
      const { counts } = writeSculpted(CRATER_STROKES, 0);
      expect(counts.usedFallback).toBe(false);
    });

    it('draws a crater with disjoint spires around it organically', () => {
      const { counts } = writeSculpted([...CRATER_STROKES, ...SPIRE_STROKES]);
      expect(counts.usedFallback).toBe(false);
    });

    it('draws several craters in one chunk organically', () => {
      const twin = writeSculpted([
        ...CRATER_STROKES,
        ...offsetStrokes(CRATER_STROKES, 6, 6),
      ]);
      expect(twin.counts.usedFallback).toBe(false);

      const ragged = writeSculpted([
        ...CRATER_STROKES,
        ...offsetStrokes(CRATER_STROKES, 6, 6),
        ...offsetStrokes(CRATER_STROKES, -6, 5),
        ...SPIRE_STROKES,
      ]);
      expect(ragged.counts.usedFallback).toBe(false);
      expect(ragged.counts.triangleCount).toBeLessThan(CHUNK_TRIANGLE_BUDGET);
    });

    it('draws a field of stamped spires organically, however many', () => {
      const worst = worstSculptedChunk(pitsEveryCells(2).map((s) => ({ ...s, up: true as const })), 4 * BAND_HEIGHT);
      expect(worst.anyFallback).toBe(false);
      expect(worst.maxTriangles).toBeGreaterThan(4096);
    });
  });

  it('takes over on terrain that is cheap in triangles but not in work', () => {
    expect(worstSculptedChunk(pitsEveryCells(2)).anyFallback).toBe(true);

    const sparse = pitsEveryCells(4 * WORLD_UNIT_CELLS, PLAYER_FINEST_BRUSH_CELLS);
    expect(worstSculptedChunk(sparse).anyFallback).toBe(false);
  });

  it('keeps both budgets above the fallback they fall back TO', () => {
    expect(FALLBACK_MAX_TRIANGLES).toBeLessThan(CHUNK_TRIANGLE_BUDGET);
    expect(CHUNK_TRIANGULATION_WORK_BUDGET).toBeGreaterThan(0);
  });

  it('keeps the honesty invariant, cell for cell', () => {
    const { triangles, counts } = writeEdge(checkerboard);
    expect(counts.usedFallback).toBe(true);
    for (let j = 1; j < CHUNK_SIZE; j++) {
      for (let i = 1; i < CHUNK_SIZE; i++) {
        const expected = drawnBandOfSample(checkerboard(i, j)) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
        expect(topmostCapY(triangles, EDGE_ORIGIN + i, EDGE_ORIGIN + j)).toBeCloseTo(
          expected,
          6,
        );
      }
    }
  });

  it('keeps walls attributed to the higher cell, through the real picking', () => {
    const { triangles } = writeEdge(checkerboard);
    for (const skirt of skirtsOf(triangles)) {
      const cell = worldPointToCell(
        (skirt.a.x + skirt.b.x + skirt.c.x) / 3,
        (skirt.a.z + skirt.b.z + skirt.c.z) / 3,
        WORLD,
      );
      if (cell === null) continue;
      const local = { i: cell.x - EDGE_ORIGIN, j: cell.y - EDGE_ORIGIN };
      expect(checkerboard(local.i, local.j)).toBe(BAND_HEIGHT);
    }
  });

  it('curtains its border so a fallback chunk can never be seen through', () => {
    const { triangles, counts } = writeEdge(checkerboard);
    expect(counts.usedFallback).toBe(true);
    const borderWorldX = EDGE_ORIGIN * CELL_WORLD_SIZE;
    const onWestBorder = skirtsOf(triangles).filter(
      (t) => Math.abs(t.a.x - borderWorldX) < 0.01 && Math.abs(t.b.x - borderWorldX) < 0.01,
    );
    expect(onWestBorder.length).toBeGreaterThan(0);
  });
});

describe('chunk seams', () => {
  function borderPoints(
    mirror: ReturnType<typeof createTerrainMirror>,
    cx: number,
    cy: number,
    threshold: number,
    x: number,
  ): number[] {
    const out: number[] = [];
    for (const loop of chunkContourLoops(mirror, cx, cy, threshold)) {
      for (const p of loop) {
        if (Math.abs(p.x - x) < 1e-12) out.push(p.z);
      }
    }
    return out.sort((a, b) => a - b);
  }

  it('emits IDENTICAL border vertices from both sides of a shared feature', () => {
    const plateau = (x: number, y: number): number =>
      y > 5 && y < 11 ? 3 * BAND_HEIGHT : 0;
    const mirror = mirrorWith([
      chunkPayloadFrom(0, 0, plateau),
      chunkPayloadFrom(1, 0, plateau),
    ]);

    for (let k = 1; k <= 3; k++) {
      const left = borderPoints(mirror, 0, 0, k * BAND_HEIGHT, CHUNK_SIZE);
      const right = borderPoints(mirror, 1, 0, k * BAND_HEIGHT, CHUNK_SIZE);
      expect(left.length).toBeGreaterThan(0);
      expect(right).toEqual(left);
    }
  });

  it('reads one cell PAST its own last row, which is what mirror.ts dirties', () => {
    const before = write(mirrorWith([chunkPayload(0, 0, 0)]), 0, 0);
    const after = write(
      mirrorWith([chunkPayload(0, 0, 0), chunkPayload(1, 0, 4 * BAND_HEIGHT)]),
      0,
      0,
    );
    expect(after.counts.triangleCount).toBeGreaterThan(before.counts.triangleCount);
    expect(LATTICE_PER_CHUNK).toBe(CHUNK_SIZE + 1);
  });

  it('grows no skirt along a chunk border a band simply continues across', () => {
    const mirror = mirrorWith([
      chunkPayload(0, 0, 4 * BAND_HEIGHT),
      chunkPayload(1, 0, 4 * BAND_HEIGHT),
      chunkPayload(0, 1, 4 * BAND_HEIGHT),
      chunkPayload(1, 1, 4 * BAND_HEIGHT),
    ]);
    const { counts } = write(mirror, 0, 0);
    expect(counts.skirtTriangleCount).toBe(0);
  });

  it('grows no skirt where received territory simply ends — the frontier renders like the world border (issue #22)', () => {
    const { counts } = write(mirrorWith([chunkPayload(0, 0, 300)]), 0, 0);
    expect(counts.skirtTriangleCount).toBe(0);
  });

  it('emits no skirt at the world border, where sampling clamps', () => {
    const { counts } = writeEdge(() => 512);
    expect(counts.skirtTriangleCount).toBe(0);
  });
});

describe('skirt picking', () => {
  function bandRisers(triangles: Triangle[]): Triangle[] {
    return skirtsOf(triangles).filter(
      (t) =>
        Math.max(t.a.y, t.b.y, t.c.y) - Math.min(t.a.y, t.b.y, t.c.y) >
        SEABED_RISER_BORDER_WORLD_HEIGHT,
    );
  }

  function cellUnder(riser: Triangle): { x: number; y: number } | null {
    const x = (riser.a.x + riser.b.x + riser.c.x) / 3;
    const z = (riser.a.z + riser.b.z + riser.c.z) / 3;
    return worldPointToCell(x, z, WORLD);
  }

  function cellsUnderSkirts(triangles: Triangle[]): (string | null)[] {
    const cells = new Set<string>();
    for (const riser of bandRisers(triangles)) {
      const cell = cellUnder(riser);
      cells.add(cell === null ? 'null' : `${cell.x},${cell.y}`);
    }
    return Array.from(cells);
  }

  it('resolves every point of a spire wall to the spire itself', () => {
    const { triangles } = writeEdge((i, j) =>
      i === 5 && j === 6 ? 2 * BAND_HEIGHT : BAND_HEIGHT,
    );
    expect(cellsUnderSkirts(triangles)).toEqual([
      `${EDGE_ORIGIN + 5},${EDGE_ORIGIN + 6}`,
    ]);
  });

  it('resolves the straight stretches of a pit wall to the rim, not the floor', () => {
    const { triangles } = writeEdge((i, j) => (i === 9 && j === 4 ? 0 : BAND_HEIGHT));
    const pit = { x: EDGE_ORIGIN + 9, y: EDGE_ORIGIN + 4 };
    const risers = bandRisers(triangles);
    expect(risers.length).toBeGreaterThan(0);

    let straight = 0;
    for (const riser of risers) {
      const cell = cellUnder(riser);
      expect(cell).not.toBeNull();
      expect(Math.abs((cell as { x: number }).x - pit.x)).toBeLessThanOrEqual(1);
      expect(Math.abs((cell as { y: number }).y - pit.y)).toBeLessThanOrEqual(1);

      const x = (riser.a.x + riser.b.x + riser.c.x) / 3 / CELL_WORLD_SIZE;
      const z = (riser.a.z + riser.b.z + riser.c.z) / 3 / CELL_WORLD_SIZE;
      const offAxis = Math.min(Math.abs(x - pit.x), Math.abs(z - pit.y));
      if (offAxis > 0.25) continue;
      straight++;
      expect(cell).toEqual(pit);
    }
    expect(straight).toBeGreaterThan(0);
  });

  it('breaks an exact tie toward the HIGHER side, which is what the inset is for', () => {
    const { triangles } = writeEdge((i) => (i < 8 ? 0 : BAND_HEIGHT));
    const band1Skirts = skirtsOf(triangles).filter(
      (t) => Math.max(t.a.y, t.b.y, t.c.y) === BAND_WORLD_HEIGHT,
    );
    expect(band1Skirts.length).toBeGreaterThan(0);
    for (const skirt of band1Skirts) {
      const cell = worldPointToCell(
        skirt.a.x,
        (EDGE_ORIGIN + 4) * CELL_WORLD_SIZE,
        WORLD,
      );
      expect(cell?.x).toBe(EDGE_ORIGIN + 8);
    }
    expect(SKIRT_PICK_INSET).toBeGreaterThan(0);
    expect(SKIRT_PICK_INSET).toBeLessThan(0.01);
    expect(Number.isInteger(Math.log2(SKIRT_PICK_INSET))).toBe(true);
    const farCell = DEFAULT_WORLD_SIZE - 1 + 0.5;
    expect(Math.round(Math.fround(farCell + SKIRT_PICK_INSET))).toBe(DEFAULT_WORLD_SIZE);
    expect(Math.round(Math.fround(farCell - SKIRT_PICK_INSET))).toBe(DEFAULT_WORLD_SIZE - 1);
  });
});

describe('colour attribution', () => {
  it('paints caps from the band ramp and skirts from the cliff ramp', () => {
    const { triangles } = writeEdge((i) => (i < 8 ? 0 : 300));
    const highCaps = capsOf(triangles).filter(
      (t) => Math.abs(t.a.y - 4 * BAND_WORLD_HEIGHT) < 1e-6,
    );
    expect(highCaps.length).toBeGreaterThan(0);
    expectColor(highCaps[0].color, TERRAIN_PALETTE[bandPaletteIndex(4 * BAND_HEIGHT)]);

    const topSkirts = skirtsOf(triangles).filter(
      (t) => Math.abs(Math.max(t.a.y, t.b.y, t.c.y) - 4 * BAND_WORLD_HEIGHT) < 1e-6,
    );
    expect(topSkirts.length).toBeGreaterThan(0);
    expectColor(topSkirts[0].color, CLIFF_PALETTE[bandPaletteIndex(4 * BAND_HEIGHT)]);
  });

  it('splits each underwater riser into a next-band-down border sliver over a lightened-tread face (owner, 2026-08-19)', () => {
    const { triangles } = writeEdge((i) => (i < 8 ? -3 * BAND_HEIGHT : -BAND_HEIGHT));
    const skirts = skirtsOf(triangles);

    const shelfTop = -1 * BAND_WORLD_HEIGHT;
    const spanOf = (t: Triangle): number =>
      Math.max(t.a.y, t.b.y, t.c.y) - Math.min(t.a.y, t.b.y, t.c.y);
    const topOf = (t: Triangle): number => Math.max(t.a.y, t.b.y, t.c.y);

    const borders = skirts.filter(
      (t) =>
        Math.abs(topOf(t) - shelfTop) < 1e-6 &&
        Math.abs(spanOf(t) - SEABED_RISER_BORDER_WORLD_HEIGHT) < 1e-6,
    );
    expect(borders.length).toBeGreaterThan(0);
    for (const border of borders) {
      expectColor(border.color, TERRAIN_PALETTE[bandPaletteIndex(-2 * BAND_HEIGHT)]);
      expect(border.selfLit).toBe(SELF_LIT_ALPHA_BYTE);
    }

    const faces = skirts.filter(
      (t) => Math.abs(topOf(t) - (shelfTop - SEABED_RISER_BORDER_WORLD_HEIGHT)) < 1e-6,
    );
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(spanOf(face)).toBeCloseTo(
        BAND_WORLD_HEIGHT - SEABED_RISER_BORDER_WORLD_HEIGHT,
        6,
      );
      expectColor(face.color, CLIFF_PALETTE[bandPaletteIndex(-BAND_HEIGHT)]);
      expect(face.selfLit).toBe(SELF_LIT_ALPHA_BYTE);
    }
  });

  it('keeps LAND cliffs single-quad — no border sliver above the waterline', () => {
    const { triangles } = writeEdge((i) => (i < 8 ? 128 : 384));
    const skirts = skirtsOf(triangles);
    expect(skirts.length).toBeGreaterThan(0);
    for (const skirt of skirts) {
      const span =
        Math.max(skirt.a.y, skirt.b.y, skirt.c.y) -
        Math.min(skirt.a.y, skirt.b.y, skirt.c.y);
      expect(span).toBeGreaterThan(SEABED_RISER_BORDER_WORLD_HEIGHT * 2);
    }
  });

  it('makes LAND cliff faces visibly darker than the tread they sit under', () => {
    const luminance = (c: Rgb): number => c[0] + c[1] + c[2];
    for (let i = FIRST_LAND_PALETTE_INDEX; i < TERRAIN_PALETTE.length; i++) {
      expect(luminance(CLIFF_PALETTE[i])).toBeLessThan(
        luminance(TERRAIN_PALETTE[i]) * 0.85,
      );
    }
  });
});

describe('self-lit seabed rims', () => {
  const coast = (i: number): number => (i < 5 ? -192 : i < 10 ? -64 : 256);

  const isSeabedColored = (t: Triangle): boolean => {
    const [r, g] = asStoredBytes(t.color);
    return [
      ...CLIFF_PALETTE.slice(0, FIRST_LAND_PALETTE_INDEX),
      ...TERRAIN_PALETTE.slice(0, FIRST_LAND_PALETTE_INDEX),
    ].some((c) => {
      const [cr, cg] = asStoredBytes(c);
      return cr === r && cg === g;
    });
  };

  it('flags every underwater skirt and nothing else', () => {
    const { triangles } = writeEdge(coast);
    const skirts = skirtsOf(triangles);
    expect(skirts.length).toBeGreaterThan(0);

    let seabedFaces = 0;
    for (const skirt of skirts) {
      const seabed = isSeabedColored(skirt);
      expect(skirt.selfLit).toBe(seabed ? SELF_LIT_ALPHA_BYTE : LIT_BY_SCENE);
      if (seabed) seabedFaces++;
    }
    expect(seabedFaces).toBeGreaterThan(0);
    expect(seabedFaces).toBeLessThan(skirts.length);
  });

  it('never flags a cap, however deep it is', () => {
    const { triangles } = writeEdge(coast);
    const caps = capsOf(triangles);
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) expect(cap.selfLit).toBe(LIT_BY_SCENE);
  });

  it('flags underwater walls in the BLOCKY FALLBACK too', () => {
    const { counts, triangles } = writeEdge(
      (i, j) => ((i + j) % 2) * 4 * BAND_HEIGHT - 6 * BAND_HEIGHT,
    );
    expect(counts.usedFallback).toBe(true);
    const skirts = skirtsOf(triangles);
    expect(skirts.length).toBeGreaterThan(0);
    for (const skirt of skirts) expect(skirt.selfLit).toBe(SELF_LIT_ALPHA_BYTE);
    for (const cap of capsOf(triangles)) expect(cap.selfLit).toBe(LIT_BY_SCENE);
  });

  it('leaves an all-land chunk with no flagged geometry at all', () => {
    const { triangles } = writeEdge((i) => (i < 8 ? 128 : 384));
    expect(skirtsOf(triangles).length).toBeGreaterThan(0);
    for (const t of triangles) expect(t.selfLit).toBe(LIT_BY_SCENE);
  });

  it('leaves the flag on the unused tail alone, like every other attribute', () => {
    const { buffers, counts } = writeEdge(coast);
    const litBefore = colorAlphasFrom(buffers, counts.vertexCount);
    const flat = mirrorWith([edgeChunk(() => 0)]);
    const after = writeChunkVertexData(flat, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(colorAlphasFrom(buffers, counts.vertexCount)).toEqual(litBefore);
    expect(after.vertexCount).toBeLessThan(counts.vertexCount);
  });

  it('grows the flag buffer alongside the others', () => {
    const buffers = createChunkGeometryBuffers(4);
    const mirror = mirrorWith([edgeChunk(coast)]);
    const grown = writeChunkVertexData(mirror, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(grown.capacityGrew).toBe(true);
    expect(buffers.colors.length).toBe(
      buffers.triangleCapacity * VERTICES_PER_TRIANGLE * COMPONENTS_PER_COLOR,
    );
    expect(
      colorAlphasFrom(buffers, 0)
        .slice(0, grown.vertexCount)
        .some((flag) => flag === SELF_LIT_ALPHA_BYTE),
    ).toBe(true);
  });
});

describe('buffers', () => {
  it('reports counts consistent with the layout', () => {
    const { counts } = writeEdge((i) => (i < 8 ? 0 : 256));
    expect(counts.triangleCount).toBe(
      counts.capTriangleCount + counts.skirtTriangleCount,
    );
    expect(counts.vertexCount).toBe(counts.triangleCount * VERTICES_PER_TRIANGLE);
    expect(counts.triangleCount).toBeLessThanOrEqual(counts.triangleCapacity);
  });

  it('settles at a capacity and then patches without reallocating', () => {
    const buffers = createChunkGeometryBuffers();
    const hill = (i: number, j: number): number =>
      Math.round(360 - 3 * ((i - 8) ** 2 + (j - 8) ** 2));
    const first = writeChunkVertexData(
      mirrorWith([edgeChunk(hill)]),
      EDGE_CHUNK,
      EDGE_CHUNK,
      buffers,
      PALETTES,
    );
    expect(first.triangleCount).toBeGreaterThan(INITIAL_CHUNK_TRIANGLE_CAPACITY);
    expect(first.capacityGrew).toBe(true);

    for (let step = 1; step <= 4; step++) {
      const next = writeChunkVertexData(
        mirrorWith([edgeChunk((i, j) => hill(i, j) + step * 17)]),
        EDGE_CHUNK,
        EDGE_CHUNK,
        buffers,
        PALETTES,
      );
      expect(next.capacityGrew).toBe(false);
      expect(next.triangleCapacity).toBe(first.triangleCapacity);
    }
  });

  it('keeps an ordinary chunk inside its starting capacity', () => {
    const modest = writeEdge((i, j) => (i > 4 && j > 4 ? 2 * BAND_HEIGHT : 0));
    expect(modest.counts.capacityGrew).toBe(false);
    expect(modest.counts.triangleCapacity).toBe(INITIAL_CHUNK_TRIANGLE_CAPACITY);
  });

  it('grows (and keeps the growth) when a chunk outgrows its capacity', () => {
    const buffers = createChunkGeometryBuffers(4);
    const mirror = mirrorWith([edgeChunk((i) => (i < 8 ? 0 : 256))]);
    const grown = writeChunkVertexData(mirror, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(grown.capacityGrew).toBe(true);
    expect(buffers.positions.length).toBe(
      grown.triangleCapacity * VERTICES_PER_TRIANGLE * 3,
    );

    const flat = mirrorWith([edgeChunk(() => 256)]);
    const after = writeChunkVertexData(flat, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(after.capacityGrew).toBe(false);
    expect(after.triangleCapacity).toBe(grown.triangleCapacity);
  });

  it('leaves no stale geometry behind when a re-patch emits less', () => {
    const buffers = createChunkGeometryBuffers();
    const cliffy = mirrorWith([edgeChunk((i) => (i < 8 ? 0 : 256))]);
    const before = writeChunkVertexData(cliffy, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);

    const flat = mirrorWith([edgeChunk(() => 256)]);
    const after = writeChunkVertexData(flat, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(after.triangleCount).toBeLessThan(before.triangleCount);
    expect(after.skirtTriangleCount).toBe(0);

    expect(skirtsOf(trianglesOf(buffers, after)).length).toBe(0);
  });

  it('is idempotent — re-patching the same data yields the same buffers', () => {
    const mirror = mirrorWith([
      chunkPayloadFrom(0, 0, (x, y) => (x * 29 + y * 7) % 300),
    ]);
    const first = createChunkGeometryBuffers();
    const second = createChunkGeometryBuffers();
    const countsA = writeChunkVertexData(mirror, 0, 0, first, PALETTES);
    const countsB = writeChunkVertexData(mirror, 0, 0, second, PALETTES);

    expect(countsB).toEqual(countsA);
    expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
    // expect(Array.from(second.normals)).toEqual(Array.from(first.normals));
    expect(Array.from(second.colors)).toEqual(Array.from(first.colors));
  });
});

describe('deep strata sculpting (2026-08-19) — the digs that recalibrated the budgets', () => {
  function fixtureFloor(strokes: readonly Stroke[], base: number): number {
    const map = createHeightmap(WORLD);
    map.cells.fill(base);
    for (const stroke of strokes) {
      for (let c = 0; c < stroke.clicks; c++) {
        applySculpt(
          map,
          SCULPT_CENTRE + stroke.dx,
          SCULPT_CENTRE + stroke.dy,
          stroke.radius,
          stroke.up ? DEFAULT_SCULPT_AMOUNT : -DEFAULT_SCULPT_AMOUNT,
          { tool: 'stamp', profile: stroke.profile ?? 'soft', anchor: stroke.anchor ?? 'free' },
        );
      }
    }
    let min = Infinity;
    for (let j = 0; j < CHUNK_SIZE; j++) {
      for (let i = 0; i < CHUNK_SIZE; i++) {
        min = Math.min(min, heightAt(map, FIXTURE_ORIGIN + i, FIXTURE_ORIGIN + j));
      }
    }
    return min;
  }

  it('the deep fixtures provably bottom out on the world floor', () => {
    expect(fixtureFloor(DEEP_PIT_STROKES, SHELF_BASE)).toBe(MIN_HEIGHT + 1);
    expect(fixtureFloor(DEEP_CRATER_STROKES, SHELF_BASE)).toBe(MIN_HEIGHT + 1);
    expect(quantizeToBand(fixtureFloor(DEEP_PIT_STROKES, SHELF_BASE))).toBe(MIN_HEIGHT);
    expect(quantizeToBand(fixtureFloor(DEEP_CRATER_STROKES, SHELF_BASE))).toBe(MIN_HEIGHT);
  });

  it("draws the owner's hard-dug floor pit organically (the 2026-08-19 report)", () => {
    const worst = worstSculptedChunk(DEEP_PIT_STROKES, SHELF_BASE);
    expect(worst.anyFallback).toBe(false);
    expect(worst.skirtTriangles).toBeGreaterThan(worst.capTriangles);
  });

  it('draws a soft floor-depth crater, remnant spires and all, organically', () => {
    const withSpires = [...DEEP_CRATER_STROKES, ...asDeepPlay(SPIRE_STROKES)];
    expect(worstSculptedChunk(withSpires, SHELF_BASE).anyFallback).toBe(false);
  });

  it('draws the worst plausible chunk — three floor-depth craters — inside both budgets', () => {
    const worst = [
      ...DEEP_CRATER_STROKES,
      ...offsetStrokes(DEEP_CRATER_STROKES, 6, 6),
      ...offsetStrokes(DEEP_CRATER_STROKES, -6, 5),
      ...asDeepPlay(SPIRE_STROKES),
    ];
    const { counts } = writeSculpted(worst, SHELF_BASE);
    expect(counts.usedFallback).toBe(false);
    expect(counts.triangleCount).toBeLessThan(CHUNK_TRIANGLE_BUDGET);
    expect(counts.triangulationWork).toBeLessThan(CHUNK_TRIANGULATION_WORK_BUDGET);
  });
});

const CALIBRATION_FIXTURE_TIMEOUT_MS = 60_000;

describe('the legitimate-sculpting contract', () => {
  interface Row {
    name: string;
    strokes: readonly Stroke[];
    base: number;
  }

  const LEGITIMATE: readonly Row[] = [
    { name: 'stamped crater (land)', strokes: CRATER_STROKES, base: 8 * BAND_HEIGHT },
    { name: 'crater dug into the sea floor', strokes: CRATER_STROKES, base: 0 },
    {
      name: 'crater with spires',
      strokes: [...CRATER_STROKES, ...SPIRE_STROKES],
      base: 8 * BAND_HEIGHT,
    },
    {
      name: 'three craters and spires in one chunk',
      strokes: [
        ...CRATER_STROKES,
        ...offsetStrokes(CRATER_STROKES, 6, 6),
        ...offsetStrokes(CRATER_STROKES, -6, 5),
        ...SPIRE_STROKES,
      ],
      base: 8 * BAND_HEIGHT,
    },
    { name: 'spire field every 2 world units', strokes: spireField(), base: 4 * BAND_HEIGHT },
    {
      name: 'pits every 4th world unit',
      strokes: pitsEveryCells(4 * WORLD_UNIT_CELLS, PLAYER_FINEST_BRUSH_CELLS),
      base: 8 * BAND_HEIGHT,
    },
    { name: "the owner's floor pit (hard r4)", strokes: DEEP_PIT_STROKES, base: SHELF_BASE },
    {
      name: 'deep pit with spires',
      strokes: [...DEEP_PIT_STROKES, ...asDeepPlay(SPIRE_STROKES)],
      base: SHELF_BASE,
    },
    { name: 'deep soft crater', strokes: DEEP_CRATER_STROKES, base: SHELF_BASE },
    {
      name: 'three floor-depth craters and spires',
      strokes: [
        ...DEEP_CRATER_STROKES,
        ...offsetStrokes(DEEP_CRATER_STROKES, 6, 6),
        ...offsetStrokes(DEEP_CRATER_STROKES, -6, 5),
        ...asDeepPlay(SPIRE_STROKES),
      ],
      base: SHELF_BASE,
    },
  ];

  it(
    'renders every legitimate fixture organically — no exceptions',
    () => {
      const failed: string[] = [];
      for (const row of LEGITIMATE) {
        const worst = worstSculptedChunk(row.strokes, row.base);
        if (worst.anyFallback) failed.push(row.name);
      }
      expect(failed).toEqual([]);
    },
    CALIBRATION_FIXTURE_TIMEOUT_MS,
  );

  it('and the guard still guards: adversarial shapes still fall back', () => {
    expect(worstSculptedChunk(pitsEveryCells(2)).anyFallback).toBe(true);
    const checker = writeEdge((i, j) => ((i + j) % 2) * BAND_HEIGHT);
    expect(checker.counts.usedFallback).toBe(true);
  });

  it(
    'discriminates on the WORST POLYGON, which is what re-terracing does not move',
    () => {
    const legitimate = LEGITIMATE.map((row) => worstSculptedChunk(row.strokes, row.base));
    const worstLegitimate = Math.max(...legitimate.map((c) => c.maxPolygon));
    const pits = worstSculptedChunk(pitsEveryCells(2));
    const checker = writeEdge((i, j) => ((i + j) % 2) * BAND_HEIGHT).counts;

    expect(worstLegitimate).toBeLessThan(CHUNK_POLYGON_WORK_BUDGET);
    expect(pits.maxPolygon).toBeGreaterThan(CHUNK_POLYGON_WORK_BUDGET);
    expect(checker.maxPolygonWork).toBeGreaterThan(CHUNK_POLYGON_WORK_BUDGET);

      expect(pits.maxWork).toBeLessThan(CHUNK_TRIANGULATION_WORK_BUDGET);
    },
    CALIBRATION_FIXTURE_TIMEOUT_MS,
  );
});
