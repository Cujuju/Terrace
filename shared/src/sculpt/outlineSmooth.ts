import { SMOOTH_LAYER_BAND_REACH } from '../constants.ts';
import { drawnBandOfSample } from '../bands.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { EDGE_UNITS_PER_CELL, encodeEdgeHeight } from './edges.ts';
import { footprintRadiusSquared, isFootprintOffset } from './footprint.ts';
import { graspedCeilingRange, layerSpanIndex } from './grasp.ts';
import { buildLayerView, commitLayerView } from './layerView.ts';
import { SMOOTH_KINK_HALF_CELLS_MAX } from './options.ts';
import { edgeUnits, nearestPoint, signedDistance, traceBandOutlines, vertexKey } from './outlineField.ts';
import { OUTLINE_FIXED_POINT, type Point } from './outlineTrace.ts';

// Player smooth: trace each band outline, low-pass it along its length so
// noise narrower than the kink size cancels and wider arcs stay, rebuild cells.

/** Outlines are resampled two points per cell, so the blur's reach is set in cells. */
const SAMPLES_PER_CELL = 2;
const SAMPLE_FIXED = OUTLINE_FIXED_POINT / SAMPLES_PER_CELL;

/** Blurred coordinates carry 16x precision, so repeated passes round nothing away. */
const BLUR_PRECISION = 16;

/**
 * The shrink-corrected blur (twice the blur less the blur twice) reaches three
 * sigmas each way per blur: sigma is half the kink, so 1.5 kinks in all.
 */
const BLUR_REACH_PER_KINK_HALF_CELL = 3 / 4;

/** The outline is traced this many cells past the blur's reach, so it runs pinned into untouched ground. */
const TRACE_MARGIN_CELLS = 2;

/** Cells past the brush a smooth at this kink size reads. */
function smoothReachCells(kinkHalfCells: number): number {
  return Math.ceil(kinkHalfCells * BLUR_REACH_PER_KINK_HALF_CELL) + TRACE_MARGIN_CELLS;
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

/**
 * Low-pass the line: twice the blur less the blur twice passes long waves
 * nearly untouched (arcs keep their radius) and cancels short ones.
 */
function lowPass(line: Point[], kinkHalfCells: number): Point[] {
  const closed = isClosed(line);
  const samples = resample(line);
  const n = samples.length;
  if (n < 3) return line;
  // Sigma is half the kink: kink/2 cells is kinkHalfCells samples, and variance passes/2.
  const passes = Math.ceil((kinkHalfCells * kinkHalfCells) / 2);
  const pinned = Uint8Array.from(samples, (p) => (p.pinned ? 1 : 0));
  const axis = (pick: (p: Point) => number): Int32Array => {
    const raw = Int32Array.from(samples, (p) => pick(p) * BLUR_PRECISION);
    const once = blur(raw, pinned, closed, passes);
    const twice = blur(once, pinned, closed, passes);
    return raw.map((v, i) => (pinned[i] === 1 ? v : 2 * once[i]! - twice[i]!));
  };
  const xs = axis((p) => p.x);
  const ys = axis((p) => p.y);
  const out = samples.map((p, i) => ({
    x: Math.floor((xs[i]! + BLUR_PRECISION / 2) / BLUR_PRECISION),
    y: Math.floor((ys[i]! + BLUR_PRECISION / 2) / BLUR_PRECISION),
    pinned: p.pinned,
  }));
  if (closed) out.push(out[0]!);
  return out;
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
  // A bump the blur removes is at most about the kink deep: a cell farther keeps its side.
  const reclassifyFixed = (kinkHalfCells + 1) * OUTLINE_FIXED_POINT;

  // Level b's outline, simplified, with the inside on each segment's positive-cross side.
  let outlines = traceBandOutlines(heightAt, lowBand, highBand, x0, y0, x1, y1);
  for (const [band, raw] of outlines) {
    outlines.set(band, raw.map((line) => line.map((p) => {
      const dx = p.x - cxFixed;
      const dy = p.y - cyFixed;
      return { x: p.x, y: p.y, pinned: dx * dx + dy * dy >= pinRadiusFixed * pinRadiusFixed };
    })));
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
    smoothed.set(band, lines.map((line) => lowPass(line, kinkHalfCells)));
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
        const inside = reclassifies ? d >= 0 : band >= level;
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
