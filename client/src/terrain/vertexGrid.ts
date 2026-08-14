// Chunk mesh geometry — ORGANIC terraces: flat band caps with smooth, flowing
// outlines and vertical skirts between them.
// Pure: no Three.js, no DOM. Tested headless in test/vertexGrid.test.ts.
//
// CRITICAL CODE — this is where terrain becomes geometry, and it is
// feel-critical: the terraced silhouette is the app's namesake look
// (docs/DESIGN.md §3.4).
//
// WHY THIS REPLACED THE PER-CELL WALL RENDERER (2026-08-14). The previous
// builder emitted one axis-aligned flat quad per cell plus vertical wall quads
// on cell boundaries. It produced true 90° cliffs, but every silhouette was a
// staircase of cell edges: it read as Minecraft, not as Godus. Godus terraces
// have the same two ingredients — a flat tread and a vertical riser — but the
// OUTLINE of each band is a smooth flowing contour that cuts across cells at
// arbitrary angles. That outline is what this module now computes.
//
// THE PIPELINE, per chunk, per band level k:
//
//   1. MARCHING SQUARES over the RAW heightmap (never the quantised one) at the
//      band boundary height k·BAND_HEIGHT, with LINEAR INTERPOLATION between
//      cell samples. Interpolation is most of the organic look: wherever the
//      soft brush left a gradient, the band edge lands part-way across a cell
//      and at an angle instead of snapping to a cell edge.
//   2. CHAIKIN corner cutting (CHAIKIN_ITERATIONS passes) rounds the polyline.
//      Closed loops stay closed; vertices on the chunk's border are pinned and
//      never move (that is the seam contract, below).
//   3. TRIANGULATION of the resulting region — outer loops with holes, so a pit
//      inside a plateau is a real hole — into a flat cap at k·BAND_WORLD_HEIGHT.
//   4. SKIRTS: a vertical quad strip extruded one band down along every contour
//      segment that is not part of the chunk border.
//
// Caps stack: level k's cap covers the WHOLE region {band ≥ k}, not just the
// annulus that ends up visible. Nested caps at different heights are correct by
// construction (the higher one is opaque and wins) and — crucially — each
// level's geometry is then INDEPENDENT of every other level's. The alternative,
// cutting each level's cap into an annulus with the level above as a hole,
// halves the triangle count but makes two levels whose contours nearly coincide
// (which happens whenever the guard clamp below fires on both) degenerate into
// zero-area annuli, and a degenerate hole is exactly what breaks a hole-capable
// triangulator. Robustness beats the triangles; see the buffer note in
// render/terrainMeshes.ts for what the extra geometry actually costs.
//
// HONESTY — the render must never lie about the authoritative heightmap,
// because players click what they see (input/sculptInput.ts raycasts this
// geometry and terrain/picking.ts rounds the hit to the nearest cell centre):
//
//   INVARIANT: for every cell, the point at that cell's centre is covered by
//   the caps of exactly the levels k ≤ its own band, so the topmost cap over a
//   cell centre sits at exactly quantizeToBand(h) — the same height the old
//   per-cell renderer drew. Two mechanisms hold it up:
//     - marching squares classifies a SAMPLE (a cell centre) as inside iff
//       h ≥ k·BAND_HEIGHT, which is quantizeToBand's own test, and a contour
//       only ever crosses the EDGES between samples, never a sample itself;
//     - CONTOUR_CELL_CENTRE_GUARD keeps every contour vertex a named distance
//       clear of every cell centre, before AND after smoothing, so no amount of
//       corner cutting can drag an outline across a centre and re-classify it.
//   The invariant is asserted over every cell of a chunk, against the emitted
//   triangles, in test/vertexGrid.test.ts ("honesty").
//
// SEAM CONTRACT — adjacent chunks must emit bit-identical border vertices:
//
//   S1. Samples are read at CANONICAL WORLD cell centres through
//       mirror.sampleHeight, exactly as the old wall renderer did, so both
//       chunks see the same heights across a border (and clamped, so the world
//       border needs no special case).
//   S2. The marching-squares lattice is the world's, not the chunk's: chunk
//       (cx,cy) marches the unit squares whose lower-left sample is one of its
//       OWN cells. Every square in the world therefore belongs to exactly one
//       chunk — no square is marched twice (double geometry) or skipped (hole).
//       A chunk's domain is the world-space square [x0, x0+16] × [y0, y0+16].
//   S3. A crossing point on a lattice edge is a pure function of the two
//       samples it lies between, the level's threshold and
//       CONTOUR_SAMPLE_CLEARANCE — no chunk-local state — so the two chunks
//       sharing that edge compute the identical point.
//   S4. Smoothing never moves a vertex that lies on the chunk's domain border,
//       and never cuts the corner AT one, so a contour arriving at the border
//       arrives at exactly the point the neighbour's arc leaves from.
//   S5. Skirts are emitted only for segments that are not part of the domain
//       border, so a band that continues into the next chunk grows no wall
//       across the seam.
//   Asserted in test/vertexGrid.test.ts ("chunk seams").
//
// Consequence for invalidation (mirror.ts `chunksDirtiedByCell`, not ours to
// change): a chunk reads samples one cell PAST its last row and column, so a
// cell on a chunk's first row/column also feeds the chunk before it — which is
// what that function already dirties, diagonal included. The diagonal is no
// longer over-conservative: sample (x0+16, y0+16) really is read here.
//
// KNOWN, ACCEPTED: a chunk's drawn area is [x0, x0+16] — the lattice of cell
// CENTRES — while its cells span [x0−0.5, x0+15.5]. Chunk domains still tile the
// plane exactly (no gaps, no overlap), so this is invisible everywhere except
// at the world's outer rim, where the terrain ends half a cell short on the
// west/north edge and runs half a cell long on the east/south edge. Drawing the
// missing half-ring would mean either marching a stretched half-width lattice
// column (whose interpolation would be a lie) or bolting an apron onto the
// border chunks only; neither is worth it for half a cell of ocean rim.

import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  SEA_LEVEL,
  bandOf,
} from '@terrace/shared';
import {
  BAND_WORLD_HEIGHT,
  CELL_WORLD_SIZE,
  WATER_SURFACE_LIFT,
} from '../config.ts';
import { bandPaletteIndex, type Rgb } from './bandColors.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';

// ---------------------------------------------------------------------------
// Tuning constants. Every one of them is a shape decision, so every one is
// named and argued.
// ---------------------------------------------------------------------------

/** Samples along one chunk edge: its 16 cells plus the neighbour's first. */
export const LATTICE_PER_CHUNK = CHUNK_SIZE + 1;

/**
 * Minimum separation, in HEIGHT units, between a sample and any band boundary
 * it is being classified against, used only when positioning a crossing.
 *
 * Without it the renderer collapses back to the cell grid on exactly the
 * terrain players make most. The stamp tool adds DEFAULT_SCULPT_AMOUNT =
 * BAND_HEIGHT per click to a world that starts at 0, so cell heights are
 * usually EXACT multiples of BAND_HEIGHT — every sample sits precisely ON a
 * band boundary. A plain linear crossing then solves to the sample itself
 * (s = 1), every contour snaps onto cell centres, a stamped spire's cap
 * degenerates to a point, and the outline is the cell grid again.
 *
 * So each sample is treated as standing at least half a band clear of the
 * boundary being traced: a cell whose height is exactly a band floor is
 * unambiguously IN that band, and half a band is the largest offset that can
 * never reorder two samples (it is applied symmetrically to both ends).
 *
 * What it produces, and this is the shape decision: for a one-band step the
 * outline sits a quarter of a cell inside the HIGHER cell. So a single stamped
 * cell becomes a rounded column half a cell across, a single dug cell becomes a
 * rounded well a cell and a half across, and a plateau's rim pulls a quarter
 * cell in from its outermost cell centres. Where the terrain actually has a
 * gradient — anything the soft brush or the relaxation pass touched — the
 * offset is swamped by the real interpolation and the contour lands wherever
 * the heights say it should.
 */
export const CONTOUR_SAMPLE_CLEARANCE = BAND_HEIGHT / 2;

/**
 * Where the WATERLINE crosses an edge between a wet cell and a dry one, as a
 * fraction of that edge: the middle, always.
 *
 * The waterline is the one outline that is not a band boundary. It separates
 * two cells that render at the SAME height (band 0 spans heights 0..63 and the
 * sea is at 0), so it is a colour change, not a step, and there is no height
 * gradient across it to interpolate — h = 1 and h = 63 are equally "dry land".
 * Interpolating anyway would hug whichever side happened to be nearer the
 * threshold and paint most of a sea cell as beach. Splitting the edge down the
 * middle gives every cell its own colour over its own half, which is the only
 * honest answer; the organic shape comes from Chaikin, which rounds the result
 * into a flowing shoreline rather than a staircase.
 */
export const SHORE_EDGE_CROSSING = 0.5;

/**
 * How close, in CELL units, a contour may come to a cell centre.
 *
 * This is the honesty guard. A cell centre is the fixed point of picking.ts's
 * Math.round(), so whichever caps cover it decide what the player sees AND
 * clicks at that cell. Marching squares can already only cross the edges
 * BETWEEN samples, but a raw crossing can land arbitrarily close to one end of
 * an edge, and two Chaikin passes could then round the outline across it. Every
 * crossing is therefore clamped into the middle [1/8, 7/8] of its edge, and
 * every smoothed vertex is pushed back out of the disc of this radius around
 * its nearest cell centre.
 *
 * 1/8 of a cell: large enough that the guarantee survives the smoothing passes
 * with room to spare (a Chaikin vertex is a convex combination of two vertices
 * of the polyline it smooths, so it can only ever move ALONG the outline, never
 * outward past it), small enough that it never becomes the thing that decides
 * where an outline goes — a 1/8-cell clamp only fires on samples within a few
 * height units of a band boundary, which is where the outline's exact position
 * is meaningless anyway. It is a negative power of two, so it is exact in
 * binary and identical on every platform.
 */
export const CONTOUR_CELL_CENTRE_GUARD = 1 / 8;

/**
 * Corner-cutting passes over each contour. Each pass replaces every vertex with
 * two points a quarter of the way along its two edges, so the polyline gets 2×
 * the vertices and visibly rounder.
 *
 * TWO passes. One still shows the 45° facets marching squares produces on a
 * diagonal run; three costs 8× the vertices (and 8× the cap triangles) for a
 * change no longer visible at the camera distances the game allows, and starts
 * to shrink small features enough to matter. Two is where the outline reads as
 * drawn rather than sampled.
 */
export const CHAIKIN_ITERATIONS = 2;

/**
 * Where Chaikin cuts each corner. 1/4 is the classical value: the limit curve
 * is a quadratic B-spline, and the cut points stay inside the original polyline
 * (they are convex combinations of its vertices), which is exactly the property
 * the cell-centre guard leans on.
 */
export const CHAIKIN_CUT = 1 / 4;

/**
 * Cell units of deviation below which a smoothed vertex is dropped as
 * collinear. Chaikin subdivides straight runs as eagerly as curved ones, and a
 * contour crossing a flat plateau edge is mostly straight runs; dropping the
 * redundant vertices costs one pass and removes cap triangles that carry no
 * shape. 1/4096 of a cell is far under a pixel at any camera distance, so
 * nothing visible is simplified away.
 */
export const CONTOUR_SIMPLIFY_EPSILON = 1 / 4096;

/**
 * How far a skirt is pulled off its contour and INTO the higher ground, in CELL
 * units (picking divides world X/Z by CELL_WORLD_SIZE before rounding, so this
 * must be in the units it rounds).
 *
 * PICKING CONTRACT for skirts. A skirt hit resolves, through picking.ts's
 * unchanged Math.round(), to the nearest cell centre. Unlike the old renderer's
 * walls — which sat exactly on cell boundaries, where rounding is a tie that
 * always broke the wrong way — an organic skirt sits at a real position, and
 * "nearest cell centre" is then the honest answer: the cell whose tread the
 * riser is part of. The one case that still needs deciding is the exact tie,
 * where the outline runs down the middle between two cells (the level's
 * threshold sits exactly on the mean of the two heights). This inset decides it
 * for the HIGHER side — you sculpt the cliff face you clicked — by moving the
 * whole quad a hair into the region the contour encloses, which is by
 * construction the high side.
 *
 * Combined with CONTOUR_SAMPLE_CLEARANCE the two rules agree wherever it
 * matters: for a one-band step the contour is already a quarter cell inside the
 * higher cell, so every point of the skirt rounds to the higher cell — spire
 * walls sculpt the spire, and the walls around a pit sculpt the rim, both
 * asserted through the real worldPointToCell in the tests.
 *
 * 1/1024 is unchanged from the old CLIFF_FACE_PICK_INSET and for the same three
 * reasons: it survives Float32 storage at the far corner of the largest
 * supported world (spacing there is ~6.1e-5, so 9.8e-4 is ~16 representable
 * steps clear of a tie), it survives the raycast's own error by orders of
 * magnitude, and at 0.1% of a cell it is far under a hundredth of a pixel at
 * the closest the camera may orbit. Its documented, bounded consequence is the
 * same too: the cap overhangs its skirt by the inset, and consecutive skirt
 * quads part by at most the inset where the outline turns.
 */
export const SKIRT_PICK_INSET = 1 / 1024;

/**
 * How far the SEABED cap is sunk below y = 0, in world units.
 *
 * Band 0 is the one band that carries two colours: it spans heights 0..63, and
 * the waterline runs through it (h = 0 is sea, h ≥ 1 is dry beach — see
 * bandColors.bandPaletteIndex, and note that a freshly generated world is all
 * zeros, i.e. entirely sea). Both parts render at the same band height, so they
 * cannot simply stack: two coplanar caps z-fight.
 *
 * So the DRY part keeps y = 0 exactly — that is the plane config.WATER_SURFACE_LIFT
 * reasons about, and it is what makes a beach read as sitting at the waterline —
 * and the SEABED cap alone is sunk under it by half the water's lift. Half:
 * enough to decide the depth test at the distances the sea is legible at, and
 * still leaves the sea surface floating the other half above the seabed. The
 * seabed is submerged by definition, so a sixty-fourth of a band of extra depth
 * under a translucent sea is not observable; the residual is that at the
 * shoreline the sand cap steps down to the seabed by that much, which is closed
 * by a skirt of exactly that height.
 */
export const SEABED_CAP_SINK = WATER_SURFACE_LIFT / 2;

/**
 * Triangles a chunk's buffers hold before they first have to grow.
 *
 * 1024 triangles is 110 KB of attributes per chunk — the same order as the old
 * fixed worst-case buffers (108 KB), and it covers everything but genuinely
 * pathological terrain: a chunk crossed by four band contours costs roughly
 * 4 × (130 cap + 260 skirt) ≈ 1.6k triangles at its worst, and an ordinary one
 * a tenth of that. See render/terrainMeshes.ts for the growth policy and the
 * numbers behind it.
 */
export const INITIAL_CHUNK_TRIANGLE_CAPACITY = 1024;

/**
 * Triangles one chunk may spend on smoothed contours before it is given the
 * BLOCKY FALLBACK instead (writeBlockyFallback). The MEMORY half of the guard;
 * CHUNK_TRIANGULATION_WORK_BUDGET is the time half, and either one trips it.
 *
 * Contour geometry is unbounded in principle: every band present in a chunk
 * draws its own cap, so terrain that alternates band by cell — which no brush
 * can make, because the gradient limit forbids it, but a patient player
 * stamping single cells can — multiplies the cost by the number of bands.
 *
 * Measured on one 16×16 chunk, per patch, single core (WSL2, Node 24). The
 * "contour" column is the cost of actually building that geometry, taken with
 * both budgets lifted so every row reports what it costs rather than what the
 * guard did with it; the last two columns are what the guard DOES with it, at
 * the old budget and at this one. The crater rows are dug by the real shared
 * brush — concentric stamp lowers with ragged single-cell remnants left
 * standing — and live as fixtures in test/vertexGrid.test.ts.
 *
 *   terrain                      triangles     work   contour   4,096     now
 *   flat (any band)                      2       0k   0.04 ms      ok      ok
 *   one stamped spire                   94       1k   0.12 ms      ok      ok
 *   smooth 7-band hill               2,212     125k   0.51 ms      ok      ok
 *   rough smooth-tool relief         3,261     128k   0.74 ms      ok      ok
 *   square spiral arm                1,982     146k   0.71 ms      ok      ok
 *   spire field, every 4th cell      1,784       8k   0.29 ms      ok      ok
 *   spire field, every 2nd cell      7,976      41k   0.98 ms  blocky      ok
 *   pits every 4th cell              1,970     176k   0.62 ms  blocky      ok
 *   pits every 3rd cell              4,247     796k   2.06 ms  blocky      ok
 *   STAMPED CRATER (the fixture)     3,566     112k   0.81 ms      ok      ok
 *   crater, 12 bands deep            4,613     143k   1.04 ms  blocky      ok
 *   crater + 6 spires                5,250     148k   1.12 ms  blocky      ok
 *   two craters on one diagonal      5,218     199k   1.44 ms  blocky      ok
 *   three craters + six spires       8,319     337k   2.05 ms  blocky      ok
 *   pits every 2nd cell              8,738   3,358k   7.71 ms  blocky  blocky
 *   terraced pseudo-random          12,911   1,695k   5.81 ms  blocky  blocky
 *   alternating band checkerboard   11,714   4,914k  11.29 ms  blocky  blocky
 *   ±16-band checkerboard          192,994  78,653k 176.21 ms  blocky  blocky
 *
 * A chunk drawn blocky costs 0.4–0.7 ms in every one of these rows, whichever
 * generation drew it: the fallback's own geometry is fixed-size, and the
 * bail-out happens before the expensive work.
 *
 * "work" is the ear-clipping cost predictor defined at
 * CHUNK_TRIANGULATION_WORK_BUDGET. The 4,096 column is this same code on
 * 2026-08-14 morning, i.e. what the owner played: EIGHT rows of ordinary
 * sculpting drew blocky there, for two independent reasons that had to be
 * fixed together — the budget itself for the ones over 4,096 triangles, and,
 * for the ones under it (pits every 4th cell, at 1,970 triangles and 0.62 ms),
 * hole bridging leaving the outline self-intersecting so that the exact
 * triangle prediction failed and the verification door fired. Those two fixes
 * are the hole ORDERING at the end of groupLoops and the bridge REFINEMENT in
 * bridgeHole; between them they also cut the adversarial rows by 2–12× (the
 * ±16-band checkerboard's contour path was 2,093 ms before them).
 *
 * A multi-frame stall is not something a renderer may do, however adversarial
 * the terrain, so the builder counts what it is ABOUT to need, level by level,
 * and the moment either budget is passed it abandons the contour path for that
 * chunk and emits axis-aligned per-cell geometry instead (1,802 triangles at
 * most): correct heights, correct colours, correct picking, no smoothing.
 * Beauty is sacrificed exactly where the terrain is adversarial, and nowhere
 * else. The bail-out happens BEFORE the expensive work — bridging and ear
 * clipping are the only super-linear steps and both run after the counts are
 * known — which is why the last row costs a millisecond rather than a second
 * and a half.
 *
 * 10,240 sits 23% above the heaviest legitimately sculpted chunk measured
 * (three craters and six spires dug into one 16×16 chunk, 8,319) and roughly
 * 3× above the reported crater itself. The OLD value, 4,096, is what the owner
 * hit: an ordinary crater plus a few spires needs 5,250, so normal heavy play
 * flipped chunks to blocky and the terrain read as a patchwork.
 *
 * MEMORY. Attributes are 108 bytes per triangle (3 unshared vertices × 9
 * floats), and ensureCapacity doubles rather than fits, so the ceiling this
 * budget sets is a 16,384-triangle capacity = 1.77 MB per chunk, against
 * 442 KB at the old 4,096. That is a per-chunk HIGH-WATER MARK reached only by
 * a chunk whose own geometry demanded it, never an allocation every chunk
 * makes: the reported crater settles at 4,096 (442 KB), a crater with spires
 * at 8,192 (885 KB), the three-crater chunk at 16,384 (1.77 MB), a chunk that
 * blew either budget needs only 2,048 (221 KB) for the fallback, and an
 * ordinary chunk still never leaves its starting 1,024 (110 KB). What grew is
 * the worst case for the rare crowded chunk, not the cost of a world.
 */
export const CHUNK_TRIANGLE_BUDGET = 10240;

/**
 * Ear-clipping work one chunk may spend before it is given the blocky fallback.
 * The TIME half of the guard, and the half that catches the checkerboards.
 *
 * WHY TRIANGLES ALONE CANNOT DO THIS JOB, measured: a field of stamped spires
 * costs 7,976 triangles and 0.98 ms, while a field of stamped PITS costs 8,738
 * triangles and 7.71 ms. Same size, same stamping, eight times the time — the
 * spires are separate outer loops, the pits are holes bridged into one polygon,
 * and earClip is O(V²) in the vertices V of the polygon it is handed. Triangle
 * count is therefore not what predicts a stall; the size of the bridged
 * polygons is, and gating on the wrong one either lets a 7 ms chunk through or
 * blockifies a crater to catch it.
 *
 * So the builder sums V² over the polygons it is about to triangulate, where V
 * is the merged vertex count a polygon's outer loop, its holes and its bridges
 * come to (two extra vertices per bridge — see BRIDGE_SLIT_WIDTH). Against the
 * measured table above that predicts ear-clipping time at 1.6–3.3 ns per unit
 * across five orders of magnitude of work, which is as tight as this gets: it
 * IS the inner loop's own operation count.
 *
 * 1,000,000 is therefore ~3.3 ms of ear clipping at the worst measured rate,
 * and with the rest of the pipeline (marching, smoothing, ~1 ms of buffer
 * writes at the triangle budget) it holds a chunk build to about 4 ms — a
 * quarter of a 60 fps frame, for an event that lands on ~4% of frames during a
 * held sculpt (see the budget reasoning in render/terrainMeshes.ts: ≈32 chunk
 * patches per second, so ~13% of one core at this ceiling and under 3% at the
 * crater fixture's real 112k). It clears every legitimate fixture with room to
 * spare — the heaviest, three craters in one chunk, needs 337k, and pits every
 * third cell 796k — and catches every adversarial one by 1.7× to 78×.
 *
 * It cannot blockify anything the old triangle-only budget passed: a chunk
 * needs a polygon of ~1,000 vertices to reach this work, and 1,000 cap vertices
 * drag ~2,000 skirt triangles along with them, which was already over 4,096.
 */
export const CHUNK_TRIANGULATION_WORK_BUDGET = 1_000_000;

/**
 * How many candidate bridges the fallback search in bridgeHole tries before it
 * gives up and takes the nearest one regardless.
 *
 * The search only runs when the straight ray-cast bridge is obstructed, which
 * needs a genuinely convoluted outline; 64 nearest candidates is far more than
 * such a case has ever needed and bounds the work at O(64 × outline) so one
 * awkward hole cannot become a stall.
 */
const BRIDGE_SEARCH_LIMIT = 64;

/**
 * Width, in cell units, of the sliver a hole bridge is opened to. See
 * bridgeHole: a zero-width bridge leaves the merged polygon only weakly simple,
 * and ear clipping is not guaranteed to finish on one of those.
 */
const BRIDGE_SLIT_WIDTH = 1e-6;

const COMPONENTS_PER_POSITION = 3;
const COMPONENTS_PER_NORMAL = 3;
const COMPONENTS_PER_COLOR = 3;
/** Three corners per triangle, none shared — unshared is what creases cliffs. */
export const VERTICES_PER_TRIANGLE = 3;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** What one call to writeChunkVertexData emitted. */
export interface ChunkGeometryCounts {
  /** Flat band tops. */
  capTriangleCount: number;
  /** Vertical risers between one band and the one below. */
  skirtTriangleCount: number;
  triangleCount: number;
  /** Vertices written, i.e. triangleCount * 3 — also the draw range. */
  vertexCount: number;
  /** Triangles the buffers can hold after this call. */
  triangleCapacity: number;
  /** True when the buffers had to be reallocated to fit this geometry. */
  capacityGrew: boolean;
  /**
   * True when the chunk's contour geometry blew CHUNK_TRIANGLE_BUDGET or
   * CHUNK_TRIANGULATION_WORK_BUDGET (or failed to triangulate exactly) and it
   * was drawn with axis-aligned per-cell geometry instead.
   */
  usedFallback: boolean;
}

/**
 * A chunk's attribute arrays. Unlike the old fixed-size buffers these can be
 * REPLACED by writeChunkVertexData when a chunk's geometry outgrows them, which
 * is why the fields are mutable and why the counts report `capacityGrew`: the
 * renderer has to rebind its BufferAttributes when that happens. It is rare —
 * a chunk's capacity only ever moves up, to its own high-water mark.
 */
export interface ChunkGeometryBuffers {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  triangleCapacity: number;
}

/**
 * Cap and skirt colour ramps, injected rather than imported so the renderer can
 * pass palettes already converted to Three's linear working colour space while
 * tests pass the plain sRGB ones — same selection logic either way. Both are
 * indexed by `bandPaletteIndex`.
 */
export interface ChunkPalettes {
  top: readonly Rgb[];
  cliff: readonly Rgb[];
}

export function createChunkGeometryBuffers(
  triangleCapacity: number = INITIAL_CHUNK_TRIANGLE_CAPACITY,
): ChunkGeometryBuffers {
  const vertices = triangleCapacity * VERTICES_PER_TRIANGLE;
  return {
    positions: new Float32Array(vertices * COMPONENTS_PER_POSITION),
    normals: new Float32Array(vertices * COMPONENTS_PER_NORMAL),
    colors: new Float32Array(vertices * COMPONENTS_PER_COLOR),
    triangleCapacity,
  };
}

// ---------------------------------------------------------------------------
// Contour extraction
// ---------------------------------------------------------------------------

/** Which of the chunk domain's four borders a point lies on (bitmask). */
const RECT_NONE = 0;
const RECT_WEST = 1;
const RECT_EAST = 2;
const RECT_NORTH = 4;
const RECT_SOUTH = 8;

/**
 * One vertex of a contour, in CELL coordinates (world coordinates are these
 * times CELL_WORLD_SIZE). `rect` is non-zero exactly for the points that lie on
 * the chunk's domain border, which are the ones smoothing must not move and
 * skirts must not be built from (seam contract S4/S5).
 */
interface ContourPoint {
  x: number;
  z: number;
  rect: number;
}

type ContourLoop = ContourPoint[];

/** A band (or the waterline) drawn as one stacked, flat, coloured cap. */
interface ContourLevel {
  /** Inside means `height >= threshold`, in HEIGHT units. */
  threshold: number;
  /** World Y of the cap. */
  capY: number;
  /** World height of the skirt hanging under it; 0 emits no skirt. */
  skirtDrop: number;
  capColor: Rgb;
  skirtColor: Rgb;
  /**
   * Null for band boundaries, which interpolate the raw heights (biased by
   * CONTOUR_SAMPLE_CLEARANCE). The waterline overrides it with
   * SHORE_EDGE_CROSSING, because there is no height gradient across it to
   * interpolate — see that constant.
   */
  crossingOverride: number | null;
  loops: ContourLoop[];
}

// --- per-write scratch, module-scoped and reused ---------------------------
//
// Rebuilding a chunk allocates the contour polylines themselves (a few hundred
// small objects), which is fine — the no-allocation rule in terrainMeshes.ts is
// about GPU buffers and typed arrays, not about a few kilobytes of short-lived
// JS objects eight times a second. The fixed-size lattice and edge tables below
// are still reused, because they are the ones touched per LEVEL rather than per
// chunk.

const SAMPLE_COUNT = LATTICE_PER_CHUNK * LATTICE_PER_CHUNK;
const samples = new Int32Array(SAMPLE_COUNT);

/** Horizontal lattice edge (i,j)→(i+1,j): i ∈ [0,15], j ∈ [0,16]. */
const H_EDGE_COUNT = CHUNK_SIZE * LATTICE_PER_CHUNK;
/** Vertical lattice edge (i,j)→(i,j+1): i ∈ [0,16], j ∈ [0,15]. */
const V_EDGE_COUNT = LATTICE_PER_CHUNK * CHUNK_SIZE;
const EDGE_COUNT = H_EDGE_COUNT + V_EDGE_COUNT;
/** Two segments per dual square is the marching-squares maximum (saddles). */
const MAX_SEGMENTS = 2 * CHUNK_SIZE * CHUNK_SIZE;

const edgeCrossed = new Uint8Array(EDGE_COUNT);
const edgeX = new Float64Array(EDGE_COUNT);
const edgeZ = new Float64Array(EDGE_COUNT);
const segmentFrom = new Int32Array(MAX_SEGMENTS);
const segmentTo = new Int32Array(MAX_SEGMENTS);
const segmentUsed = new Uint8Array(MAX_SEGMENTS);
/** Edge key → index of the segment leaving it (−1 for none). */
const segmentLeaving = new Int32Array(EDGE_COUNT);
/** Edge key → 1 when some segment arrives at it. */
const edgeHasEntry = new Uint8Array(EDGE_COUNT);

/**
 * Reads the chunk's 17×17 sample lattice.
 *
 * Seam contract S1: canonical world sample positions, read through the shared
 * mirror, so a border sample is the same number in both chunks — and so the
 * world border needs no special case, because sampleHeight clamps there.
 */
function loadSamples(mirror: TerrainMirror, originX: number, originZ: number): void {
  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
      samples[j * LATTICE_PER_CHUNK + i] = sampleHeight(mirror, originX + i, originZ + j);
    }
  }
}

const horizontalEdgeKey = (i: number, j: number): number => j * CHUNK_SIZE + i;
const verticalEdgeKey = (i: number, j: number): number =>
  H_EDGE_COUNT + j * LATTICE_PER_CHUNK + i;

/** Edge slots of one dual square, in the order the case table names them. */
const SQUARE_EDGE_BOTTOM = 0;
const SQUARE_EDGE_RIGHT = 1;
const SQUARE_EDGE_TOP = 2;
const SQUARE_EDGE_LEFT = 3;

/**
 * Marching-squares case table, "inside on the left".
 *
 * Corners of dual square (i,j), which spans cell centres (i..i+1, j..j+1):
 *
 *     d(i,j+1) ──── c(i+1,j+1)      case = a | b<<1 | c<<2 | d<<3
 *        │              │           bottom = z = j, top = z = j+1
 *     a(i,j)   ──── b(i+1,j)
 *
 * Each entry is a flat list of (fromEdge, toEdge) pairs. The direction is the
 * one that keeps the INSIDE region on the left of travel, which makes outer
 * boundaries counter-clockwise and holes clockwise in the (x,z) plane — the
 * orientation the triangulator and the skirt normals below both assume.
 * The two saddles (5 and 10) are resolved by the centre sample and live in
 * their own tables.
 */
const B = SQUARE_EDGE_BOTTOM;
const R = SQUARE_EDGE_RIGHT;
const T = SQUARE_EDGE_TOP;
const L = SQUARE_EDGE_LEFT;
const MARCHING_CASES: readonly (readonly number[])[] = [
  [], // 0  nothing inside
  [B, L], // 1  a
  [R, B], // 2  b
  [R, L], // 3  a b
  [T, R], // 4  c
  [], // 5  a c — saddle, see MARCHING_SADDLE_5_*
  [T, B], // 6  b c
  [T, L], // 7  a b c
  [L, T], // 8  d
  [B, T], // 9  a d
  [], // 10 b d — saddle, see MARCHING_SADDLE_10_*
  [R, T], // 11 a b d
  [L, R], // 12 c d
  [B, R], // 13 a c d
  [L, B], // 14 b c d
  [], // 15 everything inside
];
/** Saddle 5 (a and c inside): joined through the middle, or two islands. */
const MARCHING_SADDLE_5_JOINED: readonly number[] = [B, R, T, L];
const MARCHING_SADDLE_5_SPLIT: readonly number[] = [B, L, T, R];
/** Saddle 10 (b and d inside). */
const MARCHING_SADDLE_10_JOINED: readonly number[] = [L, B, R, T];
const MARCHING_SADDLE_10_SPLIT: readonly number[] = [R, B, L, T];

/**
 * Where a contour crosses the lattice edge running from an OUTSIDE sample to an
 * INSIDE one, as a fraction of the edge measured from the outside end.
 *
 * Both samples are pushed CONTOUR_SAMPLE_CLEARANCE further from the threshold
 * before interpolating (see that constant for why), which also means the
 * denominator can never be zero: it is at least twice the clearance. The result
 * is then clamped clear of both ends by CONTOUR_CELL_CENTRE_GUARD, which is
 * what stops a contour ever reaching a cell centre.
 */
function crossingFraction(
  outsideHeight: number,
  insideHeight: number,
  threshold: number,
  override: number | null,
): number {
  if (override !== null) return override;
  const toBoundary = threshold - outsideHeight + CONTOUR_SAMPLE_CLEARANCE;
  const span = insideHeight - outsideHeight + 2 * CONTOUR_SAMPLE_CLEARANCE;
  const s = toBoundary / span;
  if (s < CONTOUR_CELL_CENTRE_GUARD) return CONTOUR_CELL_CENTRE_GUARD;
  if (s > 1 - CONTOUR_CELL_CENTRE_GUARD) return 1 - CONTOUR_CELL_CENTRE_GUARD;
  return s;
}

/**
 * Fills the per-level edge crossing tables and the segment list from the
 * sample lattice. Returns the number of segments found.
 *
 * Sample (i,j) is the centre of world cell (x0+i, y0+j) and sits at cell
 * coordinate (x0+i, y0+j) — the lattice IS the world's, which is seam contract
 * S2/S3: the crossing on a shared edge depends on nothing chunk-local.
 */
function marchLevel(
  threshold: number,
  originX: number,
  originZ: number,
  crossingOverride: number | null,
): number {
  segmentLeaving.fill(-1);
  edgeHasEntry.fill(0);
  edgeCrossed.fill(0);

  const inside = (i: number, j: number): boolean =>
    samples[j * LATTICE_PER_CHUNK + i] >= threshold;
  const heightAt = (i: number, j: number): number =>
    samples[j * LATTICE_PER_CHUNK + i];

  // Crossings, one pass over every lattice edge. Each edge has at most one
  // crossing for a given threshold (the field is linear along it).
  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const left = inside(i, j);
      const right = inside(i + 1, j);
      if (left === right) continue;
      const key = horizontalEdgeKey(i, j);
      const s = right
        ? crossingFraction(heightAt(i, j), heightAt(i + 1, j), threshold, crossingOverride)
        : crossingFraction(heightAt(i + 1, j), heightAt(i, j), threshold, crossingOverride);
      edgeCrossed[key] = 1;
      edgeX[key] = originX + (right ? i + s : i + 1 - s);
      edgeZ[key] = originZ + j;
    }
  }
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
      const near = inside(i, j);
      const far = inside(i, j + 1);
      if (near === far) continue;
      const key = verticalEdgeKey(i, j);
      const s = far
        ? crossingFraction(heightAt(i, j), heightAt(i, j + 1), threshold, crossingOverride)
        : crossingFraction(heightAt(i, j + 1), heightAt(i, j), threshold, crossingOverride);
      edgeCrossed[key] = 1;
      edgeX[key] = originX + i;
      edgeZ[key] = originZ + (far ? j + s : j + 1 - s);
    }
  }

  // Segments, one pass over every dual square the chunk owns.
  let count = 0;
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const a = inside(i, j) ? 1 : 0;
      const b = inside(i + 1, j) ? 2 : 0;
      const c = inside(i + 1, j + 1) ? 4 : 0;
      const d = inside(i, j + 1) ? 8 : 0;
      const caseIndex = a | b | c | d;
      let pairs: readonly number[] = MARCHING_CASES[caseIndex];
      if (caseIndex === 5 || caseIndex === 10) {
        // Saddle: the four corners alternate, so the two arcs can either join
        // through the middle of the square or stay apart. Decide it with the
        // square's own mean height — deterministic, and needing no agreement
        // with anyone else because a square belongs to exactly one chunk.
        const mean =
          (heightAt(i, j) +
            heightAt(i + 1, j) +
            heightAt(i + 1, j + 1) +
            heightAt(i, j + 1)) /
          4;
        const joined = mean >= threshold;
        pairs =
          caseIndex === 5
            ? joined
              ? MARCHING_SADDLE_5_JOINED
              : MARCHING_SADDLE_5_SPLIT
            : joined
              ? MARCHING_SADDLE_10_JOINED
              : MARCHING_SADDLE_10_SPLIT;
      }
      for (let p = 0; p < pairs.length; p += 2) {
        const fromKey = squareEdgeKey(i, j, pairs[p]);
        const toKey = squareEdgeKey(i, j, pairs[p + 1]);
        segmentFrom[count] = fromKey;
        segmentTo[count] = toKey;
        segmentLeaving[fromKey] = count;
        edgeHasEntry[toKey] = 1;
        count++;
      }
    }
  }
  return count;
}

function squareEdgeKey(i: number, j: number, slot: number): number {
  switch (slot) {
    case SQUARE_EDGE_BOTTOM:
      return horizontalEdgeKey(i, j);
    case SQUARE_EDGE_RIGHT:
      return verticalEdgeKey(i + 1, j);
    case SQUARE_EDGE_TOP:
      return horizontalEdgeKey(i, j + 1);
    default:
      return verticalEdgeKey(i, j);
  }
}

/** Which chunk borders a point sits on. Domain is [x0,x0+16] × [z0,z0+16]. */
function rectMaskOf(x: number, z: number, x0: number, z0: number): number {
  let mask = RECT_NONE;
  if (x === x0) mask |= RECT_WEST;
  if (x === x0 + CHUNK_SIZE) mask |= RECT_EAST;
  if (z === z0) mask |= RECT_NORTH;
  if (z === z0 + CHUNK_SIZE) mask |= RECT_SOUTH;
  return mask;
}

/**
 * Distance travelled counter-clockwise around the chunk's domain border to
 * reach a point on it, used to close open contour chains along the border in
 * the right order. The walk runs +x along z = z0, +z up x = x0+16, −x back
 * along z = z0+16 and −z down x = x0 — counter-clockwise in the (x,z) plane,
 * which is the same handedness as "inside on the left".
 */
function perimeterOf(p: ContourPoint, x0: number, z0: number): number {
  const s = CHUNK_SIZE;
  if ((p.rect & RECT_NORTH) !== 0 && (p.rect & RECT_EAST) === 0) return p.x - x0;
  if ((p.rect & RECT_EAST) !== 0 && (p.rect & RECT_SOUTH) === 0) return s + (p.z - z0);
  if ((p.rect & RECT_SOUTH) !== 0 && (p.rect & RECT_WEST) === 0) {
    return 2 * s + (x0 + s - p.x);
  }
  return 3 * s + (z0 + s - p.z);
}

/** The four domain corners, in the same counter-clockwise order. */
function rectCorners(x0: number, z0: number): ContourPoint[] {
  const s = CHUNK_SIZE;
  return [
    { x: x0, z: z0, rect: RECT_WEST | RECT_NORTH },
    { x: x0 + s, z: z0, rect: RECT_EAST | RECT_NORTH },
    { x: x0 + s, z: z0 + s, rect: RECT_EAST | RECT_SOUTH },
    { x: x0, z: z0 + s, rect: RECT_WEST | RECT_SOUTH },
  ];
}

function pointOfEdge(key: number, x0: number, z0: number): ContourPoint {
  const x = edgeX[key];
  const z = edgeZ[key];
  return { x, z, rect: rectMaskOf(x, z, x0, z0) };
}

/**
 * Turns the marched segments into closed loops covering the region
 * {height ≥ threshold}, clipped to the chunk's domain rectangle.
 *
 * Chains of segments that run off the domain (their ends are crossings on
 * border lattice edges) are closed by walking the domain border
 * counter-clockwise from where one chain leaves to where the next one enters,
 * inserting the corners passed on the way. Chains that never touch the border
 * are already closed loops. If nothing crosses at all, the region is either the
 * whole domain or none of it.
 */
function assembleLoops(
  segmentCount: number,
  x0: number,
  z0: number,
  wholeDomainInside: boolean,
): ContourLoop[] {
  const loops: ContourLoop[] = [];
  if (segmentCount === 0) {
    if (wholeDomainInside) loops.push(rectCorners(x0, z0));
    return loops;
  }
  segmentUsed.fill(0, 0, segmentCount);

  // --- open chains: start at a crossing nothing arrives at ---------------
  interface OpenChain {
    points: ContourPoint[];
    startPerimeter: number;
    endPerimeter: number;
  }
  const chains: OpenChain[] = [];
  for (let s = 0; s < segmentCount; s++) {
    if (segmentUsed[s] === 1) continue;
    if (edgeHasEntry[segmentFrom[s]] === 1) continue;
    const points: ContourPoint[] = [pointOfEdge(segmentFrom[s], x0, z0)];
    let cursor = s;
    for (;;) {
      segmentUsed[cursor] = 1;
      const toKey = segmentTo[cursor];
      points.push(pointOfEdge(toKey, x0, z0));
      const next = segmentLeaving[toKey];
      if (next < 0 || segmentUsed[next] === 1) break;
      cursor = next;
    }
    chains.push({
      points,
      startPerimeter: perimeterOf(points[0], x0, z0),
      endPerimeter: perimeterOf(points[points.length - 1], x0, z0),
    });
  }

  // --- interior loops: whatever segments are left form closed rings ------
  for (let s = 0; s < segmentCount; s++) {
    if (segmentUsed[s] === 1) continue;
    const points: ContourPoint[] = [pointOfEdge(segmentFrom[s], x0, z0)];
    let cursor = s;
    for (;;) {
      segmentUsed[cursor] = 1;
      const toKey = segmentTo[cursor];
      const next = segmentLeaving[toKey];
      if (next < 0 || segmentUsed[next] === 1) break;
      points.push(pointOfEdge(toKey, x0, z0));
      cursor = next;
    }
    if (points.length >= 3) loops.push(points);
  }

  if (chains.length === 0) {
    // Nothing crossed the domain border, so the border is uniformly inside or
    // outside — and if it is inside, the region's OUTER boundary is the whole
    // domain. This is the plateau-with-a-pit case: without the domain loop the
    // interior rings would be holes with nothing to be holes in, and the band
    // would simply not be drawn.
    if (wholeDomainInside) loops.push(rectCorners(x0, z0));
    return loops;
  }

  // --- close the open chains along the domain border ---------------------
  const corners = rectCorners(x0, z0);
  const cornerPerimeter = corners.map((c, index) => index * CHUNK_SIZE);
  const byStart = chains.map((_, index) => index);
  byStart.sort((a, b) => chains[a].startPerimeter - chains[b].startPerimeter);

  const consumed = new Uint8Array(chains.length);
  for (const seed of byStart) {
    if (consumed[seed] === 1) continue;
    const loop: ContourPoint[] = [];
    let current = seed;
    for (;;) {
      consumed[current] = 1;
      const chain = chains[current];
      // The chain's own points, minus its last (the next border walk starts
      // there and the walk re-adds nothing, so append all but the duplicate).
      for (const p of chain.points) loop.push(p);

      // Walk the border forward to the next chain that starts on it.
      let best = -1;
      let bestGap = Infinity;
      for (let k = 0; k < chains.length; k++) {
        const gap = cyclicGap(chain.endPerimeter, chains[k].startPerimeter);
        if (gap < bestGap) {
          bestGap = gap;
          best = k;
        }
      }
      if (best < 0) break;
      // Corners passed on the way are part of the boundary and must be kept,
      // or the cap would cut the chunk's corner off — in the order they are
      // passed, which is by distance travelled, not by corner index.
      const passed: number[] = [];
      for (let c = 0; c < corners.length; c++) {
        if (cyclicGap(chain.endPerimeter, cornerPerimeter[c]) < bestGap) passed.push(c);
      }
      passed.sort(
        (a, b) =>
          cyclicGap(chain.endPerimeter, cornerPerimeter[a]) -
          cyclicGap(chain.endPerimeter, cornerPerimeter[b]),
      );
      for (const c of passed) loop.push(corners[c]);
      if (best === seed) break;
      if (consumed[best] === 1) break;
      current = best;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Forward distance from `from` to `to` around the domain border. */
function cyclicGap(from: number, to: number): number {
  const perimeter = 4 * CHUNK_SIZE;
  const gap = to - from;
  return gap > 0 ? gap : gap + perimeter;
}

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

/**
 * One Chaikin pass over a CLOSED loop, with border vertices pinned.
 *
 * Ordinary vertices are replaced by two points a CHAIKIN_CUT fraction in from
 * each end of their edges, which rounds the corner. A vertex on the chunk
 * border keeps its exact position and its corner is not cut (seam contract S4),
 * so a run of border vertices stays a straight line along the border and an arc
 * arriving at the border still arrives at precisely the neighbour's point.
 */
function chaikinPass(loop: ContourLoop): ContourLoop {
  const n = loop.length;
  if (n < 3) return loop;
  const out: ContourLoop = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    const aPinned = a.rect !== RECT_NONE;
    const bPinned = b.rect !== RECT_NONE;
    const first = aPinned
      ? a
      : {
          x: a.x + (b.x - a.x) * CHAIKIN_CUT,
          z: a.z + (b.z - a.z) * CHAIKIN_CUT,
          rect: RECT_NONE,
        };
    const second = bPinned
      ? b
      : {
          x: a.x + (b.x - a.x) * (1 - CHAIKIN_CUT),
          z: a.z + (b.z - a.z) * (1 - CHAIKIN_CUT),
          rect: RECT_NONE,
        };
    pushDistinct(out, first);
    pushDistinct(out, second);
  }
  // The wrap-around can duplicate the first point; the loop is implicit.
  if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out;
}

function samePoint(a: ContourPoint, b: ContourPoint): boolean {
  return a.x === b.x && a.z === b.z;
}

function pushDistinct(out: ContourLoop, p: ContourPoint): void {
  if (out.length > 0 && samePoint(out[out.length - 1], p)) return;
  out.push(p);
}

/**
 * Pushes any smoothed vertex back out of the guard disc around its nearest cell
 * centre — the belt to the crossing clamp's braces (see
 * CONTOUR_CELL_CENTRE_GUARD). Border vertices are exempt: they lie on the
 * lattice lines that run THROUGH cell centres, they are shared with the
 * neighbouring chunk, and moving them would break the seam. What that costs is
 * bounded and stated: the guarantee is over cell centres strictly inside a
 * chunk's domain; on the domain border the two chunks agree with each other,
 * which is what keeps the surface watertight there.
 */
function enforceCentreGuard(loop: ContourLoop): void {
  for (const p of loop) {
    if (p.rect !== RECT_NONE) continue;
    const cx = Math.round(p.x);
    const cz = Math.round(p.z);
    const dx = p.x - cx;
    const dz = p.z - cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= CONTOUR_CELL_CENTRE_GUARD) continue;
    if (d === 0) {
      // Exactly on a centre: push along +x, deterministically.
      p.x = cx + CONTOUR_CELL_CENTRE_GUARD;
      continue;
    }
    const scale = CONTOUR_CELL_CENTRE_GUARD / d;
    p.x = cx + dx * scale;
    p.z = cz + dz * scale;
  }
}

/** Drops vertices that carry no shape (see CONTOUR_SIMPLIFY_EPSILON). */
function dropCollinear(loop: ContourLoop): ContourLoop {
  const n = loop.length;
  if (n < 4) return loop;
  const out: ContourLoop = [];
  for (let i = 0; i < n; i++) {
    const prev = out.length > 0 ? out[out.length - 1] : loop[(i + n - 1) % n];
    const here = loop[i];
    const next = loop[(i + 1) % n];
    if (here.rect !== RECT_NONE) {
      out.push(here);
      continue;
    }
    const area = Math.abs(
      (here.x - prev.x) * (next.z - prev.z) - (here.z - prev.z) * (next.x - prev.x),
    );
    const base = Math.hypot(next.x - prev.x, next.z - prev.z);
    if (base > 0 && area / base < CONTOUR_SIMPLIFY_EPSILON) continue;
    out.push(here);
  }
  return out.length >= 3 ? out : loop;
}

function smoothLoop(loop: ContourLoop): ContourLoop {
  let current = loop;
  for (let pass = 0; pass < CHAIKIN_ITERATIONS; pass++) {
    current = chaikinPass(current);
  }
  enforceCentreGuard(current);
  return dropCollinear(current);
}

// ---------------------------------------------------------------------------
// Triangulation — outer loops with holes, by ear clipping
// ---------------------------------------------------------------------------

function signedArea(loop: ContourLoop): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

function pointInLoop(px: number, pz: number, loop: ContourLoop): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.z > pz !== b.z > pz) {
      const t = (pz - a.z) / (b.z - a.z);
      if (px < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

function turn(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

/**
 * Containment in a triangle, edges included and winding irrelevant — the caller
 * (bridgeHole's refinement) builds its triangle from a ray and cannot know
 * which way round it came out.
 */
function pointInTriangle(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  px: number,
  pz: number,
): boolean {
  const d1 = turn(ax, az, bx, bz, px, pz);
  const d2 = turn(bx, bz, cx, cz, px, pz);
  const d3 = turn(cx, cz, ax, az, px, pz);
  const anyNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const anyPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(anyNegative && anyPositive);
}

/**
 * Whether the point (px,pz) lies on the INSIDE of `loop` as seen from the
 * loop's vertex `i` — i.e. inside the wedge that vertex's two edges cut out of
 * the plane. A convex corner's wedge is the one between its edges; a reflex
 * corner's is everything except the wedge between them.
 *
 * It is a local test, not a containment test, and that is exactly what
 * bridgeHole's refinement needs: a candidate landing vertex whose wedge does
 * not face the hole cannot be the end of a bridge that runs through the
 * interior, however close it is. (earcut calls this locallyInside.)
 */
function seesPoint(loop: ContourLoop, i: number, px: number, pz: number): boolean {
  const n = loop.length;
  const a = loop[i];
  const prev = loop[(i + n - 1) % n];
  const next = loop[(i + 1) % n];
  if (turn(prev.x, prev.z, a.x, a.z, next.x, next.z) > 0) {
    return (
      turn(a.x, a.z, px, pz, next.x, next.z) <= 0 &&
      turn(a.x, a.z, prev.x, prev.z, px, pz) <= 0
    );
  }
  return (
    turn(a.x, a.z, px, pz, prev.x, prev.z) > 0 ||
    turn(a.x, a.z, next.x, next.z, px, pz) > 0
  );
}

function segmentsCross(
  a: ContourPoint,
  b: ContourPoint,
  c: ContourPoint,
  d: ContourPoint,
): boolean {
  const d1 = turn(a.x, a.z, b.x, b.z, c.x, c.z);
  const d2 = turn(a.x, a.z, b.x, b.z, d.x, d.z);
  const d3 = turn(c.x, c.z, d.x, d.z, a.x, a.z);
  const d4 = turn(c.x, c.z, d.x, d.z, b.x, b.z);
  // Strict crossing only: touching at a shared endpoint (which every bridge
  // does, at both ends) must not count as a blocked line of sight.
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Splices a hole into its outer loop with a two-way bridge, so the pair becomes
 * one simple polygon the ear clipper can eat.
 *
 * The bridge runs from the hole's RIGHTMOST vertex straight out along +x to the
 * first outer edge the ray meets, and lands on that edge's right-hand endpoint
 * — the classic ray-cast bridge. Nothing can lie between the hole and that edge
 * except outer vertices that stick back INTO the ray's triangle, so the search
 * is refined over those (and only those) by picking the one at the shallowest
 * angle, which is always visible from the hole.
 *
 * COST, and it is the reason for the shape of this function: bridging is the
 * hot spot of the whole builder on fragmented terrain. A chunk of alternating
 * stamped cells makes ~100 holes inside one region, and the outer polygon grows
 * with every bridge spliced into it, so an O(outer × hole) candidate search
 * with a sort — the obvious "shortest clear bridge" — measured 330 ms per chunk
 * on that terrain. This one is a single O(outer) pass per hole: the same chunk
 * measures ~10 ms.
 */
function bridgeHole(outer: ContourLoop, hole: ContourLoop): ContourLoop {
  let holeIndex = 0;
  for (let j = 1; j < hole.length; j++) {
    if (hole[j].x > hole[holeIndex].x) holeIndex = j;
  }
  const hx = hole[holeIndex].x;
  const hz = hole[holeIndex].z;

  // Nearest outer edge to the right of the hole, on the ray z = hz.
  let hitX = Infinity;
  let outerIndex = -1;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    if (a.z === b.z) continue;
    if (hz < Math.min(a.z, b.z) || hz > Math.max(a.z, b.z)) continue;
    const x = a.x + ((hz - a.z) / (b.z - a.z)) * (b.x - a.x);
    if (x < hx || x >= hitX) continue;
    hitX = x;
    outerIndex = a.x > b.x ? i : (i + 1) % outer.length;
  }
  // REFINEMENT, and it is what the ray cast alone gets wrong (measured
  // 2026-08-14). The hit edge's larger-x end is the right landing vertex only
  // when nothing stands between the hole and it, and on a chunk-sized outline
  // that is usually FALSE: the hit edge is the domain's own east border, whose
  // larger-x end is a corner sixteen cells away, and almost anything — the
  // hole's own far side above all — stands in the way. Every such obstruction
  // is an outer vertex lying inside the triangle (hole point, ray hit, that
  // endpoint): a vertex outside the triangle cannot block a sight line that
  // stays inside it. So one O(outer) pass over exactly those vertices, keeping
  // the one at the shallowest angle to the ray, lands the bridge on a vertex
  // the hole can actually see. This is earcut's findHoleBridge refinement,
  // mirrored (our ray runs +x, so "closer to the hole" is SMALLER x).
  //
  // The comment this replaces claimed the refinement was already here; it was
  // not, and the cost fell on the fallback search below — which fired on
  // essentially every crater bridge and, at O(outer × hole) plus a sort plus
  // BRIDGE_SEARCH_LIMIT visibility passes, was over HALF the build time of a
  // chunk with three craters in it (2.13 ms of 4.17 ms).
  if (outerIndex >= 0) {
    const mx = outer[outerIndex].x;
    const mz = outer[outerIndex].z;
    let bestTangent = Infinity;
    for (let i = 0; i < outer.length; i++) {
      if (i === outerIndex) continue;
      const p = outer[i];
      // Only vertices strictly beyond the ray's start and no further out than
      // the current landing vertex can be in the way.
      if (p.x <= hx || p.x > mx) continue;
      if (!pointInTriangle(hx, hz, hitX, hz, mx, mz, p.x, p.z)) continue;
      if (!seesPoint(outer, i, hx, hz)) continue;
      // Tangent of the angle between the ray and the candidate: the smallest
      // one is visible from the hole, because anything that could hide it would
      // itself sit at a smaller angle and be picked instead.
      const tangent = Math.abs(hz - p.z) / (p.x - hx);
      if (tangent < bestTangent || (tangent === bestTangent && p.x < outer[outerIndex].x)) {
        bestTangent = tangent;
        outerIndex = i;
      }
    }
  }

  // The refined landing point is the usual answer, but not a guaranteed one:
  // the refinement assumes an outline that is simple to begin with. Verifying
  // costs one more O(outer + hole) pass, and only when it fails does the search
  // widen to "the nearest vertex with a clear line", which is what the first
  // version of this function did for EVERY hole — and what made it 300 ms.
  const clear = (i: number, j: number): boolean => {
    const a = outer[i];
    const b = hole[j];
    for (let k = 0; k < outer.length; k++) {
      if (segmentsCross(a, b, outer[k], outer[(k + 1) % outer.length])) return false;
    }
    for (let k = 0; k < hole.length; k++) {
      if (segmentsCross(a, b, hole[k], hole[(k + 1) % hole.length])) return false;
    }
    return true;
  };

  if (outerIndex < 0 || !clear(outerIndex, holeIndex)) {
    const candidates: { outerIndex: number; holeIndex: number; distance: number }[] = [];
    for (let i = 0; i < outer.length; i++) {
      for (let j = 0; j < hole.length; j++) {
        candidates.push({
          outerIndex: i,
          holeIndex: j,
          distance: (outer[i].x - hole[j].x) ** 2 + (outer[i].z - hole[j].z) ** 2,
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    let found = false;
    for (const candidate of candidates.slice(0, BRIDGE_SEARCH_LIMIT)) {
      if (!clear(candidate.outerIndex, candidate.holeIndex)) continue;
      outerIndex = candidate.outerIndex;
      holeIndex = candidate.holeIndex;
      found = true;
      break;
    }
    if (!found && outerIndex < 0) {
      outerIndex = candidates[0].outerIndex;
      holeIndex = candidates[0].holeIndex;
    }
  }

  // The bridge is walked out and back, and the classic splice walks it over the
  // SAME two points twice — a zero-width slit. That makes the merged polygon
  // only weakly simple, and a weakly simple polygon has no guaranteed ear: ear
  // clipping stalls at the slit, and (measured, before this) leaves a fifth of
  // a band's cap untriangulated, which shows as a hole in the terrain. Opening
  // the slit to BRIDGE_SLIT_WIDTH makes the polygon strictly simple, so the two
  // ears theorem applies again and the triangulation always completes. The
  // width is a millionth of a cell: seven orders of magnitude above the
  // arithmetic's noise at the far corner of the largest world, and utterly
  // invisible. Skirts are built from the un-merged contour loops, so they never
  // see it at all.
  const bridgeX = outer[outerIndex].x - hole[holeIndex].x;
  const bridgeZ = outer[outerIndex].z - hole[holeIndex].z;
  const bridgeLength = Math.hypot(bridgeX, bridgeZ) || 1;
  const slitX = (-bridgeZ / bridgeLength) * BRIDGE_SLIT_WIDTH;
  const slitZ = (bridgeX / bridgeLength) * BRIDGE_SLIT_WIDTH;

  const merged: ContourLoop = [];
  for (let i = 0; i <= outerIndex; i++) merged.push(outer[i]);
  for (let j = 0; j < hole.length; j++) {
    merged.push(hole[(holeIndex + j) % hole.length]);
  }
  merged.push({
    x: hole[holeIndex].x + slitX,
    z: hole[holeIndex].z + slitZ,
    rect: RECT_NONE,
  });
  merged.push({
    x: outer[outerIndex].x + slitX,
    z: outer[outerIndex].z + slitZ,
    rect: RECT_NONE,
  });
  for (let i = outerIndex + 1; i < outer.length; i++) merged.push(outer[i]);
  return merged;
}

/**
 * Ear clipping for a counter-clockwise simple polygon.
 *
 * O(n²) in the worst case, which is the right trade here: n is a smoothed
 * contour inside ONE chunk (tens to a few hundred vertices), and the
 * alternatives that beat it asymptotically all need either a dependency or a
 * sweepline whose degenerate cases are exactly the ones marching squares
 * produces. The iteration guard means a polygon we somehow made non-simple
 * costs a bounded amount of work and loses a few triangles rather than hanging
 * the render loop.
 */
function earClip(
  polygon: ContourLoop,
  emit: (a: ContourPoint, b: ContourPoint, c: ContourPoint) => void,
): void {
  // A queue rather than one pass: a polygon that stalls (see clipEars) is cut
  // in two along a diagonal and both halves go back in. Splitting conserves the
  // triangle count exactly — an n-gon split at a diagonal becomes an n₁-gon and
  // an n₂-gon with n₁ + n₂ = n + 2, and (n₁−2) + (n₂−2) = n−2 — which is what
  // keeps the caller's exact triangle prediction (and therefore its capacity
  // and its verification) honest.
  const pending: ContourLoop[] = [polygon];
  let splits = 0;
  while (pending.length > 0) {
    const poly = pending.pop() as ContourLoop;
    const stalled = clipEars(poly, emit);
    if (stalled === null) continue;
    if (splits >= EAR_CLIP_SPLIT_LIMIT) continue;
    const halves = splitPolygon(stalled);
    if (halves === null) continue;
    splits++;
    pending.push(halves[0], halves[1]);
  }
}

/**
 * How many times one polygon may be cut in two before triangulation gives up
 * and lets the caller fall back to blocky geometry.
 *
 * Splitting is the rare path — it needs a polygon whose bridges left it
 * pinched, which is a handful per thousand chunks — and each split is an O(n²)
 * diagonal search, so the limit is what keeps a pathological outline from
 * turning into a long chain of searches. 64 is far beyond anything measured.
 */
const EAR_CLIP_SPLIT_LIMIT = 64;

/**
 * Twice the area of the triangle below which a point counts as lying ON a
 * segment rather than beside it. Contour coordinates are cell-scale, so 1e-9
 * is far below any real geometry and far above the rounding of the arithmetic
 * that produced it.
 */
const COLLINEAR_TOUCH_EPSILON = 1e-9;

/**
 * Clips ears until none is left. Returns null when the polygon was fully
 * triangulated, or the vertices that remain when no ear can be found — which
 * happens on polygons that are simple but PINCHED, the shape hole bridging
 * naturally produces (a bridge is a zero-width slit, and a vertex on one side
 * of a slit sits exactly on the other side's edge).
 */
function clipEars(
  polygon: ContourLoop,
  emit: (a: ContourPoint, b: ContourPoint, c: ContourPoint) => void,
): ContourLoop | null {
  const n = polygon.length;
  if (n < 3) return null;
  const live: number[] = [];
  for (let i = 0; i < n; i++) live.push(i);

  let guard = n * n + n;
  while (live.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < live.length; k++) {
      const a = polygon[live[(k + live.length - 1) % live.length]];
      const b = polygon[live[k]];
      const c = polygon[live[(k + 1) % live.length]];
      if (turn(a.x, a.z, b.x, b.z, c.x, c.z) <= 0) continue; // reflex/degenerate
      let blocked = false;
      for (let m = 0; m < live.length; m++) {
        if (
          m === k ||
          m === (k + live.length - 1) % live.length ||
          m === (k + 1) % live.length
        ) {
          continue;
        }
        const p = polygon[live[m]];
        // Coincident vertices DO block. A bridge walks the same two points
        // twice, and clipping an ear that ignored its twin would tear the slit
        // open and leave a polygon that is no longer simple. Getting stuck at a
        // bridge instead is fine: splitPolygon resolves it.
        if (
          turn(a.x, a.z, b.x, b.z, p.x, p.z) >= 0 &&
          turn(b.x, b.z, c.x, c.z, p.x, p.z) >= 0 &&
          turn(c.x, c.z, a.x, a.z, p.x, p.z) >= 0
        ) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      emit(a, b, c);
      live.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (live.length === 3) {
    emit(polygon[live[0]], polygon[live[1]], polygon[live[2]]);
    return null;
  }
  if (live.length < 3) return null;
  return live.map((index) => polygon[index]);
}

/**
 * Cuts a stalled polygon in two along a valid diagonal: a segment between two
 * non-adjacent vertices that crosses no edge and runs through the polygon's
 * inside. Returns null when the polygon has no such diagonal, which a simple
 * polygon of four or more vertices always does — so null means the polygon was
 * not simple, and the caller's verification will send the chunk to the blocky
 * fallback.
 */
function splitPolygon(polygon: ContourLoop): [ContourLoop, ContourLoop] | null {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent around the wrap
      const a = polygon[i];
      const b = polygon[j];
      if (samePoint(a, b)) continue;
      let blocked = false;
      for (let k = 0; k < n && !blocked; k++) {
        const c = polygon[k];
        const d = polygon[(k + 1) % n];
        if (segmentsCross(a, b, c, d)) blocked = true;
      }
      if (blocked) continue;
      // No OTHER vertex may sit on the diagonal. Bridged holes leave
      // zero-width slits in the outline, and a diagonal that runs along one
      // touches it without ever "crossing" an edge — splitting there would cut
      // the polygon in a place that is not actually inside it.
      for (let k = 0; k < n && !blocked; k++) {
        if (k === i || k === j) continue;
        const p = polygon[k];
        if (Math.abs(turn(a.x, a.z, b.x, b.z, p.x, p.z)) > COLLINEAR_TOUCH_EPSILON) {
          continue;
        }
        const withinX = p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
        const withinZ = p.z >= Math.min(a.z, b.z) && p.z <= Math.max(a.z, b.z);
        if (withinX && withinZ) blocked = true;
      }
      if (blocked) continue;
      // The diagonal must run INSIDE, not across a concavity.
      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      if (!pointInLoop(midX, midZ, polygon)) continue;
      const first = polygon.slice(i, j + 1);
      const second = polygon.slice(j).concat(polygon.slice(0, i + 1));
      if (first.length < 3 || second.length < 3) continue;
      // Belt and braces: a genuine diagonal leaves both halves wound the same
      // way as the whole. A half that came out backwards would be triangulated
      // inside out, and its triangles would paint over the very hole the
      // outline exists to cut.
      if (signedArea(first) <= 0 || signedArea(second) <= 0) continue;
      return [first, second];
    }
  }
  return null;
}

/** Groups a level's loops into outer polygons with their holes. */
interface CapPolygon {
  outer: ContourLoop;
  /**
   * Sorted by descending `rightmostX`, which is the order they MUST be bridged
   * in — see the ordering argument at the end of groupLoops.
   */
  holes: ContourLoop[];
}

/** The x of the vertex bridgeHole casts its ray from. */
function rightmostX(loop: ContourLoop): number {
  let x = -Infinity;
  for (const p of loop) {
    if (p.x > x) x = p.x;
  }
  return x;
}

function groupLoops(loops: ContourLoop[]): CapPolygon[] {
  const outers: CapPolygon[] = [];
  const holes: ContourLoop[] = [];
  for (const loop of loops) {
    if (signedArea(loop) > 0) outers.push({ outer: loop, holes: [] });
    else holes.push(loop);
  }
  for (const hole of holes) {
    // Assign to the SMALLEST outer loop that contains it: nested plateaus mean
    // a hole can sit inside more than one, and it belongs to its immediate
    // parent.
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (!pointInLoop(hole[0].x, hole[0].z, outers[i].outer)) continue;
      const area = signedArea(outers[i].outer);
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    if (best >= 0) outers[best].holes.push(hole);
  }
  // BRIDGING ORDER, and it is a correctness requirement rather than a
  // preference (2026-08-14, found on an ordinary stamped crater).
  //
  // bridgeHole splices one hole at a time into an outline that already contains
  // every bridge spliced before it, and it picks its bridge by casting +x from
  // the hole's rightmost vertex and checking the line of sight against the
  // outer loop and THAT hole. It cannot check against holes not spliced yet —
  // they are not part of the outline it is looking at — so in an arbitrary
  // order a bridge can be run straight THROUGH a hole that is still to come.
  // Splicing that hole afterwards then crosses the earlier bridge's corridor:
  // the merged polygon is no longer simple, ear clipping stalls on an inverted
  // remnant, the exact triangle prediction fails, and the verification in
  // writeChunkVertexData sends the WHOLE CHUNK to the blocky fallback. Two
  // craters dug on one diagonal are enough — the second bowl sits on the first
  // bowl's bridge — which is one half of the "ordinary terrain went blocky"
  // report this ordering fixes.
  //
  // Descending rightmost x removes the possibility rather than detecting it: a
  // bridge from the rightmost vertex of hole h lands on a vertex whose x is at
  // least h's own (the ray travels +x and the landing vertex is never behind
  // the hit point), so h's corridor lies entirely in the half-plane
  // x ≥ rightmostX(h), while every hole still unspliced has rightmostX ≤ that
  // and so lies entirely in the closed half-plane on the other side. The two
  // can meet only ON the line x = rightmostX(h), which takes two holes with the
  // same rightmost x AND a vertical bridge to be a crossing rather than a
  // touch; that residue is still caught, blockily, by the verification door.
  //
  // Same ordering earcut's eliminateHoles uses, for the same reason, mirrored
  // left-to-right because our ray runs +x.
  for (const polygon of outers) {
    polygon.holes.sort((a, b) => rightmostX(b) - rightmostX(a));
  }
  return outers;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * The stack of caps to draw for one chunk, lowest first.
 *
 * One per band present anywhere in the chunk's sample lattice, from the lowest
 * (whose region is the whole domain, by definition of "lowest") to the highest,
 * plus the waterline cap when band 0 is in range. Bands the chunk does not
 * reach cost nothing: an absent band's region would either be empty or identical
 * to its neighbour's, so the stack is exactly as tall as the terrain is.
 */
function makeLevels(palettes: ChunkPalettes): ContourLevel[] {
  let lowestBand = Infinity;
  let highestBand = -Infinity;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const band = bandOf(samples[i]);
    if (band < lowestBand) lowestBand = band;
    if (band > highestBand) highestBand = band;
  }

  const levels: ContourLevel[] = [];
  for (let k = lowestBand; k <= highestBand; k++) {
    // The level's own threshold height doubles as the representative RAW height
    // for its colour, which is exactly right at both ends of the ramp: band 0's
    // threshold is 0, which bandPaletteIndex calls water (a fresh, all-zero
    // world is sea, not beach), and band k>0's threshold is the first height in
    // that band.
    const paletteIndex = bandPaletteIndex(k * BAND_HEIGHT);
    // Band 0's cap is the SEABED, sunk under the dry-land cap that shares its
    // height — see SEABED_CAP_SINK.
    const capY = k === 0 ? -SEABED_CAP_SINK : k * BAND_WORLD_HEIGHT;
    const below = k - 1 === 0 ? -SEABED_CAP_SINK : (k - 1) * BAND_WORLD_HEIGHT;
    levels.push({
      threshold: k * BAND_HEIGHT,
      capY,
      // The lowest cap is the chunk's floor: nothing is under it to fall to.
      skirtDrop: k === lowestBand ? 0 : capY - below,
      capColor: palettes.top[paletteIndex],
      skirtColor: palettes.cliff[paletteIndex],
      crossingOverride: null,
      loops: [],
    });
    if (k === 0) {
      // The waterline: the same flat band 0, one height unit up, where the
      // seabed becomes beach. It is a colour boundary rather than a step, so it
      // gets the dry-land cap at exactly y = 0 and only a hairline skirt down
      // to the seabed it covers.
      const shoreIndex = bandPaletteIndex(SEA_LEVEL + 1);
      levels.push({
        threshold: SEA_LEVEL + 1,
        capY: 0,
        skirtDrop: SEABED_CAP_SINK,
        capColor: palettes.top[shoreIndex],
        skirtColor: palettes.cliff[shoreIndex],
        crossingOverride: SHORE_EDGE_CROSSING,
        loops: [],
      });
    }
  }
  return levels;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/** Write cursor into the chunk's buffers; module state for the write only. */
let outBuffers: ChunkGeometryBuffers | null = null;
let outVertex = 0;

function pushVertex(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  color: Rgb,
): void {
  const buffers = outBuffers as ChunkGeometryBuffers;
  let p = outVertex * COMPONENTS_PER_POSITION;
  buffers.positions[p++] = x;
  buffers.positions[p++] = y;
  buffers.positions[p] = z;
  let n = outVertex * COMPONENTS_PER_NORMAL;
  buffers.normals[n++] = nx;
  buffers.normals[n++] = ny;
  buffers.normals[n] = nz;
  let c = outVertex * COMPONENTS_PER_COLOR;
  buffers.colors[c++] = color[0];
  buffers.colors[c++] = color[1];
  buffers.colors[c] = color[2];
  outVertex++;
}

/**
 * A flat cap triangle. Loops are counter-clockwise in the (x,z) plane, and the
 * 3D basis (X, Z) has X × Z = −Y, so a counter-clockwise loop's own winding
 * faces DOWN — the corners are emitted reversed to make the tread face the sky.
 */
function emitCapTriangle(
  a: ContourPoint,
  b: ContourPoint,
  c: ContourPoint,
  y: number,
  color: Rgb,
): void {
  pushVertex(a.x * CELL_WORLD_SIZE, y, a.z * CELL_WORLD_SIZE, 0, 1, 0, color);
  pushVertex(c.x * CELL_WORLD_SIZE, y, c.z * CELL_WORLD_SIZE, 0, 1, 0, color);
  pushVertex(b.x * CELL_WORLD_SIZE, y, b.z * CELL_WORLD_SIZE, 0, 1, 0, color);
}

/**
 * The vertical riser under one contour segment, inset into the high side by
 * SKIRT_PICK_INSET.
 *
 * Walking direction keeps the inside (the higher ground) on the left, so the
 * exposed face looks to the RIGHT of travel: for a step p→q the outward normal
 * is (dz, 0, −dx) normalised, and the inset moves the quad the other way.
 */
function emitSkirtQuad(
  p: ContourPoint,
  q: ContourPoint,
  topY: number,
  drop: number,
  color: Rgb,
): void {
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return;
  const outX = dz / length;
  const outZ = -dx / length;
  const px = (p.x - outX * SKIRT_PICK_INSET) * CELL_WORLD_SIZE;
  const pz = (p.z - outZ * SKIRT_PICK_INSET) * CELL_WORLD_SIZE;
  const qx = (q.x - outX * SKIRT_PICK_INSET) * CELL_WORLD_SIZE;
  const qz = (q.z - outZ * SKIRT_PICK_INSET) * CELL_WORLD_SIZE;
  const bottomY = topY - drop;

  pushVertex(px, topY, pz, outX, 0, outZ, color);
  pushVertex(qx, topY, qz, outX, 0, outZ, color);
  pushVertex(qx, bottomY, qz, outX, 0, outZ, color);

  pushVertex(px, topY, pz, outX, 0, outZ, color);
  pushVertex(qx, bottomY, qz, outX, 0, outZ, color);
  pushVertex(px, bottomY, pz, outX, 0, outZ, color);
}

/** True for a segment lying along the chunk border, which grows no skirt. */
function isBorderSegment(a: ContourPoint, b: ContourPoint): boolean {
  return (a.rect & b.rect) !== 0;
}

// ---------------------------------------------------------------------------
// The blocky fallback
//
// The pre-2026-08-14 renderer, kept alive for one purpose: chunks whose terrain
// blows the contour budget (see CHUNK_TRIANGLE_BUDGET). One axis-aligned flat
// quad per cell at that cell's own band, one vertical wall wherever two
// adjacent cells sit at different heights, and a curtain around the chunk's
// border so it can never be seen through where it meets a smoothed neighbour.
//
// It covers the SAME domain as the contour path — [x0, x0+16], the lattice of
// cell centres — so the two tile the plane identically. The cells on the domain
// border are half-width, which is what makes that work: cell x0 owns
// [x0, x0+½] and the neighbour's first cell owns [x0+15½, x0+16].
//
// Known residual, and it is the price of the whole arrangement: where a
// fallback chunk meets a contoured one, the two surfaces agree at cell centres
// but not between them, so a step of up to one band can show along that seam.
// The curtain guarantees it is a step and never a hole.
// ---------------------------------------------------------------------------

/** Half a cell edge, in cell units. */
const CELL_HALF_EXTENT = 0.5;

/** Caps: one quad per lattice cell. */
const FALLBACK_CAP_TRIANGLES = 2 * LATTICE_PER_CHUNK * LATTICE_PER_CHUNK;
/** Walls: at most one per interior cell boundary, on each axis. */
const FALLBACK_WALL_TRIANGLES = 2 * (2 * CHUNK_SIZE * LATTICE_PER_CHUNK);
/** Curtain: one quad per border cell, on each of the four sides. */
const FALLBACK_CURTAIN_TRIANGLES = 2 * (4 * LATTICE_PER_CHUNK);
/** The fallback's exact worst case, which is what its buffers are sized for. */
export const FALLBACK_MAX_TRIANGLES =
  FALLBACK_CAP_TRIANGLES + FALLBACK_WALL_TRIANGLES + FALLBACK_CURTAIN_TRIANGLES;

/**
 * World Y of a cell's flat top: its band floor, with band-0 SEA sunk to match
 * the contour path's seabed cap so the two renderers meet at the same height.
 */
function cellCapY(height: number): number {
  const band = bandOf(height);
  if (band === 0 && height <= SEA_LEVEL) return -SEABED_CAP_SINK;
  return band * BAND_WORLD_HEIGHT;
}

function writeBlockyFallback(
  originX: number,
  originZ: number,
  palettes: ChunkPalettes,
): { caps: number; skirts: number } {
  let caps = 0;
  let skirts = 0;

  const heightAt = (i: number, j: number): number => samples[j * LATTICE_PER_CHUNK + i];
  // Cell extents, clipped to the chunk's domain so the border cells are halves.
  const loX = (i: number): number => Math.max(originX + i - CELL_HALF_EXTENT, originX);
  const hiX = (i: number): number =>
    Math.min(originX + i + CELL_HALF_EXTENT, originX + CHUNK_SIZE);
  const loZ = (j: number): number => Math.max(originZ + j - CELL_HALF_EXTENT, originZ);
  const hiZ = (j: number): number =>
    Math.min(originZ + j + CELL_HALF_EXTENT, originZ + CHUNK_SIZE);

  let floorY = Infinity;
  for (let i = 0; i < SAMPLE_COUNT; i++) floorY = Math.min(floorY, cellCapY(samples[i]));

  // --- caps -------------------------------------------------------------
  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
      const height = heightAt(i, j);
      const y = cellCapY(height);
      const color = palettes.top[bandPaletteIndex(height)];
      const west = { x: loX(i), z: loZ(j), rect: RECT_NONE };
      const east = { x: hiX(i), z: loZ(j), rect: RECT_NONE };
      const southWest = { x: loX(i), z: hiZ(j), rect: RECT_NONE };
      const southEast = { x: hiX(i), z: hiZ(j), rect: RECT_NONE };
      // Counter-clockwise in (x,z) — emitCapTriangle flips the winding to make
      // the tread face the sky.
      emitCapTriangle(west, east, southEast, y, color);
      emitCapTriangle(west, southEast, southWest, y, color);
      caps += 2;
    }
  }

  // --- walls, one per differing cell boundary ----------------------------
  // Direction of travel keeps the HIGHER cell on the left, which is what makes
  // emitSkirtQuad's outward normal and its pick inset point the right way.
  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const here = heightAt(i, j);
      const next = heightAt(i + 1, j);
      const hereY = cellCapY(here);
      const nextY = cellCapY(next);
      if (hereY === nextY) continue;
      const westHigher = hereY > nextY;
      const planeX = originX + i + CELL_HALF_EXTENT;
      const color = palettes.cliff[bandPaletteIndex(westHigher ? here : next)];
      const a = { x: planeX, z: westHigher ? loZ(j) : hiZ(j), rect: RECT_NONE };
      const b = { x: planeX, z: westHigher ? hiZ(j) : loZ(j), rect: RECT_NONE };
      emitSkirtQuad(a, b, Math.max(hereY, nextY), Math.abs(hereY - nextY), color);
      skirts += 2;
    }
  }
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
      const here = heightAt(i, j);
      const next = heightAt(i, j + 1);
      const hereY = cellCapY(here);
      const nextY = cellCapY(next);
      if (hereY === nextY) continue;
      const northHigher = hereY > nextY;
      const planeZ = originZ + j + CELL_HALF_EXTENT;
      const color = palettes.cliff[bandPaletteIndex(northHigher ? here : next)];
      const a = { x: northHigher ? hiX(i) : loX(i), z: planeZ, rect: RECT_NONE };
      const b = { x: northHigher ? loX(i) : hiX(i), z: planeZ, rect: RECT_NONE };
      emitSkirtQuad(a, b, Math.max(hereY, nextY), Math.abs(hereY - nextY), color);
      skirts += 2;
    }
  }

  // --- curtain around the domain border ----------------------------------
  const curtain = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    topY: number,
    height: number,
  ): void => {
    if (topY <= floorY) return;
    emitSkirtQuad(
      { x: ax, z: az, rect: RECT_NONE },
      { x: bx, z: bz, rect: RECT_NONE },
      topY,
      topY - floorY,
      palettes.cliff[bandPaletteIndex(height)],
    );
    skirts += 2;
  };
  const last = CHUNK_SIZE;
  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    const west = heightAt(0, j);
    curtain(originX, hiZ(j), originX, loZ(j), cellCapY(west), west);
    const east = heightAt(last, j);
    curtain(originX + last, loZ(j), originX + last, hiZ(j), cellCapY(east), east);
  }
  for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
    const north = heightAt(i, 0);
    curtain(loX(i), originZ, hiX(i), originZ, cellCapY(north), north);
    const south = heightAt(i, last);
    curtain(hiX(i), originZ + last, loX(i), originZ + last, cellCapY(south), south);
  }

  return { caps, skirts };
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Fills a chunk's position/normal/colour buffers from the mirror and reports
 * how much of them is live.
 *
 * The buffers are patched in place whenever the geometry fits — which, after a
 * chunk's first few edits, is essentially always — and are otherwise grown to
 * fit and flagged with `capacityGrew` so the renderer can rebind. Geometry is
 * NON-INDEXED: every triangle owns its three vertices, which is what gives flat
 * shading a clean crease at every cap/skirt boundary, and it means the live
 * range is simply the first `vertexCount` vertices.
 */
export function writeChunkVertexData(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  buffers: ChunkGeometryBuffers,
  palettes: ChunkPalettes,
): ChunkGeometryCounts {
  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  loadSamples(mirror, originX, originZ);

  const levels = makeLevels(palettes);

  // --- geometry, level by level -----------------------------------------
  //
  // Counted first, emitted second. The count is exact (a polygon of V vertices
  // with H holes triangulates to V + 2H − 2 triangles), which is what lets the
  // buffers be sized once AND lets an adversarial chunk bail out to the blocky
  // fallback BEFORE the super-linear work — see CHUNK_TRIANGLE_BUDGET.
  let capTriangles = 0;
  let skirtTriangles = 0;
  /** Σ V² over the polygons to be triangulated — see the work budget. */
  let triangulationWork = 0;
  let overBudget = false;
  const polygonsPerLevel: CapPolygon[][] = [];
  for (const level of levels) {
    const segmentCount = marchLevel(
      level.threshold,
      originX,
      originZ,
      level.crossingOverride,
    );
    const wholeInside = samples[0] >= level.threshold;
    const rawLoops = assembleLoops(segmentCount, originX, originZ, wholeInside);
    level.loops = rawLoops.map(smoothLoop).filter((loop) => loop.length >= 3);

    const polygons = groupLoops(level.loops);
    polygonsPerLevel.push(polygons);
    for (const polygon of polygons) {
      let vertices = polygon.outer.length;
      for (const hole of polygon.holes) vertices += hole.length;
      // Every bridge splices its two ends in twice, once per side of the slit,
      // so the polygon earClip is handed is this long — and it triangulates to
      // exactly that many vertices minus two, which is the exact prediction the
      // verification below depends on.
      const merged = vertices + 2 * polygon.holes.length;
      capTriangles += merged - 2;
      triangulationWork += merged * merged;
    }
    if (level.skirtDrop > 0) {
      for (const loop of level.loops) {
        for (let i = 0; i < loop.length; i++) {
          if (!isBorderSegment(loop[i], loop[(i + 1) % loop.length])) {
            skirtTriangles += 2;
          }
        }
      }
    }
    // Either budget alone is enough to abandon the contour path: one bounds the
    // geometry (and the buffers behind it), the other the time it takes to make
    // it. Both are checked here, before any of the super-linear work runs.
    if (
      capTriangles + skirtTriangles > CHUNK_TRIANGLE_BUDGET ||
      triangulationWork > CHUNK_TRIANGULATION_WORK_BUDGET
    ) {
      overBudget = true;
      break;
    }
  }

  const triangleTarget = overBudget
    ? FALLBACK_MAX_TRIANGLES
    : capTriangles + skirtTriangles;
  let capacityGrew = ensureCapacity(buffers, triangleTarget);

  // --- write -------------------------------------------------------------
  outBuffers = buffers;
  outVertex = 0;
  let capEmitted = 0;
  let skirtEmitted = 0;

  for (let index = 0; index < (overBudget ? 0 : levels.length); index++) {
    const level = levels[index];
    for (const polygon of polygonsPerLevel[index]) {
      let merged = polygon.outer;
      for (const hole of polygon.holes) merged = bridgeHole(merged, hole);
      earClip(merged, (a, b, c) => {
        emitCapTriangle(a, b, c, level.capY, level.capColor);
        capEmitted++;
      });
    }
    if (level.skirtDrop <= 0) continue;
    for (const loop of level.loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if (isBorderSegment(a, b)) continue;
        emitSkirtQuad(a, b, level.capY, level.skirtDrop, level.skirtColor);
        skirtEmitted += 2;
      }
    }
  }

  // VERIFICATION, and the second door to the blocky fallback. The predicted
  // triangle count is EXACT for a triangulation that completes (a polygon of V
  // vertices with H holes always yields V + 2H − 2 triangles), so emitting
  // fewer means the ear clipper hit a polygon it could not finish — which,
  // left alone, would show as a hole in the world at exactly the band that
  // failed. A geometry bug must degrade to ugly, never to see-through, so the
  // chunk is redrawn blocky instead.
  let usedFallback = overBudget;
  if (!overBudget && (capEmitted !== capTriangles || skirtEmitted !== skirtTriangles)) {
    usedFallback = true;
  }
  if (usedFallback && !overBudget) {
    capacityGrew = ensureCapacity(buffers, FALLBACK_MAX_TRIANGLES) || capacityGrew;
  }
  if (usedFallback) {
    outVertex = 0;
    const emitted = writeBlockyFallback(originX, originZ, palettes);
    capEmitted = emitted.caps;
    skirtEmitted = emitted.skirts;
  }

  const triangleCount = capEmitted + skirtEmitted;
  const vertexCount = triangleCount * VERTICES_PER_TRIANGLE;
  collapseTail(buffers, vertexCount);
  outBuffers = null;

  return {
    capTriangleCount: capEmitted,
    skirtTriangleCount: skirtEmitted,
    triangleCount,
    vertexCount,
    triangleCapacity: buffers.triangleCapacity,
    capacityGrew,
    usedFallback,
  };
}

/**
 * Grows a chunk's buffers to hold `triangles`, doubling rather than fitting
 * exactly so a chunk being sculpted cannot reallocate on every intent. Capacity
 * never shrinks: a chunk that once held a big cliff will hold one again, and a
 * few hundred KB of headroom is worth far more than a reallocation mid-stroke.
 */
function ensureCapacity(buffers: ChunkGeometryBuffers, triangles: number): boolean {
  if (triangles <= buffers.triangleCapacity) return false;
  let capacity = buffers.triangleCapacity;
  while (capacity < triangles) capacity *= 2;
  const grown = createChunkGeometryBuffers(capacity);
  buffers.positions = grown.positions;
  buffers.normals = grown.normals;
  buffers.colors = grown.colors;
  buffers.triangleCapacity = capacity;
  return true;
}

/**
 * Collapses every unused vertex slot onto vertex 0.
 *
 * Two reasons, both about not trusting a single mechanism:
 *   - computeBoundingSphere() (terrainMeshes.ts, every patch) reads the WHOLE
 *     position attribute and ignores drawRange, so stale or zeroed tail
 *     vertices would drag the sphere back toward the world origin and inflate
 *     it enormously for a distant chunk. Vertex 0 is inside this chunk, so
 *     collapsing onto it leaves the sphere exact.
 *   - if the draw range were ever wrong, the tail rasterises as zero-area
 *     triangles rather than as garbage.
 */
function collapseTail(buffers: ChunkGeometryBuffers, vertexCount: number): void {
  const { positions, normals, colors } = buffers;
  const total = buffers.triangleCapacity * VERTICES_PER_TRIANGLE;
  const anchorX = positions[0];
  const anchorY = positions[1];
  const anchorZ = positions[2];
  for (let v = vertexCount; v < total; v++) {
    const p = v * COMPONENTS_PER_POSITION;
    positions[p] = anchorX;
    positions[p + 1] = anchorY;
    positions[p + 2] = anchorZ;
    const n = v * COMPONENTS_PER_NORMAL;
    normals[n] = 0;
    normals[n + 1] = 0;
    normals[n + 2] = 0;
    const c = v * COMPONENTS_PER_COLOR;
    colors[c] = 0;
    colors[c + 1] = 0;
    colors[c + 2] = 0;
  }
}

// ---------------------------------------------------------------------------
// Test-facing helpers
//
// The geometry is subtle enough that tests need to talk about contours, not
// only about the float soup they turn into. These are the same functions the
// builder runs, exposed so a test can assert the shape of a band's outline
// directly (and, for the seam contract, compare two chunks' border vertices).
// ---------------------------------------------------------------------------

/**
 * The triangulated cap of one band level, as flat (x,z) triangles.
 *
 * Exposed because triangulation is where this module's subtlety concentrates:
 * a test can assert that the triangles PARTITION the region (their areas sum
 * to the outline's, none of them wound backwards) rather than only that some
 * geometry came out. Bridged holes make that a real property to hold — see
 * BRIDGE_SLIT_WIDTH.
 */
export function chunkCapTriangles(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  threshold: number,
): { x: number; z: number }[][] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  loadSamples(mirror, originX, originZ);
  const segmentCount = marchLevel(threshold, originX, originZ, null);
  const loops = assembleLoops(segmentCount, originX, originZ, samples[0] >= threshold)
    .map(smoothLoop)
    .filter((loop) => loop.length >= 3);
  const triangles: { x: number; z: number }[][] = [];
  for (const polygon of groupLoops(loops)) {
    let merged = polygon.outer;
    for (const hole of polygon.holes) merged = bridgeHole(merged, hole);
    earClip(merged, (a, b, c) => {
      triangles.push([
        { x: a.x, z: a.z },
        { x: b.x, z: b.z },
        { x: c.x, z: c.z },
      ]);
    });
  }
  return triangles;
}

/** The smoothed outline of `{height ≥ threshold}` for one chunk. */
export function chunkContourLoops(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  threshold: number,
  crossingOverride: number | null = null,
): { x: number; z: number; onBorder: boolean }[][] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  loadSamples(mirror, originX, originZ);
  const segmentCount = marchLevel(threshold, originX, originZ, crossingOverride);
  const wholeInside = samples[0] >= threshold;
  return assembleLoops(segmentCount, originX, originZ, wholeInside)
    .map(smoothLoop)
    .filter((loop) => loop.length >= 3)
    .map((loop) =>
      loop.map((p) => ({ x: p.x, z: p.z, onBorder: p.rect !== RECT_NONE })),
    );
}
