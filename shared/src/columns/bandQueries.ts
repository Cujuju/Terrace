import { bandFloorHeight, bandLevelHeight, drawnBandOfSample } from '../bands.ts';
import { type Heightmap } from '../grid.ts';
import {
  canonicaliseColumn,
  isGapDrawn,
  OPEN_COLUMN_SAMPLE,
  spanCapBand,
  spanCoversBand,
  type Span,
} from './span.ts';
import { moveSpanCeiling, readSpans, setColumn, spanAt, spanCount } from './store.ts';

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

export type BandFill =
  | { readonly kind: 'extend'; readonly spanIndex: number }
  | { readonly kind: 'overhang' };

/** The slab a band's own overhang lays: that one band, floored and capped in it. */
export function overhangSlabAtBand(band: number): Span {
  return { floorBand: band, ceiling: bandLevelHeight(band) };
}

export function bandFillAt(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): BandFill | null {
  const count = spanCount(map, x, y);
  let below: number | null = null;
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (spanCoversBand(span, band)) return null;
    if (spanCapBand(span) < band) below = k;
  }
  const firstAbove = below === null ? 0 : below + 1;
  if (firstAbove < count) {
    // A slab that welds to the ground under it is a filled carve, not a roof:
    // an overhang needs its own slab plus one of air to be seen under.
    const slab = overhangSlabAtBand(band);
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
  const slab = overhangSlabAtBand(drawnBandOfSample(ceiling));
  const spans = readSpans(map, x, y);
  let at = spans.length;
  for (let k = 0; k < spans.length; k++) {
    if (spans[k]!.floorBand > slab.floorBand) {
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
