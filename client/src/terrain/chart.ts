// The Cartographer's chart MODEL: everything about the inked map that can be
// computed from heights and reveal state alone. Pure — no Three.js, no DOM —
// so the whole classification (water/land/unknown, bands, the singed frontier,
// where "here be krakens" goes) is unit-testable headless; the canvas painting
// that consumes this lives in ui/Cartographer.tsx.
//
// DETERMINISM: the chart is a pure function of the revealed world. Two clients
// holding the same chunks draw byte-identical charts — the mottling and the
// torn-edge jitter come from hash01 below (a fixed integer hash of the cell
// coordinates), never from Math.random(), and every scan and BFS below runs in
// a fixed order.

import { bandOf, isWater } from '@terrace/shared';

/**
 * What the chart needs to know about the world — a deliberately narrow window
 * onto the client's terrain mirror (world.ts implements it) so this module
 * depends on data, not on the mirror type. Coordinates are in-bounds cell
 * coordinates; `heightAt` is the RAW height (bandColors.ts explains why raw
 * matters: quantisation destroys the water/land distinction at band 0).
 */
export interface ChartSource {
  readonly size: number;
  heightAt(x: number, y: number): number;
  revealedAt(x: number, y: number): boolean;
}

/** Cell classification on the chart. */
export const CHART_UNKNOWN = 0;
export const CHART_WATER = 1;
export const CHART_LAND = 2;

/**
 * How far the burn gradient bleeds from the frontier into unknown territory,
 * in cells. Five cells at the chart's scale reads as a singed edge rather
 * than a glow (wider washes out into "shaded region", narrower reads as a
 * hairline); it is a purely visual reach, so it is not derived from anything.
 */
export const SINGE_RANGE_CELLS = 5;

/**
 * Minimum distance (cells) from all revealed territory for the "here be
 * krakens" flourish. Past the singe range with room to spare, so the words
 * always sit in clean deep parchment, never on the burnt edge itself.
 */
export const KRAKEN_MIN_DEPTH_CELLS = SINGE_RANGE_CELLS + 3;

/** Inclusive bounding box of the revealed cells. */
export interface ChartBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The square window of the world a chart sheet actually shows. */
export interface ChartWindow {
  readonly x0: number;
  readonly y0: number;
  readonly span: number;
}

export interface ChartModel {
  readonly size: number;
  /** Per cell: CHART_UNKNOWN / CHART_WATER / CHART_LAND, y-major. */
  readonly kind: Uint8Array;
  /** Per cell: bandOf(height) for revealed cells, 0 for unknown. */
  readonly band: Int16Array;
  /** Bounding box of revealed territory, or null when nothing is revealed. */
  readonly bounds: ChartBounds | null;
  /**
   * Per cell: 0 for revealed cells and deep unknown; for unknown cells within
   * SINGE_RANGE_CELLS of revealed territory, the 4-neighbour BFS distance to
   * the nearest revealed cell (1 = touching the frontier).
   */
  readonly singe: Uint8Array;
  /**
   * Flat index of the unknown cell FARTHEST from any revealed cell (smallest
   * index wins ties, so the anchor is deterministic), or -1 when there is no
   * unknown cell at least KRAKEN_MIN_DEPTH_CELLS deep — a nearly fully
   * charted world gets no kraken caption rather than one crammed against the
   * frontier.
   */
  readonly krakenCell: number;
  readonly revealedCount: number;
}

/**
 * Deterministic per-cell hash → [0, 1). A small integer avalanche (xorshift
 * flavoured) — quality only has to be "no visible pattern at chart scale",
 * and it must be identical on every client, which rules out Math.random().
 */
export function hash01(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h = h ^ (h >>> 16);
  // Unsigned before scaling: | 0 above keeps h in signed 32-bit range.
  return (h >>> 0) / 4294967296;
}

/**
 * Builds the chart model in three fixed-order passes: classify every cell,
 * then BFS outward from the frontier into unknown territory for the singe
 * gradient, then pick the kraken anchor from the completed distance field.
 *
 * The BFS runs to completion (not just SINGE_RANGE_CELLS) because the kraken
 * anchor is defined by the GLOBAL maximum distance; on a 512² world that is a
 * quarter-million-cell flood fill of integer work, well inside a single
 * frame's budget for something that runs once per chart open.
 */
export function buildChartModel(source: ChartSource): ChartModel {
  const size = source.size;
  const cellCount = size * size;
  const kind = new Uint8Array(cellCount);
  const band = new Int16Array(cellCount);
  const singe = new Uint8Array(cellCount);
  /** Full BFS distances; 0 = revealed, -1 = unreached unknown (pending). */
  const dist = new Int32Array(cellCount).fill(-1);

  let revealedCount = 0;
  let bx0 = size;
  let by0 = size;
  let bx1 = -1;
  let by1 = -1;
  // Pass 1 — classify, and seed the BFS frontier: every UNKNOWN cell that
  // 4-neighbours a revealed cell starts at distance 1. Seeding the unknown
  // side (rather than the revealed side at 0) keeps the queue a fraction of
  // the world's size on typical maps.
  const queue = new Int32Array(cellCount);
  let queueHead = 0;
  let queueTail = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (source.revealedAt(x, y)) {
        revealedCount++;
        const h = source.heightAt(x, y);
        kind[i] = isWater(h) ? CHART_WATER : CHART_LAND;
        band[i] = bandOf(h);
        dist[i] = 0;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }

  if (revealedCount > 0 && revealedCount < cellCount) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (dist[i] !== -1) continue;
        const touchesRevealed =
          (x > 0 && dist[i - 1] === 0) ||
          (x < size - 1 && dist[i + 1] === 0) ||
          (y > 0 && dist[i - size] === 0) ||
          (y < size - 1 && dist[i + size] === 0);
        if (touchesRevealed) {
          dist[i] = 1;
          queue[queueTail++] = i;
        }
      }
    }
    // Pass 2 — flood the rest of the unknown. Fixed neighbour order (west,
    // east, north, south) so the field — and therefore the chart — is
    // reproducible.
    while (queueHead < queueTail) {
      const i = queue[queueHead++];
      const d = dist[i] + 1;
      const x = i % size;
      if (x > 0 && dist[i - 1] === -1) {
        dist[i - 1] = d;
        queue[queueTail++] = i - 1;
      }
      if (x < size - 1 && dist[i + 1] === -1) {
        dist[i + 1] = d;
        queue[queueTail++] = i + 1;
      }
      if (i >= size && dist[i - size] === -1) {
        dist[i - size] = d;
        queue[queueTail++] = i - size;
      }
      if (i < cellCount - size && dist[i + size] === -1) {
        dist[i + size] = d;
        queue[queueTail++] = i + size;
      }
    }
  }

  // Pass 3 — derive the singe band and the kraken anchor from the field.
  let krakenCell = -1;
  let krakenDepth = 0;
  for (let i = 0; i < cellCount; i++) {
    const d = dist[i];
    if (d <= 0) continue; // revealed, or unknown in a world with no frontier
    if (d <= SINGE_RANGE_CELLS) singe[i] = d;
    if (d > krakenDepth) {
      krakenDepth = d;
      krakenCell = i;
    }
  }
  if (krakenDepth < KRAKEN_MIN_DEPTH_CELLS) krakenCell = -1;

  return {
    size,
    kind,
    band,
    singe,
    krakenCell,
    revealedCount,
    bounds: bx1 >= 0 ? { x0: bx0, y0: by0, x1: bx1, y1: by1 } : null,
  };
}

/**
 * Parchment margin around the revealed territory, in cells. Wide enough that
 * the full singe gradient plus a band of clean deep parchment fits on the
 * sheet — the burnt edge must never touch the frame.
 */
export const WINDOW_PAD_CELLS = SINGE_RANGE_CELLS * 4;

/**
 * The square world window a chart sheet shows: the revealed bounding box,
 * padded by WINDOW_PAD_CELLS, squared up (a sheet is square; the shorter axis
 * grows symmetrically), and clamped into the world. A world with nothing
 * revealed charts everything — an all-parchment sheet at world scale.
 *
 * Windowing exists because reveal territory is typically a small fraction of
 * a 512² world (owner's live world charts ~2%): drawn at world scale, the
 * known world is a stamp on an empty page. A chart fills its sheet with what
 * its maker knows.
 */
export function chartWindow(model: ChartModel): ChartWindow {
  const size = model.size;
  if (model.bounds === null) return { x0: 0, y0: 0, span: size };
  const { x0, y0, x1, y1 } = model.bounds;
  const w = x1 - x0 + 1 + 2 * WINDOW_PAD_CELLS;
  const h = y1 - y0 + 1 + 2 * WINDOW_PAD_CELLS;
  const span = Math.min(size, Math.max(w, h));
  const centreX = (x0 + x1 + 1) / 2;
  const centreY = (y0 + y1 + 1) / 2;
  const clamp = (v: number): number =>
    Math.max(0, Math.min(size - span, Math.round(v - span / 2)));
  return { x0: clamp(centreX), y0: clamp(centreY), span };
}
