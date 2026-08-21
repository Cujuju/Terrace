// Cap and skirt emission — pipeline step 4 of vertexGrid.ts's overview, plus
// everything that turns contours into a chunk's attribute buffers: the level
// stack, the vertex/triangle writers, the blocky fallback, the budget-guarded
// builder itself and the test-facing helpers. Split out of vertexGrid.ts
// (issue #10); see that facade for the pipeline overview, the honesty
// invariant and seam contracts S1–S5 (S5 — no skirts on the domain border —
// is enforced here by isBorderSegment).

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
import {
  bandPaletteIndex,
  isEmissivePaletteIndex,
  isSeabedPaletteIndex,
  type Rgb,
} from './bandColors.ts';
import type { TerrainMirror } from './mirror.ts';
import {
  LATTICE_PER_CHUNK,
  RECT_NONE,
  SAMPLE_COUNT,
  SHORE_EDGE_CROSSING,
  assembleLoops,
  loadSamples,
  marchLevel,
  samples,
  type ContourLoop,
  type ContourPoint,
} from './contours.ts';
import { smoothLoop } from './contourSmoothing.ts';
import { bridgeHole, earClip, groupLoops, type CapPolygon } from './triangulation.ts';

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
 * Height of the hairline border along the TOP edge of an underwater riser, in
 * world units (owner, 2026-08-19: "a single one pixel border at the top edge
 * of that band ... the same color as the next layer down").
 *
 * The border is GEOMETRY — a second, sliver-height quad above the main face —
 * because the owner asked for a border, not a fade, and per-vertex colours
 * interpolate: one quad with different top/bottom colours would gradient the
 * whole face. A sixteenth of a band: at the game's usual orbit a one-band
 * riser stands ~10–20 px tall, so the sliver reads as the requested ~1 px
 * line while staying a real, pickable part of the same riser (both quads take
 * the same inset and resolve to the same cell). A negative power of two, so
 * the split heights are exact in binary like every other Y this module emits.
 * It is 4× SEABED_CAP_SINK, so even the shortest underwater riser the level
 * stack produces (band 0's seabed cap over band −1, one band minus the sink)
 * is ~15× taller than its border and the face below never degenerates.
 */
export const SEABED_RISER_BORDER_WORLD_HEIGHT = BAND_WORLD_HEIGHT / 16;

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
 * RECALIBRATED 2026-08-19 EVENING (Deep Strata): the owner dug a brush-4 hard
 * pit from the coastal shelf to the new lava floor and watched it draw blocky
 * on stack 231.8d78097 — at 10,240 that was arithmetic, not accident. Two
 * shipped features moved the legitimate worst case: underwater risers COUNT
 * DOUBLE (each carries a top-edge border sliver, SEABED_RISER_BORDER_WORLD_
 * HEIGHT, so a submerged segment costs 4 skirt triangles against 2 on land),
 * and Deep Strata opened 8 more bands below the old floor, so one floor-depth
 * pit stacks up to ~26 contour levels in a single chunk. Remeasured rows,
 * same method, submerged fixtures dug with the wire-default anchored brush
 * (see the DEEP-SEA FIXTURES in test/vertexGrid.test.ts):
 *
 *   terrain (2026-08-19 rows)     triangles     work   contour  10,240     now
 *   crater(land, now bordered)       4,129     123k   3.1 ms       ok      ok
 *   THE OWNER'S PIT (hard r4)       10,575     229k   2.9 ms   blocky      ok
 *   deep pit + spires               12,864     240k   3.7 ms   blocky      ok
 *   deep soft crater                14,830     323k   4.5 ms   blocky      ok
 *   three deep craters + spires     28,033     777k   9.1 ms   blocky      ok
 *
 * (The land crater's own row moved 3,566 → 4,129 for the same reason — it
 * digs below the waterline, so its submerged risers now carry borders. The
 * original table's land-only rows above are kept as history of the method.)
 *
 * THE GUARD DUTY MOVED. Deep digging made legitimate triangle counts OVERLAP
 * the adversarial ones — the owner's pit (10.5k) and every deep row sit above
 * pits-every-2nd-cell (8.7k) — so triangles can no longer tell honest terrain
 * from adversarial terrain, and this budget stops trying. Discrimination is
 * now entirely the WORK budget's job (legitimate rows top out at 777k work,
 * adversarial rows start at 1,695k — clean separation); what THIS budget
 * bounds is memory and emission time, nothing else.
 *
 * 32,768 is 17% above the heaviest legitimate fixture (28,033) — thinner than
 * the 08-14 margin because the question changed: a margin here no longer
 * decides which terrain flips (the work guard stands in front of it), only
 * how much buffer a maximal chunk may ask for, and it is deliberately EXACTLY
 * the capacity ensureCapacity's doubling lands on, so the budget and the
 * high-water allocation are the same number.
 *
 * MEMORY. Attributes are 111 bytes per triangle (3 unshared vertices × 9
 * floats, plus one self-lit byte each), and ensureCapacity doubles rather
 * than fits, so the ceiling this budget sets is a 32,768-triangle capacity =
 * 3.64 MB per chunk. That is a per-chunk HIGH-WATER MARK reached only by a
 * chunk whose own geometry demanded it, never an allocation every chunk
 * makes: the land crater settles at 8,192 (0.9 MB), the owner's pit at
 * 16,384 (1.77 MB), only a floor-depth triple-crater chunk at 32,768
 * (3.64 MB), a chunk that blew either budget needs only 2,048 (221 KB) for
 * the fallback, and an ordinary chunk still never leaves its starting 1,024
 * (110 KB).
 *
 * COST HONESTY: the worst legitimate row builds in ~9 ms on the dev machine —
 * a dropped frame per patch while sculpting THAT chunk, paid only at the
 * bottom of the world, and chosen over drawing the owner's dig as blocks.
 * The architectural fix that removes the frame cost AND this whole budget
 * tradeoff class is async/multi-frame meshing — flagged, not built.
 */
/*
 * RECALIBRATED 2026-08-20 for BAND_HEIGHT 16 (was 32,768 at BAND_HEIGHT 64).
 *
 * Re-terracing the world quadrupled the number of band LEVELS a deep dig
 * crosses — the shelf-to-floor drop is 94 bands where it was 22 — and every
 * level contributes its own contour, cap and riser. The heaviest legitimate
 * fixture went 28,033 -> 117,384 triangles, so the old budget would have drawn
 * the owner's floor-deep dig as blocks: exactly the 2026-08-19 bug this table
 * was built to close.
 *
 *   fixture (2026-08-20 rows)          triangles       work   max polygon
 *   stamped crater (land)                  4,144    124k          23,104
 *   three craters and spires               9,902    354k          53,361
 *   the owner's floor pit (hard r4)       45,708    996k          14,641
 *   deep soft crater                      65,750  1,471k          23,716
 *   three floor-depth craters + spires   117,384  3,318k          58,564
 *   ── adversarial ───────────────────────────────────────────────────────
 *   pits every 3rd cell                    4,247    796k         265,225
 *   pits every 2nd cell                    8,738  3,358k       1,119,364
 *   checkerboard                          10,984  4,264k       4,235,364
 *
 * 131,072 is the next capacity ensureCapacity's doubling lands on above the
 * heaviest legitimate row, keeping this budget and the high-water allocation
 * the same number as before.
 *
 * MEMORY, AND THE BILL THIS RUNS UP. At the unchanged 111 bytes per triangle a
 * 131,072-triangle capacity is 14.5 MB for one chunk — four times the old
 * ceiling, reached only by a chunk that digs three craters to the world floor.
 * That is the honest cost of a four-times-finer world and it is what makes the
 * vertex-format compression (111 -> ~48 bytes/triangle) load-bearing rather
 * than an optimisation.
 */
export const CHUNK_TRIANGLE_BUDGET = 131072;

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
 * and with the rest of the pipeline (marching, smoothing, buffer writes) it
 * holds a chunk build to single-digit milliseconds (see the budget reasoning
 * in render/terrainMeshes.ts: ≈32 chunk patches per second during a held
 * sculpt).
 *
 * RE-RATIFIED UNCHANGED at the 2026-08-19 Deep Strata recalibration, and
 * PROMOTED: it is now the ONLY discriminating guard. Deep-sea digging pushed
 * legitimate triangle counts past the adversarial pit fields', so the
 * triangle budget above no longer separates honest terrain from hostile
 * terrain — this metric still does, cleanly. The heaviest legitimate fixture
 * (three floor-depth craters plus spires) needs 776,705; pits every third
 * cell 796k; the cheapest ADVERSARIAL row (terraced pseudo-random) 1,695k,
 * pits every 2nd cell 3,358k, the checkerboards 4,914k and 78,653k. One
 * million sits 26% above the heaviest legitimate row and 41% under the
 * cheapest adversarial one — and unlike triangles, the two populations did
 * not move toward each other when the world got deeper, because depth adds
 * LEVELS (linear, small polygons each) while adversarial shapes add HOLES
 * (quadratic in one polygon), and V² only explodes for the latter.
 */
/*
 * RAISED 2026-08-20, AND STRIPPED OF ITS GUARD DUTY (was 1,000,000).
 *
 * The claim above — that depth adds LEVELS while adversarial shapes add HOLES,
 * so the two populations cannot converge — held only while a deep dig crossed
 * 22 bands. At BAND_HEIGHT 16 it crosses 94, and the linear term won: the
 * heaviest legitimate fixture climbed 777k -> 3,318k while pits-every-2nd sat
 * still at 3,358k, because ITS cost is a function of band levels too and it
 * only ever had three. The gap closed from 2.2x to 1.2%, which is not a budget.
 *
 * So this constant keeps only the job it can still do — bounding the TIME one
 * chunk may spend, ~14 ms of ear clipping at the worst measured rate — and
 * discrimination moves to CHUNK_POLYGON_WORK_BUDGET below, which measures the
 * thing that actually blows up. 4,194,304 sits 26% above the heaviest
 * legitimate row, the same margin this budget carried before.
 */
export const CHUNK_TRIANGULATION_WORK_BUDGET = 4_194_304;

/**
 * Vertices the single largest merged polygon in a chunk may reach before the
 * chunk is given the blocky fallback.
 *
 * THE DISCRIMINATING GUARD since 2026-08-20, and the one metric in this file
 * that does not move when the world is re-terraced. earClip is O(V²) in the
 * vertices V of ONE polygon, so a stall comes from a single polygon that has
 * had many holes bridged into it — never from many small polygons stacked up
 * a deep column. Summing V² over a chunk conflates those two; taking the
 * MAXIMUM separates them, and keeps separating them at any BAND_HEIGHT,
 * because adding levels adds polygons rather than enlarging one.
 *
 * Measured against the same two populations (√work, i.e. vertices in the
 * worst polygon): every legitimate fixture tops out at 242 — the three
 * floor-depth craters and the shallow pits-every-4th tie there — while the
 * adversarial rows start at 515 (pits every 3rd cell), then 1,058 (pits every
 * 2nd) and 2,058 (checkerboard). 512 is double the heaviest legitimate
 * polygon, rounded up to a power of two.
 *
 * RESIDUAL, NAMED: pits-every-3rd-cell sits at 515, three vertices over the
 * cap, and is the nearest neighbour on the hostile side. It is in neither
 * fixture list — it was already in that no-man's land at the 2026-08-19
 * calibration (796k against a 777k legitimate ceiling) — so it falls back
 * today. Anything that promotes it to legitimate must re-measure this cap, not
 * nudge it.
 */
export const MAX_MERGED_POLYGON_VERTICES = 512;
export const CHUNK_POLYGON_WORK_BUDGET =
  MAX_MERGED_POLYGON_VERTICES * MAX_MERGED_POLYGON_VERTICES;

const COMPONENTS_PER_POSITION = 3;
const COMPONENTS_PER_NORMAL = 3;
const COMPONENTS_PER_COLOR = 3;
/** Three corners per triangle, none shared — unshared is what creases cliffs. */
export const VERTICES_PER_TRIANGLE = 3;

/**
 * The two values of the per-vertex SELF-LIT flag.
 *
 * WHAT IT IS FOR (owner, 2026-08-14, low-angle screenshot). Underwater terrace
 * seams are drawn as brightened silt-aqua rims on the one-band skirt that runs
 * along each seam (terrain/bandColors.ts). A skirt is a VERTICAL face and the
 * terrain material is lit by a single directional sun, so the orientations
 * facing away from it render dark whatever colour they carry: the outlines read
 * from overhead and vanish from a low camera. The dependence on lighting is the
 * bug, so the flag removes the dependence — a flagged vertex is shaded as its
 * own colour and nothing else (see render/terrainMeshes.ts, which is where the
 * shading half of this contract lives).
 *
 * WHY A PER-VERTEX FLAG rather than a second material. Splitting the rims into
 * their own geometry group with an unlit material is the native mechanism and
 * would cost nothing per vertex, but it costs a SECOND DRAW CALL on every chunk
 * that has underwater geometry — which, on a world that starts as an ocean, is
 * every chunk there is. One byte per vertex (2.8% on top of the 108 bytes a
 * triangle already costs) buys the same result with the draw call count
 * untouched. It is stored as a NORMALISED Uint8, so the shader reads 0.0 or 1.0
 * with no conversion of ours.
 */
export const LIT_BY_SCENE = 0;
export const SELF_LIT = 255;

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
  /**
   * Σ V² over the polygons the contour path triangulated (or was about to) —
   * the exact metric CHUNK_TRIANGULATION_WORK_BUDGET gates on, reported so the
   * calibration tests can assert real headroom against the budget instead of
   * re-deriving the sum. On a chunk that fell back mid-count this is the
   * PARTIAL sum up to the level that tripped a budget, which is still the
   * honest answer to "how far did the guard let it get".
   */
  triangulationWork: number;
  /**
   * V² of the LARGEST single polygon the chunk triangulated — the metric
   * CHUNK_POLYGON_WORK_BUDGET gates on. Reported so the calibration fixtures
   * can measure the two populations rather than infer them.
   */
  maxPolygonWork: number;
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
  /** One byte per vertex, LIT_BY_SCENE or SELF_LIT — see those constants. */
  selfLit: Uint8Array;
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
    selfLit: new Uint8Array(vertices),
    triangleCapacity,
  };
}

/** A band (or the waterline) drawn as one stacked, flat, coloured cap. */
interface ContourLevel {
  /** Inside means `height >= threshold`, in HEIGHT units. */
  threshold: number;
  /** World Y of the cap. */
  capY: number;
  /** World height of the skirt hanging under it; 0 emits no skirt. */
  skirtDrop: number;
  capColor: Rgb;
  /**
   * LIT_BY_SCENE for every cap except the lava floor's, which is SELF_LIT:
   * lava is a light source, not a lit surface (Deep Strata, 2026-08-19 —
   * see the amended emitCapTriangle comment and bandColors.ts's
   * isEmissivePaletteIndex). Decided here in makeLevels for the same reason
   * skirtSelfLit is: emission sites must not re-derive regime decisions.
   */
  capSelfLit: number;
  skirtColor: Rgb;
  /**
   * Colour of the hairline border along the riser's top edge — the NEXT BAND
   * DOWN's tread (owner, 2026-08-19), read straight from the top palette.
   * Non-null exactly for the underwater risers, which are the ones emitted as
   * border sliver + face (see SEABED_RISER_BORDER_WORLD_HEIGHT); null keeps a
   * land cliff a single quad. Decided HERE, in makeLevels, so the triangle
   * counting and the emission below cannot disagree about which skirts split.
   */
  skirtBorderColor: Rgb | null;
  /**
   * SELF_LIT for the skirts below the waterline — they read as part of the
   * water-dimmed seabed, not lit surfaces, and must track their tread's
   * colour on all four orientations (see bandColors.ts's seabed section; the
   * 2026-08-19 lightened-tread faces keep the flag for the same reason the
   * 2026-08-14 rims introduced it). Decided by the palette's own regime
   * predicate, so a face that took the seabed derivation is exactly the face
   * that is drawn self-lit — the border sliver rides the same flag.
   */
  skirtSelfLit: number;
  /**
   * Null for band boundaries, which interpolate the raw heights (biased by
   * CONTOUR_SAMPLE_CLEARANCE). The waterline overrides it with
   * SHORE_EDGE_CROSSING, because there is no height gradient across it to
   * interpolate — see that constant.
   */
  crossingOverride: number | null;
  loops: ContourLoop[];
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
    // The lowest cap is the chunk's floor: nothing is under it to fall to.
    const skirtDrop = k === lowestBand ? 0 : capY - below;
    // Underwater risers carry the top-edge border, coloured as the NEXT BAND
    // DOWN's tread — the band this skirt lands on, (k−1), through the same
    // palette lookup its own cap used. Land cliffs stay single-quad (null).
    // The drop guard is belt-and-braces: every underwater drop the stack can
    // produce is at least a band minus SEABED_CAP_SINK, ~15× the border.
    const bordered =
      isSeabedPaletteIndex(paletteIndex) &&
      skirtDrop > SEABED_RISER_BORDER_WORLD_HEIGHT;
    levels.push({
      threshold: k * BAND_HEIGHT,
      capY,
      skirtDrop,
      capColor: palettes.top[paletteIndex],
      capSelfLit: capSelfLitFor(paletteIndex),
      skirtColor: palettes.cliff[paletteIndex],
      skirtBorderColor: bordered
        ? palettes.top[bandPaletteIndex((k - 1) * BAND_HEIGHT)]
        : null,
      skirtSelfLit: selfLitFor(paletteIndex),
      crossingOverride: null,
      loops: [],
    });
    if (k === 0) {
      // The waterline: the same flat band 0, one height unit up, where the
      // seabed becomes beach. It is a colour boundary rather than a step, so it
      // gets the dry-land cap at exactly y = 0 and only a hairline skirt down
      // to the seabed it covers. That hairline is DRY beach — the first land
      // entry of the ramp — so it is lit like every other land cliff.
      const shoreIndex = bandPaletteIndex(SEA_LEVEL + 1);
      levels.push({
        threshold: SEA_LEVEL + 1,
        capY: 0,
        skirtDrop: SEABED_CAP_SINK,
        capColor: palettes.top[shoreIndex],
        capSelfLit: capSelfLitFor(shoreIndex),
        skirtColor: palettes.cliff[shoreIndex],
        // Dry land: never bordered (and its hairline drop is under the border
        // height anyway).
        skirtBorderColor: null,
        skirtSelfLit: selfLitFor(shoreIndex),
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

/**
 * Whether a cut face taking this palette entry is drawn self-lit.
 *
 * The single decision point for the whole module: every skirt, wall and curtain
 * the builder emits gets its flag from here, keyed by the very same palette
 * index that chose its colour. So "seabed rims are outlines, land cliffs are
 * surfaces" is stated once and cannot be forgotten at one of the four emission
 * sites.
 */
function selfLitFor(paletteIndex: number): number {
  return isSeabedPaletteIndex(paletteIndex) ? SELF_LIT : LIT_BY_SCENE;
}

/**
 * The cap counterpart: treads are lit surfaces, except the lava floor, which
 * is a light source (see the emitCapTriangle amendment). One decision point,
 * mirroring selfLitFor, so the contour path and the blocky fallback cannot
 * disagree about which cap glows.
 */
function capSelfLitFor(paletteIndex: number): number {
  return isEmissivePaletteIndex(paletteIndex) ? SELF_LIT : LIT_BY_SCENE;
}

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
  selfLit: number,
): void {
  const buffers = outBuffers as ChunkGeometryBuffers;
  buffers.selfLit[outVertex] = selfLit;
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
 *
 * Caps are never self-lit, seabed ones included: a tread IS a surface, it faces
 * the sky so it already receives the sun on every orientation, and unlighting
 * the seabed floor would flatten the depth ramp the palette exists to show.
 *
 * AMENDMENT (Deep Strata, 2026-08-19): "never" gained its one exception — the
 * lava floor at MIN_HEIGHT. Lava is not a surface catching light, it is the
 * light; a sun-lit orange tread would just read as wet paint. The exception is
 * decided by the palette's own predicate (capSelfLitFor / bandColors.ts's
 * isEmissivePaletteIndex), not here, so "the lava band glows" is stated once.
 */
function emitCapTriangle(
  a: ContourPoint,
  b: ContourPoint,
  c: ContourPoint,
  y: number,
  color: Rgb,
  selfLit: number,
): void {
  pushVertex(a.x * CELL_WORLD_SIZE, y, a.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
  pushVertex(c.x * CELL_WORLD_SIZE, y, c.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
  pushVertex(b.x * CELL_WORLD_SIZE, y, b.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
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
  selfLit: number,
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

  pushVertex(px, topY, pz, outX, 0, outZ, color, selfLit);
  pushVertex(qx, topY, qz, outX, 0, outZ, color, selfLit);
  pushVertex(qx, bottomY, qz, outX, 0, outZ, color, selfLit);

  pushVertex(px, topY, pz, outX, 0, outZ, color, selfLit);
  pushVertex(qx, bottomY, qz, outX, 0, outZ, color, selfLit);
  pushVertex(px, bottomY, pz, outX, 0, outZ, color, selfLit);
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
      const capIndex = bandPaletteIndex(height);
      const color = palettes.top[capIndex];
      // The fallback keeps the lava glow: same predicate as the contour path.
      const capLit = capSelfLitFor(capIndex);
      const west = { x: loX(i), z: loZ(j), rect: RECT_NONE };
      const east = { x: hiX(i), z: loZ(j), rect: RECT_NONE };
      const southWest = { x: loX(i), z: hiZ(j), rect: RECT_NONE };
      const southEast = { x: hiX(i), z: hiZ(j), rect: RECT_NONE };
      // Counter-clockwise in (x,z) — emitCapTriangle flips the winding to make
      // the tread face the sky.
      emitCapTriangle(west, east, southEast, y, color, capLit);
      emitCapTriangle(west, southEast, southWest, y, color, capLit);
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
      // The fallback draws underwater walls too, so it takes the same self-lit
      // rule from the same palette index — a chunk that went blocky must not
      // also lose its seabed treatment. It deliberately does NOT split the
      // top-edge border sliver off its walls (2026-08-19): the fallback's
      // whole contract is fixed-size degraded geometry ("correct heights,
      // correct colours, correct picking, no smoothing"), and the hairline is
      // a beauty feature. The face still takes the lightened-tread colour, so
      // a blocky chunk matches its smoothed neighbours' material, just
      // without the line.
      const index = bandPaletteIndex(westHigher ? here : next);
      const a = { x: planeX, z: westHigher ? loZ(j) : hiZ(j), rect: RECT_NONE };
      const b = { x: planeX, z: westHigher ? hiZ(j) : loZ(j), rect: RECT_NONE };
      emitSkirtQuad(
        a,
        b,
        Math.max(hereY, nextY),
        Math.abs(hereY - nextY),
        palettes.cliff[index],
        selfLitFor(index),
      );
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
      const index = bandPaletteIndex(northHigher ? here : next);
      const a = { x: northHigher ? hiX(i) : loX(i), z: planeZ, rect: RECT_NONE };
      const b = { x: northHigher ? loX(i) : hiX(i), z: planeZ, rect: RECT_NONE };
      emitSkirtQuad(
        a,
        b,
        Math.max(hereY, nextY),
        Math.abs(hereY - nextY),
        palettes.cliff[index],
        selfLitFor(index),
      );
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
    const index = bandPaletteIndex(height);
    emitSkirtQuad(
      { x: ax, z: az, rect: RECT_NONE },
      { x: bx, z: bz, rect: RECT_NONE },
      topY,
      topY - floorY,
      palettes.cliff[index],
      selfLitFor(index),
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
  /** Largest single polygon's V² — the adversarial-shape discriminator. */
  let maxPolygonWork = 0;
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
      const polygonWork = merged * merged;
      triangulationWork += polygonWork;
      if (polygonWork > maxPolygonWork) maxPolygonWork = polygonWork;
    }
    if (level.skirtDrop > 0) {
      // A bordered (underwater) riser is two stacked quads per segment — the
      // top-edge sliver and the face — so it counts 4 triangles where a land
      // cliff counts 2. Split-ness was decided once, in makeLevels, so this
      // count and the emission below cannot disagree.
      const trianglesPerSegment = level.skirtBorderColor !== null ? 4 : 2;
      for (const loop of level.loops) {
        for (let i = 0; i < loop.length; i++) {
          if (!isBorderSegment(loop[i], loop[(i + 1) % loop.length])) {
            skirtTriangles += trianglesPerSegment;
          }
        }
      }
    }
    // Either budget alone is enough to abandon the contour path: one bounds the
    // geometry (and the buffers behind it), the other the time it takes to make
    // it. Both are checked here, before any of the super-linear work runs.
    if (
      capTriangles + skirtTriangles > CHUNK_TRIANGLE_BUDGET ||
      triangulationWork > CHUNK_TRIANGULATION_WORK_BUDGET ||
      maxPolygonWork > CHUNK_POLYGON_WORK_BUDGET
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
        emitCapTriangle(a, b, c, level.capY, level.capColor, level.capSelfLit);
        capEmitted++;
      });
    }
    if (level.skirtDrop <= 0) continue;
    for (const loop of level.loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if (isBorderSegment(a, b)) continue;
        if (level.skirtBorderColor !== null) {
          // Underwater: the hairline top-edge border in the next band down's
          // tread colour, then the face — the band's own tread, lightened —
          // filling the rest of the drop. Same inset, same flag: one riser,
          // two colours, a crisp line where they meet.
          emitSkirtQuad(
            a,
            b,
            level.capY,
            SEABED_RISER_BORDER_WORLD_HEIGHT,
            level.skirtBorderColor,
            level.skirtSelfLit,
          );
          emitSkirtQuad(
            a,
            b,
            level.capY - SEABED_RISER_BORDER_WORLD_HEIGHT,
            level.skirtDrop - SEABED_RISER_BORDER_WORLD_HEIGHT,
            level.skirtColor,
            level.skirtSelfLit,
          );
          skirtEmitted += 4;
        } else {
          emitSkirtQuad(
            a,
            b,
            level.capY,
            level.skirtDrop,
            level.skirtColor,
            level.skirtSelfLit,
          );
          skirtEmitted += 2;
        }
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
    triangulationWork,
    maxPolygonWork,
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
  buffers.selfLit = grown.selfLit;
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
  const { positions, normals, colors, selfLit } = buffers;
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
    selfLit[v] = LIT_BY_SCENE;
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

