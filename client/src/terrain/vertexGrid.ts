// Chunk mesh geometry — the terraced surface with TRUE VERTICAL CLIFFS.
// Pure: no Three.js, no DOM. Tested headless in test/vertexGrid.test.ts.
//
// CRITICAL CODE — this is where terrain becomes geometry, and it is
// feel-critical: the terraced silhouette is the app's namesake look
// (docs/DESIGN.md §3.4). Four decisions carry the module.
//
// 1. QUAD SOUP, NOT A VERTEX GRID. Phase 1 used one shared vertex per cell,
//    which made every band change a 45° ramp — a vertex cannot be in two
//    places at once, so a riser had to stretch across the whole cell. That
//    limit is gone: each cell now emits its OWN four-cornered flat top quad at
//    its quantised band height, and a separate VERTICAL wall quad is emitted
//    wherever a cell's band differs from a neighbour's. Nothing is shared
//    between faces, so a cliff is a true 90° wall of any height, and flat
//    shading gets a clean crease at every edge (no normal is averaged across
//    the top/wall boundary because no vertex is).
//
// 2. CELLS ARE CENTRED ON INTEGER WORLD COORDINATES. Cell (x,y) covers the
//    world square [x−½, x+½] × [y−½, y+½] (times CELL_WORLD_SIZE). This is NOT
//    a free choice — terrain/picking.ts (owned by another workstream, and not
//    to be changed) resolves a raycast hit to a cell with Math.round(), i.e.
//    "nearest cell centre". Centring each cell's top quad on its integer
//    coordinate is exactly what makes that rounding land on the cell whose top
//    face was clicked, everywhere inside the quad. Phase 1's grid had the same
//    property (a vertex WAS a cell centre); this preserves it.
//
// 3. WALL OWNERSHIP — the HIGHER cell owns its cliff face. A vertical wall
//    sits exactly on the boundary between two cells, which is precisely where
//    Math.round() is ambiguous (it breaks ties upward, so a wall at x+½ would
//    always resolve to x+1 regardless of which side is the cliff). You sculpt
//    the cliff face you clicked, so the wall must resolve to the HIGHER cell.
//    Achieved through geometry alone: the wall plane is inset by
//    CLIFF_FACE_PICK_INSET out of the boundary and INTO the higher cell, which
//    puts every point of the wall strictly inside the higher cell's rounding
//    basin. No change to picking.ts or sculptInput.ts is needed.
//
// 4. EACH SHARED EDGE IS EMITTED EXACTLY ONCE. A chunk emits, for each of its
//    OWN 256 cells, the wall on that cell's +x edge and the wall on its +y
//    edge — never a −x or −y wall. Every interior edge of the world is the +x
//    or +y edge of exactly one cell, so no wall is ever drawn twice (z-fighting
//    coplanar duplicates) or missed. Border walls read the neighbouring
//    chunk's height through the shared mirror (sampleHeight), so no cross-mesh
//    communication is needed; a chunk we have never received reads as height 0
//    / band 0, exactly the Phase 1 convention (mirror.ts invariant 2). At the
//    world border sampleHeight clamps, so a cell's neighbour is itself, the
//    bands match and no wall is emitted — the world does not end in a
//    floating rim.
//
//    The matching invalidation rule already exists: mirror.ts
//    `chunksDirtiedByCell` dirties the chunk BEFORE a cell on a chunk's first
//    row/column, which is exactly the chunk whose last-row/column walls read
//    that cell. (It also dirties the up-left diagonal chunk, which under this
//    scheme no longer reads the cell — a harmless extra patch, and mirror.ts
//    is not ours to change.)
//
// TERRACING. Face height is `quantizeToBand(h)`, not `h` — snapping to the
// band floor is what produces the Godus step look. Top faces sit at exactly
// the heights Phase 1 put them at, so the water/z-fighting reasoning in
// config.WATER_SURFACE_LIFT is untouched: a band-0 flat is still at world
// y = 0 and the sea still floats WATER_SURFACE_LIFT above it.

import { CHUNK_SIZE, quantizeToBand } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { bandPaletteIndex, type Rgb } from './bandColors.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';

/** Cells a chunk owns. Every one of them always emits a top quad. */
export const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

/** One flat top face per owned cell, always emitted, in fixed slots. */
export const TOP_QUADS_PER_CHUNK = CELLS_PER_CHUNK;

/**
 * Upper bound on wall quads: each owned cell can emit at most one +x wall and
 * one +y wall. The bound is TIGHT — a checkerboard of alternating bands makes
 * every cell differ from both neighbours — so it is what the buffers must be
 * sized for, however rare that terrain is.
 */
export const MAX_WALL_QUADS_PER_CHUNK = 2 * CELLS_PER_CHUNK;

/** Worst-case quads in one chunk: 256 tops + 512 walls = 768. */
export const MAX_QUADS_PER_CHUNK = TOP_QUADS_PER_CHUNK + MAX_WALL_QUADS_PER_CHUNK;

/** Four unshared corners per quad — unshared is what allows the 90° crease. */
export const VERTICES_PER_QUAD = 4;
/** Two triangles per quad. */
export const INDICES_PER_QUAD = 6;

/**
 * Vertices a chunk's buffers must hold: 3072. Comfortably under the 65536
 * limit of the Uint16 index buffer, so the shared index attribute stays
 * 16-bit.
 */
export const CHUNK_VERTEX_COUNT = MAX_QUADS_PER_CHUNK * VERTICES_PER_QUAD;
/** Indices a chunk's (shared) index buffer holds: 4608. */
export const CHUNK_INDEX_COUNT = MAX_QUADS_PER_CHUNK * INDICES_PER_QUAD;

const COMPONENTS_PER_POSITION = 3;
const COMPONENTS_PER_NORMAL = 3;
const COMPONENTS_PER_COLOR = 3;

/**
 * Half a cell edge, in CELL units. Cell (x,y)'s top quad spans [x−½, x+½] on
 * both horizontal axes — see decision 2 above; this is the number that keeps
 * picking.ts's Math.round() honest.
 */
const CELL_HALF_EXTENT = 0.5;

/**
 * How far a vertical wall is pulled off the cell boundary and into the cell
 * that owns it, in CELL units (picking divides world X/Z by CELL_WORLD_SIZE
 * before rounding, so this must be expressed in the same units it rounds).
 *
 * It has to clear three thresholds at once, and 1/1024 is the value that does:
 *
 *   - BIG ENOUGH TO SURVIVE FLOAT32. Positions are stored in a Float32Array,
 *     and the largest supported world is 512 cells across. Float32 spacing
 *     near 512 is 2⁻¹⁴ ≈ 6.1e-5, so 1/1024 ≈ 9.8e-4 is ~16 representable
 *     steps clear of the boundary even at the far corner of the biggest world
 *     — the inset can never be rounded away into a tie.
 *   - BIG ENOUGH TO SURVIVE THE RAYCAST. The hit point comes back from a
 *     ray/triangle intersection in double precision from float32 inputs; its
 *     error is of the same order as the storage above, i.e. orders of
 *     magnitude below this.
 *   - SMALL ENOUGH TO BE INVISIBLE. 1/1024 of a cell is 0.1% of a cell edge.
 *     At the closest the camera may orbit (CAMERA_MIN_DISTANCE, 20 cells) a
 *     cell is a few tens of pixels, so the inset is far under a hundredth of a
 *     pixel: the cliff still reads as sitting exactly on the cell boundary.
 *
 * It is a negative power of two, so it is exact in binary and the same on
 * every platform.
 *
 * Consequence, deliberate and bounded: the higher cell's tread overhangs its
 * own wall by the inset, and a slit of the same width is left where the wall
 * meets the lower cell's tread. Both are one thousandth of a cell — far under
 * a pixel at any camera distance the game allows — and the residual failure
 * mode is named rather than hidden: at a grazing angle close enough to resolve
 * a thousandth of a cell, the slit at a cliff's foot would show. Nothing about
 * the geometry can open a gap WIDER than CLIFF_FACE_PICK_INSET.
 */
export const CLIFF_FACE_PICK_INSET = 1 / 1024;

/** What one call to writeChunkVertexData actually emitted. */
export interface ChunkGeometryCounts {
  /** Always TOP_QUADS_PER_CHUNK — every owned cell has a top face. */
  topQuadCount: number;
  /** 0..MAX_WALL_QUADS_PER_CHUNK, depending on how cliffy the chunk is. */
  wallQuadCount: number;
  quadCount: number;
  /** Vertices written, i.e. quadCount * VERTICES_PER_QUAD. */
  vertexCount: number;
  /** Indices to DRAW, i.e. quadCount * INDICES_PER_QUAD — the draw range. */
  indexCount: number;
}

/** The three per-chunk attribute arrays, allocated once and rewritten in place. */
export interface ChunkGeometryBuffers {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
}

/**
 * Top-face and cliff-face colour ramps, injected rather than imported so the
 * renderer can pass palettes already converted to Three's linear working
 * colour space while tests pass the plain sRGB ones — same selection logic
 * either way. Both are indexed by `bandPaletteIndex`.
 */
export interface ChunkPalettes {
  top: readonly Rgb[];
  cliff: readonly Rgb[];
}

/**
 * Writes one quad into slot `quad` of the buffers.
 *
 * Corner order is fixed and is what `buildChunkIndices` assumes:
 *
 *   v0 ── v1        triangles (v0, v2, v1) and (v1, v2, v3)
 *   │  ╲  │         face normal = (v2 − v0) × (v1 − v0)
 *   v2 ── v3
 *
 * So callers place v1 along the quad's "U" axis and v2 along its "V" axis such
 * that V × U points OUT of the surface, and the quad is front-facing under
 * Three's counter-clockwise convention. Get it backwards and the face renders
 * as its own underside (which the DoubleSide terrain material would hide, but
 * the normals written here would then be lies).
 *
 * Scalar parameters rather than vector objects: this runs up to 768 times per
 * chunk per patch, and the patch path must not allocate (see terrainMeshes.ts).
 */
function writeQuad(
  buffers: ChunkGeometryBuffers,
  quad: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  x3: number, y3: number, z3: number,
  nx: number, ny: number, nz: number,
  color: Rgb,
): void {
  const { positions, normals, colors } = buffers;
  let p = quad * VERTICES_PER_QUAD * COMPONENTS_PER_POSITION;
  let n = quad * VERTICES_PER_QUAD * COMPONENTS_PER_NORMAL;
  let c = quad * VERTICES_PER_QUAD * COMPONENTS_PER_COLOR;

  positions[p++] = x0; positions[p++] = y0; positions[p++] = z0;
  positions[p++] = x1; positions[p++] = y1; positions[p++] = z1;
  positions[p++] = x2; positions[p++] = y2; positions[p++] = z2;
  positions[p++] = x3; positions[p++] = y3; positions[p++] = z3;

  // One face normal, repeated on all four corners: the whole quad is planar,
  // and nothing is shared with the neighbouring face, so there is no averaging
  // and therefore no rounded cliff crease.
  for (let v = 0; v < VERTICES_PER_QUAD; v++) {
    normals[n++] = nx; normals[n++] = ny; normals[n++] = nz;
  }

  // Flat colour per face, likewise: a terrace tread is one solid band colour
  // rather than a gradient toward its neighbours (Phase 1 interpolated,
  // because its vertices were shared).
  for (let v = 0; v < VERTICES_PER_QUAD; v++) {
    colors[c++] = color[0]; colors[c++] = color[1]; colors[c++] = color[2];
  }
}

/**
 * Fills a chunk's position/normal/colour buffers from the mirror and reports
 * how much of them is live.
 *
 * This is the in-place patch path: the caller owns the buffers for the whole
 * life of the chunk mesh and simply re-runs this function, then flags the
 * attributes as needing upload and narrows the draw range to `indexCount`.
 * Geometry is never rebuilt on an edit (design doc §8, client performance
 * target).
 *
 * LAYOUT of the emitted quads, which the tests and the draw range rely on:
 *   quads 0 .. 255            top faces, one per owned cell, row-major
 *                             (j outer, i inner); slot j*CHUNK_SIZE + i is
 *                             ALWAYS cell (cx*16+i, cy*16+j).
 *   quads 256 .. 256+walls−1  wall faces, PACKED in emission order (row-major
 *                             over cells, +x wall before +y wall).
 * Packing the walls (rather than giving every possible wall a fixed slot and
 * degenerating the absent ones) is what lets a single `setDrawRange(0,
 * indexCount)` cut the unused tail: the tail is always contiguous and always
 * at the end.
 */
export function writeChunkVertexData(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  buffers: ChunkGeometryBuffers,
  palettes: ChunkPalettes,
): ChunkGeometryCounts {
  const expectedPositions = CHUNK_VERTEX_COUNT * COMPONENTS_PER_POSITION;
  const expectedNormals = CHUNK_VERTEX_COUNT * COMPONENTS_PER_NORMAL;
  const expectedColors = CHUNK_VERTEX_COUNT * COMPONENTS_PER_COLOR;
  if (
    buffers.positions.length !== expectedPositions ||
    buffers.normals.length !== expectedNormals ||
    buffers.colors.length !== expectedColors
  ) {
    throw new RangeError(
      `chunk buffers must be ${expectedPositions}/${expectedNormals}/` +
        `${expectedColors} long, got ${buffers.positions.length}/` +
        `${buffers.normals.length}/${buffers.colors.length}`,
    );
  }

  const originX = cx * CHUNK_SIZE;
  const originY = cy * CHUNK_SIZE;

  // ---------------------------------------------------------------------
  // Pass 1 — top faces. Fixed slots, always all 256 of them.
  // ---------------------------------------------------------------------
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const cellX = originX + i;
      const cellY = originY + j;
      const height = sampleHeight(mirror, cellX, cellY);

      // World layout: cell X → +X, cell Y → +Z, height → +Y (up).
      const top = quantizeToBand(height) * HEIGHT_WORLD_SCALE;
      const westX = (cellX - CELL_HALF_EXTENT) * CELL_WORLD_SIZE;
      const eastX = (cellX + CELL_HALF_EXTENT) * CELL_WORLD_SIZE;
      const northZ = (cellY - CELL_HALF_EXTENT) * CELL_WORLD_SIZE;
      const southZ = (cellY + CELL_HALF_EXTENT) * CELL_WORLD_SIZE;

      // Colour from the RAW height, and it MUST be the raw one. Band 0 spans
      // heights 0..BAND_HEIGHT-1, which straddles the waterline, so the
      // quantised value (always 0 for that whole band) cannot distinguish sea
      // from the beach above it. See bandPaletteIndex.
      const color = palettes.top[bandPaletteIndex(height)];

      // U = +X (v0→v1), V = +Z (v0→v2) ⇒ V × U = +Y: the tread faces the sky.
      writeQuad(
        buffers,
        j * CHUNK_SIZE + i,
        westX, top, northZ,
        eastX, top, northZ,
        westX, top, southZ,
        eastX, top, southZ,
        0, 1, 0,
        color,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Pass 2 — vertical walls, packed after the top faces.
  //
  // Only the +x and +y edges of owned cells, so every shared edge in the
  // world is emitted exactly once (decision 4 above). Neighbour heights come
  // from the mirror, which clamps at the world border (equal bands ⇒ no wall)
  // and reads never-received chunks as height 0.
  // ---------------------------------------------------------------------
  let quad = TOP_QUADS_PER_CHUNK;

  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const cellX = originX + i;
      const cellY = originY + j;

      const height = sampleHeight(mirror, cellX, cellY);
      const band = quantizeToBand(height);
      const top = band * HEIGHT_WORLD_SCALE;
      const northZ = (cellY - CELL_HALF_EXTENT) * CELL_WORLD_SIZE;
      const southZ = (cellY + CELL_HALF_EXTENT) * CELL_WORLD_SIZE;
      const westX = (cellX - CELL_HALF_EXTENT) * CELL_WORLD_SIZE;
      const eastX = (cellX + CELL_HALF_EXTENT) * CELL_WORLD_SIZE;

      // ---- wall on this cell's +x edge, shared with cell (x+1, y) ----
      const eastHeight = sampleHeight(mirror, cellX + 1, cellY);
      const eastBand = quantizeToBand(eastHeight);
      if (eastBand !== band) {
        const thisIsHigher = band > eastBand;
        // The cliff belongs to whichever cell stands taller; its colour comes
        // from that cell's RAW height so the rock matches the tread above it.
        const ownerHeight = thisIsHigher ? height : eastHeight;
        const color = palettes.cliff[bandPaletteIndex(ownerHeight)];
        const highY = (thisIsHigher ? band : eastBand) * HEIGHT_WORLD_SCALE;
        const lowY = (thisIsHigher ? eastBand : band) * HEIGHT_WORLD_SCALE;
        // Inset INTO the owning cell so Math.round() on a hit point lands on
        // it: pull west (−x) when this cell owns the wall, east (+x) when the
        // neighbour does.
        const planeX =
          (cellX +
            CELL_HALF_EXTENT +
            (thisIsHigher ? -CLIFF_FACE_PICK_INSET : CLIFF_FACE_PICK_INSET)) *
          CELL_WORLD_SIZE;

        if (thisIsHigher) {
          // Face looks +X, away from the owner and down onto the lower cell.
          // U = +Z, V = +Y ⇒ V × U = +X.
          writeQuad(
            buffers, quad++,
            planeX, lowY, northZ,
            planeX, lowY, southZ,
            planeX, highY, northZ,
            planeX, highY, southZ,
            1, 0, 0,
            color,
          );
        } else {
          // Owner is the east cell, so the exposed face looks −X.
          // U = −Z, V = +Y ⇒ V × U = −X.
          writeQuad(
            buffers, quad++,
            planeX, lowY, southZ,
            planeX, lowY, northZ,
            planeX, highY, southZ,
            planeX, highY, northZ,
            -1, 0, 0,
            color,
          );
        }
      }

      // ---- wall on this cell's +y edge, shared with cell (x, y+1) ----
      const southHeight = sampleHeight(mirror, cellX, cellY + 1);
      const southBand = quantizeToBand(southHeight);
      if (southBand !== band) {
        const thisIsHigher = band > southBand;
        const ownerHeight = thisIsHigher ? height : southHeight;
        const color = palettes.cliff[bandPaletteIndex(ownerHeight)];
        const highY = (thisIsHigher ? band : southBand) * HEIGHT_WORLD_SCALE;
        const lowY = (thisIsHigher ? southBand : band) * HEIGHT_WORLD_SCALE;
        const planeZ =
          (cellY +
            CELL_HALF_EXTENT +
            (thisIsHigher ? -CLIFF_FACE_PICK_INSET : CLIFF_FACE_PICK_INSET)) *
          CELL_WORLD_SIZE;

        if (thisIsHigher) {
          // Face looks +Z. U = −X, V = +Y ⇒ V × U = +Z.
          writeQuad(
            buffers, quad++,
            eastX, lowY, planeZ,
            westX, lowY, planeZ,
            eastX, highY, planeZ,
            westX, highY, planeZ,
            0, 0, 1,
            color,
          );
        } else {
          // Owner is the south cell, so the exposed face looks −Z.
          // U = +X, V = +Y ⇒ V × U = −Z.
          writeQuad(
            buffers, quad++,
            westX, lowY, planeZ,
            eastX, lowY, planeZ,
            westX, highY, planeZ,
            eastX, highY, planeZ,
            0, 0, -1,
            color,
          );
        }
      }
    }
  }

  const quadCount = quad;
  const vertexCount = quadCount * VERTICES_PER_QUAD;

  // ---------------------------------------------------------------------
  // Tail — collapse every unused vertex slot onto vertex 0.
  //
  // Two reasons, both about not trusting a single mechanism:
  //   - computeBoundingSphere() (terrainMeshes.ts, every patch) reads the
  //     WHOLE position attribute and ignores drawRange, so stale or zeroed
  //     tail vertices would drag the sphere back toward the world origin and
  //     inflate it enormously for a distant chunk. Vertex 0 is inside this
  //     chunk, so collapsing onto it leaves the sphere exact.
  //   - if the draw range were ever wrong, the tail rasterises as zero-area
  //     triangles rather than as garbage.
  // ---------------------------------------------------------------------
  const { positions, normals, colors } = buffers;
  const anchorX = positions[0];
  const anchorY = positions[1];
  const anchorZ = positions[2];
  for (let v = vertexCount; v < CHUNK_VERTEX_COUNT; v++) {
    const p = v * COMPONENTS_PER_POSITION;
    positions[p] = anchorX;
    positions[p + 1] = anchorY;
    positions[p + 2] = anchorZ;
    const n = v * COMPONENTS_PER_NORMAL;
    normals[n] = 0; normals[n + 1] = 0; normals[n + 2] = 0;
    const c = v * COMPONENTS_PER_COLOR;
    colors[c] = 0; colors[c + 1] = 0; colors[c + 2] = 0;
  }

  return {
    topQuadCount: TOP_QUADS_PER_CHUNK,
    wallQuadCount: quadCount - TOP_QUADS_PER_CHUNK,
    quadCount,
    vertexCount,
    indexCount: quadCount * INDICES_PER_QUAD,
  };
}

/**
 * The triangle index buffer, covering EVERY possible quad slot.
 *
 * Quad k always owns vertices 4k..4k+3, whatever that quad turns out to be, so
 * the indices are the same for every chunk in every world state: this is built
 * once and the resulting attribute is shared by every chunk mesh. A chunk that
 * emitted fewer quads simply narrows its draw range; it never needs its own
 * indices.
 *
 * Winding is (v0, v2, v1) / (v1, v2, v3) — see writeQuad for the corner
 * convention that makes this front-facing.
 */
export function buildChunkIndices(): Uint16Array {
  const indices = new Uint16Array(CHUNK_INDEX_COUNT);
  let k = 0;
  for (let quad = 0; quad < MAX_QUADS_PER_CHUNK; quad++) {
    const v0 = quad * VERTICES_PER_QUAD;
    const v1 = v0 + 1;
    const v2 = v0 + 2;
    const v3 = v0 + 3;
    indices[k++] = v0; indices[k++] = v2; indices[k++] = v1;
    indices[k++] = v1; indices[k++] = v2; indices[k++] = v3;
  }
  return indices;
}

export function createChunkPositionBuffer(): Float32Array {
  return new Float32Array(CHUNK_VERTEX_COUNT * COMPONENTS_PER_POSITION);
}

export function createChunkNormalBuffer(): Float32Array {
  return new Float32Array(CHUNK_VERTEX_COUNT * COMPONENTS_PER_NORMAL);
}

export function createChunkColorBuffer(): Float32Array {
  return new Float32Array(CHUNK_VERTEX_COUNT * COMPONENTS_PER_COLOR);
}

/** Allocates all three attribute arrays for one chunk. */
export function createChunkGeometryBuffers(): ChunkGeometryBuffers {
  return {
    positions: createChunkPositionBuffer(),
    normals: createChunkNormalBuffer(),
    colors: createChunkColorBuffer(),
  };
}
