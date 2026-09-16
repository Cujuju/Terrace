import { MAX_HEIGHT, MIN_HEIGHT } from '../constants.ts';
import {
  bandFloorHeight,
  bandLevelHeight,
  drawnBandOfSample,
  isHeightInBand,
} from '../bands.ts';

export const BEDROCK_FLOOR = MIN_HEIGHT;

/** The band every column floors in: the drawn band of the lowest height the world holds. */
export const BEDROCK_BAND = drawnBandOfSample(BEDROCK_FLOOR);

/**
 * A slab of solid material: floor in bands, so undersides are exact; ceiling
 * raw, because that is the walkable surface the world samples.
 */
export interface Span {
  readonly floorBand: number;
  readonly ceiling: number;
}

/** Packed as [floorBand, ceiling] per span. */
export const SPAN_STRIDE = 2;

/** A column carved to nothing keeps its bedrock band and no more. */
const BEDROCK_FLOOR_SPAN: Span = { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR };

/** Topmost band a span draws. The ground's own rounding rule, applied to the ceiling. */
export function spanCapBand(span: Span): number {
  return drawnBandOfSample(span.ceiling);
}

/** Canonical write level of a span's top drawn band. */
export function spanCapHeight(span: Span): number {
  return bandLevelHeight(spanCapBand(span));
}

/** Exact underside of a span: the write level of the band below its floor. */
export function spanUndersideLevel(span: Span): number {
  return bandLevelHeight(span.floorBand - 1);
}

/**
 * Highest ceiling a span under `upper` may hold. Band `floorBand - 1` carries
 * `upper`'s underside, so a span below must cap beneath that band.
 */
export function highestCeilingUnderSpan(upper: Span): number {
  return bandFloorHeight(upper.floorBand - 1) - 1;
}

export function isSpanDrawn(span: Span): boolean {
  return span.floorBand <= spanCapBand(span);
}

/** The raw range a ceiling may sit in. The writer, the parser and the repair all ask here. */
export function isCeilingInRange(ceiling: number): boolean {
  return ceiling >= BEDROCK_FLOOR && ceiling <= MAX_HEIGHT;
}

/**
 * The band a slab standing on `height` floors in: the lowest whose write level
 * clears it. This is how a raw floor from an old save is read.
 */
export function floorBandOfHeight(height: number): number {
  const band = drawnBandOfSample(height);
  return bandLevelHeight(band) >= height ? band : band + 1;
}

export function spanCoversBand(span: Span, band: number): boolean {
  return span.floorBand <= band && band <= spanCapBand(span);
}

/** `upper` rests straight on `lower`: no band of air between them, so no underside shows. */
export function spansAdjacent(lower: Span, upper: Span): boolean {
  return upper.floorBand === spanCapBand(lower) + 1;
}

/** At least one whole band of air separates them, which is what seeing under `upper` needs. */
export function isGapDrawn(lower: Span, upper: Span): boolean {
  return upper.floorBand > spanCapBand(lower) + 1;
}

/** Sample for a column holding no material at a band: below every ceiling it can hold. */
export const OPEN_COLUMN_SAMPLE = bandLevelHeight(BEDROCK_BAND - 1);

export function spansHaveCapAtBand(spans: readonly Span[], band: number): boolean {
  for (const span of spans) if (isHeightInBand(span.ceiling, band)) return true;
  return false;
}

/**
 * Repairs a column into one `setColumn` accepts. Refuses what repair cannot
 * mean: an out-of-range ceiling, or spans that do not ascend.
 */
export function canonicaliseColumn(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (let k = 0; k < spans.length; k++) {
    const span = spans[k]!;
    if (!isCeilingInRange(span.ceiling)) {
      throw new RangeError(
        `span ${k} caps at ${span.ceiling}, outside [${BEDROCK_FLOOR}, ${MAX_HEIGHT}]`,
      );
    }
    const below = k === 0 ? undefined : spans[k - 1]!;
    if (below !== undefined && span.floorBand <= below.floorBand) {
      throw new RangeError(
        `span ${k} floors in band ${span.floorBand}, not above span ${k - 1}'s band ` +
          `${below.floorBand} — a column is repaired in place, never sorted`,
      );
    }
    if (!isSpanDrawn(span)) continue;
    const last = out.length === 0 ? undefined : out[out.length - 1]!;
    if (last !== undefined && !isGapDrawn(last, span)) {
      out[out.length - 1] = {
        floorBand: last.floorBand,
        ceiling: last.ceiling > span.ceiling ? last.ceiling : span.ceiling,
      };
      continue;
    }
    out.push(span);
  }
  if (out.length === 0) return [BEDROCK_FLOOR_SPAN];
  // A column always floors at bedrock. Cutting the bottom span away leaves the
  // bedrock band under whatever still stands, never a span floating on nothing.
  const lowest = out[0]!;
  if (lowest.floorBand !== BEDROCK_BAND) {
    if (isGapDrawn(BEDROCK_FLOOR_SPAN, lowest)) out.unshift(BEDROCK_FLOOR_SPAN);
    else out[0] = { floorBand: BEDROCK_BAND, ceiling: lowest.ceiling };
  }
  return out;
}

export function parsePackedSpans(flat: readonly number[]): Span[] | null {
  if (flat.length % SPAN_STRIDE !== 0) return null;
  const count = flat.length / SPAN_STRIDE;
  if (count < 2) return null;
  const spans: Span[] = [];
  for (let k = 0; k < count; k++) {
    const floorBand = flat[k * SPAN_STRIDE]!;
    const ceiling = flat[k * SPAN_STRIDE + 1]!;
    if (!Number.isInteger(floorBand) || !Number.isInteger(ceiling)) return null;
    if (floorBand < BEDROCK_BAND) return null;
    if (!isCeilingInRange(ceiling)) return null;
    const span: Span = { floorBand, ceiling };
    if (!isSpanDrawn(span)) return null;
    if (k > 0 && !isGapDrawn(spans[k - 1]!, span)) return null;
    spans.push(span);
  }
  if (spans[0]!.floorBand !== BEDROCK_BAND) return null;
  return spans;
}
