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

// Player smooth: trace each band outline, simplify it within the kink tolerance,
// round the corners left, rebuild cells from distances to the result.

/** Rounds of corner cutting after simplification: each halves the corners left. */
const CORNER_CUT_ROUNDS = 2;

/** The outline is traced this many cells past the brush, so it runs pinned into the untouched ground. */
const TRACE_MARGIN_CELLS = 2;

/** Every cell past the brush a smooth reads, at the largest kink size. */
export const OUTLINE_SMOOTH_READ_MARGIN_CELLS = SMOOTH_KINK_HALF_CELLS_MAX + TRACE_MARGIN_CELLS;

function isClosed(line: readonly Point[]): boolean {
  return line.length > 2 && line[0]!.x === line[line.length - 1]!.x && line[0]!.y === line[line.length - 1]!.y;
}

function pointDistance(a: Point, b: Point): number {
  return Math.floor(Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)));
}

/** Fixed-point distance from p to the segment a–b. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const along = (p.x - a.x) * dx + (p.y - a.y) * dy;
  if (lengthSquared === 0 || along <= 0) return pointDistance(p, a);
  if (along >= lengthSquared) return pointDistance(p, b);
  return Math.trunc(Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.floor(Math.sqrt(lengthSquared)));
}

/** Douglas–Peucker between anchors (pinned vertices, line ends): the line left strays at most the tolerance from the traced one. */
function simplify(line: Point[], tolerance: number): Point[] {
  const closed = isClosed(line);
  const ring = closed ? line.slice(0, -1) : line;
  const n = ring.length;
  if (n < 3) return line;
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (ring[i]!.pinned) keep[i] = 1;
  if (!closed) {
    keep[0] = 1;
    keep[n - 1] = 1;
  } else if (!keep.includes(1)) {
    // A free loop anchors on its first vertex and the one farthest from it.
    let far = 0;
    for (let i = 1; i < n; i++) if (pointDistance(ring[i]!, ring[0]!) > pointDistance(ring[far]!, ring[0]!)) far = i;
    keep[0] = 1;
    keep[far] = 1;
  }
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) anchors.push(i);
  const spans: [number, number][] = [];
  for (let k = 0; k + 1 < anchors.length; k++) spans.push([anchors[k]!, anchors[k + 1]!]);
  if (closed) spans.push([anchors[anchors.length - 1]!, anchors[0]! + n]);
  while (spans.length > 0) {
    const [a, b] = spans.pop()!;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(ring[i % n]!, ring[a % n]!, ring[b % n]!);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst % n] = 1;
    spans.push([a, worst], [worst, b]);
  }
  const kept = ring.filter((_, i) => keep[i] === 1);
  if (closed) kept.push(kept[0]!);
  return kept;
}

/** The point `cut` along v→t, at most a quarter of the way (Chaikin's cut). */
function toward(v: Point, t: Point, maxCut: number): Point {
  const length = pointDistance(v, t);
  if (length === 0) return v;
  const cut = Math.min(Math.trunc(length / 4), maxCut);
  return { x: v.x + Math.trunc(((t.x - v.x) * cut) / length), y: v.y + Math.trunc(((t.y - v.y) * cut) / length), pinned: false };
}

/** Chaikin corner cutting at free vertices, each cut at most `maxCut` long so long segments keep their corners' place. */
function cutCorners(line: Point[], maxCut: number): Point[] {
  let current = line;
  for (let round = 0; round < CORNER_CUT_ROUNDS; round++) {
    const closed = isClosed(current);
    const ring = closed ? current.slice(0, -1) : current;
    const n = ring.length;
    if (n < 3) return current;
    const out: Point[] = [];
    for (let i = 0; i < n; i++) {
      const v = ring[i]!;
      if (v.pinned || (!closed && (i === 0 || i === n - 1))) {
        out.push(v);
        continue;
      }
      out.push(toward(v, ring[(i + n - 1) % n]!, maxCut), toward(v, ring[(i + 1) % n]!, maxCut));
    }
    if (closed) out.push(out[0]!);
    current = out;
  }
  return current;
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
  const extent = radius + kinkHalfCells + TRACE_MARGIN_CELLS;
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
  const tolerance = (kinkHalfCells * OUTLINE_FIXED_POINT) / 2;
  // Simplifying and cutting each move an outline at most the tolerance; a cell farther keeps its side.
  const reclassifyFixed = 2 * tolerance + OUTLINE_FIXED_POINT;

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
    smoothed.set(band, lines.map((line) => cutCorners(simplify(line, tolerance), tolerance)));
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
