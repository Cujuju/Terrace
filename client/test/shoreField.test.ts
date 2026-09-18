import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  DRAWN_GROUND_BAND_BIAS,
  DRAWN_GROUND_COORD_DENOM,
  chunkIndex,
  drawnCornerNumerator,
  drawnLevelThreshold,
  shoreContourSample,
} from '@terrace/shared';
import {
  createTerrainMirror,
  sampleRenderBandHeight,
  type TerrainMirror,
} from '../src/terrain/mirror.ts';
import {
  RECT_NONE,
  assembleLoops,
  domainInside,
  loadSampleField,
  marchLevel,
} from '../src/terrain/contours.ts';
import { createShoreFieldBuffer, writeShoreFieldTexels } from '../src/terrain/waterDepth.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const CHUNKS_PER_EDGE = WORLD_SIZE / CHUNK_SIZE;

const SHORE_FIELD_BAND = 0;

// What the sea's shader calls dry: the land cap's own threshold, unbiased.
const SHORE_THRESHOLD = drawnLevelThreshold(SHORE_FIELD_BAND) - DRAWN_GROUND_BAND_BIAS;

const WEIGHT_TOTAL = DRAWN_GROUND_COORD_DENOM * DRAWN_GROUND_COORD_DENOM;

// The contour marches a chunk at a time; its seam vertices ride the chunk border
// rather than the isoline, so only interior vertices carry the shore contract.
const ON_ISOLINE_TOLERANCE = 1 / 64;

const CONE_PEAK_HEIGHT = 40;
const CONE_FALL_PER_CELL = 3;

function coneMirror(): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  const centre = WORLD_SIZE / 2;
  for (let z = 0; z < WORLD_SIZE; z++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const r = Math.hypot(x - centre, z - centre);
      mirror.map.cells[z * WORLD_SIZE + x] = Math.round(CONE_PEAK_HEIGHT - r * CONE_FALL_PER_CELL);
    }
  }
  return mirror;
}

function receiveAll(mirror: TerrainMirror): number[] {
  const chunks: number[] = [];
  for (let cy = 0; cy < CHUNKS_PER_EDGE; cy++) {
    for (let cx = 0; cx < CHUNKS_PER_EDGE; cx++) {
      const index = chunkIndex(WORLD_SIZE, cx, cy);
      mirror.received.add(index);
      chunks.push(index);
    }
  }
  return chunks;
}

function fieldOf(mirror: TerrainMirror, chunks: number[]): Float32Array {
  const buffer = createShoreFieldBuffer(WORLD_SIZE);
  writeShoreFieldTexels(buffer, WORLD_SIZE, mirror, chunks);
  return buffer;
}

/** The blend the sea's shader does: floor to a texel corner, bilinear over the 2x2 it starts. */
function blendAt(field: Float32Array, x: number, z: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const last = WORLD_SIZE - 1;
  const clamp = (v: number) => (v < 0 ? 0 : v > last ? last : v);
  const texel = (a: number, b: number) => field[clamp(b) * WORLD_SIZE + clamp(a)]!;
  return (
    drawnCornerNumerator(
      texel(i, j),
      texel(i + 1, j),
      texel(i, j + 1),
      texel(i + 1, j + 1),
      Math.round((x - i) * DRAWN_GROUND_COORD_DENOM),
      Math.round((z - j) * DRAWN_GROUND_COORD_DENOM),
    ) / WEIGHT_TOTAL
  );
}

function bandZeroLoops(mirror: TerrainMirror) {
  const threshold = drawnLevelThreshold(SHORE_FIELD_BAND);
  const loops = [];
  for (let cy = 0; cy < CHUNKS_PER_EDGE; cy++) {
    for (let cx = 0; cx < CHUNKS_PER_EDGE; cx++) {
      const originX = cx * CHUNK_SIZE;
      const originZ = cy * CHUNK_SIZE;
      loadSampleField(
        (i, j) =>
          shoreContourSample(
            sampleRenderBandHeight(mirror, originX + i, originZ + j, SHORE_FIELD_BAND),
          ),
        CHUNK_SIZE,
      );
      const segments = marchLevel(threshold, originX, originZ, null);
      loops.push(
        ...assembleLoops(segments, originX, originZ, domainInside(threshold, null)),
      );
    }
  }
  return loops;
}

describe('the sea reads the land cap band-0 field', () => {
  it('stores the wet/dry value of every cell it owns', () => {
    const mirror = coneMirror();
    const field = fieldOf(mirror, receiveAll(mirror));
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        expect(field[z * WORLD_SIZE + x]).toBe(
          shoreContourSample(sampleRenderBandHeight(mirror, x, z, SHORE_FIELD_BAND)),
        );
      }
    }
  });

  it('blends to the shore threshold along the land cap contour', () => {
    const mirror = coneMirror();
    const field = fieldOf(mirror, receiveAll(mirror));
    let checked = 0;
    for (const loop of bandZeroLoops(mirror)) {
      for (const point of loop) {
        if (point.rect !== RECT_NONE) continue;
        expect(Math.abs(blendAt(field, point.x, point.z) - SHORE_THRESHOLD)).toBeLessThan(
          ON_ISOLINE_TOLERANCE,
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('separates wet from dry on the two sides of that contour', () => {
    const mirror = coneMirror();
    const field = fieldOf(mirror, receiveAll(mirror));
    const centre = WORLD_SIZE / 2;
    const step = 1 / 4;
    let inland = 0;
    let offshore = 0;
    for (const loop of bandZeroLoops(mirror)) {
      for (const point of loop) {
        if (point.rect !== RECT_NONE) continue;
        const toSea = Math.hypot(point.x - centre, point.z - centre);
        if (toSea === 0) continue;
        const ux = (point.x - centre) / toSea;
        const uz = (point.z - centre) / toSea;
        if (blendAt(field, point.x - ux * step, point.z - uz * step) > SHORE_THRESHOLD) inland++;
        if (blendAt(field, point.x + ux * step, point.z + uz * step) < SHORE_THRESHOLD) offshore++;
      }
    }
    expect(inland).toBeGreaterThan(0);
    expect(offshore).toBe(inland);
  });

  it('writes a seam texel the unreceived neighbour cannot write for itself', () => {
    const mirror = coneMirror();
    receiveAll(mirror);
    mirror.received.delete(chunkIndex(WORLD_SIZE, 1, 0));
    const field = fieldOf(mirror, [chunkIndex(WORLD_SIZE, 0, 0)]);
    const seamX = CHUNK_SIZE;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      expect(field[z * WORLD_SIZE + seamX]).toBe(
        shoreContourSample(sampleRenderBandHeight(mirror, seamX, z, SHORE_FIELD_BAND)),
      );
    }
  });

  it('leaves a received neighbour to write its own seam texels', () => {
    const mirror = coneMirror();
    receiveAll(mirror);
    const field = createShoreFieldBuffer(WORLD_SIZE);
    writeShoreFieldTexels(field, WORLD_SIZE, mirror, [chunkIndex(WORLD_SIZE, 0, 0)]);
    expect(field[CHUNK_SIZE]).toBe(0);
  });
});
