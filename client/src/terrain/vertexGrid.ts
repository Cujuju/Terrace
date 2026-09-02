// Chunk mesh geometry — ORGANIC terraces: flat band caps with smooth, flowing
// outlines and vertical skirts between them.
// Pure: no Three.js, no DOM. Tested headless in test/vertexGrid.test.ts.
//
// CRITICAL CODE — this is where terrain becomes geometry, and it is
// feel-critical: the terraced silhouette is the app's namesake look
// (docs/DESIGN.md).
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
//      segment that is not part of the chunk border. Every skirt vertex also
//      carries a SELF-LIT flag (see LIT_BY_SCENE/SELF_LIT): underwater skirts
//      are seam OUTLINES rather than lit surfaces and must read identically on
//      all four orientations, which no vertex colour alone can achieve under a
//      directional sun.
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
//       mirror.sampleRenderHeight, exactly as the old wall renderer did, so
//       both chunks see the same heights across a border (and clamped, so the
//       world border needs no special case; samples in never-received chunks
//       are pulled back onto received terrain by the same principle — see that
//       function's seam-safety note, issue #22).
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

// SPLIT (issue #10, 2026-08-19): the implementation now lives in four seam
// modules — contours.ts (marching squares + loop assembly), contourSmoothing.ts
// (Chaikin + centre guard + simplify), triangulation.ts (hole bridging + ear
// clipping) and capEmission.ts (levels, buffer emission, blocky fallback, the
// builder, test-facing helpers). This file keeps the contract record above —
// the pipeline overview, the honesty invariant and seam contracts S1–S5 are
// stated once, here — and re-exports the public API unchanged.

export {
  CONTOUR_CELL_CENTRE_GUARD,
  CONTOUR_SAMPLE_CLEARANCE,
  LATTICE_PER_CHUNK,
  SHORE_EDGE_CROSSING,
} from './contours.ts';
export {
  CHAIKIN_CUT,
  CHAIKIN_ITERATIONS,
  CONTOUR_SIMPLIFY_EPSILON,
} from './contourSmoothing.ts';
export {
  CHUNK_POLYGON_WORK_BUDGET,
  CHUNK_TRIANGLE_BUDGET,
  CHUNK_TRIANGULATION_WORK_BUDGET,
  FALLBACK_MAX_TRIANGLES,
  MAX_MERGED_POLYGON_VERTICES,
  INITIAL_CHUNK_TRIANGLE_CAPACITY,
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
} from './capEmission.ts';
