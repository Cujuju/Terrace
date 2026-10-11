import { bandFloorHeight } from '../bands.ts';
import { type Heightmap } from '../grid.ts';
import {
  BEDROCK_BAND,
  canonicaliseColumn,
  isGapDrawn,
  isSpanDrawn,
  OPEN_COLUMN_SAMPLE,
  spanCapBand,
  spanCoversBand,
  type Span,
} from './span.ts';
import { readSpans, setColumn, spanAt, spanCount } from './store.ts';

export function spanIndexCoveringBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): number | null {
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    if (spanCoversBand(spanAt(map, x, y, k), band)) return k;
  }
  return null;
}

export function columnCoversBand(map: Heightmap, x: number, y: number, band: number): boolean {
  return spanIndexCoveringBand(map, x, y, band) !== null;
}

export function spanIndexBelowBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): number | null {
  if (columnCoversBand(map, x, y, band)) return null;
  const threshold = bandFloorHeight(band);
  let below: number | null = null;
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    if (spanAt(map, x, y, k).ceiling < threshold) below = k;
  }
  return below;
}

/**
 * Floor of the run down from `band`: solid to its span's floor, air to its
 * void's. Read in the GRABBED column only — see `overhangs.md`.
 */
export function runFloorBandAt(map: Heightmap, x: number, y: number, band: number): number {
  const count = spanCount(map, x, y);
  let capBelow: number | null = null;
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (spanCoversBand(span, band)) return span.floorBand;
    const cap = spanCapBand(span);
    if (cap < band) capBelow = cap;
  }
  return capBelow === null ? BEDROCK_BAND : capBelow + 1;
}

/** True when the column already holds every band of `[floorBand, band]`. */
export function columnHoldsRun(
  map: Heightmap,
  x: number,
  y: number,
  floorBand: number,
  band: number,
): boolean {
  const k = spanIndexCoveringBand(map, x, y, band);
  return k !== null && spanAt(map, x, y, k).floorBand <= floorBand;
}

/**
 * Welds `slab` in, absorbing every span it meets. One ordered pass, so the
 * result ascends without sorting — which `canonicaliseColumn` demands.
 */
function weldSlab(spans: readonly Span[], slab: Span): Span[] {
  const out: Span[] = [];
  let pending: Span | null = slab;
  for (const span of spans) {
    if (pending === null || isGapDrawn(span, pending)) {
      out.push(span);
      continue;
    }
    if (isGapDrawn(pending, span)) {
      out.push(pending);
      pending = null;
      out.push(span);
      continue;
    }
    pending = {
      floorBand: span.floorBand < pending.floorBand ? span.floorBand : pending.floorBand,
      ceiling: span.ceiling > pending.ceiling ? span.ceiling : pending.ceiling,
    };
  }
  if (pending !== null) out.push(pending);
  return out;
}

/**
 * Writes the run's slab into one cell, returning whether it changed. Nothing
 * inspects what is overhead; only an already-solid run refuses.
 */
export function fillBandRun(
  map: Heightmap,
  x: number,
  y: number,
  floorBand: number,
  band: number,
  ceiling: number,
): boolean {
  if (columnHoldsRun(map, x, y, floorBand, band)) return false;
  const slab: Span = { floorBand, ceiling };
  if (!isSpanDrawn(slab)) return false;
  setColumn(map, x, y, canonicaliseColumn(weldSlab(readSpans(map, x, y), slab)));
  return true;
}

export function highestCeilingBelow(
  map: Heightmap,
  x: number,
  y: number,
  threshold: number,
): number | null {
  let best: number | null = null;
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const { ceiling } = spanAt(map, x, y, k);
    if (ceiling < threshold) best = ceiling;
  }
  return best;
}

export function columnSampleAtBand(map: Heightmap, x: number, y: number, band: number): number {
  const count = spanCount(map, x, y);
  let below = OPEN_COLUMN_SAMPLE;
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (spanCoversBand(span, band)) return span.ceiling;
    if (spanCapBand(span) < band) below = span.ceiling;
  }
  return below;
}

export function canSpreadBandToSpan(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      if (columnCoversBand(map, nx, ny, band)) return true;
    }
  }
  return false;
}

export function canCarveBandAt(map: Heightmap, cx: number, cy: number, band: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      if (!columnCoversBand(map, nx, ny, band)) return true;
    }
  }
  return false;
}
