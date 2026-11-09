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
  createOutlineDistanceQuery,
  createDroppedRingQuery,
  createNearestPointQuery,
  traceBandOutlines,
  vertexKey,
} from './outlineField.ts';
import { OUTLINE_FIXED_POINT, isClosedOutline as isClosed, type Point } from './outlineTrace.ts';
import { medianReachSamples, SAMPLE_FIXED, SAMPLES_PER_CELL, smoothLine } from './outlineMedian.ts';

function sameOutlines(a: readonly Point[][], b: readonly Point[][]): boolean {
  return a.length === b.length && a.every((line, k) => {
    const other = b[k]!;
    return line.length === other.length && line.every((p, i) => {
      const q = other[i]!;
      return p.x === q.x && p.y === q.y && p.pinned === q.pinned;
    });
  });
}

// Player smooth: trace each band outline, drop bumps narrower than about twice
// the kink with a median along it (wider arcs stay), rebuild cells.

/** A cell farther than the widest outvoted bump plus this keeps its side of the smoothed outline. */
const RECLASSIFY_MARGIN_CELLS = 1;

/** The outline is traced a cell past the farthest point a brush cell reclassifies by. */
const TRACE_MARGIN_CELLS = 1;

/** How far from a smoothed outline, in cells, a brush cell takes that outline's side. */
function reclassifyCells(kinkHalfCells: number): number {
  return Math.ceil(medianReachSamples(kinkHalfCells) / SAMPLES_PER_CELL) + RECLASSIFY_MARGIN_CELLS;
}

/** Cells past the brush a smooth reads; blurs never read past the pinned rim. */
function smoothReachCells(kinkHalfCells: number): number {
  return reclassifyCells(kinkHalfCells) + TRACE_MARGIN_CELLS;
}

/** Every cell past the brush a smooth reads, at the largest kink size. */
export const OUTLINE_SMOOTH_READ_MARGIN_CELLS = smoothReachCells(SMOOTH_KINK_HALF_CELLS_MAX);

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
  const partitioned = new Map<Point[][], { kept: Point[][]; gone: Point[][] }>();
  for (const [band, raw] of outlines) {
    const cached = partitioned.get(raw);
    if (cached !== undefined) {
      outlines.set(band, cached.kept);
      dropped.set(band, cached.gone);
      continue;
    }
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
    partitioned.set(raw, { kept, gone });
  }
  // Ascending, so an alt smooth can lay each level's shared wall on the level below's smoothed one.
  const smoothed = new Map<number, Point[][]>();
  const filtered = new Map<Point[][], Point[][]>();
  const projections = new Map<Point[][], (p: Point) => Point | null>();
  for (let band = lowBand + 1; band <= highBand; band++) {
    let lines = outlines.get(band)!;
    const below = smoothed.get(band - 1);
    if (walls && below !== undefined) {
      const shared = new Set(outlines.get(band - 1)!.flatMap((line) => line.map(vertexKey)));
      const project = projections.get(below) ?? createNearestPointQuery(below);
      projections.set(below, project);
      lines = lines.map((line) => line.map((p) => (shared.has(vertexKey(p)) ? (project(p) ?? p) : p)));
    }
    let result = filtered.get(lines);
    if (result === undefined) {
      result = lines.map((line) => smoothLine(line, kinkHalfCells));
      filtered.set(lines, result);
    }
    if (below !== undefined && sameOutlines(result, below)) result = below;
    smoothed.set(band, result);
  }
  outlines = smoothed;
  const queries = new Map<Point[][], (px: number, py: number) => number | null>();
  for (const lines of outlines.values()) {
    if (!queries.has(lines)) queries.set(lines, createOutlineDistanceQuery(lines, reclassifyFixed));
  }
  const droppedQueries = new Map<Point[][], (px: number, py: number) => boolean | null>();
  for (const rings of dropped.values()) {
    if (!droppedQueries.has(rings)) droppedQueries.set(rings, createDroppedRingQuery(rings));
  }

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
      const queried = new Map<Point[][], number | null>();
      for (let level = lowBand + 1; level <= highBand; level++) {
        const lines = outlines.get(level)!;
        const cached = queried.get(lines);
        const d = cached === undefined ? queries.get(lines)!(px, py) : cached;
        if (cached === undefined) queried.set(lines, d);
        distances.set(level, d);
        const reclassifies = d !== null && Math.abs(d) <= reclassifyFixed;
        // A dropped island's cells leave the level; a dropped hole's join it.
        const side = droppedQueries.get(dropped.get(level)!)!(px, py);
        const inside = side !== null ? side : reclassifies ? d >= 0 : band >= level;
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
