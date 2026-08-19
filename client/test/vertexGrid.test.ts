// Geometry-builder tests. The builder is pure (no Three.js, no DOM), so all of
// this runs headless against plain typed arrays — which is the point: the
// terraced silhouette is feel-critical and must be assertable without a GPU.
//
// The organic renderer (2026-08-14) moved the interesting assertions from
// "which quad is in which slot" to "what shape did the outline take, and does
// it still tell the truth about the heightmap".

import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  SEA_LEVEL,
  applySculpt,
  createHeightmap,
  heightAt,
  quantizeToBand,
  type ChunkPayload,
} from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  CHAIKIN_ITERATIONS,
  CHUNK_TRIANGLE_BUDGET,
  CHUNK_TRIANGULATION_WORK_BUDGET,
  CONTOUR_CELL_CENTRE_GUARD,
  CONTOUR_SAMPLE_CLEARANCE,
  FALLBACK_MAX_TRIANGLES,
  INITIAL_CHUNK_TRIANGLE_CAPACITY,
  LATTICE_PER_CHUNK,
  LIT_BY_SCENE,
  SEABED_CAP_SINK,
  SEABED_RISER_BORDER_WORLD_HEIGHT,
  SELF_LIT,
  SKIRT_PICK_INSET,
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
  WATER_SURFACE_LIFT,
} from '../src/config.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

/**
 * The world's last chunk. Tests that want a chunk with no un-received
 * neighbours build their terrain HERE: at the world border sampleHeight clamps,
 * so the lattice's last row/column falls back onto the chunk itself instead of
 * reading a never-received neighbour as sea.
 */
const EDGE_CHUNK = WORLD / CHUNK_SIZE - 1;
const EDGE_ORIGIN = EDGE_CHUNK * CHUNK_SIZE;

/**
 * Where the SCULPTED fixtures below are dug: an interior chunk, whose
 * neighbours are all present in the fixture world. The edge-chunk trick is
 * wrong for them — a brush overhanging the world border would be clipped, and
 * the fixtures are about what a stroke costs, not about the rim.
 */
const FIXTURE_CHUNK = 1;
const FIXTURE_ORIGIN = FIXTURE_CHUNK * CHUNK_SIZE;

/** sRGB palettes — the builder does not care which space it is handed. */
const PALETTES: ChunkPalettes = { top: TERRAIN_PALETTE, cliff: CLIFF_PALETTE };

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

/** A chunk whose heights come from each cell's own WORLD coordinates. */
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

/** The border chunk described above, addressed in LOCAL cell coordinates. */
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
  /** The face's self-lit flag; see selfLitOf, which also checks it is a face. */
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

function trianglesOf(
  buffers: ChunkGeometryBuffers,
  counts: ChunkGeometryCounts,
): Triangle[] {
  const out: Triangle[] = [];
  for (let t = 0; t < counts.triangleCount; t++) {
    const base = t * VERTICES_PER_TRIANGLE;
    out.push({
      a: vertexAt(buffers, base),
      b: vertexAt(buffers, base + 1),
      c: vertexAt(buffers, base + 2),
      normal: {
        x: buffers.normals[base * 3],
        y: buffers.normals[base * 3 + 1],
        z: buffers.normals[base * 3 + 2],
      },
      color: [
        buffers.colors[base * 3],
        buffers.colors[base * 3 + 1],
        buffers.colors[base * 3 + 2],
      ],
      selfLit: selfLitOf(buffers, base),
    });
  }
  return out;
}

/**
 * The self-lit flag of the face starting at vertex `base`.
 *
 * It asserts, rather than assumes, that all three corners carry the same value:
 * the shader interpolates the attribute, so a triangle whose corners disagreed
 * would fade between lit and unlit across its own surface — which is not a
 * thing the renderer is allowed to draw, and not a thing a per-face flag can be
 * read back from.
 */
function selfLitOf(buffers: ChunkGeometryBuffers, base: number): number {
  const value = buffers.selfLit[base];
  expect(buffers.selfLit[base + 1]).toBe(value);
  expect(buffers.selfLit[base + 2]).toBe(value);
  return value;
}

/** Flat band tops: the ones whose normal points straight up. */
const capsOf = (triangles: Triangle[]): Triangle[] =>
  triangles.filter((t) => t.normal.y === 1);
/** Vertical risers: everything else the builder emits. */
const skirtsOf = (triangles: Triangle[]): Triangle[] =>
  triangles.filter((t) => t.normal.y === 0);

/** Colours round-trip through Float32, so compare them at that precision. */
function expectColor(actual: readonly number[], expected: Rgb): void {
  expect(actual[0]).toBeCloseTo(expected[0], 6);
  expect(actual[1]).toBeCloseTo(expected[1], 6);
  expect(actual[2]).toBeCloseTo(expected[2], 6);
}

/**
 * Barycentric containment in the XZ plane, inclusive of the edges.
 *
 * Zero-area triangles cover nothing: hole bridging leaves a few slivers along
 * its bridges (a bridge is walked in both directions, so the triangle that
 * closes it is degenerate), and they rasterise to no pixels at all. Counting
 * them as covering the whole plane — which the sign test alone would — makes
 * every coverage assertion below meaningless.
 */
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

/**
 * The surface a player would see (and click) at a point: the highest cap
 * covering it. This is the function the honesty invariant is stated against.
 */
function topmostCapY(triangles: Triangle[], x: number, z: number): number | null {
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

/** Builds the edge chunk from local heights and writes its geometry. */
function writeEdge(height: (i: number, j: number) => number) {
  return write(mirrorWith([edgeChunk(height)]), EDGE_CHUNK, EDGE_CHUNK);
}

// ---------------------------------------------------------------------------
// SCULPTED FIXTURES — terrain made the way a player makes it.
//
// The renderer's budgets are decisions about what real play costs, so the
// terrain they are tuned against must be real play and not a formula that
// happens to be expensive. These fixtures are therefore dug with the shared
// brush itself (applySculpt, tool 'stamp', profile 'soft' — the player-facing
// wire defaults), one stroke per click, exactly as the server would apply
// them. They are what the measured table at CHUNK_TRIANGLE_BUDGET reports.
// ---------------------------------------------------------------------------

/** One held-brush click: a centre offset, a radius, a repeat count. */
interface Stroke {
  dx: number;
  dy: number;
  radius: number;
  clicks: number;
  /** Raise instead of lower — how a remnant column is left standing. */
  up?: boolean;
}

/** Cell the fixture strokes are centred on: the middle of the fixture chunk. */
const SCULPT_CENTRE = FIXTURE_ORIGIN + CHUNK_SIZE / 2;

/**
 * THE CRATER. A stamp-dug bowl of the shape the owner reported going blocky:
 * radius 4 down to radius 1, walked around an irregular ring so the rim is
 * ragged rather than circular, bottoming out about nine bands down, with five
 * single-cell columns raised back up inside it — the remnants a player leaves
 * when digging around something.
 *
 * Deliberately NOT symmetric: a clean cone produces neatly nested contours and
 * is far cheaper than what a player actually leaves behind.
 */
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

/** Disjoint spires stamped around the crater — the second reported shape. */
const SPIRE_STROKES: readonly Stroke[] = [
  { dx: -4, dy: -4, radius: 1, clicks: 7, up: true },
  { dx: 4, dy: -3, radius: 1, clicks: 5, up: true },
  { dx: -3, dy: 4, radius: 1, clicks: 9, up: true },
  { dx: 5, dy: 4, radius: 1, clicks: 4, up: true },
  { dx: 0, dy: -6, radius: 1, clicks: 6, up: true },
  { dx: 6, dy: 0, radius: 2, clicks: 3, up: true },
];

/** The same crater dug again, offset — two bowls on one diagonal. */
const offsetStrokes = (strokes: readonly Stroke[], dx: number, dy: number): Stroke[] =>
  strokes.map((s) => ({ ...s, dx: s.dx + dx, dy: s.dy + dy }));

/**
 * Applies strokes to a world that starts flat at `base`, and returns every
 * chunk of it — neighbours included, so the fixture chunk's lattice reads real
 * heights one cell past its own edge instead of clamping.
 */
function sculptedWorld(strokes: readonly Stroke[], base: number): ChunkPayload[] {
  const map = createHeightmap(WORLD);
  map.cells.fill(base);
  for (const stroke of strokes) {
    for (let click = 0; click < stroke.clicks; click++) {
      applySculpt(
        map,
        SCULPT_CENTRE + stroke.dx,
        SCULPT_CENTRE + stroke.dy,
        stroke.radius,
        stroke.up ? DEFAULT_SCULPT_AMOUNT : -DEFAULT_SCULPT_AMOUNT,
        { tool: 'stamp', profile: 'soft' },
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

/** Sculpts a world and writes the chunk the strokes were centred in. */
function writeSculpted(strokes: readonly Stroke[], base = 8 * BAND_HEIGHT) {
  const mirror = mirrorWith(sculptedWorld(strokes, base));
  return write(mirror, FIXTURE_CHUNK, FIXTURE_CHUNK);
}

describe('flat terrain', () => {
  it('draws a whole-chunk cap for the one band present, and nothing else', () => {
    // Every sample is band 1, so there is exactly one level and it covers the
    // chunk's whole domain: two triangles, no contour, no riser.
    const { counts, triangles } = writeEdge(() => 100);
    expect(counts.skirtTriangleCount).toBe(0);
    expect(counts.capTriangleCount).toBe(2);
    for (const cap of capsOf(triangles)) {
      for (const corner of [cap.a, cap.b, cap.c]) {
        expect(corner.y).toBeCloseTo(BAND_WORLD_HEIGHT);
      }
    }
  });

  it('covers the chunk domain exactly: cell centres in, the next chunk out', () => {
    // The domain is [x0, x0+16] — the lattice of cell centres — so a chunk is
    // responsible for everything from its own first centre up to (and
    // including) its neighbour's, and no further.
    const { triangles } = writeEdge(() => 100);
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
    // Y component of e1 × e2 for two vectors in the XZ plane.
    expect(e1.z * e2.x - e1.x * e2.z).toBeGreaterThan(0);
  });
});

describe('the waterline', () => {
  it('keeps DRY band-0 land at exactly y = 0, so the sea cannot z-fight it', () => {
    // WATER_SURFACE_LIFT's reasoning in config.ts depends on this: a band-0
    // flat renders at world y = 0 and the sea floats just above it.
    const { triangles } = write(mirrorWith([chunkPayload(0, 0, 63)]), 0, 0);
    const shore = capsOf(triangles).filter((t) => t.a.y === 0);
    expect(shore.length).toBeGreaterThan(0);
    expectColor(shore[0].color, TERRAIN_PALETTE[bandPaletteIndex(SEA_LEVEL + 1)]);
  });

  it('sinks the SEABED cap under the dry one rather than z-fighting it', () => {
    // Band 0 carries two colours at one height; the submerged half is the one
    // that moves, and only far enough to decide the depth test.
    const { triangles } = write(mirrorWith([chunkPayload(0, 0, 63)]), 0, 0);
    const seabed = capsOf(triangles).filter((t) => t.a.y < 0);
    expect(seabed.length).toBeGreaterThan(0);
    for (const cap of seabed) expect(cap.a.y).toBeCloseTo(-SEABED_CAP_SINK);
    expectColor(seabed[0].color, TERRAIN_PALETTE[bandPaletteIndex(SEA_LEVEL)]);
    // Still comfortably under the sea surface, which is what makes the sink
    // invisible.
    expect(SEABED_CAP_SINK).toBeGreaterThan(0);
    expect(SEABED_CAP_SINK).toBeLessThan(WATER_SURFACE_LIFT);
  });

  it('paints a freshly generated (all-zero) world as seabed, never beach', () => {
    const { triangles } = write(mirrorWith([chunkPayload(0, 0, 0)]), 0, 0);
    const caps = capsOf(triangles);
    expect(caps.length).toBe(2);
    for (const cap of caps) {
      expectColor(cap.color, TERRAIN_PALETTE[bandPaletteIndex(0)]);
      expect(cap.a.y).toBeCloseTo(-SEABED_CAP_SINK);
    }
  });
});

describe('organic outlines', () => {
  it('puts a band edge INSIDE a cell, not on the cell boundary', () => {
    // A one-band step between cell 7 (height 0) and cell 8 (height 64). The
    // old renderer put a wall on the boundary at x = 7.5; the contour instead
    // sits a quarter of a cell inside the higher cell, which is what makes a
    // stamped edge read as drawn rather than as a grid line.
    const mirror = mirrorWith([edgeChunk((i) => (i < 8 ? 0 : BAND_HEIGHT))]);
    const loops = chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, BAND_HEIGHT);
    expect(loops).toHaveLength(1);
    // Everything the loop does inside the chunk (the rest of it runs along the
    // domain border, which is the neighbour's business).
    const interior = loops[0].filter(
      (p) => p.x > EDGE_ORIGIN && p.x < EDGE_ORIGIN + CHUNK_SIZE,
    );
    expect(interior.length).toBeGreaterThan(0);
    const expected = EDGE_ORIGIN + 8 - 0.25;
    for (const p of interior) {
      expect(p.x).toBeCloseTo(expected, 6);
      // And emphatically NOT on the cell boundary, which is where the old
      // renderer's wall stood.
      expect(p.x).not.toBeCloseTo(EDGE_ORIGIN + 7.5, 6);
    }
  });

  it('stacks a multi-band drop as a staircase of contours, not one wall', () => {
    // Heights 0 and 256 across one cell boundary: four band boundaries fall
    // between the two samples, and each lands at its own interpolated place.
    const mirror = mirrorWith([edgeChunk((i) => (i < 8 ? 0 : 256))]);
    const positions: number[] = [];
    for (let k = 1; k <= 4; k++) {
      const loops = chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, k * BAND_HEIGHT);
      const interior = loops[0].filter(
        (p) => p.x > EDGE_ORIGIN && p.x < EDGE_ORIGIN + CHUNK_SIZE,
      );
      positions.push(interior[0].x - EDGE_ORIGIN);
    }
    // Strictly increasing: the higher the band, the further into the high cell
    // its edge sits. Nesting is what lets caps stack without crossing.
    for (let k = 1; k < positions.length; k++) {
      expect(positions[k]).toBeGreaterThan(positions[k - 1]);
    }
    expect(positions[0]).toBeCloseTo(7.3, 6);
    expect(positions[3]).toBeCloseTo(7 + (1 - CONTOUR_CELL_CENTRE_GUARD), 6);
  });

  it('follows a gradient diagonally instead of stepping around cells', () => {
    // A smooth diagonal ramp. If the outline were the cell grid, every skirt
    // would be axis-aligned; the whole point of interpolating is that they are
    // not.
    const { triangles } = writeEdge((i, j) => (i + j) * 12);
    const angled = skirtsOf(triangles).filter((t) => {
      const dx = Math.abs(t.b.x - t.a.x);
      const dz = Math.abs(t.b.z - t.a.z);
      return dx > 1e-6 && dz > 1e-6;
    });
    expect(angled.length).toBeGreaterThan(0);
  });

  it('rounds the outline: two Chaikin passes, no 90° turns left', () => {
    const mirror = mirrorWith([edgeChunk((i, j) => (i > 4 && j > 4 ? 128 : 0))]);
    const loops = chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, BAND_HEIGHT);
    const corner = loops[0].filter((p) => !p.onBorder);
    expect(CHAIKIN_ITERATIONS).toBe(2);
    // The raw marching-squares corner is one right angle; after smoothing the
    // turn is spread over several vertices, none of them square.
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
  /** Distance from a point to a cell centre, in cells. */
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

    // Rounded, not a four-sided diamond and not a cell-shaped square.
    expect(loops[0].length).toBeGreaterThan(8);
    for (const p of loops[0]) {
      const d = distanceTo(p, centreX, centreZ);
      // A COLUMN: it stands well inside its own cell...
      expect(d).toBeLessThan(0.5);
      // ...and never touches the centre, which is the honesty guard.
      expect(d).toBeGreaterThanOrEqual(CONTOUR_CELL_CENTRE_GUARD - 1e-9);
    }

    // And it is a real column: a cap on top with a skirt all the way round.
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
    // Two loops: the chunk's own outline (the whole domain) and the well.
    expect(loops).toHaveLength(2);
    const well = loops.find((loop) => loop.every((p) => !p.onBorder));
    expect(well).toBeDefined();
    const centreX = EDGE_ORIGIN + pit.i;
    const centreZ = EDGE_ORIGIN + pit.j;
    expect(well!.length).toBeGreaterThan(8);
    for (const p of well!) {
      const d = distanceTo(p, centreX, centreZ);
      expect(d).toBeGreaterThan(0.5); // the well is wider than the cell it digs
      expect(d).toBeLessThan(1); // but does not swallow the neighbours
    }

    // The hole is real: the plateau cap does not cover the pit's centre, and
    // the seabed below does.
    const { triangles } = write(mirror, EDGE_CHUNK, EDGE_CHUNK);
    expect(topmostCapY(triangles, centreX, centreZ)).toBeCloseTo(-SEABED_CAP_SINK);
  });
});

describe('honesty — the render never lies about the heightmap', () => {
  /**
   * THE invariant: at every cell centre the topmost cap is at exactly the
   * height the authoritative heightmap quantises to. Players click what they
   * see (picking.ts rounds a hit to the nearest cell centre), so a cap that
   * covered a centre at the wrong band would sculpt the wrong terrain.
   *
   * Cells on the chunk's own domain border are excluded: their centres lie
   * exactly ON the seam, where this chunk's cap and its neighbour's meet, and
   * both draw them at the same height (asserted separately in "chunk seams").
   */
  function expectHonest(
    height: (i: number, j: number) => number,
    probeRadius = 0,
  ): ChunkGeometryCounts {
    const { triangles, counts } = writeEdge(height);
    for (let j = 1; j < CHUNK_SIZE; j++) {
      for (let i = 1; i < CHUNK_SIZE; i++) {
        const expected = quantizeToBand(height(i, j)) * HEIGHT_WORLD_SCALE;
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
          // Band 0's cap is the sunk seabed; every other band sits on its floor.
          const tolerance = SEABED_CAP_SINK + 1e-6;
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
    // The guard is what buys the margin: the cap covers a disc around every
    // cell centre, so a click that lands slightly off centre still resolves to
    // the surface the player aimed at.
    expectHonest(
      (i, j) => ((i * 7 + j * 3) % 3) * BAND_HEIGHT,
      CONTOUR_CELL_CENTRE_GUARD / 2,
    );
  });

  it('keeps every smoothed contour clear of every cell centre', () => {
    const mirror = mirrorWith([
      edgeChunk((i, j) => Math.round(i * 19 + j * 7 + ((i * j) % 13) * 5)),
    ]);
    for (let k = 0; k <= 4; k++) {
      for (const loop of chunkContourLoops(
        mirror,
        EDGE_CHUNK,
        EDGE_CHUNK,
        k * BAND_HEIGHT,
      )) {
        for (const p of loop) {
          if (p.onBorder) continue; // shared with the neighbour, and pinned
          const d = Math.hypot(p.x - Math.round(p.x), p.z - Math.round(p.z));
          expect(d).toBeGreaterThanOrEqual(CONTOUR_CELL_CENTRE_GUARD - 1e-9);
        }
      }
    }
  });

  it('keeps the sample clearance from swamping a real gradient', () => {
    // The clearance is what stops stamped terrain collapsing onto the grid; it
    // must not also decide where a genuinely sloped edge goes. Half a band is
    // the largest offset that cannot reorder two samples.
    expect(CONTOUR_SAMPLE_CLEARANCE).toBe(BAND_HEIGHT / 2);
  });
});

describe('triangulation', () => {
  /** Twice the signed area of a triangle in the (x,z) plane. */
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

  /**
   * A cap must PARTITION its region: same total area, nothing wound backwards.
   * Both fail loudly if hole bridging leaves the merged polygon only weakly
   * simple — the triangulation then stalls, and the leftovers show as terrain
   * you can see through, or as a hole quietly painted over.
   */
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
      // Backwards triangles cancel in the sum but not on screen.
      expect(twice).toBeGreaterThanOrEqual(0);
      triangleArea += twice / 2;
    }

    let regionArea = 0;
    for (const loop of chunkContourLoops(mirror, EDGE_CHUNK, EDGE_CHUNK, threshold)) {
      regionArea += loopArea(loop); // holes are wound the other way and subtract
    }
    // Not exactly equal, and the difference is a documented sliver: each hole
    // is bridged through a slit BRIDGE_SLIT_WIDTH (a millionth of a cell) wide
    // and at most a chunk diagonal long, so a few dozen holes add well under a
    // thousandth of a square cell of area that the outline itself does not
    // enclose. Anything larger means triangles outside the region.
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
  /**
   * Terrain no brush can produce and only deliberate single-cell stamping can:
   * every cell one band above its neighbours. Its contour geometry is an
   * order of magnitude over budget, and triangulating it measured ~90 ms per
   * patch — a multi-frame stall — so the chunk is drawn blocky instead.
   */
  const checkerboard = (i: number, j: number): number => ((i + j) % 2) * BAND_HEIGHT;

  it('takes over when a chunk blows the contour budget, and stays bounded', () => {
    const { counts } = writeEdge(checkerboard);
    expect(counts.usedFallback).toBe(true);
    expect(counts.triangleCount).toBeLessThanOrEqual(FALLBACK_MAX_TRIANGLES);
    // And the budget is what it trips: the contour path would have needed far
    // more than this.
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

  /**
   * THE REGRESSION THE BUDGETS EXIST TO GET RIGHT (2026-08-14). A stamped
   * crater is not adversarial terrain — it is the single most ordinary thing
   * the stamp tool makes — and at the old 4,096-triangle budget every one of
   * these drew blocky, which the owner saw as a patchwork of square chunks in
   * the middle of a normal dig.
   *
   * Asserted on counts and flags only, never on wall-clock: a timing assertion
   * in CI measures the CI runner's mood. The milliseconds behind these numbers
   * are in the table at CHUNK_TRIANGLE_BUDGET, from local runs.
   */
  describe('and the sculpted terrain it must NOT take over from', () => {
    it('draws a stamped crater organically', () => {
      const { counts } = writeSculpted(CRATER_STROKES);
      expect(counts.usedFallback).toBe(false);
      // Real contour geometry, not a degenerate handful of triangles.
      expect(counts.capTriangleCount).toBeGreaterThan(500);
      expect(counts.skirtTriangleCount).toBeGreaterThan(500);
    });

    it('draws a crater dug into the sea floor organically too', () => {
      // Starting from a flat sea rather than a plateau: the same bowl, but its
      // levels run from band -14 up, and band 0 carries the extra waterline cap.
      const { counts } = writeSculpted(CRATER_STROKES, 0);
      expect(counts.usedFallback).toBe(false);
    });

    it('draws a crater with disjoint spires around it organically', () => {
      const { counts } = writeSculpted([...CRATER_STROKES, ...SPIRE_STROKES]);
      expect(counts.usedFallback).toBe(false);
    });

    it('draws several craters in one chunk organically', () => {
      // Two bowls on one diagonal is the case that used to defeat hole
      // bridging outright — the second bowl sits on the first bowl's bridge.
      const twin = writeSculpted([
        ...CRATER_STROKES,
        ...offsetStrokes(CRATER_STROKES, 6, 6),
      ]);
      expect(twin.counts.usedFallback).toBe(false);

      // And a chunk dug three times over, with spires, which is the heaviest
      // legitimately sculpted chunk the budgets are tuned against.
      const ragged = writeSculpted([
        ...CRATER_STROKES,
        ...offsetStrokes(CRATER_STROKES, 6, 6),
        ...offsetStrokes(CRATER_STROKES, -6, 5),
        ...SPIRE_STROKES,
      ]);
      expect(ragged.counts.usedFallback).toBe(false);
      // It must also still fit the budget with headroom rather than scrape in.
      expect(ragged.counts.triangleCount).toBeLessThan(CHUNK_TRIANGLE_BUDGET);
    });

    it('draws a field of stamped spires organically, however many', () => {
      // The case that proves the triangle budget alone cannot be the guard:
      // this costs MORE triangles than the pit field below and a fraction of
      // the time, because separate outer loops never get bridged together.
      const field: Stroke[] = [];
      for (let dx = -8; dx <= 8; dx += 2) {
        for (let dy = -8; dy <= 8; dy += 2) {
          field.push({ dx, dy, radius: 1, clicks: 3, up: true });
        }
      }
      const { counts } = writeSculpted(field, 4 * BAND_HEIGHT);
      expect(counts.usedFallback).toBe(false);
      expect(counts.triangleCount).toBeGreaterThan(4096);
    });
  });

  /**
   * The work budget's own door. A field of single-cell PITS at the same spacing
   * as the spire field above makes one polygon with dozens of holes bridged
   * into it, which is quadratic to triangulate; it is comfortably inside the
   * triangle budget and must still be caught.
   */
  it('takes over on terrain that is cheap in triangles but not in work', () => {
    const pits: Stroke[] = [];
    for (let dx = -8; dx <= 8; dx += 2) {
      for (let dy = -8; dy <= 8; dy += 2) pits.push({ dx, dy, radius: 1, clicks: 3 });
    }
    const { counts } = writeSculpted(pits);
    expect(counts.usedFallback).toBe(true);
    expect(counts.triangleCount).toBeLessThanOrEqual(FALLBACK_MAX_TRIANGLES);

    // Pits every FOURTH cell are the same shape an order of magnitude cheaper,
    // and must come through organically — the gate has to discriminate, not
    // just reject holes.
    const sparse: Stroke[] = [];
    for (let dx = -8; dx <= 8; dx += 4) {
      for (let dy = -8; dy <= 8; dy += 4) sparse.push({ dx, dy, radius: 1, clicks: 3 });
    }
    expect(writeSculpted(sparse).counts.usedFallback).toBe(false);
  });

  it('keeps both budgets above the fallback they fall back TO', () => {
    // A fallback that could itself trip a budget would loop; both gates must
    // sit clear of the geometry the fallback emits.
    expect(FALLBACK_MAX_TRIANGLES).toBeLessThan(CHUNK_TRIANGLE_BUDGET);
    expect(CHUNK_TRIANGULATION_WORK_BUDGET).toBeGreaterThan(0);
  });

  it('keeps the honesty invariant, cell for cell', () => {
    const { triangles, counts } = writeEdge(checkerboard);
    expect(counts.usedFallback).toBe(true);
    for (let j = 1; j < CHUNK_SIZE; j++) {
      for (let i = 1; i < CHUNK_SIZE; i++) {
        const expected =
          quantizeToBand(checkerboard(i, j)) * HEIGHT_WORLD_SCALE -
          (checkerboard(i, j) === 0 ? SEABED_CAP_SINK : 0);
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
      // Probed at the centroid: a wall's corners sit on the cell grid in the
      // axis it runs along, where rounding is a tie that says nothing about
      // which side of the wall is higher.
      const cell = worldPointToCell(
        (skirt.a.x + skirt.b.x + skirt.c.x) / 3 / CELL_WORLD_SIZE,
        (skirt.a.z + skirt.b.z + skirt.c.z) / 3 / CELL_WORLD_SIZE,
        WORLD,
      );
      if (cell === null) continue; // the world-rim half-cell, off the map
      // The higher cell of the checkerboard is the one whose parity raises it.
      const local = { i: cell.x - EDGE_ORIGIN, j: cell.y - EDGE_ORIGIN };
      expect(checkerboard(local.i, local.j)).toBe(BAND_HEIGHT);
    }
  });

  it('curtains its border so a fallback chunk can never be seen through', () => {
    const { triangles, counts } = writeEdge(checkerboard);
    expect(counts.usedFallback).toBe(true);
    const onWestBorder = skirtsOf(triangles).filter(
      (t) => Math.abs(t.a.x - EDGE_ORIGIN) < 0.01 && Math.abs(t.b.x - EDGE_ORIGIN) < 0.01,
    );
    expect(onWestBorder.length).toBeGreaterThan(0);
  });
});

describe('chunk seams', () => {
  /** Every contour vertex a chunk emits on one world-space line of constant X. */
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
    // A plateau that runs across the border between chunk (0,0) and (1,0). The
    // two chunks compute the crossing on the shared lattice edges from the same
    // canonical samples, so their border vertices must agree exactly — if they
    // did not, the seam would crack open under the camera.
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
    // Chunk (0,0)'s geometry must react to a change in chunk (1,0)'s first
    // column, or the seam would be built against stale heights.
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
    // A flat plateau spanning both chunks: the border is not an edge of
    // anything, so neither chunk may wall it off.
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
    // Chunk (0,0)'s east/south neighbours were never sent. The renderer pulls
    // their samples back onto received terrain (mirror.sampleRenderHeight),
    // so the plateau extends flat to the domain edge instead of contouring a
    // cliff against a phantom sea-level neighbour — the mist bank
    // (render/frontierFog.ts) is the frontier's only rendering. This INVERTS
    // the pre-#22 pin ("walls off the edge of received territory down to the
    // sea"), which asserted the accidental cliff this fix removes.
    const { counts } = write(mirrorWith([chunkPayload(0, 0, 300)]), 0, 0);
    expect(counts.skirtTriangleCount).toBe(0);
  });

  it('emits no skirt at the world border, where sampling clamps', () => {
    const { counts } = writeEdge(() => 512);
    expect(counts.skirtTriangleCount).toBe(0);
  });
});

describe('skirt picking', () => {
  /**
   * The contract picking depends on, asserted through picking.ts's UNCHANGED
   * pure API rather than a restatement of its rounding rule.
   */
  /**
   * Cells every BAND riser resolves to. The waterline's own riser is excluded:
   * it is SEABED_CAP_SINK tall (a sixty-fourth of a band), it lies at the sea
   * surface where there is no cliff to click, and it is a colour boundary
   * rather than a step — see SHORE_EDGE_CROSSING.
   */
  function bandRisers(triangles: Triangle[]): Triangle[] {
    return skirtsOf(triangles).filter(
      (t) =>
        Math.max(t.a.y, t.b.y, t.c.y) - Math.min(t.a.y, t.b.y, t.c.y) >
        SEABED_CAP_SINK * 2,
    );
  }

  /**
   * The cell a riser resolves to, probed at the triangle's centroid — a point
   * genuinely on the face, and away from its corners. Corners are deliberately
   * not probed: a riser's corners sit on the cell grid in the axis it runs
   * along, where rounding is a tie in the OTHER direction, and that says
   * nothing about which side of the cliff the face belongs to.
   */
  function cellUnder(riser: Triangle): { x: number; y: number } | null {
    const x = (riser.a.x + riser.b.x + riser.c.x) / 3;
    const z = (riser.a.z + riser.b.z + riser.c.z) / 3;
    return worldPointToCell(x / CELL_WORLD_SIZE, z / CELL_WORLD_SIZE, WORLD);
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
    const { triangles } = writeEdge((i, j) => (i === 5 && j === 6 ? BAND_HEIGHT : 0));
    expect(cellsUnderSkirts(triangles)).toEqual([
      `${EDGE_ORIGIN + 5},${EDGE_ORIGIN + 6}`,
    ]);
  });

  it('resolves the straight stretches of a pit wall to the rim, not the floor', () => {
    // The inverse of the spire, and the case where the contract has a boundary
    // worth stating. A one-cell well's outline runs three quarters of a cell
    // out from the dug cell along the axes — comfortably inside the RIM cells,
    // so clicking those stretches raises the rim, which is what filling a hole
    // looks like. Where the outline rounds the corner between two of those
    // stretches it cuts back across the dug cell's own square, and a click
    // there sculpts the floor instead. That is inherent: an outline that
    // follows the terrain instead of the grid cannot stay outside a
    // single-cell square all the way round it, and no inset can move it there
    // without tearing the wall away from the tread it hangs from.
    const { triangles } = writeEdge((i, j) => (i === 9 && j === 4 ? 0 : BAND_HEIGHT));
    const pit = { x: EDGE_ORIGIN + 9, y: EDGE_ORIGIN + 4 };
    const risers = bandRisers(triangles);
    expect(risers.length).toBeGreaterThan(0);

    let straight = 0;
    for (const riser of risers) {
      const cell = cellUnder(riser);
      expect(cell).not.toBeNull();
      // Never further away than the ring of cells around the pit.
      expect(Math.abs((cell as { x: number }).x - pit.x)).toBeLessThanOrEqual(1);
      expect(Math.abs((cell as { y: number }).y - pit.y)).toBeLessThanOrEqual(1);

      const x = (riser.a.x + riser.b.x + riser.c.x) / 3;
      const z = (riser.a.z + riser.b.z + riser.c.z) / 3;
      const offAxis = Math.min(Math.abs(x - pit.x), Math.abs(z - pit.y));
      if (offAxis > 0.25) continue; // the rounded corner, exempt above
      straight++;
      expect(cell).not.toEqual(pit);
    }
    expect(straight).toBeGreaterThan(0);
  });

  it('breaks an exact tie toward the HIGHER side, which is what the inset is for', () => {
    // Heights 0 and 128 put band 1's boundary exactly on the mean of the two
    // samples, so the contour runs down the middle between the cells and
    // rounding is a tie. The inset decides it for the cliff you clicked.
    const { triangles } = writeEdge((i) => (i < 8 ? 0 : 2 * BAND_HEIGHT));
    const band1Skirts = skirtsOf(triangles).filter(
      (t) => Math.max(t.a.y, t.b.y, t.c.y) === BAND_WORLD_HEIGHT,
    );
    expect(band1Skirts.length).toBeGreaterThan(0);
    for (const skirt of band1Skirts) {
      // Probe at the quad's own mid-height corner, on the chunk's interior side
      // (the domain runs half a cell past the last cell centre at the world
      // rim, which picking legitimately reports as off-map).
      const cell = worldPointToCell(
        skirt.a.x / CELL_WORLD_SIZE,
        EDGE_ORIGIN + 4,
        WORLD,
      );
      expect(cell?.x).toBe(EDGE_ORIGIN + 8);
    }
    expect(SKIRT_PICK_INSET).toBeGreaterThan(0);
    expect(SKIRT_PICK_INSET).toBeLessThan(0.01);
    // A negative power of two: exact in binary, identical on every platform.
    expect(Number.isInteger(Math.log2(SKIRT_PICK_INSET))).toBe(true);
    // And it must survive Float32 storage at the far corner of the largest
    // supported world (512 cells), or it would round back into a tie.
    expect(Math.round(Math.fround(511.5 + SKIRT_PICK_INSET))).toBe(512);
    expect(Math.round(Math.fround(511.5 - SKIRT_PICK_INSET))).toBe(511);
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
    // A submerged step: band −1 shelf standing over a band −3 floor. Levels
    // −2 and −1 each hang a one-band riser, and both are underwater, so each
    // riser must be TWO stacked quads: a SEABED_RISER_BORDER_WORLD_HEIGHT
    // sliver at the top edge painted as the NEXT BAND DOWN's tread, and the
    // face below painted as the riser's own band's tread, lightened
    // (CLIFF_PALETTE's seabed derivation). Both self-lit.
    const { triangles } = writeEdge((i) => (i < 8 ? -3 * BAND_HEIGHT : -BAND_HEIGHT));
    const skirts = skirtsOf(triangles);

    const shelfTop = -1 * BAND_WORLD_HEIGHT;
    const spanOf = (t: Triangle): number =>
      Math.max(t.a.y, t.b.y, t.c.y) - Math.min(t.a.y, t.b.y, t.c.y);
    const topOf = (t: Triangle): number => Math.max(t.a.y, t.b.y, t.c.y);

    // The band −1 riser's border: starts exactly at the shelf's cap.
    const borders = skirts.filter(
      (t) =>
        Math.abs(topOf(t) - shelfTop) < 1e-6 &&
        Math.abs(spanOf(t) - SEABED_RISER_BORDER_WORLD_HEIGHT) < 1e-6,
    );
    expect(borders.length).toBeGreaterThan(0);
    for (const border of borders) {
      // "the same color as the next layer down": band −2's tread, unmodified.
      expectColor(border.color, TERRAIN_PALETTE[bandPaletteIndex(-2 * BAND_HEIGHT)]);
      expect(border.selfLit).toBe(SELF_LIT);
    }

    // The face below it: the remaining drop, in band −1's lightened tread.
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
      expect(face.selfLit).toBe(SELF_LIT);
    }
  });

  it('keeps LAND cliffs single-quad — no border sliver above the waterline', () => {
    // The border is an underwater treatment only; a land riser stays one
    // full-height quad, so no skirt triangle of sliver height may exist.
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
    // Land only since the seabed rim change (2026-08-14): underwater the same
    // skirt is a seam OUTLINE and brightens instead — that regime's contract
    // lives in bandColors.test.ts, next to the derivation it tests.
    const luminance = (c: Rgb): number => c[0] + c[1] + c[2];
    for (let i = FIRST_LAND_PALETTE_INDEX; i < TERRAIN_PALETTE.length; i++) {
      expect(luminance(CLIFF_PALETTE[i])).toBeLessThan(
        luminance(TERRAIN_PALETTE[i]) * 0.85,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SELF-LIT SEABED RIMS (owner, 2026-08-14, low-angle screenshot).
//
// The rim palette makes an underwater seam a bright silt line, but a skirt is a
// VERTICAL face and the scene has one directional sun, so the orientations
// facing away from it rendered dark whatever colour they carried: the outlines
// read from overhead and vanished from a low camera. The geometry therefore
// flags every underwater cut face, and the material shades a flagged face as
// its own colour (render/terrainMeshes.ts).
//
// These assertions are about which FACES carry the flag, which is the half of
// the contract that can be checked without a GL context; the other half — that
// the material actually honours it — is asserted in terrainMeshes.test.ts.
// ---------------------------------------------------------------------------
describe('self-lit seabed rims', () => {
  /**
   * A coast in cross-section: deep seabed (band −3), shelf (band −1), then
   * land four bands up. It therefore emits underwater skirts, the hairline
   * shore skirt, and ordinary land cliffs, which is every case the flag has an
   * opinion about.
   */
  const coast = (i: number): number => (i < 5 ? -192 : i < 10 ? -64 : 256);

  /**
   * Whether a face's colour came from the seabed regime: the lightened-tread
   * riser faces (seabed half of the cliff ramp) or, since the 2026-08-19
   * top-edge borders, the seabed TREADS themselves — a border sliver is
   * painted as the next band down's tread and rides the same self-lit flag as
   * the face it caps.
   */
  const isSeabedColored = (t: Triangle): boolean =>
    [
      ...CLIFF_PALETTE.slice(0, FIRST_LAND_PALETTE_INDEX),
      ...TERRAIN_PALETTE.slice(0, FIRST_LAND_PALETTE_INDEX),
    ].some(
      (c) => Math.abs(t.color[0] - c[0]) < 1e-6 && Math.abs(t.color[1] - c[1]) < 1e-6,
    );

  it('flags every underwater skirt and nothing else', () => {
    const { triangles } = writeEdge(coast);
    const skirts = skirtsOf(triangles);
    expect(skirts.length).toBeGreaterThan(0);

    // The flag follows the palette regime exactly: a face drawn with a seabed
    // colour (riser face or border sliver) is self-lit, and a face drawn with
    // a rock colour is not. Stated as an equivalence rather than two counts,
    // so neither side can drift.
    let seabedFaces = 0;
    for (const skirt of skirts) {
      const seabed = isSeabedColored(skirt);
      expect(skirt.selfLit).toBe(seabed ? SELF_LIT : LIT_BY_SCENE);
      if (seabed) seabedFaces++;
    }
    expect(seabedFaces).toBeGreaterThan(0);
    expect(seabedFaces).toBeLessThan(skirts.length);
  });

  it('never flags a cap, however deep it is', () => {
    // A tread faces the sky, so it already catches the sun on every
    // orientation; unlighting the seabed floor would flatten the depth ramp
    // the palette exists to show.
    const { triangles } = writeEdge(coast);
    const caps = capsOf(triangles);
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) expect(cap.selfLit).toBe(LIT_BY_SCENE);
  });

  it('flags underwater walls in the BLOCKY FALLBACK too', () => {
    // The fallback draws its own per-cell walls, so a chunk that went blocky
    // must not also lose its rims — same rule, second emission path.
    // The checkerboard of the fallback's own suite, sunk four bands under the
    // sea: every cell alternates between band −6 and band −2, so every level
    // it crosses is underwater and its contour geometry is far over budget.
    const { counts, triangles } = writeEdge(
      (i, j) => ((i + j) % 2) * 4 * BAND_HEIGHT - 6 * BAND_HEIGHT,
    );
    expect(counts.usedFallback).toBe(true);
    const skirts = skirtsOf(triangles);
    expect(skirts.length).toBeGreaterThan(0);
    // Every cell of this fixture is underwater, so every wall and curtain the
    // fallback emits is a rim.
    for (const skirt of skirts) expect(skirt.selfLit).toBe(SELF_LIT);
    for (const cap of capsOf(triangles)) expect(cap.selfLit).toBe(LIT_BY_SCENE);
  });

  it('leaves an all-land chunk with no flagged geometry at all', () => {
    const { triangles } = writeEdge((i) => (i < 8 ? 128 : 384));
    expect(skirtsOf(triangles).length).toBeGreaterThan(0);
    for (const t of triangles) expect(t.selfLit).toBe(LIT_BY_SCENE);
  });

  it('clears the flag on the unused tail, like every other attribute', () => {
    // A stale SELF_LIT byte under a later, shorter geometry would light a
    // triangle that no longer exists if the draw range were ever wrong.
    const { buffers } = writeEdge(coast);
    const flat = mirrorWith([edgeChunk(() => 0)]);
    const after = writeChunkVertexData(flat, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    for (let v = after.vertexCount; v < buffers.selfLit.length; v++) {
      expect(buffers.selfLit[v]).toBe(LIT_BY_SCENE);
    }
  });

  it('grows the flag buffer alongside the others', () => {
    // ensureCapacity replaces all four arrays; a forgotten one would leave the
    // flags addressing the OLD, shorter buffer and throw away every rim past
    // the previous capacity.
    const buffers = createChunkGeometryBuffers(4);
    const mirror = mirrorWith([edgeChunk(coast)]);
    const grown = writeChunkVertexData(mirror, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(grown.capacityGrew).toBe(true);
    expect(buffers.selfLit.length).toBe(
      buffers.triangleCapacity * VERTICES_PER_TRIANGLE,
    );
    expect(
      Array.from(buffers.selfLit.subarray(0, grown.vertexCount)).some(
        (flag) => flag === SELF_LIT,
      ),
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
    // The whole point of the working capacity: a chunk grows to its own
    // high-water mark within the first edits, and the steady state of a held
    // sculpt then reallocates nothing.
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
    // A smooth 7-band hill outgrows the starting capacity, so it grows once...
    expect(first.triangleCount).toBeGreaterThan(INITIAL_CHUNK_TRIANGLE_CAPACITY);
    expect(first.capacityGrew).toBe(true);

    // ...and then never again, however the stroke reshapes it.
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

    // Capacity never shrinks back, so the same chunk never thrashes.
    const flat = mirrorWith([edgeChunk(() => 256)]);
    const after = writeChunkVertexData(flat, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(after.capacityGrew).toBe(false);
    expect(after.triangleCapacity).toBe(grown.triangleCapacity);
  });

  it('collapses the unused tail onto a vertex inside the chunk', () => {
    // computeBoundingSphere (terrainMeshes.ts) reads the whole attribute and
    // ignores the draw range, so stale or zeroed tail vertices would drag a
    // distant chunk's bound back toward the world origin.
    const { buffers, counts } = write(mirrorWith([chunkPayload(2, 2, 100)]), 2, 2);
    const total = counts.triangleCapacity * VERTICES_PER_TRIANGLE;
    expect(counts.vertexCount).toBeLessThan(total);
    const anchor = vertexAt(buffers, 0);
    for (let v = counts.vertexCount; v < total; v++) {
      expect(vertexAt(buffers, v)).toEqual(anchor);
    }
  });

  it('leaves no stale geometry behind when a re-patch emits less', () => {
    const buffers = createChunkGeometryBuffers();
    const cliffy = mirrorWith([edgeChunk((i) => (i < 8 ? 0 : 256))]);
    const before = writeChunkVertexData(cliffy, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);

    const flat = mirrorWith([edgeChunk(() => 256)]);
    const after = writeChunkVertexData(flat, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(after.triangleCount).toBeLessThan(before.triangleCount);
    expect(after.skirtTriangleCount).toBe(0);

    const anchor = vertexAt(buffers, 0);
    const total = after.triangleCapacity * VERTICES_PER_TRIANGLE;
    for (let v = after.vertexCount; v < total; v++) {
      expect(vertexAt(buffers, v).y).toBe(anchor.y);
    }
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
    expect(Array.from(second.normals)).toEqual(Array.from(first.normals));
    expect(Array.from(second.colors)).toEqual(Array.from(first.colors));
  });
});
