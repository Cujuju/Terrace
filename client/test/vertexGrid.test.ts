import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, quantizeToBand, type ChunkPayload } from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  CHUNK_INDEX_COUNT,
  CHUNK_VERTEX_COUNT,
  CHUNK_VERTS_PER_EDGE,
  buildChunkIndices,
  chunkVertexCell,
  createChunkColorBuffer,
  createChunkPositionBuffer,
  writeChunkVertexData,
} from '../src/terrain/vertexGrid.ts';
import { TERRAIN_PALETTE } from '../src/terrain/bandColors.ts';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

/** Reads vertex (i,j) of a written position buffer as {x,y,z}. */
function vertexAt(positions: Float32Array, i: number, j: number) {
  const base = (j * CHUNK_VERTS_PER_EDGE + i) * 3;
  return { x: positions[base], y: positions[base + 1], z: positions[base + 2] };
}

describe('chunkVertexCell', () => {
  it('maps vertex (i,j) to the cell at the chunk origin plus (i,j)', () => {
    expect(chunkVertexCell(WORLD, 0, 0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(chunkVertexCell(WORLD, 1, 2, 3, 4)).toEqual({
      x: CHUNK_SIZE + 3,
      y: CHUNK_SIZE * 2 + 4,
    });
  });

  it('samples one cell into the neighbouring chunk on the far edge', () => {
    // This is the seam rule: chunk 0's last vertex is chunk 1's first cell.
    const last = chunkVertexCell(WORLD, 0, 0, CHUNK_SIZE, CHUNK_SIZE);
    expect(last).toEqual({ x: CHUNK_SIZE, y: CHUNK_SIZE });

    const neighbourFirst = chunkVertexCell(WORLD, 1, 1, 0, 0);
    expect(neighbourFirst).toEqual(last);
  });

  it('clamps the extra sampling row at the world border', () => {
    const lastChunk = WORLD / CHUNK_SIZE - 1;
    expect(chunkVertexCell(WORLD, lastChunk, lastChunk, CHUNK_SIZE, CHUNK_SIZE)).toEqual({
      x: WORLD - 1,
      y: WORLD - 1,
    });
  });
});

describe('buildChunkIndices', () => {
  it('emits two triangles per cell', () => {
    const indices = buildChunkIndices();
    expect(indices.length).toBe(CHUNK_INDEX_COUNT);
    expect(CHUNK_INDEX_COUNT).toBe(CHUNK_SIZE * CHUNK_SIZE * 6);
  });

  it('references only vertices that exist', () => {
    for (const index of buildChunkIndices()) {
      expect(index).toBeLessThan(CHUNK_VERTEX_COUNT);
    }
  });

  it('winds triangles so the surface faces up (+Y)', () => {
    const indices = buildChunkIndices();
    const positions = createChunkPositionBuffer();
    const colors = createChunkColorBuffer();
    const mirror = createTerrainMirror(WORLD);
    writeChunkVertexData(mirror, 0, 0, positions, colors, TERRAIN_PALETTE);

    // Cross product of the first triangle's edges must point along +Y.
    const [ia, ib, ic] = [indices[0], indices[1], indices[2]];
    const read = (i: number) => ({
      x: positions[i * 3],
      y: positions[i * 3 + 1],
      z: positions[i * 3 + 2],
    });
    const a = read(ia);
    const b = read(ib);
    const c = read(ic);
    const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const normalY = e1.z * e2.x - e1.x * e2.z;
    expect(normalY).toBeGreaterThan(0);
  });
});

describe('writeChunkVertexData', () => {
  it('places vertices at cell coordinates with height snapped to its band', () => {
    const mirror = createTerrainMirror(WORLD);
    // 100 sits inside band 1 (BAND_HEIGHT 64), so it must render at 64.
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 100)],
    });

    const positions = createChunkPositionBuffer();
    const colors = createChunkColorBuffer();
    writeChunkVertexData(mirror, 0, 0, positions, colors, TERRAIN_PALETTE);

    const v = vertexAt(positions, 3, 4);
    expect(v.x).toBeCloseTo(3 * CELL_WORLD_SIZE);
    expect(v.z).toBeCloseTo(4 * CELL_WORLD_SIZE);
    expect(v.y).toBeCloseTo(quantizeToBand(100) * HEIGHT_WORLD_SCALE);
    // One band of height is one cell of width — the 45° riser.
    expect(v.y).toBeCloseTo(BAND_WORLD_HEIGHT);
  });

  it('makes adjacent chunk meshes agree on their shared border vertices', () => {
    // THE seam test. Two chunks at different heights; the border vertices of
    // each must coincide exactly, or the meshes crack apart.
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 0), chunkPayload(1, 0, 512)],
    });

    const leftPos = createChunkPositionBuffer();
    const rightPos = createChunkPositionBuffer();
    const scratch = createChunkColorBuffer();
    writeChunkVertexData(mirror, 0, 0, leftPos, scratch, TERRAIN_PALETTE);
    writeChunkVertexData(mirror, 1, 0, rightPos, scratch, TERRAIN_PALETTE);

    for (let j = 0; j < CHUNK_VERTS_PER_EDGE; j++) {
      // Left chunk's LAST column against the right chunk's FIRST column.
      const left = vertexAt(leftPos, CHUNK_SIZE, j);
      const right = vertexAt(rightPos, 0, j);
      expect(left).toEqual(right);

      // Those vertices must carry the RIGHT chunk's height, not the left's —
      // that is the whole point of sampling across the border. Only rows the
      // right chunk actually covers: row CHUNK_SIZE is the seam sample of the
      // chunk below, which was never sent and so is correctly at sea level.
      if (j < CHUNK_SIZE) {
        expect(left.y).toBeCloseTo(512 * HEIGHT_WORLD_SCALE);
      } else {
        expect(left.y).toBeCloseTo(0);
      }
    }
  });

  it('agrees on the shared border row between vertically adjacent chunks', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 0), chunkPayload(0, 1, 256)],
    });

    const topPos = createChunkPositionBuffer();
    const bottomPos = createChunkPositionBuffer();
    const scratch = createChunkColorBuffer();
    writeChunkVertexData(mirror, 0, 0, topPos, scratch, TERRAIN_PALETTE);
    writeChunkVertexData(mirror, 0, 1, bottomPos, scratch, TERRAIN_PALETTE);

    for (let i = 0; i < CHUNK_VERTS_PER_EDGE; i++) {
      expect(vertexAt(topPos, i, CHUNK_SIZE)).toEqual(vertexAt(bottomPos, i, 0));
    }
  });

  it('slopes down to sea level at the edge of received territory', () => {
    // Chunk (1,0) was never sent, so chunk (0,0)'s border samples read 0 —
    // the revealed land runs down into the sea rather than ending in a
    // floating cliff.
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 300)],
    });

    const positions = createChunkPositionBuffer();
    const colors = createChunkColorBuffer();
    writeChunkVertexData(mirror, 0, 0, positions, colors, TERRAIN_PALETTE);

    expect(vertexAt(positions, CHUNK_SIZE - 1, 0).y).toBeCloseTo(
      quantizeToBand(300) * HEIGHT_WORLD_SCALE,
    );
    expect(vertexAt(positions, CHUNK_SIZE, 0).y).toBeCloseTo(0);
  });

  it('writes a colour per vertex from the injected palette', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 100)],
    });

    const positions = createChunkPositionBuffer();
    const colors = createChunkColorBuffer();
    writeChunkVertexData(mirror, 0, 0, positions, colors, TERRAIN_PALETTE);

    // Band 1 → palette index 2 (index 0 is seabed, 1 is band 0).
    const expected = TERRAIN_PALETTE[2];
    expect(colors[0]).toBeCloseTo(expected[0]);
    expect(colors[1]).toBeCloseTo(expected[1]);
    expect(colors[2]).toBeCloseTo(expected[2]);
  });

  it('rejects buffers of the wrong size rather than writing out of range', () => {
    const mirror = createTerrainMirror(WORLD);
    expect(() =>
      writeChunkVertexData(
        mirror,
        0,
        0,
        new Float32Array(3),
        createChunkColorBuffer(),
        TERRAIN_PALETTE,
      ),
    ).toThrow(RangeError);
  });

  it('is idempotent — re-patching the same data yields the same buffers', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 77)],
    });

    const first = createChunkPositionBuffer();
    const second = createChunkPositionBuffer();
    const scratch = createChunkColorBuffer();
    writeChunkVertexData(mirror, 0, 0, first, scratch, TERRAIN_PALETTE);
    writeChunkVertexData(mirror, 0, 0, second, scratch, TERRAIN_PALETTE);
    expect(Array.from(second)).toEqual(Array.from(first));
  });
});
