import { SMOOTH_LAYER_BAND_REACH } from '../constants.ts';
import { bandFloorHeight, drawnBandField, drawnBandOfSample } from '../bands.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { EDGE_UNITS_PER_CELL, encodeEdgeHeight } from './edges.ts';
import { footprintRadiusSquared, isFootprintOffset } from './footprint.ts';
import { graspedCeilingRange, layerSpanIndex } from './grasp.ts';
import { buildLayerView, commitLayerView } from './layerView.ts';
import { SMOOTH_KINK_CELLS_MAX } from './options.ts';
import { OUTLINE_FIXED_POINT, traceLevel, type Field, type Point } from './outlineTrace.ts';

// Player smooth: trace each band outline, drop vertices smallest-first up to the
// kink size, cut the corners left, rebuild cells from distances to the result.

/** Rounds of corner cutting after simplification: each halves the corners left. */
const CORNER_CUT_ROUNDS = 2;

/** The outline is traced this many cells past the brush, so it runs pinned into the untouched ground. */
const TRACE_MARGIN_CELLS = 2;

/** Every cell past the brush a smooth reads, at the largest kink size. */
export const OUTLINE_SMOOTH_READ_MARGIN_CELLS = SMOOTH_KINK_CELLS_MAX + TRACE_MARGIN_CELLS;

/** Outside every level: an excluded column is a hole in the grasped layer. */
const HOLE_FIELD = -0x40000000;

/** Twice the triangle's area, in fixed-point units squared. */
function doubleArea(a: Point, b: Point, c: Point): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

/** Visvalingam–Whyatt: drop the smallest-area free vertex until every one left spans at least the threshold. */
function simplify(line: Point[], thresholdDoubleArea: number): Point[] {
  const kept = line.slice();
  const first = kept[0]!;
  const last = kept[kept.length - 1]!;
  const closed = kept.length > 2 && first.x === last.x && first.y === last.y;
  const minKept = closed ? 4 : 2;
  for (;;) {
    let best = -1;
    let bestArea = thresholdDoubleArea;
    for (let i = 1; i < kept.length - 1; i++) {
      if (kept[i]!.pinned) continue;
      const area = doubleArea(kept[i - 1]!, kept[i]!, kept[i + 1]!);
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    if (best < 0 || kept.length <= minKept) return kept;
    kept.splice(best, 1);
  }
}

/** Chaikin corner cutting at free vertices; pinned vertices and line ends stay put. */
function cutCorners(line: Point[]): Point[] {
  let current = line;
  for (let round = 0; round < CORNER_CUT_ROUNDS; round++) {
    const out: Point[] = [current[0]!];
    for (let i = 1; i < current.length - 1; i++) {
      const p = current[i - 1]!;
      const v = current[i]!;
      const n = current[i + 1]!;
      if (v.pinned) {
        out.push(v);
        continue;
      }
      out.push({ x: Math.trunc((p.x + 3 * v.x) / 4), y: Math.trunc((p.y + 3 * v.y) / 4), pinned: false });
      out.push({ x: Math.trunc((3 * v.x + n.x) / 4), y: Math.trunc((3 * v.y + n.y) / 4), pinned: false });
    }
    out.push(current[current.length - 1]!);
    current = out;
  }
  return current;
}

/** Inward normal of the segment a→b: the inside is on its positive-cross side. */
function normalOf(a: Point, b: Point): [number, number] {
  return [a.y - b.y, b.x - a.x];
}

/** Signed distance to the nearest outline point, positive inside; a vertex's side is its segments' summed unit normals. */
function signedDistance(lines: readonly Point[][], px: number, py: number): number | null {
  let bestSquared = Infinity;
  let bestSide = 0;
  for (const line of lines) {
    const closed = line.length > 2 && line[0]!.x === line[line.length - 1]!.x && line[0]!.y === line[line.length - 1]!.y;
    const vertexSide = (v: number): number => {
      const before = v > 0 ? v - 1 : closed ? line.length - 2 : -1;
      const after = v < line.length - 1 ? v + 1 : closed ? 1 : -1;
      let nx = 0;
      let ny = 0;
      if (before >= 0) {
        const [ux, uy] = normalOf(line[before]!, line[v]!);
        const length = Math.floor(Math.sqrt(ux * ux + uy * uy)) || 1;
        nx += Math.trunc((ux * OUTLINE_FIXED_POINT) / length);
        ny += Math.trunc((uy * OUTLINE_FIXED_POINT) / length);
      }
      if (after >= 0) {
        const [ux, uy] = normalOf(line[v]!, line[after]!);
        const length = Math.floor(Math.sqrt(ux * ux + uy * uy)) || 1;
        nx += Math.trunc((ux * OUTLINE_FIXED_POINT) / length);
        ny += Math.trunc((uy * OUTLINE_FIXED_POINT) / length);
      }
      return nx * (px - line[v]!.x) + ny * (py - line[v]!.y);
    };
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      const along = length === 0 ? 0 : Math.max(0, Math.min(length, (px - a.x) * dx + (py - a.y) * dy));
      const nx = length === 0 ? a.x : a.x + Math.trunc((dx * along) / length);
      const ny = length === 0 ? a.y : a.y + Math.trunc((dy * along) / length);
      const squared = (px - nx) * (px - nx) + (py - ny) * (py - ny);
      if (squared >= bestSquared) continue;
      bestSquared = squared;
      bestSide = along <= 0 ? vertexSide(i - 1) : along >= length ? vertexSide(i) : dx * (py - a.y) - dy * (px - a.x);
    }
  }
  if (bestSquared === Infinity) return null;
  const distance = Math.floor(Math.sqrt(bestSquared));
  return bestSide >= 0 ? distance : -distance;
}

export function applyOutlineSmooth(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  kinkCells: number,
  spanBand: number | null,
  changed: Set<number>,
): void {
  const size = map.size;
  const extent = radius + kinkCells + TRACE_MARGIN_CELLS;
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
  const threshold = kinkCells * kinkCells * OUTLINE_FIXED_POINT * OUTLINE_FIXED_POINT;
  const reclassifyFixed = (kinkCells + 1) * OUTLINE_FIXED_POINT;

  // Level b's outline, simplified, with the inside on each segment's positive-cross side.
  const outlines = new Map<number, Point[][]>();
  for (let band = lowBand + 1; band <= highBand; band++) {
    const field: Field = (x, y) => {
      const h = heightAt(x, y);
      return h === null ? HOLE_FIELD : drawnBandField(h, band);
    };
    const lines: Point[][] = [];
    for (const raw of traceLevel(field, bandFloorHeight(band), x0, y0, x1, y1)) {
      const pinnedLine = raw.map((p) => {
        const dx = p.x - cxFixed;
        const dy = p.y - cyFixed;
        return { x: p.x, y: p.y, pinned: dx * dx + dy * dy >= pinRadiusFixed * pinRadiusFixed };
      });
      lines.push(cutCorners(simplify(pinnedLine, threshold)));
    }
    outlines.set(band, lines);
  }

  const units = (distanceFixed: number | null): number => {
    if (distanceFixed === null) return EDGE_UNITS_PER_CELL;
    const u = Math.floor((Math.abs(distanceFixed) * EDGE_UNITS_PER_CELL + OUTLINE_FIXED_POINT / 2) / OUTLINE_FIXED_POINT);
    return u < EDGE_UNITS_PER_CELL ? u : EDGE_UNITS_PER_CELL;
  };

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
      let nextBand = lowBand;
      let nearEdge = false;
      const distances = new Map<number, number | null>();
      for (let level = lowBand + 1; level <= highBand; level++) {
        const d = signedDistance(outlines.get(level)!, px, py);
        distances.set(level, d);
        // Simplifying moves an outline at most the kink size: farther cells keep their side.
        const reclassifies = d !== null && Math.abs(d) <= reclassifyFixed;
        const inside = reclassifies ? d >= 0 : band >= level;
        if (inside) nextBand = level;
        if (d !== null && Math.abs(d) < OUTLINE_FIXED_POINT) nearEdge = true;
      }
      if (nextBand === band && !nearEdge) continue;
      const i = cellIndex(map, x, y);
      const span = map.columnSpans.has(i) ? layerSpanIndex(map, i, spanBand) : 0;
      if (span === null) continue;
      const lower = nextBand > lowBand ? units(distances.get(nextBand) ?? null) : EDGE_UNITS_PER_CELL;
      const upper = nextBand < highBand ? units(distances.get(nextBand + 1) ?? null) : EDGE_UNITS_PER_CELL;
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
