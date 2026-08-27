// DrawnGroundStore — the terrain HANDS OVER what it drew, per chunk.
//
// WHAT THIS REPLACES, and why "publish" used to be a lie. Commit 7e3332c gave
// the world a contract — "the terrain publishes what it drew; water reads it" —
// but the reading half honoured it by RE-DERIVING: `createDrawnGround(mirror)`
// held its own `Map` and called `planChunkCaps` again for every chunk any query
// touched, while `writeChunkVertexData` had already built exactly that plan for
// the same chunk and thrown it away (it still returns it as
// `ChunkGeometryCounts.drawnCaps`). Two consequences, both measured:
//
//   * COST. The re-plan ran per WATER REBUILD, not per terrain edit: a fresh
//     oracle per `riverRig` rebuild meant a cold cache twice a second and a
//     re-march of every chunk the water reached.
//   * INVALIDATION. Because the plan was a private memo of a mutable mirror, it
//     "MUST NOT outlive a terrain edit", so four separate places in world.ts had
//     to remember to null it. A cache that has to be invalidated by hand is a
//     bug waiting for the fifth caller.
//
// Publishing for real removes both. The emitter writes into this store as part
// of drawing the chunk, so the entry is replaced on exactly the event that
// redraws the chunk — there is nothing left to invalidate, and nothing left to
// re-derive.
//
// THE BAND GRID, and why the polygons alone were not enough. `bandAt` /
// `topmostLevelAt` used to answer with a point-in-polygon test against every
// level of the chunk (`insideGrouped`), which the waterfall curtain calls four
// times per boundary segment for thousands of segments — 5.1 s of a 9.2 s
// rebuild in the measurement that motivated this change. Since a chunk's
// polygons are fixed the moment it is drawn, that whole query is precomputed
// here ONCE per chunk build: the level polygons are rasterised, lowest level
// first so the topmost drawn level wins, into a `BAND_GRID_CELLS`-resolution
// lattice, and the query becomes an array read.
//
// The rasteriser fills from EXACTLY the polygons (outers with their holes) the
// point-in-polygon test used, with the same even-odd rule and the same
// half-open edge convention, so the answer AT A GRID SAMPLE is identical to
// what `insideGrouped` would have said. What changes is that a query is
// answered from the grid sample its position falls on rather than from its own
// exact position — a quantisation of at most half a grid step. That is
// acceptable precisely because the only caller that probes off the cell lattice
// is the curtain, whose probe step IS this grid step (waterCurtain.ts's
// `CURTAIN_PROBE_CELLS` is this constant), and whose own doc comment records
// that the two bands either side of a contour are both correct answers there.
//
// LIFETIME. An entry is valid until the chunk is next drawn, and the drawing is
// what replaces it. A chunk that has NOT been drawn has no entry, which is a
// real and correct state rather than a gap: the mesh builder drains its queue
// under a frame budget (terrainMeshes.ts), so during a held stroke the terrain
// on screen can be a frame or two behind the mirror. Water asking this store
// therefore gets what is ON SCREEN, which is the side of that race the water
// must be on — a sheet welded to last frame's rock is right, and one welded to
// rock that has not been drawn yet is not.

import { CHUNK_SIZE, chunksPerEdge } from '@terrace/shared';
import { CLIFF_PALETTE, TERRAIN_PALETTE } from './bandColors.ts';
import { planChunkCaps, type ChunkDrawnCaps, type ChunkPalettes } from './capEmission.ts';
import { type ContourLoop } from './contours.ts';
import { type TerrainMirror } from './mirror.ts';
import { type CapPolygon } from './triangulation.ts';

/**
 * The band grid's step, in CELLS — the resolution at which "which level does
 * the terrain draw here" is precomputed.
 *
 * A QUARTER CELL, and the number is not free: it is the curtain's own probe
 * step (waterCurtain.ts re-exports it as `CURTAIN_PROBE_CELLS`, with the full
 * argument for the value), so the lattice this answers on is the lattice the
 * only sub-cell caller already reasons about. Halving it would quarter the
 * quantisation error and quadruple both the memory (4.2 KB per chunk today) and
 * the rasterisation cost; doubling it would let one grid sample straddle a
 * whole terrace face.
 */
export const BAND_GRID_CELLS = 1 / 4;

/** Grid samples per cell edge — the reciprocal of the step, an integer by construction. */
const BAND_GRID_SAMPLES_PER_CELL = Math.round(1 / BAND_GRID_CELLS);

/**
 * Grid samples along one chunk edge.
 *
 * INCLUSIVE OF BOTH ENDS, like the 17x17 contour lattice the chunk is marched
 * on: sample `i` sits AT `originX + i * BAND_GRID_CELLS`, so the first sits on
 * the chunk's first lattice line and the last on its last. Samples ON the
 * lattice rather than at the centres of grid squares is what makes every query
 * at a cell centre, a half cell or a quarter cell EXACT — which is every query
 * but the curtain's outward probe, and the whole reason the grid is safe to
 * quantise to at all.
 */
const BAND_GRID_EDGE = CHUNK_SIZE * BAND_GRID_SAMPLES_PER_CELL + 1;

/**
 * Grid value for "no drawn level covers this sample".
 *
 * Distinct from level 0: the lowest level's region is the whole domain by
 * `makeLevels`' construction, so in practice only a malformed chunk leaves
 * samples uncovered — but the old query returned `null` there and had a
 * documented fallback, and flattening the two would silently change it.
 */
const BAND_GRID_UNCOVERED = -1;

/**
 * What one chunk's terrain emission drew, plus the precomputed answer to "which
 * level is drawn at this point".
 */
export interface ChunkChart {
  /** Cell coordinate of the chunk's first lattice column/row. */
  readonly originX: number;
  readonly originZ: number;
  /** Exactly what `writeChunkVertexData` published for this chunk. */
  readonly caps: ChunkDrawnCaps;
  /**
   * Index into `caps.levels` of the TOPMOST level covering each grid sample, or
   * `BAND_GRID_UNCOVERED`. Row-major, `BAND_GRID_EDGE` samples per row. Empty
   * for a blocky chunk, which drew no levels at all.
   */
  readonly topLevel: Int8Array;
}

export interface DrawnGroundStore {
  /**
   * Records what a chunk drew. Called by the emitter as part of drawing it, so
   * the entry and the vertices in the buffer are the same event.
   */
  publish(chunkIdx: number, caps: ChunkDrawnCaps): void;
  /** What the chunk at these CHUNK coordinates drew, or null if it has not been drawn. */
  chartOf(chunkX: number, chunkZ: number): ChunkChart | null;
  /** Drops every entry — used when the world is replaced. */
  clear(): void;
  /** Chunks with an entry. For tests and diagnostics. */
  size(): number;
}

/**
 * The topmost drawn level's index at a (fractional) CELL coordinate inside this
 * chart's chunk, or `null` where nothing is drawn.
 *
 * The grid geometry lives here rather than in the reader so that the fill and
 * the lookup cannot disagree about where a sample sits.
 */
export function topLevelIndexAt(chart: ChunkChart, cellX: number, cellZ: number): number | null {
  if (chart.topLevel.length === 0) return null;
  // NEAREST sample, not the one below: the grid samples sit on the lattice, so
  // rounding is what makes an on-lattice query land on itself and an off-lattice
  // one (the curtain's outward probe) land on the nearer of its two neighbours.
  const i = clampToGrid(Math.round((cellX - chart.originX) / BAND_GRID_CELLS));
  const j = clampToGrid(Math.round((cellZ - chart.originZ) / BAND_GRID_CELLS));
  const value = chart.topLevel[j * BAND_GRID_EDGE + i]!;
  return value === BAND_GRID_UNCOVERED ? null : value;
}

/**
 * Clamps a grid index into range. A query is inside its own chunk by
 * construction (the chunk is chosen by flooring the coordinate), so this only
 * catches a non-finite coordinate — cheaper than validating one.
 */
function clampToGrid(index: number): number {
  if (!(index >= 0)) return 0;
  if (index > BAND_GRID_EDGE - 1) return BAND_GRID_EDGE - 1;
  return index;
}

export function createDrawnGroundStore(worldSize: number): DrawnGroundStore {
  const chunkCols = chunksPerEdge(worldSize);
  const charts = new Map<number, ChunkChart>();

  return {
    publish(chunkIdx: number, caps: ChunkDrawnCaps): void {
      const chunkX = chunkIdx % chunkCols;
      const chunkZ = (chunkIdx - chunkX) / chunkCols;
      const originX = chunkX * CHUNK_SIZE;
      const originZ = chunkZ * CHUNK_SIZE;
      charts.set(chunkIdx, {
        originX,
        originZ,
        caps,
        topLevel: rasterizeLevels(caps, originX, originZ),
      });
    },
    chartOf(chunkX: number, chunkZ: number): ChunkChart | null {
      if (chunkX < 0 || chunkZ < 0 || chunkX >= chunkCols || chunkZ >= chunkCols) return null;
      return charts.get(chunkZ * chunkCols + chunkX) ?? null;
    },
    clear(): void {
      charts.clear();
    },
    size(): number {
      return charts.size;
    },
  };
}

/**
 * Publishes a chunk by PLANNING it, for harnesses that ask what the terrain
 * draws without drawing it — unit tests over a bare mirror, and previews that
 * build no meshes.
 *
 * NOT A PATH THE APP TAKES, and that is the whole point of naming it this
 * loudly: in the client the producer is `writeChunkVertexData`, which publishes
 * the plan it actually emitted from. This runs `planChunkCaps` a second time,
 * which is exactly the duplication the store exists to delete, and it is
 * tolerable here only because a harness that never draws the chunk has no first
 * time to reuse.
 */
export function publishPlannedChunk(
  store: DrawnGroundStore,
  mirror: TerrainMirror,
  chunkX: number,
  chunkZ: number,
): void {
  const plan = planChunkCaps(mirror, chunkX, chunkZ, DRAWN_PALETTES);
  const caps: ChunkDrawnCaps = plan.overBudget
    ? { blocky: true, levels: [] }
    : {
        blocky: false,
        levels: plan.levels.map((level, index) => ({
          threshold: level.threshold,
          sampleBand: level.sampleBand,
          capY: level.capY,
          polygons: plan.polygonsPerLevel[index]!,
        })),
      };
  store.publish(chunkZ * chunksPerEdge(mirror.map.size) + chunkX, caps);
}

/**
 * The palettes a harness plans with, and they are the ones the renderer draws
 * with (terrainMeshes.ts builds this same pair from these same two module
 * constants). Colour is almost irrelevant to a plan — but not entirely: an
 * underwater riser that takes a border colour counts 4 triangles per segment
 * instead of 2, which feeds CHUNK_TRIANGLE_BUDGET and can therefore flip the
 * blocky-fallback verdict. Planning with a stand-in palette would reintroduce a
 * way for the harness and the renderer to disagree, so it does not.
 */
const DRAWN_PALETTES: ChunkPalettes = {
  top: TERRAIN_PALETTE,
  cliff: CLIFF_PALETTE,
};

/**
 * Publishes every chunk the mirror has received, by planning each one. The
 * whole-world form of `publishPlannedChunk`, and it carries that function's
 * caveat: this is for harnesses that never draw the terrain.
 */
export function publishPlannedWorld(store: DrawnGroundStore, mirror: TerrainMirror): void {
  const chunkCols = chunksPerEdge(mirror.map.size);
  for (const chunkIdx of mirror.received) {
    const chunkX = chunkIdx % chunkCols;
    publishPlannedChunk(store, mirror, chunkX, (chunkIdx - chunkX) / chunkCols);
  }
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

/**
 * Crossing x-coordinates per grid row, reused across polygons.
 *
 * Module scratch, on the same precondition every other scratch in the contour
 * pipeline states: one fill runs to completion before the next starts. That
 * holds by construction — the only caller is `publish`, which is synchronous.
 */
const rowCrossings: number[][] = Array.from({ length: BAND_GRID_EDGE }, () => []);

const ascending = (a: number, b: number): number => a - b;

/**
 * Fills a chunk's band grid from its drawn levels, LOWEST LEVEL FIRST so the
 * topmost one that covers a sample is the one left in the grid.
 *
 * That is exactly the resolution rule `topmostLevelAt` walked the stack
 * backwards to apply — the levels are drawn lowest-first, each over the one
 * below, so the last one covering a point is the one you can see.
 */
function rasterizeLevels(caps: ChunkDrawnCaps, originX: number, originZ: number): Int8Array {
  if (caps.blocky || caps.levels.length === 0) return new Int8Array(0);
  const grid = new Int8Array(BAND_GRID_EDGE * BAND_GRID_EDGE).fill(BAND_GRID_UNCOVERED);
  for (let index = 0; index < caps.levels.length; index++) {
    for (const polygon of caps.levels[index]!.polygons) {
      fillPolygon(grid, index, polygon, originX, originZ);
    }
  }
  return grid;
}

/**
 * Scanline fill of one grouped polygon — its outer loop with its holes — by the
 * SAME even-odd rule `pointInLoop` applied, so a sample inside the outer and
 * inside one of its holes ends up outside, exactly as `insideGrouped` said.
 *
 * A polygon at a time rather than a whole level at a time: `insideGrouped` tests
 * each outer against ITS OWN holes, and while a well-formed level's loops nest
 * so that one even-odd pass over all of them agrees, keeping the grouping means
 * the fill cannot be wrong about a malformed one either.
 *
 * Edges are bucketed into the rows they cross rather than every row being tested
 * against every edge, so the cost is proportional to the contour's own length
 * plus the area it covers — not to (levels x edges x rows).
 */
function fillPolygon(
  grid: Int8Array,
  levelIndex: number,
  polygon: CapPolygon,
  originX: number,
  originZ: number,
): void {
  let minRow = BAND_GRID_EDGE;
  let maxRow = -1;

  const bucketLoop = (loop: ContourLoop): void => {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i]!;
      const b = loop[j]!;
      // `pointInLoop`'s test is `(a.z > pz) !== (b.z > pz)`, which is true
      // exactly for pz in [min(a.z, b.z), max(a.z, b.z)) either way round —
      // half-open at the top, which is what stops a vertex shared by two edges
      // from being counted twice.
      const lowZ = a.z < b.z ? a.z : b.z;
      const highZ = a.z < b.z ? b.z : a.z;
      if (lowZ === highZ) continue;
      let firstRow = Math.ceil((lowZ - originZ) / BAND_GRID_CELLS);
      let lastRow = Math.ceil((highZ - originZ) / BAND_GRID_CELLS) - 1;
      if (firstRow < 0) firstRow = 0;
      if (lastRow > BAND_GRID_EDGE - 1) lastRow = BAND_GRID_EDGE - 1;
      for (let row = firstRow; row <= lastRow; row++) {
        const pz = originZ + row * BAND_GRID_CELLS;
        const t = (pz - a.z) / (b.z - a.z);
        rowCrossings[row]!.push(a.x + t * (b.x - a.x));
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
      }
    }
  };

  bucketLoop(polygon.outer);
  for (const hole of polygon.holes) bucketLoop(hole);

  for (let row = minRow; row <= maxRow; row++) {
    const crossings = rowCrossings[row]!;
    if (crossings.length === 0) continue;
    crossings.sort(ascending);
    // `pointInLoop` counts crossings STRICTLY to the right of the sample, so a
    // sample sitting exactly on a crossing belongs to the span that starts
    // there: the inside runs [crossings[k], crossings[k + 1]).
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      let firstColumn = Math.ceil((crossings[k]! - originX) / BAND_GRID_CELLS);
      let lastColumn = Math.ceil((crossings[k + 1]! - originX) / BAND_GRID_CELLS) - 1;
      if (firstColumn < 0) firstColumn = 0;
      if (lastColumn > BAND_GRID_EDGE - 1) lastColumn = BAND_GRID_EDGE - 1;
      const rowStart = row * BAND_GRID_EDGE;
      for (let column = firstColumn; column <= lastColumn; column++) {
        grid[rowStart + column] = levelIndex;
      }
    }
    crossings.length = 0;
  }
}
