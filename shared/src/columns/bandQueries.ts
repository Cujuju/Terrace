import { BAND_HEIGHT } from '../constants.ts';
import { bandFloorHeight, bandLevelHeight } from '../bands.ts';
import { type Heightmap } from '../grid.ts';
import {
  BEDROCK_FLOOR,
  canonicaliseColumn,
  HEIGHT_UNIT,
  isGapDrawn,
  isSpanDrawn,
  OPEN_COLUMN_SAMPLE,
  spanCapHeight,
  type Span,
} from './span.ts';
import { moveSpanCeiling, readSpans, setColumn, spanAt, spanCount } from './store.ts';

export function spanIndexCoveringBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): number | null {
  const threshold = bandLevelHeight(band);
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    if (span.floor <= threshold && threshold <= spanCapHeight(span)) return k;
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

export type BandFill =
  | { readonly kind: 'extend'; readonly spanIndex: number }
  | { readonly kind: 'overhang' };

/** The slab a band's own overhang lays: one band deep, hung clear of the boundary below it. */
export function overhangSlabAt(ceiling: number): Span | null {
  const floor = Math.max(BEDROCK_FLOOR, ceiling - BAND_HEIGHT + HEIGHT_UNIT);
  return floor >= ceiling ? null : { floor, ceiling };
}

export function bandFillAt(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): BandFill | null {
  // Drag-fill admission is material reach, not drawn coverage: skip only when
  // solid material already meets the write level. Drawn coverage stays
  // render-sense, for picking and carving.
  const threshold = bandLevelHeight(band);
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (span.floor <= threshold && threshold <= span.ceiling) return null;
  }
  let below: number | null = null;
  for (let k = 0; k < count; k++) {
    if (spanAt(map, x, y, k).ceiling < threshold) below = k;
  }
  const firstAbove = below === null ? 0 : below + 1;
  if (firstAbove < count) {
    // A slab that welds to the ground under it is a filled carve, not a roof:
    // one carve opens a single drawn band, which has no room for either.
    const slab = overhangSlabAt(threshold);
    if (slab === null) return null;
    if (below !== null && !isGapDrawn(spanAt(map, x, y, below), slab)) return null;
    return { kind: 'overhang' };
  }
  if (below === null) return null;
  return { kind: 'extend', spanIndex: below };
}

export function applyBandFill(
  map: Heightmap,
  x: number,
  y: number,
  fill: BandFill,
  ceiling: number,
): void {
  if (fill.kind === 'extend') {
    moveSpanCeiling(map, x, y, fill.spanIndex, ceiling);
    return;
  }
  const slab = overhangSlabAt(ceiling);
  if (slab === null) return;
  const { floor } = slab;
  const spans = readSpans(map, x, y);
  let at = spans.length;
  for (let k = 0; k < spans.length; k++) {
    if (spans[k]!.floor > floor) {
      at = k;
      break;
    }
  }
  spans.splice(at, 0, slab);
  setColumn(map, x, y, canonicaliseColumn(spans));
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
  const threshold = bandLevelHeight(band);
  const count = spanCount(map, x, y);
  let below = OPEN_COLUMN_SAMPLE;
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    if (span.floor <= threshold && threshold <= spanCapHeight(span)) return span.ceiling;
    if (span.ceiling < threshold) below = span.ceiling;
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
