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
import { cellIndex, cellX, cellY, quantizeToBand, type Heightmap } from './grid.ts';

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

/**
 * Whether the renderer draws AIR between two consecutive spans of a column —
 * the mirror of `isSpanDrawn`, and so the rule that decides when two spans of
 * one column are really one span.
 *
 * A span's top surface is its cap and its bottom surface is its underside, so
 * the opening between `lower` and `upper` is the distance between those two,
 * and it exists on screen only when the underside sits STRICTLY ABOVE the cap.
 * Because the underside hangs one band below the lowest filled band (see
 * `spanUndersideHeight` for why the mesh has always drawn it there), an
 * opening of one band puts the roof's underside at exactly the height of the
 * floor's cap: no thickness, nothing drawn, and — since the picking march
 * gates on the same drawn extent — nothing clickable either. Two bands is the
 * first opening that is actually there.
 *
 * Worked through, at BAND_HEIGHT = 16, for a lower span capped at 0:
 *   upper floored at 16 (one band of air):  underside 16 − 16 =  0;  0 > 0 is false
 *   upper floored at 32 (two bands of air): underside 32 − 16 = 16; 16 > 0 is true
 * The threshold is therefore never written down as a number — it falls out of
 * `spanUndersideHeight`/`spanCapHeight` and follows a re-terrace for free.
 *
 * NOT YET CONFIRMED BY EYE (2026-08-24). The arithmetic above is derived from
 * those two functions as they are written; no one has yet carved a one-band
 * gap into a mound and looked at it. If a one-band gap ever proves visible,
 * this predicate is the thing to change — never its callers.
 */
export function isGapDrawn(lower: Span, upper: Span): boolean {
  return spanUndersideHeight(upper) > spanCapHeight(lower);
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

/**
 * WHICH span of this column fills band `band`, or `null` if the column is open
 * there — the one way a stroke is ever allowed to resolve "the span the player
 * has hold of".
 *
 * A span index is a position in a list whose length is server state: a carve by
 * another player between a pick and its apply shifts every index above it, so an
 * index that travelled over the wire would name a different span on each
 * replica. A BAND names a place in the world instead, and this re-derives the
 * span from the map that is actually there — the same argument `targetBand`
 * already rests on (protocol.ts).
 *
 * At most one span can answer: spans ascend with a drawn gap between them, so no
 * two of them reach the same band boundary. A span too thin to reach any
 * boundary (`!isSpanDrawn`) answers for no band at all — it cannot satisfy the
 * test below — which is what keeps this in step with the picking march, which
 * skips exactly those spans.
 */
export function spanIndexCoveringBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): number | null {
  const threshold = band * BAND_HEIGHT;
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    // `floor <= threshold` rather than the span's lowest band: the threshold is
    // a band boundary, so the two say the same thing, and this says it in the
    // terms the span itself is stored in.
    if (span.floor <= threshold && threshold <= spanCapHeight(span)) return k;
  }
  return null;
}

/**
 * Whether any span of this column fills band `band` — solid at that level.
 *
 * The same question `spanIndexCoveringBand` answers, asked without caring which
 * span it was, and phrased through it so the mesh and the sculpt tools can never
 * end up disagreeing about what "solid at band k" means.
 */
export function columnCoversBand(map: Heightmap, x: number, y: number, band: number): boolean {
  return spanIndexCoveringBand(map, x, y, band) !== null;
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

// ---------------------------------------------------------------------------
// The only two writers of a multi-span column.
// ---------------------------------------------------------------------------
//
// Every sculpt tool moves a surface, and on a layered column "the surface" is a
// choice: which span, and what happens to the ones above and below it. The two
// functions below are the whole answer, and they are the ONLY code in the repo
// that may write a column holding more than one span:
//
//   * `moveSpanCeiling` moves one span's ceiling and touches nothing else. It is
//     the only source of merges.
//   * `carveRange` removes a height range from a column. It is the only source
//     of splits — lowering a ceiling can shrink a span away, but it can never
//     divide one — which is what makes "where did this second span come from"
//     an answerable question.
//
// Both re-canonicalise through the one pass below and both end in `setColumn`,
// so the ascending-with-a-gap form is enforced in a single place and cannot be
// half-enforced in four tools. `setColumn` still THROWS on a column the model
// cannot express rather than repairing it quietly: a loud RangeError is what
// makes the invariant checkable, and two replicas that disagree about a column
// must diverge visibly rather than agree about a repair.
//
// Two such inexpressible results are reachable from here, both of them a column
// with nothing left at the bottom of the world: a carve that removes every
// span, and a carve or a collapse that leaves ONE span no longer standing on
// BEDROCK_FLOOR (the storage says a lone span is floored there, so a single
// floating span has no encoding). Neither can occur in play, because every
// column covers the world's bottom band — a span reaches down to BEDROCK_FLOOR
// unless something above it was carved first — so `canCarveBandAt` refuses that
// band on every cell in the world. Callers that reach past the sculpt tools are
// on notice: the RangeError is the contract.

/** A column's spans as a mutable array, ascending, for the passes below. */
function readSpans(map: Heightmap, x: number, y: number): Span[] {
  const count = spanCount(map, x, y);
  const spans: Span[] = [];
  for (let k = 0; k < count; k++) spans.push(spanAt(map, x, y, k));
  return spans;
}

/**
 * Puts an edited span list back into canonical form: ONE ascending pass that
 * drops what cannot be seen and merges what is not really two spans.
 *
 * Two rules, both of them this file's existing definition of what a span looks
 * like drawn rather than new policy:
 *
 * - NO INVISIBLE SOLID. A span too thin to reach a band boundary
 *   (`!isSpanDrawn`) is dropped. Keeping it would be honest to the arithmetic
 *   and dishonest to the player: `heightAt` would report material where the
 *   renderer draws none and the picking march refuses to hit — terrain you can
 *   see through and cannot touch. A cut that leaves such a sliver therefore
 *   consumes it instead.
 * - NO INVISIBLE AIR. A gap the renderer cannot draw (`!isGapDrawn`) is closed,
 *   and the merged span takes the UPPER span's ceiling: filling in under a roof
 *   cannot push the roof up. Two overlapping spans fail `isGapDrawn` too, so
 *   this is also what performs an ordinary merge; and because the pass keeps
 *   comparing against the span it has just merged into, a fill that reaches
 *   through three spans welds all three in one call.
 *
 * Both rules only ever make spans taller or fewer, so one pass reaches the
 * fixed point: a merge cannot un-draw a span, and a drop cannot un-draw the gap
 * that swallows it.
 */
function canonicaliseColumn(spans: readonly Span[]): Span[] {
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
  return out;
}

/**
 * Moves span `k`'s ceiling to `newCeiling`, leaving every other span of the
 * column byte-untouched.
 *
 * That second clause is the point of the whole span model: the report this work
 * answers (#99) was that pulling on one layer dragged the layers below it out
 * with it, and a primitive that can only write one span's ceiling makes that
 * impossible rather than merely unlikely.
 *
 * The span's FLOOR never moves — a raise adds material on top of the span it
 * has hold of, whichever way the camera happens to be looking at it. Two
 * consequences fall out of the canonical form rather than being decided here:
 *
 * - Raising into the span above merges the two (`canonicaliseColumn`), and the
 *   merged ceiling is the upper span's, so a ceiling raised past a roof does
 *   not carry the roof up with it.
 * - `newCeiling` at or below the span's own floor empties it, and an emptied
 *   span is REMOVED — its opening joins the one below it. The bottom span
 *   floors at BEDROCK_FLOOR, so lowering it digs toward the bottom of the world
 *   exactly as an unlayered column always has.
 *
 * On a column of one span this is `map.cells[i] = newCeiling` and nothing else,
 * which is what keeps sculpting ordinary ground identical to what it was.
 */
export function moveSpanCeiling(
  map: Heightmap,
  x: number,
  y: number,
  k: number,
  newCeiling: number,
): void {
  const spans = readSpans(map, x, y);
  if (!Number.isInteger(k) || k < 0 || k >= spans.length) {
    throw new RangeError(`cell (${x}, ${y}) has ${spans.length} span(s), asked to move span ${k}`);
  }
  const target = spans[k]!;
  if (newCeiling <= target.floor) {
    spans.splice(k, 1);
  } else {
    spans[k] = { floor: target.floor, ceiling: newCeiling };
  }
  setColumn(map, x, y, canonicaliseColumn(spans));
}

/**
 * Removes the height range `[lo, hi)` from every span of a column — the one
 * operation that can turn one span into two, and so the only way a cave, an
 * arch or an overhang ever comes into existence.
 *
 * A span the range crosses keeps whatever of it lies below `lo` and whatever
 * lies above `hi`; a span the range swallows disappears. What survives is then
 * re-canonicalised, which is where the two rules that keep the result honest
 * live (`canonicaliseColumn`): a leftover sliver too thin to draw is consumed
 * by the cut rather than left as terrain that cannot be seen or clicked, and an
 * opening too thin to draw is closed again — a carve that would open a gap
 * nobody can see does not open one, so a hole through a roof has to be cut deep
 * enough to actually be a hole.
 *
 * `lo >= hi` removes nothing. The caller decides WHERE to cut and whether the
 * player is allowed to cut there (`canCarveBandAt`); this decides only what the
 * column looks like afterwards.
 */
export function carveRange(map: Heightmap, x: number, y: number, lo: number, hi: number): void {
  if (lo >= hi) return;
  const spans = readSpans(map, x, y);
  const cut: Span[] = [];
  for (let k = 0; k < spans.length; k++) {
    const span = spans[k]!;
    if (hi <= span.floor || lo >= span.ceiling) {
      cut.push(span);
      continue;
    }
    if (span.floor < lo) cut.push({ floor: span.floor, ceiling: lo });
    if (hi < span.ceiling) cut.push({ floor: hi, ceiling: span.ceiling });
  }
  setColumn(map, x, y, canonicaliseColumn(cut));
}

// ---------------------------------------------------------------------------
// What a stroke is allowed to reach — the same walk, once for material and
// once for air.
// ---------------------------------------------------------------------------
//
// `canSpreadBandTo` (heightmap.ts) is the drag anchor's whole anti-cheat story:
// a band may only spread onto a cell one of whose eight neighbours already
// stands at it, re-derived from the server's own map, so a level creeps outward
// from ground that is really there and a forged band on an unrelated cell does
// nothing. The two below are that rule said in spans — the form every layered
// tool uses — and they differ from it only in what "stands at that band" means.

/**
 * The span-aware `canSpreadBandTo`: whether band `band` may spread ONTO cell
 * (cx, cy), asked as "is a neighbour SOLID AT that band" rather than "is a
 * neighbour's topmost surface above it".
 *
 * STRICTLY TIGHTER THAN THE HEIGHT TEST, which is the safe direction to move. A
 * neighbour with a cave running under it has its top surface above the band and
 * no material AT the band; the height test would let a terrace creep out of
 * that neighbour's shadow, which is growing terrain out of thin air with extra
 * steps. On a world of one-span columns the two tests agree by construction —
 * `columnCoversBand` on a single span IS `cells[i] >= threshold` — so ordinary
 * play does not change.
 *
 * Eight neighbours, not four, for the reason `canSpreadBandTo` gives: the lip a
 * player grabs is a marching-squares contour that cuts across cell corners, and
 * four-neighbour adjacency would stall a drag on a lip it is visibly touching.
 * Off-map neighbours are absent — the world's border holds nothing up.
 */
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

/**
 * The exact mirror for removing material: whether cell (cx, cy) may be CARVED
 * at band `band` — true when at least one of its eight neighbours is already
 * OPEN there.
 *
 * Air spreads the way material does, one cell per intent, outward from air that
 * is really there, re-derived from the server's own map. So a tunnel must start
 * at a face the open world already touches: the low ground outside a cliff is
 * open at the face's band, which admits the face cell; carving it makes that
 * cell open, which admits the next one inward on the next intent. No single
 * message can hollow out the middle of a mountain, for the same reason no
 * single message can raise a plateau in the middle of a plain.
 *
 * It reads like a limitation in one case and is not: on flat ground every
 * neighbour covers the top band, so carving it is refused — and that is exactly
 * the case where lowering is the tool that means what the player wants. Carve
 * is refused precisely where it is redundant.
 */
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

// ---------------------------------------------------------------------------
// SERIALISATION — the one flattened form, shared by the wire and the disk.
// ---------------------------------------------------------------------------
//
// A column's spans travel as a flat integer list, `[floor0, ceiling0, floor1,
// ceiling1, ...]` ascending — exactly the layout `map.columnSpans` already
// holds in memory. One shape for the diff, the chunk payload and the snapshot
// blob, so a column cannot mean one thing on the wire and another on disk.
//
// ABSENT MEANS ONE SPAN, everywhere. A cell with no packed entry is the
// one-span column `[BEDROCK_FLOOR, cells[i])`, so a receiver that holds a span
// list for a cell the sender did not list must DELETE it (see `applyPackedSpans`
// below). Without that, a carve which later re-merges back to a single span
// would leave the receiver split forever.

/**
 * A column's spans in flattened form, or `undefined` for the one-span case
 * that needs no entry at all. Returns a plain `number[]` rather than the live
 * `Int16Array`: this value is destined for JSON and for callers that keep it
 * past the next sculpt, and handing out the backing store would alias both.
 */
export function packColumnSpans(map: Heightmap, x: number, y: number): number[] | undefined {
  const packed = map.columnSpans.get(cellIndex(map, x, y));
  return packed === undefined ? undefined : Array.from(packed);
}

/**
 * Parses a flattened span list into canonical spans, or `null` if it is not
 * one. NULL RATHER THAN A THROW, and deliberately: every caller is a trust
 * boundary reading bytes it did not write — a broadcast diff, a chunk payload,
 * a row out of SQLite — and one malformed entry must cost that one cell, not
 * the whole message. Callers that consider a bad entry fatal (persistence at
 * boot) still get to say so themselves.
 *
 * Rejects everything `setColumn` rejects, plus the two shapes only a
 * serialised list can have: an odd length, and a lone span (which is the
 * absent case and must never be written out, or the same column would have two
 * encodings and two replicas could disagree while agreeing).
 */
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

/**
 * Applies a received span list to one column: sets it when the list parses,
 * and returns the column to the one-span case when the list is absent.
 *
 * THIS IS WHERE "ABSENT MEANS ONE SPAN" IS ENFORCED, and it is the reason
 * every receiver calls this rather than reaching for `setColumn` itself — the
 * delete is the half that is easy to forget and impossible to see going wrong
 * until a column stays split long after the world re-merged it.
 *
 * Returns false when a present list did not parse; the caller's height for the
 * cell still stands, so the column degrades to one span rather than to
 * nothing. The single-span path always returns true — there is nothing to
 * reject.
 */
export function applyPackedSpans(
  map: Heightmap,
  x: number,
  y: number,
  flat: readonly number[] | undefined,
): boolean {
  if (flat === undefined) {
    map.columnSpans.delete(cellIndex(map, x, y));
    return true;
  }
  const spans = parsePackedSpans(flat);
  if (spans === null) {
    map.columnSpans.delete(cellIndex(map, x, y));
    return false;
  }
  setColumn(map, x, y, spans);
  return true;
}

/**
 * Throws unless every column in ONE CHUNK has exactly one span — the per-chunk
 * form of `assertSingleSpanWorld`, for the paths that still carry one height
 * per cell after the world as a whole is allowed to hold a span.
 *
 * Costs nothing in the ordinary world: the side table is empty, so this is a
 * size check. It only walks the chunk once someone has carved somewhere.
 */
export function assertSingleSpanChunk(
  map: Heightmap,
  x0: number,
  y0: number,
  width: number,
  height: number,
  context: string,
): void {
  if (map.columnSpans.size === 0) return;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      if (!map.columnSpans.has(cellIndex(map, x, y))) continue;
      throw new Error(
        `${context}: column (${x}, ${y}) holds more than one span. ` +
          `This path carries one height per cell and cannot express a layered column.`,
      );
    }
  }
}
