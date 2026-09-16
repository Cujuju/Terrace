import { BAND_HEIGHT, MAX_HEIGHT, MIN_HEIGHT } from '../constants.ts';
import {
  bandFloorHeight,
  bandLevelHeight,
  drawnBandOfSample,
  isHeightInBand,
} from '../bands.ts';

export const BEDROCK_FLOOR = MIN_HEIGHT;

export interface Span {
  readonly floor: number;
  readonly ceiling: number;
}

export const HEIGHT_UNIT = 1;

/**
 * Lowest ceiling a column can hold: one unit of bedrock always remains, so a
 * write that would cut to BEDROCK_FLOOR leaves this remnant instead.
 */
export const BEDROCK_REMNANT_CEILING = BEDROCK_FLOOR + HEIGHT_UNIT;

const BEDROCK_REMNANT: Span = { floor: BEDROCK_FLOOR, ceiling: BEDROCK_REMNANT_CEILING };

export const SPAN_STRIDE = 2;

/** Canonical drawn cap of a span: the write level of its ceiling's drawn band. */
export function spanCapHeight(span: Span): number {
  return bandLevelHeight(drawnBandOfSample(span.ceiling));
}

/** Lowest band whose write level is at or above `height`. */
function lowestBandAtOrAbove(height: number): number {
  const band = drawnBandOfSample(height);
  return bandLevelHeight(band) >= height ? band : band + 1;
}

/**
 * Lowest write level at or above a span's floor. A span is drawn exactly when
 * this clears its cap, which holds exactly when the span covers some band.
 */
export function spanLowestBandHeight(span: Span): number {
  return bandLevelHeight(lowestBandAtOrAbove(span.floor));
}

export function spanUndersideHeight(span: Span): number {
  return spanLowestBandHeight(span) - BAND_HEIGHT;
}

/**
 * Highest ceiling a span under `upper` may hold: below its floor, and low
 * enough that the gap still draws. `spanCapHeight` rounds up, so the underside
 * is not the limit.
 */
export function highestCeilingUnderSpan(upper: Span): number {
  const drawn = bandFloorHeight(lowestBandAtOrAbove(spanUndersideHeight(upper))) - 1;
  const physical = upper.floor - HEIGHT_UNIT;
  return drawn < physical ? drawn : physical;
}

export function isSpanDrawn(span: Span): boolean {
  return spanLowestBandHeight(span) <= spanCapHeight(span);
}

export function isGapDrawn(lower: Span, upper: Span): boolean {
  return spanUndersideHeight(upper) > spanCapHeight(lower);
}

export const OPEN_COLUMN_SAMPLE = BEDROCK_FLOOR - BAND_HEIGHT;

export function spansHaveCapAtBand(spans: readonly Span[], band: number): boolean {
  for (const span of spans) if (isHeightInBand(span.ceiling, band)) return true;
  return false;
}

export function canonicaliseColumn(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (let k = 0; k < spans.length; k++) {
    const span = spans[k]!;
    if (!isSpanDrawn(span)) continue;
    const last = out.length === 0 ? undefined : out[out.length - 1]!;
    if (last !== undefined && !isGapDrawn(last, span)) {
      out[out.length - 1] = { floor: last.floor, ceiling: span.ceiling };
      continue;
    }
    out.push(span);
  }
  if (out.length === 0) return [BEDROCK_REMNANT];
  // A column always floors at bedrock. Cutting the bottom span away leaves the
  // remnant under whatever still stands, never a span floating on nothing.
  const lowest = out[0]!;
  if (lowest.floor !== BEDROCK_FLOOR) {
    if (isGapDrawn(BEDROCK_REMNANT, lowest)) out.unshift(BEDROCK_REMNANT);
    else out[0] = { floor: BEDROCK_FLOOR, ceiling: lowest.ceiling };
  }
  return out;
}

export function parsePackedSpans(flat: readonly number[]): Span[] | null {
  if (flat.length % SPAN_STRIDE !== 0) return null;
  const count = flat.length / SPAN_STRIDE;
  if (count < 2) return null;
  const spans: Span[] = [];
  for (let k = 0; k < count; k++) {
    const floor = flat[k * SPAN_STRIDE]!;
    const ceiling = flat[k * SPAN_STRIDE + 1]!;
    if (!Number.isInteger(floor) || !Number.isInteger(ceiling)) return null;
    if (floor < MIN_HEIGHT || ceiling > MAX_HEIGHT) return null;
    if (floor >= ceiling) return null;
    if (k > 0 && spans[k - 1]!.ceiling >= floor) return null;
    spans.push({ floor, ceiling });
  }
  if (spans[0]!.floor !== BEDROCK_FLOOR) return null;
  return spans;
}
