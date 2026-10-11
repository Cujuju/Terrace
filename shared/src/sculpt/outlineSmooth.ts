import { SMOOTH_LAYER_BAND_REACH } from '../constants.ts';
import { drawnBandOfSample } from '../bands.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { EDGE_UNITS_PER_CELL, encodeEdgeHeight } from './edges.ts';
import { footprintRadiusSquared, isFootprintOffset } from './footprint.ts';
import { graspedCeilingRange, layerSpanIndex } from './grasp.ts';
import { buildLayerView, commitLayerView } from './layerView.ts';
import { SMOOTH_KINK_HALF_CELLS_MAX } from './options.ts';
import {
  edgeUnits,
  nearestPoint,
  ringArea,
  ringContains,
  signedDistance,
  traceBandOutlines,
  vertexKey,
} from './outlineField.ts';
import { OUTLINE_FIXED_POINT, type Point } from './outlineTrace.ts';

// Player smooth: trace each band outline, drop bumps narrower than about twice
// the kink with a median along it (wider arcs stay), rebuild cells.

/** Outlines are resampled two points per cell, so windows are set in cells. */
const SAMPLES_PER_CELL = 2;
const SAMPLE_FIXED = OUTLINE_FIXED_POINT / SAMPLES_PER_CELL;

/** Blurred coordinates carry 16x precision, so repeated passes round nothing away. */
const BLUR_PRECISION = 16;

/** The median reaches twice the kink each way, so a bump up to twice the kink wide is outvoted. */
const MEDIAN_REACH_KINKS = 2;

/** A cell farther than the widest outvoted bump plus this keeps its side of the smoothed outline. */
const RECLASSIFY_MARGIN_CELLS = 1;

/** The outline is traced a cell past the farthest point a brush cell reclassifies by. */
const TRACE_MARGIN_CELLS = 1;

/** Half the median window, in samples. */
function medianReachSamples(kinkHalfCells: number): number {
  return (MEDIAN_REACH_KINKS * kinkHalfCells * SAMPLES_PER_CELL) / 2;
}

/** How far from a smoothed outline, in cells, a brush cell takes that outline's side. */
function reclassifyCells(kinkHalfCells: number): number {
  return Math.ceil((MEDIAN_REACH_KINKS * kinkHalfCells) / 2) + RECLASSIFY_MARGIN_CELLS;
}

/** Cells past the brush a smooth reads; blurs never read past the pinned rim. */
function smoothReachCells(kinkHalfCells: number): number {
  return reclassifyCells(kinkHalfCells) + TRACE_MARGIN_CELLS;
}

/** Every cell past the brush a smooth reads, at the largest kink size. */
export const OUTLINE_SMOOTH_READ_MARGIN_CELLS = smoothReachCells(SMOOTH_KINK_HALF_CELLS_MAX);

function isClosed(line: readonly Point[]): boolean {
  return line.length > 2 && line[0]!.x === line[line.length - 1]!.x && line[0]!.y === line[line.length - 1]!.y;
}

/** Points every SAMPLE_FIXED along the line, on it; one is pinned when the stretch it falls in is. A closed ring comes back unclosed. */
function resample(line: Point[]): Point[] {
  const out: Point[] = [];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.floor(Math.sqrt(dx * dx + dy * dy));
    const pinned = a.pinned && b.pinned;
    for (; carry < length; carry += SAMPLE_FIXED) {
      out.push({ x: a.x + Math.trunc((dx * carry) / length), y: a.y + Math.trunc((dy * carry) / length), pinned: pinned || (carry === 0 && a.pinned) });
    }
    carry -= length;
  }
  if (!isClosed(line)) out.push(line[line.length - 1]!);
  return out;
}

/**
 * `passes` rounds of the [1 2 1] blur: a binomial kernel, variance passes / 2
 * samples². Pinned points hold; an open line's ends see themselves past the end.
 */
function blur(values: Int32Array, pinned: Uint8Array, closed: boolean, passes: number): Int32Array {
  const n = values.length;
  let current = values.slice();
  let next = new Int32Array(n);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      if (pinned[i] === 1) {
        next[i] = values[i]!;
        continue;
      }
      const before = i > 0 ? current[i - 1]! : closed ? current[n - 1]! : current[i]!;
      const after = i < n - 1 ? current[i + 1]! : closed ? current[0]! : current[i]!;
      next[i] = Math.floor((before + 2 * current[i]! + after + 2) / 4);
    }
    [current, next] = [next, current];
  }
  return current;
}

/** Blurred precision back to fixed-point outline units, rounded. */
function unblurred(v: number): number {
  return Math.floor((v + BLUR_PRECISION / 2) / BLUR_PRECISION);
}

/**
 * Each point takes the median of its neighbours' offsets from a wide low-pass:
 * a narrow bump is outvoted outright, while an arc's offsets vary smoothly and stay.
 */
function smoothLine(line: Point[], kinkHalfCells: number): Point[] {
  const closed = isClosed(line);
  const samples = resample(line);
  const n = samples.length;
  const pinned = Uint8Array.from(samples, (p) => (p.pinned ? 1 : 0));
  if (n < 3 || !pinned.includes(0)) return line;
  const reach = medianReachSamples(kinkHalfCells);
  // Twice the blur less the blur twice keeps arcs' radius; sigma is the median's reach, variance passes / 2.
  const passes = 2 * reach * reach;
  const reference = (raw: Int32Array): Int32Array => {
    const once = blur(raw, pinned, closed, passes);
    const twice = blur(once, pinned, closed, passes);
    return raw.map((v, i) => (pinned[i] === 1 ? v : 2 * once[i]! - twice[i]!));
  };
  const xs = Int32Array.from(samples, (p) => p.x * BLUR_PRECISION);
  const ys = Int32Array.from(samples, (p) => p.y * BLUR_PRECISION);
  const refX = reference(xs);
  const refY = reference(ys);

  // Each point's offset from the reference along its normal; pinned points sit on it.
  const normalX = new Int32Array(n);
  const normalY = new Int32Array(n);
  const normalLength = new Int32Array(n);
  const offsets = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const before = i > 0 ? i - 1 : closed ? n - 1 : i;
    const after = i < n - 1 ? i + 1 : closed ? 0 : i;
    const tx = refX[after]! - refX[before]!;
    const ty = refY[after]! - refY[before]!;
    const length = Math.floor(Math.sqrt(tx * tx + ty * ty));
    normalX[i] = -ty;
    normalY[i] = tx;
    normalLength[i] = length;
    if (length > 0) offsets[i] = Math.trunc(((xs[i]! - refX[i]!) * -ty + (ys[i]! - refY[i]!) * tx) / length);
  }

  // A ring's window stops short of meeting itself, so no sample votes twice.
  const span = closed ? Math.min(reach, (n - 1) >> 1) : reach;
  const window = new Int32Array(2 * span + 1);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (pinned[i] === 1) {
      out.push(samples[i]!);
      continue;
    }
    if (normalLength[i] === 0) {
      out.push({ x: unblurred(refX[i]!), y: unblurred(refY[i]!), pinned: false });
      continue;
    }
    let count = 0;
    for (let d = -span; d <= span; d++) {
      const j = i + d;
      if (closed) window[count++] = offsets[(j + n) % n]!;
      else if (j >= 0 && j < n) window[count++] = offsets[j]!;
    }
    const votes = window.subarray(0, count).sort();
    const median = votes[(count - 1) >> 1]!;
    const x = refX[i]! + Math.trunc((median * normalX[i]!) / normalLength[i]!);
    const y = refY[i]! + Math.trunc((median * normalY[i]!) / normalLength[i]!);
    out.push({ x: unblurred(x), y: unblurred(y), pinned: false });
  }
  if (closed) out.push(out[0]!);
  return out;
}

/** A ring wholly inside the brush, no wider than a bump the median outvotes, is one bump: it goes whole. */
function isOutvotedRing(line: readonly Point[], outvoteFixed: number): boolean {
  if (!isClosed(line) || line.some((p) => p.pinned)) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of line) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return maxX - minX <= outvoteFixed && maxY - minY <= outvoteFixed;
}

export function applyOutlineSmooth(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  kinkHalfCells: number,
  walls: boolean,
  spanBand: number | null,
  changed: Set<number>,
): void {
  const size = map.size;
  const extent = radius + smoothReachCells(kinkHalfCells);
  const x0 = Math.max(0, cx - extent);
  const y0 = Math.max(0, cy - extent);
  const x1 = Math.min(size - 1, cx + extent);
  const y1 = Math.min(size - 1, cy + extent);
  const view = buildLayerView(map, spanBand, y0, y1, null);
  const heightAt = (x: number, y: number): number | null => {
    const k = y * size + x - view.base;
    return view.excluded[k] === 1 ? null : view.heights[k]!;
  };

  let lowBand = Infinity;
  let highBand = -Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const h = heightAt(x, y);
      if (h === null) continue;
      const band = drawnBandOfSample(h);
      if (band < lowBand) lowBand = band;
      if (band > highBand) highBand = band;
    }
  }
  if (!(highBand > lowBand)) return;

  const rimSquared = footprintRadiusSquared(radius);
  const pinRadiusFixed = Math.floor(Math.sqrt(rimSquared * OUTLINE_FIXED_POINT * OUTLINE_FIXED_POINT));
  const cxFixed = cx * OUTLINE_FIXED_POINT;
  const cyFixed = cy * OUTLINE_FIXED_POINT;
  const reclassifyFixed = reclassifyCells(kinkHalfCells) * OUTLINE_FIXED_POINT;

  const outvoteFixed = medianReachSamples(kinkHalfCells) * SAMPLE_FIXED;

  // Level b's outline, the inside on each segment's positive-cross side; points past the rim are pinned.
  let outlines = traceBandOutlines(heightAt, lowBand, highBand, x0, y0, x1, y1);
  const dropped = new Map<number, Point[][]>();
  for (const [band, raw] of outlines) {
    const kept: Point[][] = [];
    const gone: Point[][] = [];
    for (const line of raw) {
      const pinnedLine = line.map((p) => {
        const dx = p.x - cxFixed;
        const dy = p.y - cyFixed;
        return { x: p.x, y: p.y, pinned: dx * dx + dy * dy >= pinRadiusFixed * pinRadiusFixed };
      });
      (isOutvotedRing(pinnedLine, outvoteFixed) ? gone : kept).push(pinnedLine);
    }
    outlines.set(band, kept);
    dropped.set(band, gone);
  }
  // Ascending, so an alt smooth can lay each level's shared wall on the level below's smoothed one.
  const smoothed = new Map<number, Point[][]>();
  for (let band = lowBand + 1; band <= highBand; band++) {
    let lines = outlines.get(band)!;
    const below = smoothed.get(band - 1);
    if (walls && below !== undefined) {
      const shared = new Set(outlines.get(band - 1)!.flatMap((line) => line.map(vertexKey)));
      lines = lines.map((line) => line.map((p) => (shared.has(vertexKey(p)) ? (nearestPoint(below, p) ?? p) : p)));
    }
    smoothed.set(band, lines.map((line) => smoothLine(line, kinkHalfCells)));
  }
  outlines = smoothed;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!isFootprintOffset(radius, dx, dy)) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(map, x, y)) continue;
      const h = heightAt(x, y);
      if (h === null) continue;
      const band = drawnBandOfSample(h);
      // A wall above the grasped layer is another layer's ground.
      if (spanBand !== null && band - spanBand > SMOOTH_LAYER_BAND_REACH) continue;
      const px = x * OUTLINE_FIXED_POINT;
      const py = y * OUTLINE_FIXED_POINT;
      // Up: the highest level the cell is inside. Down: the top of the unbroken run from the bottom.
      let up = lowBand;
      let down = lowBand;
      let unbroken = true;
      let nearEdge = false;
      const distances = new Map<number, number | null>();
      for (let level = lowBand + 1; level <= highBand; level++) {
        const d = signedDistance(outlines.get(level)!, px, py);
        distances.set(level, d);
        const reclassifies = d !== null && Math.abs(d) <= reclassifyFixed;
        // A dropped island's cells leave the level; a dropped hole's join it.
        const ring = dropped.get(level)!.find((r) => ringContains(r, px, py));
        const inside = ring !== undefined ? ringArea(ring) < 0 : reclassifies ? d >= 0 : band >= level;
        if (inside) up = level;
        if (inside && unbroken) down = level;
        else unbroken = false;
        if (d !== null && Math.abs(d) < OUTLINE_FIXED_POINT) nearEdge = true;
      }
      // Smoothed outlines that cross keep the cell's own band: no band eats into its neighbour.
      const nextBand = band < down ? down : band > up ? up : band;
      if (nextBand === band && !nearEdge) continue;
      const i = cellIndex(map, x, y);
      const span = map.columnSpans.has(i) ? layerSpanIndex(map, i, spanBand) : 0;
      if (span === null) continue;
      const lower = nextBand > lowBand ? edgeUnits(distances.get(nextBand) ?? null) : EDGE_UNITS_PER_CELL;
      const upper = nextBand < highBand ? edgeUnits(distances.get(nextBand + 1) ?? null) : EDGE_UNITS_PER_CELL;
      let next = encodeEdgeHeight(nextBand, lower, upper);
      const { lo, hi } = graspedCeilingRange(map, i, span);
      if (next < lo) next = lo;
      if (next > hi) next = hi;
      if (next === h || drawnBandOfSample(next) !== nextBand) continue;
      view.heights[y * size + x - view.base] = next;
      changed.add(i);
    }
  }
  commitLayerView(map, view, spanBand, changed);
}
