// Heightmap: grid type, brush, gradient-limit smoothing, water, terracing.
//
// CRITICAL CODE — this module runs on BOTH server (authoritative) and client
// (prediction). See the determinism contract in constants.ts: identical inputs
// must give identical outputs on both sides, or reconciliation will visibly
// snap. Iteration order in every loop here is part of the contract — do not
// "optimize" loop order or replace the sequential relaxation without updating
// both sides atomically (they always are, this is the shared package — that is
// the point).

import {
  BAND_HEIGHT,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  SEA_LEVEL,
  SMOOTH_PASS_LIMIT,
} from './constants.ts';

/** The world grid. `cells` is row-major, index = y * size + x. */
export interface Heightmap {
  readonly size: number;
  readonly cells: Int16Array;
}

/** One changed cell, as broadcast to clients after an applied edit. */
export interface CellDiff {
  x: number;
  y: number;
  h: number;
}

/** Allocates a flat (all-zero = sea-level shoreline) world up front. */
export function createHeightmap(size: number): Heightmap {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`world size must be a positive integer, got ${size}`);
  }
  return { size, cells: new Int16Array(size * size) };
}

export function inBounds(map: Heightmap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.size && y < map.size;
}

export function cellIndex(map: Heightmap, x: number, y: number): number {
  return y * map.size + x;
}

export function heightAt(map: Heightmap, x: number, y: number): number {
  return map.cells[cellIndex(map, x, y)];
}

/** Static sea (design decision Q3): water is derived, never simulated. */
export function isWater(h: number): boolean {
  return h <= SEA_LEVEL;
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

function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

/**
 * Applies the sculpt brush: linear falloff from center, radius 1 degenerating
 * to the Populous point brush (design decision Q2).
 *
 * Cells at integer distance `d = floor(sqrt(dx² + dy²))` from the center get
 * `trunc(amount * (radius - d) / radius)`; cells at d >= radius are untouched.
 * Math.sqrt is IEEE-exact and immediately floored, so this is deterministic
 * cross-platform. Results clamp to [MIN_HEIGHT, MAX_HEIGHT].
 *
 * Changed cell indices are added to `changed` (for the caller to smooth and
 * diff). Throws on invalid center/radius — validation of untrusted input
 * happens in protocol.ts; reaching here with garbage is a programming error.
 */
export function applyBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
): void {
  if (!inBounds(map, cx, cy)) {
    throw new RangeError(`brush center (${cx},${cy}) out of bounds`);
  }
  if (
    !Number.isInteger(radius) ||
    radius < MIN_BRUSH_RADIUS ||
    radius > MAX_BRUSH_RADIUS
  ) {
    throw new RangeError(`brush radius ${radius} outside [${MIN_BRUSH_RADIUS}, ${MAX_BRUSH_RADIUS}]`);
  }
  if (!Number.isInteger(amount)) {
    throw new RangeError(`brush amount must be an integer, got ${amount}`);
  }

  // Scan order (dy outer, dx inner, both ascending) is fixed — see module
  // header. Each cell is written at most once, so order only matters for
  // reproducibility of the `changed` set's insertion order.
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      const dist = Math.floor(Math.sqrt(dx * dx + dy * dy));
      if (dist >= radius) continue;
      // Linear falloff; trunc (toward zero) keeps raise/lower symmetric.
      const delta = Math.trunc((amount * (radius - dist)) / radius);
      if (delta === 0) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(map, x, y)) continue; // brush overhanging the map edge
      const i = cellIndex(map, x, y);
      const h = clampHeight(map.cells[i] + delta);
      if (h !== map.cells[i]) {
        map.cells[i] = h;
        changed.add(i);
      }
    }
  }
}

/**
 * Gradient-limit relaxation — the Populous signature and the single most
 * feel-critical routine in the project. After an edit, any 4-neighbor pair
 * differing by more than MAX_STEP is pulled toward each other by half the
 * excess (higher cell loses floor(e/2), lower gains the rest, leaving the
 * pair at exactly MAX_STEP), swept in fixed row-major passes over a bounding
 * box that grows by one cell per pass so spillover can propagate outward.
 *
 * Exits as soon as a full pass changes nothing. SMOOTH_PASS_LIMIT (see
 * constants.ts) is a safety cap sized to the worst realistic cascade; if it
 * is ever hit, the gradient invariant may be locally violated until a later
 * edit resumes relaxation — accepted and documented residual.
 *
 * Every adjusted cell's index is added to `changed`.
 *
 * INVARIANT (tested): starting from a map that satisfies the gradient limit,
 * applyBrush + smooth leaves no 4-neighbor pair exceeding MAX_STEP.
 * Relaxation moves values strictly toward each other, so it can never leave
 * [MIN_HEIGHT, MAX_HEIGHT] and never needs clamping.
 */
export function smooth(map: Heightmap, changed: Set<number>): void {
  if (changed.size === 0) return;

  const { size, cells } = map;

  // Bounding box of the initial edit.
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (const i of changed) {
    const x = i % size;
    const y = (i - x) / size;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  for (let pass = 0; pass < SMOOTH_PASS_LIMIT; pass++) {
    // Expand one ring per pass: excess travels at most one cell per pass, so
    // this always covers the frontier. Everything outside the box satisfied
    // the invariant before the edit and is untouched, so it still does.
    if (minX > 0) minX--;
    if (minY > 0) minY--;
    if (maxX < size - 1) maxX++;
    if (maxY < size - 1) maxY++;

    let changedThisPass = false;

    for (let y = minY; y <= maxY; y++) {
      const row = y * size;
      for (let x = minX; x <= maxX; x++) {
        const i = row + x;
        // Each pair visited once, via its "forward" (right/down) neighbor.
        if (x < maxX) {
          const j = i + 1;
          const d = cells[i] - cells[j];
          if (d > MAX_STEP) {
            const e = d - MAX_STEP;
            cells[i] -= e >> 1;
            cells[j] += e - (e >> 1);
            changed.add(i); changed.add(j);
            changedThisPass = true;
          } else if (d < -MAX_STEP) {
            const e = -d - MAX_STEP;
            cells[j] -= e >> 1;
            cells[i] += e - (e >> 1);
            changed.add(i); changed.add(j);
            changedThisPass = true;
          }
        }
        if (y < maxY) {
          const j = i + size;
          const d = cells[i] - cells[j];
          if (d > MAX_STEP) {
            const e = d - MAX_STEP;
            cells[i] -= e >> 1;
            cells[j] += e - (e >> 1);
            changed.add(i); changed.add(j);
            changedThisPass = true;
          } else if (d < -MAX_STEP) {
            const e = -d - MAX_STEP;
            cells[j] -= e >> 1;
            cells[i] += e - (e >> 1);
            changed.add(i); changed.add(j);
            changedThisPass = true;
          }
        }
      }
    }

    if (!changedThisPass) break;
  }
}

/**
 * The complete sculpt operation both sides run: brush → relaxation → diff.
 * The server runs it authoritatively and broadcasts the returned diff; the
 * client runs it for instant prediction and reconciles against that diff.
 * Diff order is ascending cell index — deterministic wire order.
 */
export function applySculpt(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
): CellDiff[] {
  const changed = new Set<number>();
  applyBrush(map, cx, cy, radius, amount, changed);
  smooth(map, changed);

  const indices = Array.from(changed).sort((a, b) => a - b);
  const diff: CellDiff[] = [];
  for (const i of indices) {
    const x = i % map.size;
    diff.push({ x, y: (i - x) / map.size, h: map.cells[i] });
  }
  return diff;
}
