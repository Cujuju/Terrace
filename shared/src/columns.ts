// Columns: a cell is a LIST OF SOLID SPANS, not a single height.
//
// CRITICAL CODE — shared by server (authoritative) and client (prediction).
// See the determinism contract in constants.ts. Everything here is
// integer-only, and the one collection with an iteration order (the sparse
// side table below) is never iterated as part of any simulation — see
// "Determinism" at the bottom of this comment.
//
// THE MODEL (docs/DESIGN.md, "Decisions made 2026-08-24"). A column is an
// ascending list of solid spans `[floor, ceiling)`. An overhang is a span whose
// floor sits above its neighbour's ceiling; an arch is two spans with the
// opening between them; a cave is a connected region of those gaps. The world
// as it stands is the ONE-SPAN case `[BEDROCK_FLOOR, heightAt(x, y))`, which is
// why this is a widening of the type rather than a replacement of it.
//
// STORAGE — deliberately two-part, so the 99% case pays nothing:
//   * `map.cells[i]` still holds the CEILING OF THE TOPMOST SPAN. That is
//     exactly what `heightAt` has always returned — the walkable surface — so
//     every consumer that reads heights keeps working untouched.
//   * `map.columnSpans` is a sparse side table keyed by cell index, holding the
//     FULL span list of the rare column that has more than one, flattened
//     ascending as [floor0, ceiling0, floor1, ceiling1, ...]. A column absent
//     from the table has exactly one span, `[BEDROCK_FLOOR, cells[i])`.
// The last ceiling in a table entry therefore duplicates `cells[i]`. That
// redundancy is the point: it is what lets the whole existing codebase — the
// wire, persistence, rivers, pathing, the mesh — keep reading `cells` as it
// always has.
//
// DETERMINISM. `Map` iterates in insertion order, which two replicas can differ
// on even when they agree on every column. Nothing here iterates the table for
// anything but an error message, and nothing outside here may either: read it
// BY CELL INDEX, and walk the world in grid order when you need every column.

import { BAND_HEIGHT, MAX_HEIGHT, MIN_HEIGHT } from './constants.ts';
import { cellIndex, cellX, cellY, quantizeToBand, type Heightmap } from './heightmap.ts';

/**
 * The floor of the bottom span of an uncarved column — the bottom of the world,
 * so a one-span column is solid all the way down, which is what "the column is
 * treated as SOLID from its cap downward" (picking.ts) has always assumed.
 */
export const BEDROCK_FLOOR = MIN_HEIGHT;

/** Solid from `floor` up to but NOT including `ceiling`. Always floor < ceiling. */
export interface Span {
  readonly floor: number;
  readonly ceiling: number;
}

/** Flattened entries are [floor, ceiling] pairs; this is the stride. */
const SPAN_STRIDE = 2;

/** How many solid spans a column holds. One unless it has been carved. */
export function spanCount(map: Heightmap, x: number, y: number): number {
  const packed = map.columnSpans.get(cellIndex(map, x, y));
  return packed === undefined ? 1 : packed.length / SPAN_STRIDE;
}

/**
 * The `k`th span of a column, counting UPWARD from the bottom: 0 is the deepest
 * span, `spanCount - 1` is the one whose ceiling is the walkable surface.
 */
export function spanAt(map: Heightmap, x: number, y: number, k: number): Span {
  const i = cellIndex(map, x, y);
  const packed = map.columnSpans.get(i);
  if (packed === undefined) {
    if (k !== 0) {
      throw new RangeError(`cell (${x}, ${y}) has 1 span, asked for span ${k}`);
    }
    return { floor: BEDROCK_FLOOR, ceiling: map.cells[i]! };
  }
  if (!Number.isInteger(k) || k < 0 || k >= packed.length / SPAN_STRIDE) {
    throw new RangeError(
      `cell (${x}, ${y}) has ${packed.length / SPAN_STRIDE} spans, asked for span ${k}`,
    );
  }
  return { floor: packed[k * SPAN_STRIDE]!, ceiling: packed[k * SPAN_STRIDE + 1]! };
}

/** The span carrying the walkable surface: its ceiling is `heightAt(map, x, y)`. */
export function topSpan(map: Heightmap, x: number, y: number): Span {
  return spanAt(map, x, y, spanCount(map, x, y) - 1);
}

/**
 * Replaces a column's spans wholesale, keeping `cells[i]` — and so `heightAt`,
 * and so everything downstream of it — equal to the topmost ceiling.
 *
 * Rejects anything that is not in CANONICAL form: ascending, non-empty spans,
 * with a real gap between consecutive ones. Two spans that touch are one span,
 * and storing them either way would let two replicas hold the same world in two
 * different encodings — which the determinism contract does not allow.
 */
export function setColumn(map: Heightmap, x: number, y: number, spans: readonly Span[]): void {
  if (spans.length === 0) {
    throw new RangeError(`cell (${x}, ${y}) needs at least one solid span`);
  }
  for (let k = 0; k < spans.length; k++) {
    const { floor, ceiling } = spans[k]!;
    if (!Number.isInteger(floor) || !Number.isInteger(ceiling)) {
      throw new RangeError(`cell (${x}, ${y}) span ${k} [${floor}, ${ceiling}) is not integral`);
    }
    if (floor < MIN_HEIGHT || ceiling > MAX_HEIGHT) {
      throw new RangeError(
        `cell (${x}, ${y}) span ${k} [${floor}, ${ceiling}) leaves [${MIN_HEIGHT}, ${MAX_HEIGHT}]`,
      );
    }
    if (floor >= ceiling) {
      throw new RangeError(`cell (${x}, ${y}) span ${k} [${floor}, ${ceiling}) is empty`);
    }
    if (k > 0 && spans[k - 1]!.ceiling >= floor) {
      throw new RangeError(
        `cell (${x}, ${y}) span ${k} starts at ${floor}, which does not clear span ${k - 1} ` +
          `ending at ${spans[k - 1]!.ceiling} — spans must ascend with a gap between them`,
      );
    }
  }
  const i = cellIndex(map, x, y);
  map.cells[i] = spans[spans.length - 1]!.ceiling;
  if (spans.length === 1) {
    if (spans[0]!.floor !== BEDROCK_FLOOR) {
      throw new RangeError(
        `cell (${x}, ${y}) has one span floored at ${spans[0]!.floor}; a lone span floors at ` +
          `${BEDROCK_FLOOR} (a column standing on nothing needs the gap below it to be a span)`,
      );
    }
    map.columnSpans.delete(i);
    return;
  }
  const packed = new Int16Array(spans.length * SPAN_STRIDE);
  for (let k = 0; k < spans.length; k++) {
    packed[k * SPAN_STRIDE] = spans[k]!.floor;
    packed[k * SPAN_STRIDE + 1] = spans[k]!.ceiling;
  }
  map.columnSpans.set(i, packed);
}

/**
 * Returns every column in the rectangle to the one-span case, leaving `cells`
 * alone. What a bulk height write means: a payload that carries one height per
 * cell defines a column completely, so any span list it lands on is stale.
 */
export function resetColumns(
  map: Heightmap,
  x0: number,
  y0: number,
  width: number,
  height: number,
): void {
  if (map.columnSpans.size === 0) return;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      map.columnSpans.delete(cellIndex(map, x, y));
    }
  }
}

/** Returns the whole world to the one-span case (a snapshot restore, a rewind). */
export function clearColumns(map: Heightmap): void {
  map.columnSpans.clear();
}

/**
 * Throws unless every column in the world has exactly one span.
 *
 * The invariant the layered-column work holds while it is being built, and the
 * standing precondition of every path that carries one height per cell — the
 * wire, the snapshot, the thumbnail. O(1): the table is empty exactly when the
 * invariant holds, so this is a size check, not a sweep.
 */
export function assertSingleSpanWorld(map: Heightmap, context: string): void {
  if (map.columnSpans.size === 0) return;
  const first = map.columnSpans.keys().next().value as number;
  throw new Error(
    `${context}: ${map.columnSpans.size} column(s) hold more than one span — ` +
      `first at (${cellX(map.size, first)}, ${cellY(map.size, first)}). ` +
      `This path carries one height per cell and cannot express a layered column.`,
  );
}

// ---------------------------------------------------------------------------
// What a span looks like once it is DRAWN.
// ---------------------------------------------------------------------------
//
// The renderer is a stack of level sets: it asks "is this cell solid at band
// k?", so a span occupies whole bands, and its drawn extent is the band
// boundaries it reaches — not its exact floor and ceiling. Picking and the mesh
// builder must agree on that extent to the last unit or the player clicks one
// thing and sculpts another, so the rule lives here, once, in shared.

/**
 * The band cap a span is drawn with — its TOP surface, and for the topmost span
 * of a column exactly what the renderer has always drawn at `quantizeToBand(h)`.
 */
export function spanCapHeight(span: Span): number {
  return quantizeToBand(span.ceiling);
}

/**
 * The LOWEST band boundary a span reaches — the first threshold at or above its
 * floor, and the mirror image of `spanCapHeight`, which rounds the ceiling
 * down. A span is solid at exactly the bands from here up to its cap.
 */
export function spanLowestBandHeight(span: Span): number {
  const quantized = quantizeToBand(span.floor);
  return quantized === span.floor ? quantized : quantized + BAND_HEIGHT;
}

/**
 * The UNDERSIDE the renderer draws for a span — ONE BAND BELOW its lowest
 * filled band.
 *
 * Not a quirk: it is how the existing mesh already draws material. A band's cap
 * sits at its own threshold and its skirt hangs one band below, so the slab the
 * renderer draws for band k occupies [(k−1)·BAND_HEIGHT, k·BAND_HEIGHT] — cap
 * on top, skirt as the side wall. A span filling one band is therefore one band
 * thick, and the ceiling cap that closes it off is the bottom of that same
 * slab, which the band's own skirt already walls in. Rounding to the lowest
 * filled band instead would give a one-band roof no thickness at all, and its
 * cap and its underside the same Y to fight over.
 *
 * For an uncarved column this lands a band BELOW the bottom of the world, which
 * is exactly as unobservable as today's "solid from the cap downward".
 */
export function spanUndersideHeight(span: Span): number {
  return spanLowestBandHeight(span) - BAND_HEIGHT;
}

/**
 * Whether a span reaches a band boundary at all.
 *
 * A span thinner than a band that falls between two boundaries fills no level
 * set, so the renderer draws nothing for it — and picking must miss it for the
 * same reason, or the player would be able to click terrain that is not there.
 */
export function isSpanDrawn(span: Span): boolean {
  return spanLowestBandHeight(span) <= spanCapHeight(span);
}

// ---------------------------------------------------------------------------
// The question the renderer actually asks: "is this cell solid at band k?"
// ---------------------------------------------------------------------------

/**
 * A sample lower than any band threshold a world can have, for a column that is
 * OPEN at the band being asked about and has no solid span below it either.
 *
 * The marching pass classifies a sample as inside when it reaches the
 * threshold, so "open" has to be expressible as a height — and BEDROCK_FLOOR
 * itself will not do, because it IS the lowest threshold: a column open at the
 * bottom band would read as solid there.
 */
export const OPEN_COLUMN_SAMPLE = BEDROCK_FLOOR - BAND_HEIGHT;

/** Whether any span of this column fills band `band` — solid at that level. */
export function columnCoversBand(map: Heightmap, x: number, y: number, band: number): boolean {
  const threshold = band * BAND_HEIGHT;
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    // `floor <= threshold` rather than the span's lowest band: the threshold is
    // a band boundary, so the two say the same thing, and this says it in the
    // terms the span itself is stored in.
    if (span.floor <= threshold && threshold <= spanCapHeight(span)) return true;
  }
  return false;
}

/**
 * The HEIGHT the contour pass marches for one band — the number that answers
 * "solid at band k" through the same `sample >= threshold` test the renderer
 * has always used, and that interpolates against its neighbours to place the
 * crossing.
 *
 * Solid at the band: the ceiling of the span that fills it, so two neighbouring
 * columns interpolate their real heights and the outline keeps the organic
 * wander that is most of the terraced look.
 *
 * Open at the band: the ceiling of the highest span BELOW it — the surface a
 * ray would land on there — which is under the threshold by construction, so
 * the cell reads as outside and the crossing still has a real height to
 * interpolate toward.
 *
 * FOR A COLUMN OF ONE SPAN THIS IS `heightAt`, AT EVERY BAND. That is the
 * property the mesh builder's fast path rests on: while the world holds one
 * span per column, marching this field is marching exactly the field the
 * renderer marched before spans existed.
 */
export function columnSampleAtBand(map: Heightmap, x: number, y: number, band: number): number {
  const threshold = band * BAND_HEIGHT;
  const count = spanCount(map, x, y);
  let below = OPEN_COLUMN_SAMPLE;
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    if (span.floor <= threshold && threshold <= spanCapHeight(span)) return span.ceiling;
    if (spanCapHeight(span) < threshold) below = span.ceiling;
  }
  return below;
}

/**
 * Whether any column in the rectangle holds more than one span.
 *
 * The mesh builder's fast path: a chunk of plain columns is marched once, as it
 * always was, and only a chunk that actually carries a layer pays for a
 * per-band reload. O(1) while the world holds no layered column at all.
 */
export function anyColumnLayered(
  map: Heightmap,
  x0: number,
  y0: number,
  width: number,
  height: number,
): boolean {
  if (map.columnSpans.size === 0) return false;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      if (map.columnSpans.has(cellIndex(map, x, y))) return true;
    }
  }
  return false;
}
