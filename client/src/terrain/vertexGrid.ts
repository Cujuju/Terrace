// Chunk mesh vertex maths — the terraced surface and the seam rule.
// Pure: no Three.js, no DOM. Tested headless in test/vertexGrid.test.ts.
//
// CRITICAL CODE — this is where terrain becomes geometry, and where adjacent
// chunk meshes are made to line up. Two decisions carry the module:
//
// SEAM RULE. A chunk owns CHUNK_SIZE × CHUNK_SIZE cells but its mesh has
// (CHUNK_SIZE + 1)² vertices: one vertex per owned cell, PLUS one extra row and
// column that sample the FIRST cells of the neighbouring chunks. So the last
// vertex of chunk N and the first vertex of chunk N+1 sit at the same world
// position with the same height, and the two meshes tile with no crack. All of
// those samples come from the shared local mirror, which holds every cell the
// server has sent us, so no cross-mesh communication is needed. (The matching
// invalidation rule — a border cell dirties its neighbour's mesh too — lives in
// mirror.ts `chunksDirtiedByCell`.)
//
// TERRACING. Vertex height is `quantizeToBand(h)`, not `h`. Snapping to the
// band floor is what produces the Godus step look; with MAX_STEP = BAND_HEIGHT/2
// a one-band change needs at least two cells of travel, so the surface reads as
// flat treads separated by one-cell risers. Combined with a flat-shaded
// material (each triangle gets a constant face normal) the steps read crisply.
//
// KNOWN LIMIT, deliberate for Phase 1: because vertices are shared between
// adjacent cells, a riser is a 45° ramp rather than a vertical wall. True
// vertical walls need four unduplicated vertices per cell plus always-present
// (often degenerate) wall quads — ~12 vertices per cell instead of ~1. That is
// a Phase 2 look upgrade; the vertex-per-cell grid is what Phase 1 pinned, and
// it keeps a patch at 289 vertices per chunk.

import { CHUNK_SIZE, quantizeToBand } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { bandPaletteIndex, type Rgb } from './bandColors.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';

/** One extra row/column beyond the owned cells — see SEAM RULE above. */
export const CHUNK_VERTS_PER_EDGE = CHUNK_SIZE + 1;
export const CHUNK_VERTEX_COUNT = CHUNK_VERTS_PER_EDGE * CHUNK_VERTS_PER_EDGE;
/** Two triangles per cell quad. */
export const CHUNK_INDEX_COUNT = CHUNK_SIZE * CHUNK_SIZE * 6;

const COMPONENTS_PER_POSITION = 3;
const COMPONENTS_PER_COLOR = 3;

export interface CellCoord {
  x: number;
  y: number;
}

/**
 * The world cell that vertex (i,j) of chunk (cx,cy) represents.
 *
 * Coordinates are clamped into the world, which only bites on the chunks at
 * the world's far edge: their extra sampling row would fall on cell
 * `worldSize`, which does not exist. Clamping collapses that last quad to zero
 * area instead — harmless, and it keeps the rendered terrain exactly within
 * [0, worldSize-1] so pointer picking needs no special case for the border.
 *
 * Both the sampled height AND the vertex's world position come from this one
 * function, so geometry and data can never disagree about which cell a vertex
 * is.
 */
export function chunkVertexCell(
  worldSize: number,
  cx: number,
  cy: number,
  i: number,
  j: number,
): CellCoord {
  const max = worldSize - 1;
  const x = cx * CHUNK_SIZE + i;
  const y = cy * CHUNK_SIZE + j;
  return { x: x > max ? max : x, y: y > max ? max : y };
}

/**
 * Fills the position and colour buffers for one chunk from the mirror.
 *
 * This is the in-place patch path: the caller owns the buffers for the whole
 * life of the chunk mesh and simply re-runs this function, then flags the
 * attributes as needing upload. Geometry is never rebuilt on an edit (design
 * doc §8, client performance target).
 *
 * `palette` is injected rather than imported so the renderer can pass a
 * palette already converted to Three's linear working colour space while tests
 * pass the plain sRGB one — same selection logic either way.
 */
export function writeChunkVertexData(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  positions: Float32Array,
  colors: Float32Array,
  palette: readonly Rgb[],
): void {
  const expectedPositions = CHUNK_VERTEX_COUNT * COMPONENTS_PER_POSITION;
  const expectedColors = CHUNK_VERTEX_COUNT * COMPONENTS_PER_COLOR;
  if (positions.length !== expectedPositions || colors.length !== expectedColors) {
    throw new RangeError(
      `chunk buffers must be ${expectedPositions}/${expectedColors} long, ` +
        `got ${positions.length}/${colors.length}`,
    );
  }

  const worldSize = mirror.map.size;
  let p = 0;
  let c = 0;

  // Row-major over the vertex grid (j outer, i inner) — the same order the
  // index buffer assumes.
  for (let j = 0; j < CHUNK_VERTS_PER_EDGE; j++) {
    for (let i = 0; i < CHUNK_VERTS_PER_EDGE; i++) {
      const cell = chunkVertexCell(worldSize, cx, cy, i, j);
      const height = sampleHeight(mirror, cell.x, cell.y);

      // World layout: cell X → +X, cell Y → +Z, height → +Y (up).
      positions[p++] = cell.x * CELL_WORLD_SIZE;
      positions[p++] = quantizeToBand(height) * HEIGHT_WORLD_SCALE;
      positions[p++] = cell.y * CELL_WORLD_SIZE;

      // Colour from the RAW height, not the quantised one: both agree on the
      // band (quantizing cannot move a height across a band boundary), and
      // using the raw value keeps this independent of the terracing step.
      const color = palette[bandPaletteIndex(height)];
      colors[c++] = color[0];
      colors[c++] = color[1];
      colors[c++] = color[2];
    }
  }
}

/**
 * The triangle index buffer. Every chunk has identical topology, so this is
 * built once and the resulting attribute is shared by every chunk mesh.
 *
 * Winding is (a, c, b) / (b, c, d) with a=(i,j), b=(i+1,j), c=(i,j+1),
 * d=(i+1,j+1), which yields a +Y (upward) face normal under Three's
 * counter-clockwise front-face convention for the X→+X, Y→+Z layout above.
 * Get this backwards and the whole world renders as its own underside.
 */
export function buildChunkIndices(): Uint16Array {
  const indices = new Uint16Array(CHUNK_INDEX_COUNT);
  let k = 0;
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const a = j * CHUNK_VERTS_PER_EDGE + i;
      const b = a + 1;
      const c = a + CHUNK_VERTS_PER_EDGE;
      const d = c + 1;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }
  return indices;
}

export function createChunkPositionBuffer(): Float32Array {
  return new Float32Array(CHUNK_VERTEX_COUNT * COMPONENTS_PER_POSITION);
}

export function createChunkColorBuffer(): Float32Array {
  return new Float32Array(CHUNK_VERTEX_COUNT * COMPONENTS_PER_COLOR);
}
