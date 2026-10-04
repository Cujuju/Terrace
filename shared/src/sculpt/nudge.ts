import { SMOOTH_LAYER_BAND_REACH } from '../constants.ts';
import { bandFloorHeight, drawnBandOfSample } from '../bands.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { encodeEdgeHeight } from './edges.ts';
import { footprintRadiusSquared, forEachFootprintOffset } from './footprint.ts';
import { graspedCeilingRange, layerSpanIndex } from './grasp.ts';
import { buildLayerView, commitLayerView } from './layerView.ts';
import { HOLE_FIELD, edgeUnits, signedDistance, traceBandOutlines } from './outlineField.ts';
import { OUTLINE_FIXED_POINT, traceLevel, type Point } from './outlineTrace.ts';

// Nudge stretches (spread) or squeezes (together) elevation about the brush centre's.
// In-band heights store edges, so elevation is read from outlines and traced back.

/** Strength is a percent of a full step. */
const STRENGTH_FULL = 100;

/** A full-strength dab at the centre moves elevation this percent of its way to or from the centre's. Past half, a squeeze overshoots the rim. */
const MAX_STRETCH_PCT = 50;
const STRETCH_FULL = 100;

/** Elevation works in 1/64 height units; edges are traced from it at the end. */
const WORK_FIXED_POINT = 64;

/** A tread's elevation ramps between its outlines; a cell farther than this from both sits mid-band. */
const TREAD_RAMP_CELLS = 4;

/** Cells past the footprint the window holds: the 3x3 bound, and outlines a cell's edge can reach. */
const WINDOW_MARGIN_CELLS = 2;

/** Cells past the footprint a nudge reads: its window plus the tread ramp traced around it. */
export const NUDGE_READ_MARGIN_CELLS = WINDOW_MARGIN_CELLS + TREAD_RAMP_CELLS;

interface NudgeCell {
  readonly x: number;
  readonly y: number;
  /** R² - d²: hand pressure, full at the centre and nothing at the rim. */
  readonly pressure: number;
  readonly lo: number;
  readonly hi: number;
}

/** num / den rounded half away from zero, den > 0. */
function roundedQuotient(num: number, den: number): number {
  return num >= 0 ? Math.trunc((2 * num + den) / (2 * den)) : -Math.trunc((-2 * num + den) / (2 * den));
}

/** Bands spanned by the window's heights, or null when it holds one band. */
function bandRange(x0: number, y0: number, x1: number, y1: number, bandAt: (x: number, y: number) => number | null): [number, number] | null {
  let low = Infinity;
  let high = -Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const band = bandAt(x, y);
      if (band === null) continue;
      if (band < low) low = band;
      if (band > high) high = band;
    }
  }
  return high > low ? [low, high] : null;
}
export function applyNudge(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spreading: boolean,
  strengthPct: number,
  spanBand: number | null,
  changed: Set<number>,
): void {
  const size = map.size;
  const reach = radius + WINDOW_MARGIN_CELLS;
  const traceReach = radius + NUDGE_READ_MARGIN_CELLS;
  const tx0 = Math.max(0, cx - traceReach);
  const ty0 = Math.max(0, cy - traceReach);
  const tx1 = Math.min(size - 1, cx + traceReach);
  const ty1 = Math.min(size - 1, cy + traceReach);
  const view = buildLayerView(map, spanBand, ty0, ty1, null);
  const heightAt = (x: number, y: number): number | null => {
    const k = y * size + x - view.base;
    return view.excluded[k] === 1 ? null : view.heights[k]!;
  };
  const before = bandRange(tx0, ty0, tx1, ty1, (x, y) => {
    const h = heightAt(x, y);
    return h === null ? null : drawnBandOfSample(h);
  });
  // One band throughout: no spacing to nudge.
  if (before === null) return;
  const outlines = traceBandOutlines(heightAt, before[0], before[1], tx0, ty0, tx1, ty1);

  // Elevation window: the footprint and its margin.
  const wx0 = Math.max(0, cx - reach);
  const wy0 = Math.max(0, cy - reach);
  const wx1 = Math.min(size - 1, cx + reach);
  const wy1 = Math.min(size - 1, cy + reach);
  const width = wx1 - wx0 + 1;
  const rampFixed = TREAD_RAMP_CELLS * OUTLINE_FIXED_POINT;
  const rampDistance = (band: number, px: number, py: number): number => {
    const lines = outlines.get(band);
    const d = lines === undefined ? null : signedDistance(lines, px, py);
    return d === null ? rampFixed : Math.min(rampFixed, Math.abs(d));
  };
  const work = new Int32Array((wy1 - wy0 + 1) * width);
  const hole = new Uint8Array(work.length);
  for (let y = wy0; y <= wy1; y++) {
    for (let x = wx0; x <= wx1; x++) {
      const w = (y - wy0) * width + (x - wx0);
      const h = heightAt(x, y);
      if (h === null) {
        hole[w] = 1;
        continue;
      }
      const band = drawnBandOfSample(h);
      const below = rampDistance(band, x * OUTLINE_FIXED_POINT, y * OUTLINE_FIXED_POINT);
      const above = rampDistance(band + 1, x * OUTLINE_FIXED_POINT, y * OUTLINE_FIXED_POINT);
      const floor = bandFloorHeight(band) * WORK_FIXED_POINT;
      const span = (bandFloorHeight(band + 1) - bandFloorHeight(band)) * WORK_FIXED_POINT;
      work[w] = floor + Math.floor((span * below) / (below + above || 1));
    }
  }

  const rimSquared = footprintRadiusSquared(radius);
  const cells: NudgeCell[] = [];
  forEachFootprintOffset(radius, (dx, dy) => {
    const x = cx + dx;
    const y = cy + dy;
    if (!inBounds(map, x, y)) return;
    const h = heightAt(x, y);
    if (h === null) return;
    // A wall above the grasped layer is another layer's ground: it votes but holds still.
    if (spanBand !== null && drawnBandOfSample(h) - spanBand > SMOOTH_LAYER_BAND_REACH) return;
    const i = cellIndex(map, x, y);
    const span = map.columnSpans.has(i) ? layerSpanIndex(map, i, spanBand) : 0;
    if (span === null) return;
    const { lo, hi } = graspedCeilingRange(map, i, span);
    cells.push({ x, y, pressure: rimSquared - (dx * dx + dy * dy), lo: lo * WORK_FIXED_POINT, hi: hi * WORK_FIXED_POINT });
  });

  const centre = (cy - wy0) * width + (cx - wx0);
  if (hole[centre] === 1) return;
  const pivot = work[centre]!;
  // A cell stays within its 3x3's elevations: no new peak or pit.
  const nudged = work.slice();
  const stretchDen = STRENGTH_FULL * STRETCH_FULL * rimSquared;
  for (const c of cells) {
    const w = (c.y - wy0) * width + (c.x - wx0);
    const here = work[w]!;
    let lowest = here;
    let highest = here;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (x < wx0 || x > wx1 || y < wy0 || y > wy1) continue;
        const n = (y - wy0) * width + (x - wx0);
        if (hole[n] === 1) continue;
        if (work[n]! < lowest) lowest = work[n]!;
        if (work[n]! > highest) highest = work[n]!;
      }
    }
    const stretch = strengthPct * MAX_STRETCH_PCT * c.pressure;
    let next = pivot + roundedQuotient((here - pivot) * (spreading ? stretchDen - stretch : stretchDen + stretch), stretchDen);
    if (next < lowest) next = lowest;
    if (next > highest) next = highest;
    if (next < c.lo) next = c.lo;
    if (next > c.hi) next = c.hi;
    nudged[w] = next;
  }
  work.set(nudged);
  // Trace the nudged elevation's outlines and store each footprint cell's distances to them.
  const workBand = (x: number, y: number): number | null => {
    const w = (y - wy0) * width + (x - wx0);
    return hole[w] === 1 ? null : drawnBandOfSample(Math.floor(work[w]! / WORK_FIXED_POINT));
  };
  const after = bandRange(wx0, wy0, wx1, wy1, workBand);
  if (after === null) return;
  const field = (x: number, y: number): number => {
    const w = (y - wy0) * width + (x - wx0);
    return hole[w] === 1 ? HOLE_FIELD : work[w]!;
  };
  const contours = new Map<number, Point[][]>();
  for (let band = after[0] + 1; band <= after[1]; band++) {
    contours.set(band, traceLevel(field, bandFloorHeight(band) * WORK_FIXED_POINT, wx0, wy0, wx1, wy1));
  }
  const distanceTo = (level: number, px: number, py: number): number | null =>
    level > after[0] && level <= after[1] ? signedDistance(contours.get(level)!, px, py) : null;
  for (const c of cells) {
    const band = workBand(c.x, c.y)!;
    const px = c.x * OUTLINE_FIXED_POINT;
    const py = c.y * OUTLINE_FIXED_POINT;
    const lowerD = distanceTo(band, px, py);
    const upperD = distanceTo(band + 1, px, py);
    const lower = edgeUnits(lowerD);
    const upper = edgeUnits(upperD);
    const h = heightAt(c.x, c.y)!;
    let next = encodeEdgeHeight(band, lower, upper);
    if (next < c.lo / WORK_FIXED_POINT) next = c.lo / WORK_FIXED_POINT;
    if (next > c.hi / WORK_FIXED_POINT) next = c.hi / WORK_FIXED_POINT;
    if (next === h || drawnBandOfSample(next) !== band) continue;
    view.heights[c.y * size + c.x - view.base] = next;
    changed.add(cellIndex(map, c.x, c.y));
  }
  commitLayerView(map, view, spanBand, changed);
}
