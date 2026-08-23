// Contour extraction — pipeline step 1 of vertexGrid.ts's overview (marching
// squares over the raw heightmap) plus the assembly of the marched segments
// into closed loops. Split out of vertexGrid.ts (issue #10); that file remains
// the facade and holds the pipeline overview, the honesty invariant and seam
// contracts S1–S5, which this code implements — nothing here may change
// independently of that record.

import { BAND_HEIGHT, CHUNK_SIZE, MAX_BRUSH_RADIUS } from '@terrace/shared';
import { sampleRenderHeight, type TerrainMirror } from './mirror.ts';

// ---------------------------------------------------------------------------
// Tuning constants. Every one of them is a shape decision, so every one is
// named and argued. (The emission-side constants live in capEmission.ts, the
// smoothing ones in contourSmoothing.ts — each beside the code it tunes.)
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

// ---------------------------------------------------------------------------
// Contour extraction
// ---------------------------------------------------------------------------

/** Which of the chunk domain's four borders a point lies on (bitmask). */
export const RECT_NONE = 0;
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
export interface ContourPoint {
  x: number;
  z: number;
  rect: number;
}

export type ContourLoop = ContourPoint[];

// --- per-write scratch, module-scoped and reused ---------------------------
//
// Rebuilding a chunk allocates the contour polylines themselves (a few hundred
// small objects), which is fine — the no-allocation rule in terrainMeshes.ts is
// about GPU buffers and typed arrays, not about a few kilobytes of short-lived
// JS objects eight times a second. The fixed-size lattice and edge tables below
// are still reused, because they are the ones touched per LEVEL rather than per
// chunk.

/**
 * Cells across the largest lattice this module ever marches.
 *
 * A CHUNK is one client; the brush-outline preview (render/brushPreview.ts) is
 * the other, and since the 2026-08-21 re-sample its square is the bigger of
 * the two: the widest brush reaches MAX_BRUSH_RADIUS cells, which is four
 * world units of ground sampled four times as finely, while a chunk is now
 * four world units TOTAL (shared's CHUNK_SPAN). The scratch below is sized for
 * whichever is larger, and every pass marches `activeSpan` — the span the
 * current load set — so a chunk pass never reads a sample the preview left
 * behind.
 *
 * The preview's square is a footprint disc of diameter 2·MAX_BRUSH_RADIUS,
 * centred with one cell of clear lattice on each side (brushPreview.ts's
 * FOOTPRINT_LATTICE_MARGIN_CELLS), hence the +2.
 */
export const MAX_LATTICE_SPAN = Math.max(CHUNK_SIZE, 2 * MAX_BRUSH_RADIUS + 2);
const MAX_LATTICE_PER_SPAN = MAX_LATTICE_SPAN + 1;

/**
 * The span every marching pass below uses, in cells — set by `loadSamples`
 * (a chunk) or `loadSampleField` (whatever the caller is contouring), and read
 * by everything downstream. It is module state for the same reason the sample
 * lattice is: this pipeline is one synchronous load → march → assemble run at
 * a time, and its precondition is documented on both loaders.
 */
let activeSpan = CHUNK_SIZE;
let activeLattice = LATTICE_PER_CHUNK;

/**
 * Samples one CHUNK's lattice holds — what a chunk-marching caller iterates.
 *
 * Deliberately NOT the array's length: the scratch is allocated for the
 * largest span this module can be asked to march (see MAX_LATTICE_SPAN), and a
 * caller that walked the whole allocation would read whatever the last, wider
 * pass left behind. capEmission.ts scans exactly this many.
 */
export const SAMPLE_COUNT = LATTICE_PER_CHUNK * LATTICE_PER_CHUNK;
const SAMPLE_CAPACITY = MAX_LATTICE_PER_SPAN * MAX_LATTICE_PER_SPAN;
export const samples = new Int32Array(SAMPLE_CAPACITY);

/** Horizontal lattice edge (i,j)→(i+1,j): i ∈ [0,span−1], j ∈ [0,span]. */
const H_EDGE_COUNT = MAX_LATTICE_SPAN * MAX_LATTICE_PER_SPAN;
/** Vertical lattice edge (i,j)→(i,j+1): i ∈ [0,span], j ∈ [0,span−1]. */
const V_EDGE_COUNT = MAX_LATTICE_PER_SPAN * MAX_LATTICE_SPAN;
const EDGE_COUNT = H_EDGE_COUNT + V_EDGE_COUNT;
/** Two segments per dual square is the marching-squares maximum (saddles). */
const MAX_SEGMENTS = 2 * MAX_LATTICE_SPAN * MAX_LATTICE_SPAN;

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
 * world border needs no special case, because the sampler clamps there.
 *
 * Read through `sampleRenderHeight`, not raw `sampleHeight` (issue #22): a
 * sample falling in a never-received chunk is pulled back onto received
 * terrain, so the frontier extends flat like the world border instead of
 * contouring a cliff against a phantom sea-level neighbour. The pull-back is a
 * pure function of the world position and the received set (see its doc), so
 * S1/S3 hold unchanged between received chunks.
 */
export function loadSamples(mirror: TerrainMirror, originX: number, originZ: number): void {
  activeSpan = CHUNK_SIZE;
  activeLattice = LATTICE_PER_CHUNK;
  for (let j = 0; j < activeLattice; j++) {
    for (let i = 0; i < activeLattice; i++) {
      samples[j * activeLattice + i] = sampleRenderHeight(
        mirror,
        originX + i,
        originZ + j,
      );
    }
  }
}

/**
 * Loads the lattice from an arbitrary field rather than the terrain mirror, so
 * a caller with something other than a chunk to contour can use this same
 * marching-squares pipeline instead of writing a second one.
 *
 * Its one client today is the brush-outline preview
 * (render/brushPreview.ts), which marches the brush footprint as a binary
 * in/out field: the outline the player sees is then built by the code that
 * builds the terrain, which is the only way the two can be guaranteed to speak
 * one shape language.
 *
 * PRECONDITION, shared with `loadSamples`: the lattice and the edge tables
 * below are module scratch, reused per level and per chunk. A caller must run
 * loadSampleField → marchLevel → assembleLoops to completion before anyone
 * else touches them. That holds today because everything here is synchronous
 * and the preview builds its geometries once, at startup, before the first
 * chunk mesh exists.
 */
export function loadSampleField(
  fill: (i: number, j: number) => number,
  span: number = CHUNK_SIZE,
): void {
  if (span < 1 || span > MAX_LATTICE_SPAN) {
    throw new RangeError(`lattice span ${span} outside [1, ${MAX_LATTICE_SPAN}]`);
  }
  activeSpan = span;
  activeLattice = span + 1;
  for (let j = 0; j < activeLattice; j++) {
    for (let i = 0; i < activeLattice; i++) {
      samples[j * activeLattice + i] = fill(i, j);
    }
  }
}

const horizontalEdgeKey = (i: number, j: number): number => j * MAX_LATTICE_SPAN + i;
const verticalEdgeKey = (i: number, j: number): number =>
  H_EDGE_COUNT + j * MAX_LATTICE_PER_SPAN + i;

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
export function marchLevel(
  threshold: number,
  originX: number,
  originZ: number,
  crossingOverride: number | null,
): number {
  segmentLeaving.fill(-1);
  edgeHasEntry.fill(0);
  edgeCrossed.fill(0);

  const inside = (i: number, j: number): boolean =>
    samples[j * activeLattice + i] >= threshold;
  const heightAt = (i: number, j: number): number =>
    samples[j * activeLattice + i];

  // Crossings, one pass over every lattice edge. Each edge has at most one
  // crossing for a given threshold (the field is linear along it).
  for (let j = 0; j < activeLattice; j++) {
    for (let i = 0; i < activeSpan; i++) {
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
  for (let j = 0; j < activeSpan; j++) {
    for (let i = 0; i < activeLattice; i++) {
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
  for (let j = 0; j < activeSpan; j++) {
    for (let i = 0; i < activeSpan; i++) {
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
  if (x === x0 + activeSpan) mask |= RECT_EAST;
  if (z === z0) mask |= RECT_NORTH;
  if (z === z0 + activeSpan) mask |= RECT_SOUTH;
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
  const s = activeSpan;
  if ((p.rect & RECT_NORTH) !== 0 && (p.rect & RECT_EAST) === 0) return p.x - x0;
  if ((p.rect & RECT_EAST) !== 0 && (p.rect & RECT_SOUTH) === 0) return s + (p.z - z0);
  if ((p.rect & RECT_SOUTH) !== 0 && (p.rect & RECT_WEST) === 0) {
    return 2 * s + (x0 + s - p.x);
  }
  return 3 * s + (z0 + s - p.z);
}

/** The four domain corners, in the same counter-clockwise order. */
function rectCorners(x0: number, z0: number): ContourPoint[] {
  const s = activeSpan;
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
export function assembleLoops(
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
  const cornerPerimeter = corners.map((c, index) => index * activeSpan);
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
  const perimeter = 4 * activeSpan;
  const gap = to - from;
  return gap > 0 ? gap : gap + perimeter;
}

export function samePoint(a: ContourPoint, b: ContourPoint): boolean {
  return a.x === b.x && a.z === b.z;
}
