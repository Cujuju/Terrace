// The world grid, and nothing that has an opinion about it.
//
// WHY THIS MODULE EXISTS, and it is a dependency fact rather than a taste one.
// `columns.ts` — the span model — needs the grid type and its index arithmetic.
// `heightmap.ts` — the sculpt tools — needs the span model, because a tool that
// moves "the surface" of a layered column has to say which span it has hold of
// (issue #129, step 4.3 onward: `spanIndexCoveringBand`, `moveSpanCeiling`,
// `carveRange`). Those two needs point at each other, and until this module
// existed the second one could not be met: heightmap.ts's own `diffOf` had to
// read the span side table by hand rather than through columns.ts, with a
// comment saying why ("importing back would put a cycle between the two modules
// the whole determinism contract rests on").
//
// Splitting the LEAF half out settles it in the direction that keeps the ban.
// Everything here is layout and band arithmetic with no knowledge of spans, of
// brushes or of the wire, so both modules can sit on top of it and the arrow
// between them only ever points one way: grid → columns → heightmap.
//
// heightmap.ts re-exports every name below, so nothing outside shared/ changed
// when they moved; `@terrace/shared` exports them exactly as before.
//
// DETERMINISM. Same contract as constants.ts: integer arithmetic only, no
// float division that is not exact. Both the server and the client's prediction
// index cells through these, and two different answers here would be two
// different worlds.

import { BAND_HEIGHT } from './constants.ts';

/**
 * The world grid. `cells` is row-major, index = y * size + x, and holds the
 * CEILING OF EACH COLUMN'S TOPMOST SOLID SPAN — the walkable surface, which is
 * what it has always held and what `heightAt` returns.
 *
 * `columnSpans` is the sparse side table of the rare column that holds more
 * than one span (an overhang, an arch, a cave roof); a cell absent from it is
 * solid from the bottom of the world up to `cells[i]`. See columns.ts for the
 * model, the encoding and the determinism rule that goes with the table.
 */
export interface Heightmap {
  readonly size: number;
  readonly cells: Int16Array;
  readonly columnSpans: Map<number, Int16Array>;
}

/** Allocates a flat (all-zero = sea-level shoreline) world up front. */
export function createHeightmap(size: number): Heightmap {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`world size must be a positive integer, got ${size}`);
  }
  return { size, cells: new Int16Array(size * size), columnSpans: new Map() };
}

export function inBounds(map: Heightmap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.size && y < map.size;
}

export function cellIndex(map: Heightmap, x: number, y: number): number {
  return y * map.size + x;
}

/**
 * Inverse of cellIndex for the row-major layout above, split into two
 * allocation-free halves because decomposition runs in per-cell hot loops
 * (smooth's bounding box, the wire diff, client prediction). These take the
 * bare size rather than the map so call sites that hold only a size — the
 * client's prediction journal — can share the one layout fact (#14).
 */
export function cellX(size: number, i: number): number {
  return i % size;
}

export function cellY(size: number, i: number): number {
  // Subtracting the remainder first keeps this exact integer division —
  // integer-only per the determinism contract, no float floor involved.
  return (i - (i % size)) / size;
}

/**
 * Terrace band index of a height. Floor division so negative (underwater)
 * heights band correctly: bandOf(-1) === -1, not 0 — otherwise the first
 * band below sea level would render as land.
 */
export function bandOf(h: number): number {
  return Math.floor(h / BAND_HEIGHT);
}

/** Height snapped down to its band floor — what terraced rendering draws. */
export function quantizeToBand(h: number): number {
  return bandOf(h) * BAND_HEIGHT;
}
