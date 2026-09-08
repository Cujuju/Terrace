import {
  BAND_HEIGHT,
  DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  RELAX_SLACK,
  SEA_LEVEL,
  SMOOTH_PASS_LIMIT,
  SOFT_APRON_MAX_BANDS,
  SOFT_APRON_TREAD_CELLS,
  WORLD_UNIT_CELLS,
} from './constants.ts';

export {
  bandOf,
  cellIndex,
  cellX,
  cellY,
  chebyshevDistance,
  createHeightmap,
  forEachLineCell,
  inBounds,
  quantizeToBand,
  type Heightmap,
} from './grid.ts';

import {
  anyColumnLayered,
  applyBandFill,
  bandFillAt,
  BEDROCK_FLOOR,
  canCarveBandAt,
  canSpreadBandToSpan,
  carveKeepsSpanCap,
  carveRange,
  columnCoversBand,
  highestCeilingBelow,
  isSpanDrawn,
  moveSpanCeiling,
  readSpans,
  spanAt,
  spanCount,
  spanIndexCoveringBand,
  spanLowestBandHeight,
  spanUndersideHeight,
  spansHaveCapAtBand,
  type Span,
} from './columns.ts';
import {
  bandOf,
  cellIndex,
  cellX,
  cellY,
  forEachLineCell,
  inBounds,
  quantizeToBand,
  type Heightmap,
} from './grid.ts';

export interface CellDiff {
  x: number;
  y: number;
  h: number;
  spans?: number[];
}

export function heightAt(map: Heightmap, x: number, y: number): number {
  return map.cells[cellIndex(map, x, y)];
}

export function isWater(h: number): boolean {
  return h <= SEA_LEVEL;
}

export const MIN_BAND = bandOf(MIN_HEIGHT);
export const MAX_BAND = bandOf(MAX_HEIGHT);

export const FULL_HEIGHT_SPAN = MAX_HEIGHT - MIN_HEIGHT;

function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

export type SculptTool = 'stamp' | 'smooth' | 'drag' | 'carve';

export type SculptProfile = 'soft' | 'hard';

export const SCULPT_TOOLS: readonly SculptTool[] = ['stamp', 'smooth', 'drag', 'carve'];

export const TOOLS_WITHOUT_EDGE_PROFILE: readonly SculptTool[] = ['drag', 'carve'];

export const TOOLS_WITHOUT_DIRECTION: readonly SculptTool[] = ['carve'];

export const CARVE_BANDS_PER_STROKE = 2;

export const SCULPT_PROFILES: readonly SculptProfile[] = ['soft', 'hard'];

export type SculptSpill = 'banded' | 'free';

export type SculptAnchor = 'clicked' | 'free' | 'band';

export function canSpreadBandTo(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): boolean {
  return canSpreadBandToSpan(map, cx, cy, band);
}

function graspedSpanIndex(map: Heightmap, i: number, spanBand: number | null): number | null {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  if (spanBand === null) return spanCount(map, x, y) - 1;
  return spanIndexCoveringBand(map, x, y, spanBand);
}

function layerSpanIndex(map: Heightmap, i: number, spanBand: number | null): number | null {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  const top = spanCount(map, x, y) - 1;
  if (spanBand === null) return top;
  const k = spanIndexCoveringBand(map, x, y, spanBand);
  if (k !== null) return k;
  return spanBand * BAND_HEIGHT > spanAt(map, x, y, top).ceiling ? top : null;
}

function graspedCeiling(map: Heightmap, i: number, k: number): number {
  return spanAt(map, cellX(map.size, i), cellY(map.size, i), k).ceiling;
}

function writeGraspedCeiling(map: Heightmap, i: number, k: number, ceiling: number): void {
  moveSpanCeiling(map, cellX(map.size, i), cellY(map.size, i), k, ceiling);
}

export interface SculptOptions {
  readonly tool?: SculptTool;
  readonly profile?: SculptProfile;
  readonly spill?: SculptSpill;
  readonly anchor?: SculptAnchor;
  readonly targetBand?: number | null;
  readonly spanBand?: number | null;
  readonly sweepFrom?: SweepOrigin | null;
}

export interface SweepOrigin {
  readonly x: number;
  readonly y: number;
}

export interface ResolvedSculptOptions {
  readonly tool: SculptTool;
  readonly profile: SculptProfile;
  readonly spill: SculptSpill;
  readonly anchor: SculptAnchor;
  readonly targetBand: number | null;
  readonly spanBand: number | null;
  readonly sweepFrom: SweepOrigin | null;
}

export const LIBRARY_DEFAULT_SCULPT_OPTIONS: ResolvedSculptOptions = {
  tool: 'smooth',
  profile: 'soft',
  spill: 'free',
  anchor: 'free',
  targetBand: null,
  spanBand: null,
  sweepFrom: null,
};

export function forEachFootprintOffset(
  radius: number,
  visit: (dx: number, dy: number, dist: number) => void,
): void {
  if (radius === 1) {
    visit(0, 0, 0);
    return;
  }
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      if (!isFootprintOffset(radius, dx, dy)) continue;
      visit(dx, dy, Math.floor(Math.sqrt(dx * dx + dy * dy)));
    }
  }
}

function isFootprintOffset(radius: number, dx: number, dy: number): boolean {
  if (radius === 1) return dx === 0 && dy === 0;
  return dx * dx + dy * dy < radius * (radius - 1);
}

function forEachFootprintCell(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  visit: (i: number, dist: number) => void,
): void {
  forEachFootprintOffset(radius, (dx, dy, dist) => {
    const x = cx + dx;
    const y = cy + dy;
    if (!inBounds(map, x, y)) return;
    visit(cellIndex(map, x, y), dist);
  });
}

function brushDelta(
  amount: number,
  radius: number,
  dist: number,
  profile: SculptProfile,
): number {
  return profile === 'hard' ? amount : Math.trunc((amount * (radius - dist)) / radius);
}

function spreadableFootprintCells(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  band: number,
): ReadonlySet<number> {
  const spreadable = new Set<number>();
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    if (canSpreadBandTo(map, cellX(map.size, i), cellY(map.size, i), band)) spreadable.add(i);
  });
  return spreadable;
}

function assertBrushRadius(radius: number): void {
  if (
    !Number.isInteger(radius) ||
    radius < MIN_BRUSH_RADIUS ||
    radius > MAX_BRUSH_RADIUS
  ) {
    throw new RangeError(`brush radius ${radius} outside [${MIN_BRUSH_RADIUS}, ${MAX_BRUSH_RADIUS}]`);
  }
}

function assertBrushArgs(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
): void {
  if (!inBounds(map, cx, cy)) {
    throw new RangeError(`brush center (${cx},${cy}) out of bounds`);
  }
  assertBrushRadius(radius);
  if (!Number.isInteger(amount)) {
    throw new RangeError(`brush amount must be an integer, got ${amount}`);
  }
}

function anchoredTargetHeight(
  map: Heightmap,
  cx: number,
  cy: number,
  raising: boolean,
  targetBand: number | null = null,
  spanBand: number | null = null,
): number {
  if (targetBand !== null) return clampHeight(targetBand * BAND_HEIGHT);
  const centre = cellIndex(map, cx, cy);
  const k = graspedSpanIndex(map, centre, spanBand);
  const here = k === null ? map.cells[centre]! : graspedCeiling(map, centre, k);
  return clampHeight((bandOf(here) + (raising ? 1 : -1)) * BAND_HEIGHT);
}

export function applyBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  profile: SculptProfile = LIBRARY_DEFAULT_SCULPT_OPTIONS.profile,
  anchor: SculptAnchor = LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor,
  targetBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
): void {
  assertBrushArgs(map, cx, cy, radius, amount);

  let spreadable: ReadonlySet<number> | null = null;
  if (anchor === 'band') {
    if (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand)) return;
    spreadable = spreadableFootprintCells(map, cx, cy, radius, targetBand);
  }

  const raising = amount > 0;
  const anchored = anchor !== 'free' && amount !== 0;
  const target = anchored ? anchoredTargetHeight(map, cx, cy, raising, targetBand, spanBand) : 0;

  forEachFootprintCell(map, cx, cy, radius, (i, dist) => {
    if (spreadable !== null && !spreadable.has(i)) return;
    const delta = brushDelta(amount, radius, dist, profile);
    if (delta === 0) return;
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const before = graspedCeiling(map, i, k);
    if (anchored && (raising ? before >= target : before <= target)) return;
    let moved = before + delta;
    if (anchored) {
      moved = raising
        ? moved > target ? target : moved
        : moved < target ? target : moved;
    }
    const h = clampHeight(moved);
    if (h !== before) {
      writeGraspedCeiling(map, i, k, h);
      changed.add(i);
    }
  });
}

export function applyLevelFillBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  anchor: SculptAnchor = LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor,
  targetBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
): void {
  assertBrushArgs(map, cx, cy, radius, amount);
  if (amount === 0) return;

  let spreadable: ReadonlySet<number> | null = null;
  if (anchor === 'band') {
    if (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand)) return;
    spreadable = spreadableFootprintCells(map, cx, cy, radius, targetBand);
  }

  const raising = amount > 0;

  if (anchor !== 'free') {
    const targetHeight = anchoredTargetHeight(map, cx, cy, raising, targetBand, spanBand);
    fillTowardTarget(
      map, cx, cy, radius, amount, changed, raising, targetHeight, spanBand, spreadable,
    );
    return;
  }

  let extremeBand = 0;
  {
    let surveyed = false;
    forEachFootprintCell(map, cx, cy, radius, (i) => {
      const k = graspedSpanIndex(map, i, spanBand);
      if (k === null) return;
      const band = bandOf(graspedCeiling(map, i, k));
      if (!surveyed) {
        extremeBand = band;
        surveyed = true;
        return;
      }
      if (raising ? band < extremeBand : band > extremeBand) extremeBand = band;
    });
    if (!surveyed) return;
  }

  const targetHeight = clampHeight((extremeBand + (raising ? 1 : -1)) * BAND_HEIGHT);
  fillTowardTarget(map, cx, cy, radius, amount, changed, raising, targetHeight, spanBand);
}

export function sculptSweepRadius(
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
  anchor: SculptAnchor,
): number {
  return profile === 'soft' && tool === 'stamp' && anchor === 'clicked'
    ? radius + softApronReachCells(radius)
    : radius;
}

export function softApronReachCells(radius: number): number {
  const capped = SOFT_APRON_MAX_BANDS * SOFT_APRON_TREAD_CELLS;
  const reach = 2 * radius;
  return reach < capped ? reach : capped;
}

export function softApronBandDrop(distPastCore: number): number {
  const band = Math.floor((distPastCore + SOFT_APRON_TREAD_CELLS - 1) / SOFT_APRON_TREAD_CELLS);
  return band < SOFT_APRON_MAX_BANDS ? band : SOFT_APRON_MAX_BANDS;
}

function applySoftApron(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  coreTarget: number,
  spanBand: number | null,
  changed: Set<number>,
): void {
  if (amount === 0) return;
  const raising = amount > 0;
  const reach = softApronReachCells(radius);
  forEachFootprintCell(map, cx, cy, sculptSweepRadius(radius, 'soft', 'stamp', 'clicked'), (i) => {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const dx = x - cx;
    const dy = y - cy;
    if (isFootprintOffset(radius, dx, dy)) return;
    let dist = reach;
    for (let d = 1; d < reach; d++) {
      if (isFootprintOffset(radius + d, dx, dy)) {
        dist = d;
        break;
      }
    }
    const target = clampHeight(
      coreTarget + (raising ? -1 : 1) * softApronBandDrop(dist) * BAND_HEIGHT,
    );
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const before = graspedCeiling(map, i, k);
    if (raising ? before >= target : before <= target) return;
    const moved = before + amount;
    const h = clampHeight(raising ? (moved > target ? target : moved) : (moved < target ? target : moved));
    if (h !== before) {
      writeGraspedCeiling(map, i, k, h);
      changed.add(i);
    }
  });
}

function fillTowardTarget(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  raising: boolean,
  targetHeight: number,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
  spreadable: ReadonlySet<number> | null = null,
): void {
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    if (spreadable !== null && !spreadable.has(i)) return;
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const h = graspedCeiling(map, i, k);
    if (raising ? h >= targetHeight : h <= targetHeight) return;
    const moved = h + amount;
    const next = raising
      ? moved > targetHeight ? targetHeight : moved
      : moved < targetHeight ? targetHeight : moved;
    const clamped = clampHeight(next);
    if (clamped !== h) {
      writeGraspedCeiling(map, i, k, clamped);
      changed.add(i);
    }
  });
}

const DRAG_TREAD_TOLERANCE_CELLS = 1;

function pushLowerLayers(
  map: Heightmap,
  raisedAtBand: number[],
  topBand: number,
  hadCapAtBandBefore: (index: number, band: number) => boolean,
  record: (index: number) => void,
  changed: Set<number>,
): void {
  const treadWasNear = (cx: number, cy: number, band: number): boolean => {
    for (let dy = -DRAG_TREAD_TOLERANCE_CELLS; dy <= DRAG_TREAD_TOLERANCE_CELLS; dy++) {
      for (let dx = -DRAG_TREAD_TOLERANCE_CELLS; dx <= DRAG_TREAD_TOLERANCE_CELLS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(map, x, y)) continue;
        if (hadCapAtBandBefore(cellIndex(map, x, y), band)) return true;
      }
    }
    return false;
  };

  const band = topBand - 1;
  if (band <= MIN_BAND || raisedAtBand.length === 0) return;
  const level = clampHeight(band * BAND_HEIGHT);

  const candidates: number[] = [];
  const seen = new Set<number>();
  for (const seed of raisedAtBand) {
    const sx = cellX(map.size, seed);
    const sy = cellY(map.size, seed);
    for (let dy = -DRAG_TREAD_TOLERANCE_CELLS; dy <= DRAG_TREAD_TOLERANCE_CELLS; dy++) {
      for (let dx = -DRAG_TREAD_TOLERANCE_CELLS; dx <= DRAG_TREAD_TOLERANCE_CELLS; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!inBounds(map, x, y)) continue;
        const i = cellIndex(map, x, y);
        if (seen.has(i)) continue;
        seen.add(i);
        if (columnCoversBand(map, x, y, band)) continue;
        if (!treadWasNear(x, y, band)) continue;
        candidates.push(i);
      }
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => a - b);

  let filledThisPass = true;
  while (filledThisPass) {
    filledThisPass = false;
    for (const i of candidates) {
      const x = cellX(map.size, i);
      const y = cellY(map.size, i);
      const fill = bandFillAt(map, x, y, band);
      if (fill === null || fill.kind !== 'extend') continue;
      if (!canSpreadBandTo(map, x, y, band)) continue;
      record(i);
      applyBandFill(map, x, y, fill, level);
      changed.add(i);
      filledThisPass = true;
    }
  }

}

const SOFT_DRAG_MIN_REACH = 0.45;

const SOFT_DRAG_LOBE_CELLS = WORLD_UNIT_CELLS;

const SOFT_DRAG_LOBE_SHARE = 0.65;

function hashCell(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function cellNoise(x: number, y: number): number {
  const lobe = hashCell(
    Math.floor(x / SOFT_DRAG_LOBE_CELLS),
    Math.floor(y / SOFT_DRAG_LOBE_CELLS),
  );
  return SOFT_DRAG_LOBE_SHARE * lobe + (1 - SOFT_DRAG_LOBE_SHARE) * hashCell(x, y);
}

function retreatHeightAt(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): number | null {
  const floor = band * BAND_HEIGHT;
  let best: number | null = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      const h = highestCeilingBelow(map, nx, ny, floor);
      if (h === null) continue;
      if (best === null || h > best) best = h;
    }
  }
  return best;
}

function admitRimEnclaves(
  map: Heightmap,
  targetBand: number,
  refused: Set<number>,
  inDisc: Set<number>,
  disc: number[],
): void {
  const alreadyAtBand = (x: number, y: number): boolean => {
    const k = spanIndexCoveringBand(map, x, y, targetBand);
    return k !== null && bandOf(spanAt(map, x, y, k).ceiling) === targetBand;
  };
  const passable = (x: number, y: number): boolean =>
    inBounds(map, x, y) && refused.has(cellIndex(map, x, y)) && !alreadyAtBand(x, y);

  const reached = new Set<number>();
  const stack: number[] = [];
  const seed = (x: number, y: number): void => {
    if (!passable(x, y)) return;
    const i = cellIndex(map, x, y);
    if (reached.has(i)) return;
    reached.add(i);
    stack.push(i);
  };
  const outside = (x: number, y: number): boolean => {
    if (!inBounds(map, x, y)) return true;
    const i = cellIndex(map, x, y);
    return !inDisc.has(i) && !refused.has(i);
  };
  for (const i of refused) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    if (outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1)) {
      seed(x, y);
    }
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    seed(x - 1, y);
    seed(x + 1, y);
    seed(x, y - 1);
    seed(x, y + 1);
  }
  for (const i of refused) {
    if (!reached.has(i)) disc.push(i);
  }
}

function applyDragRegion(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  raising: boolean,
  targetBand: number,
  profile: SculptProfile,
  sweepFrom: SweepOrigin | null,
  changed: Set<number>,
): void {
  const targetHeight = clampHeight(targetBand * BAND_HEIGHT);
  const ragged = profile === 'soft';

  const priorSpans = new Map<number, readonly Span[]>();
  const record = (i: number): void => {
    if (!priorSpans.has(i)) priorSpans.set(i, readSpans(map, cellX(map.size, i), cellY(map.size, i)));
  };
  const hadCapAtBandBefore = (i: number, band: number): boolean => {
    const prior = priorSpans.get(i);
    if (prior !== undefined) return spansHaveCapAtBand(prior, band);
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const count = spanCount(map, x, y);
    for (let k = 0; k < count; k++) {
      if (bandOf(spanAt(map, x, y, k).ceiling) === band) return true;
    }
    return false;
  };

  const disc: number[] = [];
  const inDisc = new Set<number>();
  const refused = new Set<number>();
  const sweepDisc = (sx: number, sy: number): void => {
    forEachFootprintOffset(radius, (dx, dy, dist) => {
      const x = sx + dx;
      const y = sy + dy;
      if (!inBounds(map, x, y)) return;
      const i = cellIndex(map, x, y);
      if (inDisc.has(i)) return;
      if (ragged && dist >= radius * (SOFT_DRAG_MIN_REACH + (1 - SOFT_DRAG_MIN_REACH) * cellNoise(x, y))) {
        refused.add(i);
        return;
      }
      refused.delete(i);
      inDisc.add(i);
      disc.push(i);
    });
  };
  if (sweepFrom === null) sweepDisc(cx, cy);
  else forEachLineCell(sweepFrom.x, sweepFrom.y, cx, cy, sweepDisc);
  if (refused.size > 0) admitRimEnclaves(map, targetBand, refused, inDisc, disc);

  if (!raising) {
    let cutThisPass = true;
    while (cutThisPass) {
      cutThisPass = false;
      for (const i of disc) {
        const x = cellX(map.size, i);
        const y = cellY(map.size, i);
        const k = spanIndexCoveringBand(map, x, y, targetBand);
        if (k === null) continue;
        const span = spanAt(map, x, y, k);
        if (bandOf(span.ceiling) < targetBand) continue;
        const ground = retreatHeightAt(map, x, y, targetBand);
        if (ground === null) continue;
        const exposed = Math.max(ground, (targetBand - 1) * BAND_HEIGHT);
        if (k > 0 && (exposed <= span.floor || !isSpanDrawn({ floor: span.floor, ceiling: exposed }))) {
          continue;
        }
        moveSpanCeiling(map, x, y, k, exposed);
        changed.add(i);
        cutThisPass = true;
      }
    }
    return;
  }

  const raised: number[] = [];
  let filledThisPass = true;
  while (filledThisPass) {
    filledThisPass = false;
    for (const i of disc) {
      const x = cellX(map.size, i);
      const y = cellY(map.size, i);
      const fill = bandFillAt(map, x, y, targetBand);
      if (fill === null) continue;
      if (!canSpreadBandTo(map, x, y, targetBand)) continue;
      record(i);
      applyBandFill(map, x, y, fill, targetHeight);
      changed.add(i);
      if (fill.kind === 'extend') raised.push(i);
      filledThisPass = true;
    }
  }

  if (raised.length > 0) pushLowerLayers(map, raised, targetBand, hadCapAtBandBefore, record, changed);
}

export function sculptDisplacementUnits(radius: number, tool: SculptTool): number {
  assertBrushRadius(radius);

  if (tool === 'carve') {
    let cells = 0;
    forEachFootprintOffset(radius, () => {
      cells++;
    });
    return cells * CARVE_BANDS_PER_STROKE * BAND_HEIGHT;
  }

  let cells = 0;
  forEachFootprintOffset(radius, () => {
    cells++;
  });
  const perCell =
    DEFAULT_SCULPT_AMOUNT < 0 ? -DEFAULT_SCULPT_AMOUNT : DEFAULT_SCULPT_AMOUNT;
  return cells * perCell;
}

interface SpillBand {
  readonly lo: number;
  readonly hi: number;
}

type SpillBoundsOf = (index: number) => SpillBand | null;

function movePair(
  cells: Int16Array,
  base: number,
  hiIdx: number,
  loIdx: number,
  e: number,
  boundsOf: SpillBoundsOf | null,
  spanCaps: ReadonlyMap<number, SpillBand> | null,
): boolean {
  const hi = hiIdx - base;
  const lo = loIdx - base;
  let drop = e >> 1;
  let rise = drop;
  if (boundsOf !== null || spanCaps !== null) {
    const hiBand = boundsOf === null ? null : boundsOf(hiIdx);
    const loBand = boundsOf === null ? null : boundsOf(loIdx);
    let dropCap = hiBand === null ? drop : Math.min(drop, cells[hi] - hiBand.lo);
    let riseCap = loBand === null ? rise : Math.min(rise, loBand.hi - cells[lo]);
    const hiSpan = spanCaps === null ? undefined : spanCaps.get(hiIdx);
    const loSpan = spanCaps === null ? undefined : spanCaps.get(loIdx);
    if (hiSpan !== undefined) dropCap = Math.min(dropCap, cells[hi] - hiSpan.lo);
    if (loSpan !== undefined) riseCap = Math.min(riseCap, loSpan.hi - cells[lo]);
    if (dropCap < drop || riseCap < rise) {
      const t = Math.min(dropCap, riseCap);
      if (t <= 0) return false;
      drop = t;
      rise = t;
    }
    if (drop === 0 && rise === 0) return false;
  }
  cells[hi] -= drop;
  cells[lo] += rise;
  return true;
}

function relaxPair(
  cells: Int16Array,
  base: number,
  i: number,
  j: number,
  changed: Set<number>,
  boundsOf: SpillBoundsOf | null,
  layer: LayerView | null,
): boolean {
  if (layer !== null && (layer.excluded[i - base] === 1 || layer.excluded[j - base] === 1)) return false;
  const spanCaps = layer === null ? null : layer.spanCaps;
  const d = cells[i - base] - cells[j - base];
  let moved = false;
  if (d > MAX_STEP + RELAX_SLACK) {
    moved = movePair(cells, base, i, j, d - MAX_STEP, boundsOf, spanCaps);
  } else if (d < -(MAX_STEP + RELAX_SLACK)) {
    moved = movePair(cells, base, j, i, -d - MAX_STEP, boundsOf, spanCaps);
  }
  if (moved) {
    changed.add(i);
    changed.add(j);
  }
  return moved;
}

interface LayerView {
  readonly heights: Int16Array;
  readonly excluded: Uint8Array;
  readonly spanCaps: ReadonlyMap<number, SpillBand>;
  readonly base: number;
  readonly firstRow: number;
  readonly lastRow: number;
}

const LAYER_VIEW_SLACK_ROWS = 8;

function buildLayerView(
  map: Heightmap,
  spanBand: number | null,
  firstRow: number,
  lastRow: number,
  previous: LayerView | null,
): LayerView {
  const base = firstRow * map.size;
  const end = (lastRow + 1) * map.size;
  const heights = map.cells.slice(base, end);
  const excluded = new Uint8Array(end - base);
  const spanCaps = new Map<number, SpillBand>();
  for (const i of map.columnSpans.keys()) {
    if (i < base || i >= end) continue;
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const k = layerSpanIndex(map, i, spanBand);
    if (k === null) {
      excluded[i - base] = 1;
      continue;
    }
    const span = spanAt(map, x, y, k);
    heights[i - base] = span.ceiling;
    const isTop = k === spanCount(map, x, y) - 1;
    spanCaps.set(i, {
      lo: spanLowestBandHeight(span),
      hi: isTop ? MAX_HEIGHT : spanUndersideHeight(spanAt(map, x, y, k + 1)) - 1,
    });
  }
  if (previous !== null) heights.set(previous.heights, previous.base - base);
  return { heights, excluded, spanCaps, base, firstRow, lastRow };
}

function commitLayerView(map: Heightmap, view: LayerView, spanBand: number | null, changed: ReadonlySet<number>): void {
  for (const i of changed) {
    const v = i - view.base;
    if (v < 0 || v >= view.heights.length) {
      throw new RangeError(`layer view does not cover changed cell ${i}`);
    }
    if (view.excluded[v] === 1) continue;
    if (!map.columnSpans.has(i)) {
      map.cells[i] = view.heights[v]!;
      continue;
    }
    const k = layerSpanIndex(map, i, spanBand);
    if (k === null) continue;
    moveSpanCeiling(map, cellX(map.size, i), cellY(map.size, i), k, view.heights[v]!);
  }
}

export function smooth(
  map: Heightmap,
  changed: Set<number>,
  bboxSeed?: ReadonlySet<number>,
  spillFree?: ReadonlySet<number>,
  anchorBounds?: ReadonlyMap<number, SpillBand>,
  spanBand: number | null = null,
): number {
  const seed = bboxSeed ?? changed;
  if (seed.size === 0) return 0;

  const { size } = map;
  let layer: LayerView | null = null;
  let cells: Int16Array = map.cells;
  let viewBase = 0;

  const rebuildLayerView = (previous: LayerView | null): void => {
    const slack = previous === null
      ? LAYER_VIEW_SLACK_ROWS
      : Math.max(LAYER_VIEW_SLACK_ROWS, previous.lastRow - previous.firstRow + 1);
    let first = minY;
    let last = maxY;
    if (previous === null) {
      for (const i of changed) {
        const y = cellY(size, i);
        if (y < first) first = y;
        if (y > last) last = y;
      }
    } else {
      if (previous.firstRow < first) first = previous.firstRow;
      if (previous.lastRow > last) last = previous.lastRow;
    }
    first = Math.max(0, first - slack);
    last = Math.min(size - 1, last + slack);
    layer = buildLayerView(map, spanBand, first, last, previous);
    cells = layer.heights;
    viewBase = layer.base;
  };

  const growLayerView = (): void => {
    if (layer === null) return;
    if (minY < layer.firstRow || maxY > layer.lastRow) rebuildLayerView(layer);
  };

  const adoptLayerView = (x0: number, y0: number, width: number, height: number): void => {
    if (layer !== null) return;
    if (spanBand === null && !anyColumnLayered(map, x0, y0, width, height)) return;
    rebuildLayerView(null);
  };

  let boundsOf: SpillBoundsOf | null = null;
  if (spillFree !== undefined || anchorBounds !== undefined) {
    const captured = new Map<number, SpillBand>();
    boundsOf = (index: number): SpillBand | null => {
      const anchored = anchorBounds?.get(index);
      if (anchored !== undefined) return anchored;
      if (spillFree === undefined || spillFree.has(index)) return null;
      let band = captured.get(index);
      if (band === undefined) {
        const lo = bandOf(cells[index - viewBase]) * BAND_HEIGHT;
        band = { lo, hi: lo + BAND_HEIGHT - 1 };
        captured.set(index, band);
      }
      return band;
    };
  }

  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (const i of seed) {
    const x = cellX(size, i);
    const y = cellY(size, i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  adoptLayerView(minX, minY, maxX - minX + 1, maxY - minY + 1);

  let adjustingPasses = 0;
  for (let pass = 0; pass < SMOOTH_PASS_LIMIT; pass++) {
    const heldMinX = minX, heldMinY = minY, heldMaxX = maxX, heldMaxY = maxY;
    if (minX > 0) minX--;
    if (minY > 0) minY--;
    if (maxX < size - 1) maxX++;
    if (maxY < size - 1) maxY++;

    growLayerView();

    if (minY < heldMinY) adoptLayerView(minX, minY, maxX - minX + 1, 1);
    if (maxY > heldMaxY) adoptLayerView(minX, maxY, maxX - minX + 1, 1);
    if (minX < heldMinX) adoptLayerView(minX, heldMinY, 1, heldMaxY - heldMinY + 1);
    if (maxX > heldMaxX) adoptLayerView(maxX, heldMinY, 1, heldMaxY - heldMinY + 1);

    let changedThisPass = false;

    for (let y = minY; y <= maxY; y++) {
      const row = y * size;
      for (let x = minX; x <= maxX; x++) {
        const i = row + x;
        if (x < maxX && relaxPair(cells, viewBase, i, i + 1, changed, boundsOf, layer)) changedThisPass = true;
        if (y < maxY && relaxPair(cells, viewBase, i, i + size, changed, boundsOf, layer)) changedThisPass = true;
      }
    }

    if (!changedThisPass) break;
    adjustingPasses++;
  }
  if (layer !== null) commitLayerView(map, layer, spanBand, changed);
  return adjustingPasses;
}

function diffOf(map: Heightmap, changed: Set<number>): CellDiff[] {
  const indices = Array.from(changed).sort((a, b) => a - b);
  const diff: CellDiff[] = [];
  for (const i of indices) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const packed = map.columnSpans.get(i);
    const h = map.cells[i]!;
    diff.push(packed === undefined ? { x, y, h } : { x, y, h, spans: Array.from(packed) });
  }
  return diff;
}

function applyCarve(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spanBand: number,
  changed: Set<number>,
): void {
  const lowestOpenedBand = spanBand;
  const highestOpenedBand = spanBand + CARVE_BANDS_PER_STROKE - 2;
  const lo = (lowestOpenedBand - 1) * BAND_HEIGHT;
  const hi = (highestOpenedBand + 1) * BAND_HEIGHT;

  if (lo <= BEDROCK_FLOOR) return;

  const admitted: number[] = [];
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    let overlaps = false;
    const count = spanCount(map, x, y);
    for (let k = 0; k < count; k++) {
      const span = spanAt(map, x, y, k);
      if (span.floor < hi && lo < span.ceiling) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) return;
    if (!carveKeepsSpanCap(map, x, y, lo, hi)) return;
    for (let band = lowestOpenedBand; band <= highestOpenedBand; band++) {
      if (!canCarveBandAt(map, x, y, band)) return;
    }
    admitted.push(i);
  });

  for (const i of admitted) {
    carveRange(map, cellX(map.size, i), cellY(map.size, i), lo, hi);
    changed.add(i);
  }
}

export function applySculpt(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  options?: SculptOptions,
): CellDiff[] {
  const tool = options?.tool ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.tool;
  const profile = options?.profile ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.profile;
  const spill = options?.spill ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.spill;
  const anchor = options?.anchor ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor;
  const targetBand = options?.targetBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand;
  const spanBand = options?.spanBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand;
  const sweepFrom = options?.sweepFrom ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.sweepFrom;

  if (spanBand !== null && spanIndexCoveringBand(map, cx, cy, spanBand) === null) {
    return [];
  }

  if (tool === 'carve') {
    const carveChanged = new Set<number>();
    if (spanBand !== null && amount < 0) {
      applyCarve(map, cx, cy, radius, spanBand, carveChanged);
    }
    return diffOf(map, carveChanged);
  }

  if (tool === 'drag') {
    const dragChanged = new Set<number>();
    if (targetBand !== null && amount !== 0) {
      applyDragRegion(map, cx, cy, radius, amount > 0, targetBand, profile, sweepFrom, dragChanged);
    }
    return diffOf(map, dragChanged);
  }

  if (anchor === 'band' && (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand))) {
    return [];
  }

  const strokeAmount =
    anchor === 'band' && amount !== 0
      ? (amount > 0 ? FULL_HEIGHT_SPAN : -FULL_HEIGHT_SPAN)
      : amount;

  const changed = new Set<number>();
  const anchoredSmooth = tool === 'smooth' && anchor !== 'free' && amount !== 0;
  const anchorTarget = anchoredSmooth
    ? anchoredTargetHeight(map, cx, cy, amount > 0, targetBand, spanBand)
    : 0;
  const softCore = profile === 'soft' && anchor === 'clicked' && tool === 'stamp';
  const skirtCoreTarget = softCore
    ? anchoredTargetHeight(map, cx, cy, strokeAmount > 0, targetBand, spanBand)
    : 0;
  if (profile === 'hard' || softCore) {
    applyLevelFillBrush(map, cx, cy, radius, strokeAmount, changed, anchor, targetBand, spanBand);
  } else {
    applyBrush(map, cx, cy, radius, strokeAmount, changed, profile, anchor, targetBand, spanBand);
  }
  if (softCore) {
    applySoftApron(map, cx, cy, radius, strokeAmount, skirtCoreTarget, spanBand, changed);
  }
  if (tool === 'smooth') {
    let footprint: Set<number> | undefined;
    if (changed.size === 0 || spill === 'banded' || anchoredSmooth) {
      const cells = new Set<number>();
      forEachFootprintCell(map, cx, cy, radius, (i) => cells.add(i));
      footprint = cells;
    }
    let anchorBounds: Map<number, SpillBand> | undefined;
    if (anchoredSmooth) {
      const raising = amount > 0;
      const clickedIndex = cellIndex(map, cx, cy);
      anchorBounds = new Map<number, SpillBand>();
      for (const i of footprint as Set<number>) {
        const k = layerSpanIndex(map, i, spanBand);
        if (k === null) continue;
        const h = graspedCeiling(map, i, k);
        if (raising ? h > anchorTarget : h < anchorTarget) {
          anchorBounds.set(i, { lo: h, hi: h });
        } else {
          anchorBounds.set(
            i,
            raising
              ? { lo: i === clickedIndex ? h : MIN_HEIGHT, hi: anchorTarget }
              : { lo: anchorTarget, hi: i === clickedIndex ? h : MAX_HEIGHT },
          );
        }
      }
    }
    smooth(
      map,
      changed,
      changed.size === 0 ? footprint : undefined,
      spill === 'banded' ? footprint : undefined,
      anchorBounds,
      spanBand,
    );
  }

  return diffOf(map, changed);
}
