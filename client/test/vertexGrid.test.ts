// Geometry-builder tests. The builder is pure (no Three.js, no DOM), so all of
// this runs headless against plain typed arrays — which is the point: the
// terraced silhouette is feel-critical and must be assertable without a GPU.

import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, quantizeToBand, type ChunkPayload } from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  CHUNK_INDEX_COUNT,
  CHUNK_VERTEX_COUNT,
  CLIFF_FACE_PICK_INSET,
  INDICES_PER_QUAD,
  MAX_QUADS_PER_CHUNK,
  MAX_WALL_QUADS_PER_CHUNK,
  TOP_QUADS_PER_CHUNK,
  VERTICES_PER_QUAD,
  buildChunkIndices,
  createChunkGeometryBuffers,
  writeChunkVertexData,
  type ChunkGeometryBuffers,
  type ChunkGeometryCounts,
  type ChunkPalettes,
} from '../src/terrain/vertexGrid.ts';
import {
  CLIFF_PALETTE,
  TERRAIN_PALETTE,
  bandPaletteIndex,
  type Rgb,
} from '../src/terrain/bandColors.ts';
import { worldPointToCell } from '../src/terrain/picking.ts';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

/**
 * The world's last chunk. Most wall tests build their terrain HERE on purpose:
 * at the world border sampleHeight clamps, so the +x/+y probes fall back onto
 * the chunk itself and the only walls emitted are the ones the test asked for.
 * Anywhere else, the never-received neighbours read as band 0 and add a rim of
 * border walls that would swamp the count being asserted.
 */
const EDGE_CHUNK = WORLD / CHUNK_SIZE - 1;
const EDGE_ORIGIN = EDGE_CHUNK * CHUNK_SIZE;

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

/** The four corners of quad `q`, in the v0..v3 order writeQuad lays down. */
function quadCorners(buffers: ChunkGeometryBuffers, q: number): Vertex[] {
  const out: Vertex[] = [];
  for (let v = 0; v < VERTICES_PER_QUAD; v++) {
    const base = (q * VERTICES_PER_QUAD + v) * 3;
    out.push({
      x: buffers.positions[base],
      y: buffers.positions[base + 1],
      z: buffers.positions[base + 2],
    });
  }
  return out;
}

function quadColor(buffers: ChunkGeometryBuffers, q: number): number[] {
  const base = q * VERTICES_PER_QUAD * 3;
  return [buffers.colors[base], buffers.colors[base + 1], buffers.colors[base + 2]];
}

function quadNormal(buffers: ChunkGeometryBuffers, q: number): Vertex {
  const base = q * VERTICES_PER_QUAD * 3;
  return {
    x: buffers.normals[base],
    y: buffers.normals[base + 1],
    z: buffers.normals[base + 2],
  };
}

/** Colours round-trip through Float32, so compare them at that precision. */
function expectColor(actual: readonly number[], expected: Rgb): void {
  expect(actual[0]).toBeCloseTo(expected[0], 6);
  expect(actual[1]).toBeCloseTo(expected[1], 6);
  expect(actual[2]).toBeCloseTo(expected[2], 6);
}

/** Slot of the top face of local cell (i,j) — the fixed part of the layout. */
function topQuadSlot(i: number, j: number): number {
  return j * CHUNK_SIZE + i;
}

interface Wall {
  quad: number;
  corners: Vertex[];
  /** 'x' — the wall lies in a plane of constant X; 'z' — constant Z. */
  axis: 'x' | 'z';
  plane: number;
  lowY: number;
  highY: number;
}

/** Every wall quad the last write emitted, decoded. */
function walls(buffers: ChunkGeometryBuffers, counts: ChunkGeometryCounts): Wall[] {
  const out: Wall[] = [];
  for (let q = TOP_QUADS_PER_CHUNK; q < counts.quadCount; q++) {
    const corners = quadCorners(buffers, q);
    const constantX = corners.every((c) => c.x === corners[0].x);
    const ys = corners.map((c) => c.y);
    out.push({
      quad: q,
      corners,
      axis: constantX ? 'x' : 'z',
      plane: constantX ? corners[0].x : corners[0].z,
      lowY: Math.min(...ys),
      highY: Math.max(...ys),
    });
  }
  return out;
}

function write(
  mirror: ReturnType<typeof createTerrainMirror>,
  cx: number,
  cy: number,
): { buffers: ChunkGeometryBuffers; counts: ChunkGeometryCounts } {
  const buffers = createChunkGeometryBuffers();
  const counts = writeChunkVertexData(mirror, cx, cy, buffers, PALETTES);
  return { buffers, counts };
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

describe('buildChunkIndices', () => {
  it('covers every possible quad slot with two triangles', () => {
    const indices = buildChunkIndices();
    expect(indices.length).toBe(CHUNK_INDEX_COUNT);
    expect(CHUNK_INDEX_COUNT).toBe(MAX_QUADS_PER_CHUNK * INDICES_PER_QUAD);
  });

  it('gives quad k its own four vertices, so nothing is shared across a crease', () => {
    const indices = buildChunkIndices();
    for (let q = 0; q < MAX_QUADS_PER_CHUNK; q++) {
      for (let k = 0; k < INDICES_PER_QUAD; k++) {
        const index = indices[q * INDICES_PER_QUAD + k];
        expect(index).toBeGreaterThanOrEqual(q * VERTICES_PER_QUAD);
        expect(index).toBeLessThan((q + 1) * VERTICES_PER_QUAD);
      }
    }
  });

  it('references only vertices that exist, and fits in a Uint16 index', () => {
    for (const index of buildChunkIndices()) {
      expect(index).toBeLessThan(CHUNK_VERTEX_COUNT);
    }
    expect(CHUNK_VERTEX_COUNT).toBeLessThanOrEqual(0x10000);
  });

  it('winds top faces so they face up (+Y)', () => {
    const indices = buildChunkIndices();
    const { buffers } = write(mirrorWith([chunkPayload(0, 0, 0)]), 0, 0);

    // Cross product of the first triangle's edges must point along +Y.
    const read = (i: number): Vertex => ({
      x: buffers.positions[i * 3],
      y: buffers.positions[i * 3 + 1],
      z: buffers.positions[i * 3 + 2],
    });
    const a = read(indices[0]);
    const b = read(indices[1]);
    const c = read(indices[2]);
    const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const normalY = e1.z * e2.x - e1.x * e2.z;
    expect(normalY).toBeGreaterThan(0);
  });
});

describe('top faces', () => {
  it('emits one flat quad per owned cell at the cell-centred footprint', () => {
    // 100 sits inside band 1 (BAND_HEIGHT 64), so it must render at 64.
    const { buffers, counts } = write(mirrorWith([chunkPayload(0, 0, 100)]), 0, 0);

    expect(counts.topQuadCount).toBe(TOP_QUADS_PER_CHUNK);
    expect(counts.topQuadCount).toBe(CELLS_PER_CHUNK);

    const corners = quadCorners(buffers, topQuadSlot(3, 4));
    const expectedY = quantizeToBand(100) * HEIGHT_WORLD_SCALE;
    for (const corner of corners) {
      // Flat: every corner at the SAME height. This is the whole terrace look.
      expect(corner.y).toBeCloseTo(expectedY);
    }
    expect(expectedY).toBeCloseTo(BAND_WORLD_HEIGHT);

    // Cell (3,4) covers [2.5, 3.5] × [3.5, 4.5] — centred on its integer
    // coordinate, which is what keeps picking.ts's Math.round() correct.
    expect(CELL_WORLD_SIZE).toBe(1);
    expect(corners.map((c) => c.x).sort()).toEqual([2.5, 2.5, 3.5, 3.5]);
    expect(corners.map((c) => c.z).sort()).toEqual([3.5, 3.5, 4.5, 4.5]);
  });

  it('points every top face straight up', () => {
    const { buffers } = write(mirrorWith([chunkPayload(0, 0, 300)]), 0, 0);
    for (let q = 0; q < TOP_QUADS_PER_CHUNK; q++) {
      expect(quadNormal(buffers, q)).toEqual({ x: 0, y: 1, z: 0 });
    }
  });

  it('quantises every cell to its band floor', () => {
    const height = (i: number, j: number): number => (i * 37 + j * 11) % 400;
    const { buffers } = writeEdge(height);

    for (let j = 0; j < CHUNK_SIZE; j++) {
      for (let i = 0; i < CHUNK_SIZE; i++) {
        const expected = quantizeToBand(height(i, j)) * HEIGHT_WORLD_SCALE;
        expect(quadCorners(buffers, topQuadSlot(i, j))[0].y).toBeCloseTo(expected);
      }
    }
  });

  it('keeps band-0 flats exactly at the waterline, so the sea cannot z-fight', () => {
    // WATER_SURFACE_LIFT's reasoning in config.ts depends on this: every
    // height in band 0 renders at world y = 0, and the sea floats just above.
    const { buffers } = write(mirrorWith([chunkPayload(0, 0, 63)]), 0, 0);
    for (let q = 0; q < TOP_QUADS_PER_CHUNK; q++) {
      expect(quadCorners(buffers, q)[0].y).toBe(0);
    }
  });
});

describe('cliff walls', () => {
  it('emits no wall where neighbouring cells share a band', () => {
    // 0 and 63 are different heights but the SAME band, so the surface is one
    // continuous flat — no wall, however much raw height differs.
    const { counts } = writeEdge((i) => (i % 2 === 0 ? 0 : 63));
    expect(counts.wallQuadCount).toBe(0);
    expect(counts.quadCount).toBe(TOP_QUADS_PER_CHUNK);
  });

  it('emits a TRUE VERTICAL wall spanning exactly the band difference', () => {
    const { buffers, counts } = writeEdge((i) => (i < 8 ? 0 : 256));

    // One wall per row of the step, and nothing else.
    expect(counts.wallQuadCount).toBe(CHUNK_SIZE);

    for (const wall of walls(buffers, counts)) {
      expect(wall.axis).toBe('x');
      // Vertical means every corner shares one X — the plane is exact, not
      // "nearly", or the face is a 45° ramp again.
      for (const corner of wall.corners) expect(corner.x).toBe(wall.plane);
      expect(wall.lowY).toBeCloseTo(0);
      expect(wall.highY).toBeCloseTo(quantizeToBand(256) * HEIGHT_WORLD_SCALE);
      // Its horizontal footprint is a single cell edge — a wall never spans
      // more than the cell that owns it.
      const zs = wall.corners.map((c) => c.z);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(CELL_WORLD_SIZE);
    }
  });

  it('spans a multi-band cliff with ONE quad, floor to rim', () => {
    const { buffers, counts } = writeEdge((i) => (i < 8 ? 0 : 1024));
    expect(counts.wallQuadCount).toBe(CHUNK_SIZE);
    for (const wall of walls(buffers, counts)) {
      expect(wall.highY - wall.lowY).toBeCloseTo(
        quantizeToBand(1024) * HEIGHT_WORLD_SCALE,
      );
    }
  });

  it('faces the wall outward, away from the cell that owns it', () => {
    // High land to the EAST, so the exposed face looks WEST (−X).
    const eastHigh = writeEdge((i) => (i < 8 ? 0 : 256));
    for (const wall of walls(eastHigh.buffers, eastHigh.counts)) {
      expect(quadNormal(eastHigh.buffers, wall.quad)).toEqual({ x: -1, y: 0, z: 0 });
    }

    // Mirror image: high land to the WEST, face looks EAST (+X).
    const westHigh = writeEdge((i) => (i < 8 ? 256 : 0));
    for (const wall of walls(westHigh.buffers, westHigh.counts)) {
      expect(quadNormal(westHigh.buffers, wall.quad)).toEqual({ x: 1, y: 0, z: 0 });
    }
  });

  it('emits +y walls in a plane of constant Z, facing along ±Z', () => {
    const southHigh = writeEdge((_i, j) => (j < 8 ? 0 : 256));
    expect(southHigh.counts.wallQuadCount).toBe(CHUNK_SIZE);
    for (const wall of walls(southHigh.buffers, southHigh.counts)) {
      expect(wall.axis).toBe('z');
      for (const corner of wall.corners) expect(corner.z).toBe(wall.plane);
      // The high ground is to the +Z side, so its face looks −Z.
      expect(quadNormal(southHigh.buffers, wall.quad)).toEqual({ x: 0, y: 0, z: -1 });
    }

    const northHigh = writeEdge((_i, j) => (j < 8 ? 256 : 0));
    for (const wall of walls(northHigh.buffers, northHigh.counts)) {
      expect(quadNormal(northHigh.buffers, wall.quad)).toEqual({ x: 0, y: 0, z: 1 });
    }
  });

  it('emits a shared edge exactly once — the owning cell emits it, not both', () => {
    // A single raised cell has four exposed edges. Two of them (+x, +y) are
    // emitted by the cell itself; the other two are the +x/+y edges of its west
    // and north neighbours. Four walls, no duplicates.
    const { buffers, counts } = writeEdge((i, j) => (i === 5 && j === 6 ? 256 : 0));
    expect(counts.wallQuadCount).toBe(4);

    // No two walls occupy the same plane and footprint (a duplicate would
    // z-fight and, worse, blur which cell owns the face).
    const fingerprints = walls(buffers, counts).map((wall) =>
      wall.corners
        .map((c) => `${c.x},${c.y},${c.z}`)
        .sort()
        .join('|'),
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('reads the neighbouring CHUNK through the mirror for border walls', () => {
    // Chunk (0,0) flat at band 0, chunk (1,0) a plateau at band 4. The wall
    // between them belongs to chunk (0,0)'s last column: it owns the +x edge.
    const mirror = mirrorWith([chunkPayload(0, 0, 0), chunkPayload(1, 0, 256)]);

    const left = write(mirror, 0, 0);
    expect(left.counts.wallQuadCount).toBe(CHUNK_SIZE);
    for (const wall of walls(left.buffers, left.counts)) {
      expect(wall.axis).toBe('x');
      // The border between cell 15 and cell 16 sits at world x = 15.5.
      expect(wall.plane).toBeCloseTo(CHUNK_SIZE - 0.5, 2);
      expect(wall.highY).toBeCloseTo(quantizeToBand(256) * HEIGHT_WORLD_SCALE);
    }

    // And the chunk on the other side emits NOTHING on that border — it only
    // ever emits its own cells' +x/+y edges, so the wall is not drawn twice.
    // (Its own far borders, against never-received chunks, are different edges
    // and are legitimately its to emit.)
    const right = write(mirror, 1, 0);
    const onSharedBorder = walls(right.buffers, right.counts).filter(
      (wall) => wall.axis === 'x' && wall.plane < CHUNK_SIZE,
    );
    expect(onSharedBorder).toHaveLength(0);
  });

  it('walls off the edge of received territory down to band 0', () => {
    // Chunk (1,0) was never sent, so its cells read height 0 through the
    // mirror — exactly the Phase 1 convention. The revealed plateau therefore
    // ends in a cliff down to the waterline rather than in mid-air.
    const { buffers, counts } = write(mirrorWith([chunkPayload(0, 0, 300)]), 0, 0);

    expect(counts.wallQuadCount).toBe(CHUNK_SIZE * 2); // its +x AND +y borders
    for (const wall of walls(buffers, counts)) {
      expect(wall.lowY).toBeCloseTo(0);
      expect(wall.highY).toBeCloseTo(quantizeToBand(300) * HEIGHT_WORLD_SCALE);
    }
  });

  it('emits no wall at the world border, where sampling clamps', () => {
    const { counts } = writeEdge(() => 512);
    // To the east and south the world ends: sampleHeight clamps back onto the
    // cell itself, the bands match, and no rim of walls is emitted.
    expect(counts.wallQuadCount).toBe(0);
  });
});

describe('wall ownership', () => {
  /**
   * The contract picking depends on: a hit anywhere on a vertical wall must
   * resolve — through picking.ts's UNCHANGED pure API — to the higher of the
   * two cells the wall separates. Asserted against the real function rather
   * than a restatement of its rounding rule.
   */
  function cellOfWall(wall: Wall): { x: number; y: number } | null {
    const mid = (pick: (c: Vertex) => number): number => {
      const values = wall.corners.map(pick);
      return (Math.min(...values) + Math.max(...values)) / 2;
    };
    return worldPointToCell(
      mid((c) => c.x) / CELL_WORLD_SIZE,
      mid((c) => c.z) / CELL_WORLD_SIZE,
      WORLD,
    );
  }

  it('resolves a hit on a spire wall to the HIGHER cell, on all four sides', () => {
    // One raised cell: its four walls face west, east, north and south, and
    // every one of them must sculpt that cell — the cliff you clicked.
    const { buffers, counts } = writeEdge((i, j) => (i === 5 && j === 6 ? 256 : 0));
    const found = walls(buffers, counts);
    expect(found).toHaveLength(4);
    for (const wall of found) {
      expect(cellOfWall(wall)).toEqual({
        x: EDGE_ORIGIN + 5,
        y: EDGE_ORIGIN + 6,
      });
    }
  });

  it('resolves a hit on a PIT wall to the higher rim, not the floor', () => {
    // The inverse case, and the one a naive tie-break gets wrong: a single
    // sunken cell. Every surrounding wall belongs to the rim around it.
    const { buffers, counts } = writeEdge((i, j) => (i === 9 && j === 4 ? 0 : 256));
    const found = walls(buffers, counts);
    expect(found).toHaveLength(4);

    const pit = { x: EDGE_ORIGIN + 9, y: EDGE_ORIGIN + 4 };
    const rim = [
      { x: pit.x - 1, y: pit.y },
      { x: pit.x + 1, y: pit.y },
      { x: pit.x, y: pit.y - 1 },
      { x: pit.x, y: pit.y + 1 },
    ];
    for (const wall of found) {
      const cell = cellOfWall(wall);
      expect(cell).not.toEqual(pit);
      expect(rim).toContainEqual(cell);
    }
  });

  it('insets the wall plane into the owning cell by exactly the named epsilon', () => {
    const boundary = EDGE_ORIGIN + 7.5;

    // High to the east: the wall between local cells 7 and 8 is owned by 8, so
    // its plane sits on cell 8's side of the boundary.
    const eastHigh = writeEdge((i) => (i < 8 ? 0 : 256));
    for (const wall of walls(eastHigh.buffers, eastHigh.counts)) {
      expect(wall.plane).toBeCloseTo(boundary + CLIFF_FACE_PICK_INSET, 6);
    }

    // High to the west: owned by cell 7, so the plane moves the other way.
    const westHigh = writeEdge((i) => (i < 8 ? 256 : 0));
    for (const wall of walls(westHigh.buffers, westHigh.counts)) {
      expect(wall.plane).toBeCloseTo(boundary - CLIFF_FACE_PICK_INSET, 6);
    }
  });

  it('keeps the inset far below half a cell, so the wall still reads as on the edge', () => {
    expect(CLIFF_FACE_PICK_INSET).toBeGreaterThan(0);
    expect(CLIFF_FACE_PICK_INSET).toBeLessThan(0.01);
    // A negative power of two: exact in binary, identical on every platform.
    expect(Number.isInteger(Math.log2(CLIFF_FACE_PICK_INSET))).toBe(true);
    // And it must survive Float32 storage at the far corner of the largest
    // supported world (512 cells), or the inset would round back into a tie.
    const farBoundary = 511.5;
    expect(Math.round(Math.fround(farBoundary + CLIFF_FACE_PICK_INSET))).toBe(512);
    expect(Math.round(Math.fround(farBoundary - CLIFF_FACE_PICK_INSET))).toBe(511);
  });
});

describe('colour attribution', () => {
  it('paints top faces from the band palette and walls from the cliff palette', () => {
    const { buffers, counts } = writeEdge((i) => (i < 8 ? 0 : 300));

    // Top of a high cell: the ordinary band ramp, from its RAW height.
    expectColor(quadColor(buffers, topQuadSlot(8, 0)), TERRAIN_PALETTE[bandPaletteIndex(300)]);
    // Top of a low cell: height 0 is water, hence the seabed entry.
    expectColor(quadColor(buffers, topQuadSlot(7, 0)), TERRAIN_PALETTE[bandPaletteIndex(0)]);

    // Walls take the OWNING (higher) cell's entry from the cliff ramp, so the
    // cut face matches the tread above it rather than the ground below it.
    const found = walls(buffers, counts);
    expect(found.length).toBeGreaterThan(0);
    for (const wall of found) {
      expectColor(quadColor(buffers, wall.quad), CLIFF_PALETTE[bandPaletteIndex(300)]);
    }
  });

  it('makes cliff faces visibly darker than the tread they sit under', () => {
    const luminance = (c: Rgb): number => c[0] + c[1] + c[2];
    for (let i = 0; i < TERRAIN_PALETTE.length; i++) {
      expect(luminance(CLIFF_PALETTE[i])).toBeLessThan(
        luminance(TERRAIN_PALETTE[i]) * 0.85,
      );
    }
  });
});

describe('emitted counts', () => {
  it('reports counts consistent with the quad layout', () => {
    const { counts } = write(mirrorWith([chunkPayload(0, 0, 100)]), 0, 0);
    expect(counts.quadCount).toBe(counts.topQuadCount + counts.wallQuadCount);
    expect(counts.vertexCount).toBe(counts.quadCount * VERTICES_PER_QUAD);
    expect(counts.indexCount).toBe(counts.quadCount * INDICES_PER_QUAD);
  });

  it('stays inside the documented worst case on the pathological terrain', () => {
    // Alternating bands on every cell: every cell differs from BOTH its +x and
    // +y neighbours, so this is the tight upper bound the buffers are sized
    // for. Neighbour chunks are supplied so the border cells count too.
    const checkerboard = (x: number, y: number): number => ((x + y) % 2) * 128;
    const mirror = mirrorWith([
      chunkPayloadFrom(1, 1, checkerboard),
      chunkPayloadFrom(2, 1, checkerboard),
      chunkPayloadFrom(1, 2, checkerboard),
    ]);
    const { counts } = write(mirror, 1, 1);

    expect(counts.wallQuadCount).toBe(MAX_WALL_QUADS_PER_CHUNK);
    expect(counts.quadCount).toBe(MAX_QUADS_PER_CHUNK);
    expect(counts.vertexCount).toBe(CHUNK_VERTEX_COUNT);
    expect(counts.indexCount).toBe(CHUNK_INDEX_COUNT);
  });

  it('collapses the unused tail onto a vertex inside the chunk', () => {
    // computeBoundingSphere (terrainMeshes.ts) reads the whole attribute and
    // ignores the draw range, so stale or zeroed tail vertices would drag a
    // distant chunk's bound back toward the world origin.
    const { buffers, counts } = write(mirrorWith([chunkPayload(2, 2, 100)]), 2, 2);
    expect(counts.vertexCount).toBeLessThan(CHUNK_VERTEX_COUNT);

    const anchor = quadCorners(buffers, 0)[0];
    for (let v = counts.vertexCount; v < CHUNK_VERTEX_COUNT; v++) {
      const base = v * 3;
      expect(buffers.positions[base]).toBe(anchor.x);
      expect(buffers.positions[base + 1]).toBe(anchor.y);
      expect(buffers.positions[base + 2]).toBe(anchor.z);
    }
  });

  it('shrinks the live range again when a cliff is levelled', () => {
    const cliffy = writeEdge((i) => (i < 8 ? 0 : 256));
    const flat = writeEdge(() => 256);
    expect(cliffy.counts.indexCount).toBeGreaterThan(flat.counts.indexCount);
    expect(flat.counts.wallQuadCount).toBe(0);
  });
});

describe('writeChunkVertexData contract', () => {
  it('rejects buffers of the wrong size rather than writing out of range', () => {
    const mirror = createTerrainMirror(WORLD);
    const buffers = createChunkGeometryBuffers();
    const stub = new Float32Array(3);
    expect(() =>
      writeChunkVertexData(mirror, 0, 0, { ...buffers, positions: stub }, PALETTES),
    ).toThrow(RangeError);
    expect(() =>
      writeChunkVertexData(mirror, 0, 0, { ...buffers, normals: stub }, PALETTES),
    ).toThrow(RangeError);
    expect(() =>
      writeChunkVertexData(mirror, 0, 0, { ...buffers, colors: stub }, PALETTES),
    ).toThrow(RangeError);
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

  it('leaves no stale geometry behind when a re-patch emits fewer walls', () => {
    // The same buffers reused: what was a cliff must not survive as garbage in
    // the tail once the terrain is levelled.
    const buffers = createChunkGeometryBuffers();
    const cliffy = mirrorWith([edgeChunk((i) => (i < 8 ? 0 : 256))]);
    writeChunkVertexData(cliffy, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);

    const flat = mirrorWith([edgeChunk(() => 256)]);
    const counts = writeChunkVertexData(flat, EDGE_CHUNK, EDGE_CHUNK, buffers, PALETTES);
    expect(counts.wallQuadCount).toBe(0);

    const anchor = quadCorners(buffers, 0)[0];
    for (let v = counts.vertexCount; v < CHUNK_VERTEX_COUNT; v++) {
      expect(buffers.positions[v * 3 + 1]).toBe(anchor.y);
    }
  });
});
