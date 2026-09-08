// Heightmap: grid, brush, gradient-limit smoothing, water, terracing. Runs on server
// and client; every loop's iteration order is part of the determinism contract.

import {
  BAND_HEIGHT,
  DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  RELAX_SLACK,
  SEA_LEVEL,
  SMOOTH_PASS_LIMIT,
  SOFT_APRON_MAX_BANDS,
  SOFT_APRON_TREAD_CELLS,
  WORLD_UNIT_CELLS,
} from './constants.ts';

// Grid type lives in grid.ts; re-exported here so `@terrace/shared` keeps its
// existing export surface.
export {
  bandOf,
  cellIndex,
  cellX,
  cellY,
  chebyshevDistance,
  createHeightmap,
  forEachLineCell,
  inBounds,
  quantizeToBand,
  type Heightmap,
} from './grid.ts';

// Imported (not just re-exported) because used below.
import {
  anyColumnLayered,
  applyBandFill,
  bandFillAt,
  BEDROCK_FLOOR,
  canCarveBandAt,
  canSpreadBandToSpan,
  carveRange,
  columnCoversBand,
  highestCeilingBelow,
  isSpanDrawn,
  moveSpanCeiling,
  readSpans,
  spanAt,
  spanCount,
  spanIndexCoveringBand,
  spanLowestBandHeight,
  spanUndersideHeight,
  spansHaveCapAtBand,
  type Span,
} from './columns.ts';
import {
  bandOf,
  cellIndex,
  cellX,
  cellY,
  forEachLineCell,
  inBounds,
  quantizeToBand,
  type Heightmap,
} from './grid.ts';

/**
 * One changed cell. `h` is the topmost ceiling. `spans` (`[floor0, ceiling0, …]`)
 * appears only for a multi-span column — see `applyPackedSpans` (columns.ts).
 */
export interface CellDiff {
  x: number;
  y: number;
  h: number;
  spans?: number[];
}

export function heightAt(map: Heightmap, x: number, y: number): number {
  return map.cells[cellIndex(map, x, y)];
}

/** Water is derived, never simulated (decision Q3). */
export function isWater(h: number): boolean {
  return h <= SEA_LEVEL;
}

/** Band range the world can hold. Used to reject an out-of-range `targetBand` off the wire. */
export const MIN_BAND = bandOf(MIN_HEIGHT);
export const MAX_BAND = bandOf(MAX_HEIGHT);

/** Whole height range — the amount a `band`-anchored stroke uses so the target clamp alone stops it. */
export const FULL_HEIGHT_SPAN = MAX_HEIGHT - MIN_HEIGHT;

function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

/**
 * `stamp` — footprint only, sheer edges. `smooth` — brush + relaxation.
 * `drag` — drags a terrace lip sideways (`applyDragRegion`). `carve` —
 * lower-only, opens a second span for arches/tunnels (`applyCarve`).
 */
export type SculptTool = 'stamp' | 'smooth' | 'drag' | 'carve';

/**
 * `soft` — linear falloff from centre. `hard` — level-fills the lowest band
 * under the brush before starting the next, under either tool; see
 * `applyLevelFillBrush`.
 */
export type SculptProfile = 'soft' | 'hard';

/** Every valid tool, in wire/UI order. */
export const SCULPT_TOOLS: readonly SculptTool[] = ['stamp', 'smooth', 'drag', 'carve'];

/**
 * Tools with no edge profile (#225). `sculptOptionsOf` resolves both to a fixed
 * profile; the HUD hides Edge for them.
 */
export const TOOLS_WITHOUT_EDGE_PROFILE: readonly SculptTool[] = ['drag', 'carve'];

/**
 * Tools with no raise/lower direction: `carve` only removes. `sculptOptionsOf`
 * forces `lower`; the HUD hides Mode. Excludes `drag`, which has both.
 */
export const TOOLS_WITHOUT_DIRECTION: readonly SculptTool[] = ['carve'];

/**
 * Bands one carve removes. Derived from `isGapDrawn` — one band closes itself. Re-check
 * that predicate before changing this.
 */
export const CARVE_BANDS_PER_STROKE = 2;

/** Every valid profile, in wire/UI order. */
export const SCULPT_PROFILES: readonly SculptProfile[] = ['soft', 'hard'];

/**
 * How far `smooth`'s relaxation moves terrain outside the footprint (#26). Fixed
 * server-side; not a wire field.
 */
export type SculptSpill = 'banded' | 'free';

/**
 * Level a stroke's brush locks to. `band` is the drag's, re-validated by
 * `canSpreadBandTo`. Binds the brush only; `smooth`'s relaxation uses `spill`.
 */
export type SculptAnchor = 'clicked' | 'free' | 'band';

/**
 * True iff a neighbour already stands solid at `band` — not merely above it (#129 step
 * 4.5). Eight neighbours: a lip's contour cuts diagonally.
 */
export function canSpreadBandTo(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): boolean {
  return canSpreadBandToSpan(map, cx, cy, band);
}

// The layer-edge drag: each intent is a disc filled to the grabbed band, but
// only onto cells `canSpreadBandTo` admits. Idempotent, so a dropped intent
// costs a frame, not the stroke.

// The grasp (#129 step 4.4): which span a stroke works on. `map.cells[i]` is the
// topmost ceiling, so a cave-floor grasp would move the roof.

/** Span of cell `i` this stroke holds, or null if the grasped band passes through open air there. Null band means topmost span (the surface). */
function graspedSpanIndex(map: Heightmap, i: number, spanBand: number | null): number | null {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  if (spanBand === null) return spanCount(map, x, y) - 1;
  return spanIndexCoveringBand(map, x, y, spanBand);
}

/**
 * Layer-consistent span for relaxation (#129 step 4.6). A band in a gap under a roof is
 * null — excluded, never filled with a stand-in height.
 */
function layerSpanIndex(map: Heightmap, i: number, spanBand: number | null): number | null {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  const top = spanCount(map, x, y) - 1;
  if (spanBand === null) return top;
  const k = spanIndexCoveringBand(map, x, y, spanBand);
  if (k !== null) return k;
  return spanBand * BAND_HEIGHT > spanAt(map, x, y, top).ceiling ? top : null;
}

/** The ceiling of the grasped span — what the brush moves. */
function graspedCeiling(map: Heightmap, i: number, k: number): number {
  return spanAt(map, cellX(map.size, i), cellY(map.size, i), k).ceiling;
}

/** Writes the grasped span's ceiling; merge/split/canonical-form rules live in columns.ts. */
function writeGraspedCeiling(map: Heightmap, i: number, k: number, ceiling: number): void {
  moveSpanCeiling(map, cellX(map.size, i), cellY(map.size, i), k, ceiling);
}

/** Caller-supplied sculpt options; every field defaults when absent. */
export interface SculptOptions {
  readonly tool?: SculptTool;
  readonly profile?: SculptProfile;
  readonly spill?: SculptSpill;
  readonly anchor?: SculptAnchor;
  /** Band a `band`-anchored stroke fills toward. Meaningful only with `anchor: 'band'`. */
  readonly targetBand?: number | null;
  /** Band the stroke holds. Absent/null means topmost span. */
  readonly spanBand?: number | null;
  /** Previous drag intent's cursor cell; region sweeps the line to (cx, cy). Drag only. */
  readonly sweepFrom?: SweepOrigin | null;
}

/** Where a drag sweep starts — see SculptOptions.sweepFrom. */
export interface SweepOrigin {
  readonly x: number;
  readonly y: number;
}

/** Sculpt options with nothing left to default — what the math actually runs. */
export interface ResolvedSculptOptions {
  readonly tool: SculptTool;
  readonly profile: SculptProfile;
  readonly spill: SculptSpill;
  readonly anchor: SculptAnchor;
  /** Band a `band`-anchored stroke fills toward. Meaningful only with `anchor: 'band'`. */
  readonly targetBand: number | null;
  /**
   * Band the stroke holds, not a span index — resolved via
   * `spanIndexCoveringBand` at apply time so both replicas agree. Null means
   * topmost span. See SculptIntent.spanBand in protocol.ts.
   */
  readonly spanBand: number | null;
  /** Drag sweep's start cell, or null for a single disc. */
  readonly sweepFrom: SweepOrigin | null;
}

/**
 * What `applySculpt` runs without options. NOT the player-facing default —
 * this reproduces pre-2026-08-14 plugin behaviour (brush + relaxation, no
 * spill containment) bit for bit. Player default is `WIRE_DEFAULT_SCULPT_OPTIONS`
 * in protocol.ts.
 */
export const LIBRARY_DEFAULT_SCULPT_OPTIONS: ResolvedSculptOptions = {
  tool: 'smooth',
  profile: 'soft',
  spill: 'free',
  anchor: 'free',
  targetBand: null,
  spanBand: null,
  sweepFrom: null,
};

/**
 * The footprint, defined once. Scan order is part of the determinism contract. Shared
 * by brushes, pricing and the client preview so none drift.
 */
export function forEachFootprintOffset(
  radius: number,
  visit: (dx: number, dy: number, dist: number) => void,
): void {
  if (radius === 1) {
    // r·(r−1)=0 would exclude the centre; radius 1 is the point brush.
    visit(0, 0, 0);
    return;
  }
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      if (!isFootprintOffset(radius, dx, dy)) continue;
      visit(dx, dy, Math.floor(Math.sqrt(dx * dx + dy * dy)));
    }
  }
}

/** Membership test for a single offset, same rule as forEachFootprintOffset. Used by admitRimEnclaves. */
function isFootprintOffset(radius: number, dx: number, dy: number): boolean {
  if (radius === 1) return dx === 0 && dy === 0;
  return dx * dx + dy * dy < radius * (radius - 1);
}

/** forEachFootprintOffset narrowed to in-bounds cells (index + dist). Off-map offsets are dropped. */
function forEachFootprintCell(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  visit: (i: number, dist: number) => void,
): void {
  forEachFootprintOffset(radius, (dx, dy, dist) => {
    const x = cx + dx;
    const y = cy + dy;
    if (!inBounds(map, x, y)) return;
    visit(cellIndex(map, x, y), dist);
  });
}

/** Per-cell delta at distance `dist`. Shared with sculptDisplacementUnits so pricing matches application exactly. */
function brushDelta(
  amount: number,
  radius: number,
  dist: number,
  profile: SculptProfile,
): number {
  return profile === 'hard' ? amount : Math.trunc((amount * (radius - dist)) / radius);
}

/**
 * Checked per cell against the untouched map, not just the centre: otherwise one legal
 * cell makes its neighbours legal mid-sweep and the disc fills by scan order.
 */
function spreadableFootprintCells(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  band: number,
): ReadonlySet<number> {
  const spreadable = new Set<number>();
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    if (canSpreadBandTo(map, cellX(map.size, i), cellY(map.size, i), band)) spreadable.add(i);
  });
  return spreadable;
}

/** Radius precondition. Throws (not clamps) — untrusted input is validated in protocol.ts. */
function assertBrushRadius(radius: number): void {
  if (
    !Number.isInteger(radius) ||
    radius < MIN_BRUSH_RADIUS ||
    radius > MAX_BRUSH_RADIUS
  ) {
    throw new RangeError(`brush radius ${radius} outside [${MIN_BRUSH_RADIUS}, ${MAX_BRUSH_RADIUS}]`);
  }
}

/** Full brush precondition set: in-bounds centre, legal radius, integer amount. */
function assertBrushArgs(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
): void {
  if (!inBounds(map, cx, cy)) {
    throw new RangeError(`brush center (${cx},${cy}) out of bounds`);
  }
  assertBrushRadius(radius);
  if (!Number.isInteger(amount)) {
    throw new RangeError(`brush amount must be an integer, got ${amount}`);
  }
}

/**
 * Floor of the band adjacent to the centre's pre-stroke band, read before any write.
 * applyBrush, applyLevelFillBrush and applySculpt's containment must agree bit for bit.
 */
function anchoredTargetHeight(
  map: Heightmap,
  cx: number,
  cy: number,
  raising: boolean,
  targetBand: number | null = null,
  spanBand: number | null = null,
): number {
  // Drag case: level is the grabbed band's own floor, not derived from `raising`.
  if (targetBand !== null) return clampHeight(targetBand * BAND_HEIGHT);
  // Centre's grasped ceiling, not the column's topmost — a cave-floor grasp
  // anchors to the floor, not the roof.
  const centre = cellIndex(map, cx, cy);
  const k = graspedSpanIndex(map, centre, spanBand);
  // No span at the grasped band: nothing to anchor to; callers guard this
  // before writing, so the fallback only needs to move nothing.
  const here = k === null ? map.cells[centre]! : graspedCeiling(map, centre, k);
  return clampHeight((bandOf(here) + (raising ? 1 : -1)) * BAND_HEIGHT);
}

/**
 * Applies the sculpt brush. Clamps to [MIN_HEIGHT, MAX_HEIGHT]; throws on an invalid
 * centre or radius. applySculpt routes `hard` to applyLevelFillBrush instead.
 */
export function applyBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  profile: SculptProfile = LIBRARY_DEFAULT_SCULPT_OPTIONS.profile,
  anchor: SculptAnchor = LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor,
  targetBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
): void {
  assertBrushArgs(map, cx, cy, radius, amount);

  // Drag's spread rule: checked per footprint cell against the untouched map.
  let spreadable: ReadonlySet<number> | null = null;
  if (anchor === 'band') {
    if (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand)) return;
    spreadable = spreadableFootprintCells(map, cx, cy, radius, targetBand);
  }

  // Target pinned from centre before any write, so periphery cells don't
  // anchor to a target computed after the centre moved.
  const raising = amount > 0;
  const anchored = anchor !== 'free' && amount !== 0;
  const target = anchored ? anchoredTargetHeight(map, cx, cy, raising, targetBand, spanBand) : 0;

  forEachFootprintCell(map, cx, cy, radius, (i, dist) => {
    if (spreadable !== null && !spreadable.has(i)) return;
    const delta = brushDelta(amount, radius, dist, profile);
    if (delta === 0) return;
    // Null means the grasped band passes through open air here — skip, don't
    // fill with a stand-in height (D4).
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const before = graspedCeiling(map, i, k);
    if (anchored && (raising ? before >= target : before <= target)) return;
    let moved = before + delta;
    if (anchored) {
      moved = raising
        ? moved > target ? target : moved
        : moved < target ? target : moved;
    }
    const h = clampHeight(moved);
    if (h !== before) {
      writeGraspedCeiling(map, i, k, h);
      changed.add(i);
    }
  });
}

/**
 * Level-fill brush (`hard`). Target is the band adjacent to the footprint's extreme
 * terrace; cells short of it move, the rest stay. One band per stroke.
 */
export function applyLevelFillBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  anchor: SculptAnchor = LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor,
  targetBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
): void {
  assertBrushArgs(map, cx, cy, radius, amount);
  // No direction to fill toward; without this the survey would pick a meaningless target.
  if (amount === 0) return;

  // Same spread-rule guard as applyBrush.
  let spreadable: ReadonlySet<number> | null = null;
  if (anchor === 'band') {
    if (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand)) return;
    spreadable = spreadableFootprintCells(map, cx, cy, radius, targetBand);
  }

  const raising = amount > 0;

  if (anchor !== 'free') {
    // Anchored target, read before any write — same derivation as the other anchored call sites.
    const targetHeight = anchoredTargetHeight(map, cx, cy, raising, targetBand, spanBand);
    fillTowardTarget(
      map, cx, cy, radius, amount, changed, raising, targetHeight, spanBand, spreadable,
    );
    return;
  }

  let extremeBand = 0;
  {
    // Pass 1: survey. Extreme band across the footprint's in-bounds cells.
    let surveyed = false;
    forEachFootprintCell(map, cx, cy, radius, (i) => {
      // A cell the grasp passes through is not surveyed — an opening isn't a low place to fill from.
      const k = graspedSpanIndex(map, i, spanBand);
      if (k === null) return;
      const band = bandOf(graspedCeiling(map, i, k));
      if (!surveyed) {
        extremeBand = band;
        surveyed = true;
        return;
      }
      if (raising ? band < extremeBand : band > extremeBand) extremeBand = band;
    });
    // Cannot fire: the centre is always in bounds and in the footprint. Defensive.
    if (!surveyed) return;
  }

  // Floor of the band adjacent to the extreme one; clamped since the top
  // band's ceiling can exceed MAX_HEIGHT.
  const targetHeight = clampHeight((extremeBand + (raising ? 1 : -1)) * BAND_HEIGHT);
  fillTowardTarget(map, cx, cy, radius, amount, changed, raising, targetHeight, spanBand);
}

/** Cells this stroke writes to. Shared by sweep, price, and prediction guard — must not disagree. */
export function sculptSweepRadius(
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
  anchor: SculptAnchor,
): number {
  return profile === 'soft' && tool === 'stamp' && anchor === 'clicked'
    ? radius + softApronReachCells(radius)
    : radius;
}

/**
 * Cells the apron runs past the core: twice the radius, capped at the band
 * ceiling. Twice, so it drops one band per world unit the brush slider names.
 */
export function softApronReachCells(radius: number): number {
  const capped = SOFT_APRON_MAX_BANDS * SOFT_APRON_TREAD_CELLS;
  const reach = 2 * radius;
  return reach < capped ? reach : capped;
}

/** Bands below the core at `distPastCore` (1..reach) cells out. */
export function softApronBandDrop(distPastCore: number): number {
  const band = Math.floor((distPastCore + SOFT_APRON_TREAD_CELLS - 1) / SOFT_APRON_TREAD_CELLS);
  return band < SOFT_APRON_MAX_BANDS ? band : SOFT_APRON_MAX_BANDS;
}

/**
 * The soft profile's apron: a staircase of up to SOFT_APRON_MAX_BANDS below
 * the core. Targets are bands, so a press is always visible (#387).
 */
function applySoftApron(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  coreTarget: number,
  spanBand: number | null,
  changed: Set<number>,
): void {
  if (amount === 0) return;
  const raising = amount > 0;
  const reach = softApronReachCells(radius);
  forEachFootprintCell(map, cx, cy, sculptSweepRadius(radius, 'soft', 'stamp', 'clicked'), (i) => {
    // Core cells are already filled; excluded by the core's own membership test.
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const dx = x - cx;
    const dy = y - cy;
    if (isFootprintOffset(radius, dx, dy)) return;
    // Ring distance by the core's own predicate, so the apron cannot drift
    // from the footprint boundary. The sweep radius guarantees a hit by `reach`.
    let dist = reach;
    for (let d = 1; d < reach; d++) {
      if (isFootprintOffset(radius + d, dx, dy)) {
        dist = d;
        break;
      }
    }
    const target = clampHeight(
      coreTarget + (raising ? -1 : 1) * softApronBandDrop(dist) * BAND_HEIGHT,
    );
    // Open air at this level: skip, never fill. Same rule as applyBrush.
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const before = graspedCeiling(map, i, k);
    if (raising ? before >= target : before <= target) return;
    const moved = before + amount;
    const h = clampHeight(raising ? (moved > target ? target : moved) : (moved < target ? target : moved));
    if (h !== before) {
      writeGraspedCeiling(map, i, k, h);
      changed.add(i);
    }
  });
}

/** Pass 2 of the level fill: moves cells short of `targetHeight` by `amount`, stopping at it. Shared by both target derivations. */
function fillTowardTarget(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  raising: boolean,
  targetHeight: number,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
  // The band anchor's per-cell spread rule, or null when the caller's target
  // came from its own survey and no band is being spread (see applyBrush).
  spreadable: ReadonlySet<number> | null = null,
): void {
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    if (spreadable !== null && !spreadable.has(i)) return;
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const h = graspedCeiling(map, i, k);
    // Already at or past the level being filled: untouched. This is what stops
    // the brush from starting the next level while this one is unfinished.
    if (raising ? h >= targetHeight : h <= targetHeight) return;
    // Never THROUGH the target: that builds a step above the level being filled, which
    // is what this brush exists to prevent.
    const moved = h + amount;
    const next = raising
      ? moved > targetHeight ? targetHeight : moved
      : moved < targetHeight ? targetHeight : moved;
    // A no-op for in-range terrain, kept so this brush gives applyBrush's guarantee
    // whatever it is handed: nothing written outside [MIN_HEIGHT, MAX_HEIGHT].
    const clamped = clampHeight(next);
    if (clamped !== h) {
      writeGraspedCeiling(map, i, k, clamped);
      changed.add(i);
    }
  });
}

/**
 * Adjacency before a dragged lip pushes the level below along. Larger values translated
 * a whole staircase. A lattice fact, so stated in cells.
 */
const DRAG_TREAD_TOLERANCE_CELLS = 1;

/**
 * Carries a staircase step below the dragged one. Raises to band j only if crowded by
 * this edit's own j+1 ground AND a band-j tread pre-existed (pyramid bug).
 */
function pushLowerLayers(
  map: Heightmap,
  raisedAtBand: number[],
  topBand: number,
  hadCapAtBandBefore: (index: number, band: number) => boolean,
  record: (index: number) => void,
  changed: Set<number>,
): void {
  /**
   * A tread of EXACTLY `band` before this intent. "At or above" let a totem count as
   * every band below it — the pyramid bug.
   */
  const treadWasNear = (cx: number, cy: number, band: number): boolean => {
    for (let dy = -DRAG_TREAD_TOLERANCE_CELLS; dy <= DRAG_TREAD_TOLERANCE_CELLS; dy++) {
      for (let dx = -DRAG_TREAD_TOLERANCE_CELLS; dx <= DRAG_TREAD_TOLERANCE_CELLS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(map, x, y)) continue;
        if (hadCapAtBandBefore(cellIndex(map, x, y), band)) return true;
      }
    }
    return false;
  };

  // Only one level down — no chain here (see the note at the end of this function).
  const band = topBand - 1;
  if (band <= MIN_BAND || raisedAtBand.length === 0) return;
  const level = clampHeight(band * BAND_HEIGHT);

  // Cells within tolerance of what the level above just took, deduped and sorted for order-independence.
  const candidates: number[] = [];
  const seen = new Set<number>();
  for (const seed of raisedAtBand) {
    const sx = cellX(map.size, seed);
    const sy = cellY(map.size, seed);
    for (let dy = -DRAG_TREAD_TOLERANCE_CELLS; dy <= DRAG_TREAD_TOLERANCE_CELLS; dy++) {
      for (let dx = -DRAG_TREAD_TOLERANCE_CELLS; dx <= DRAG_TREAD_TOLERANCE_CELLS; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!inBounds(map, x, y)) continue;
        const i = cellIndex(map, x, y);
        if (seen.has(i)) continue;
        seen.add(i);
        // Solid at this band already — nothing here to push.
        if (columnCoversBand(map, x, y, band)) continue;
        // Clause 2: only a step that was already here may be pushed.
        if (!treadWasNear(x, y, band)) continue;
        candidates.push(i);
      }
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => a - b);

  // Same wave discipline as the drag: swept to a fixpoint. Not collected — no next level down.
  let filledThisPass = true;
  while (filledThisPass) {
    filledThisPass = false;
    for (const i of candidates) {
      const x = cellX(map.size, i);
      const y = cellY(map.size, i);
      // Skips 'overhang' fills (issue #224): this pass carries steps, never hangs new slabs under roofs.
      const fill = bandFillAt(map, x, y, band);
      if (fill === null || fill.kind !== 'extend') continue;
      if (!canSpreadBandTo(map, x, y, band)) continue;
      record(i);
      applyBandFill(map, x, y, fill, level);
      changed.add(i);
      filledThisPass = true;
    }
  }

  // Chain stops here: feeding `raised` into the next level's entitlement cascaded one
  // intent across nine bands (measured). Drag again to carry the next.
}

/**
 * Smallest fraction of brush radius a `soft` drag's rim can bite in to.
 * 0.45 measured as the deepest bite that still reads as one round shape
 * rather than scattered cells.
 */
const SOFT_DRAG_MIN_REACH = 0.45;

/** Width of a ragged-edge lobe, in cells: about one world unit, so it stays that size across a re-sample. */
const SOFT_DRAG_LOBE_CELLS = WORLD_UNIT_CELLS;

/** Share of ragged-edge wander from the lobe octave vs. per-cell fringe. Must sum to 1 with the fringe's share. */
const SOFT_DRAG_LOBE_SHARE = 0.65;

/**
 * Stable [0, 1) per cell, keyed on coordinates not the stroke, so a held drag's ragged
 * edge stays ragged. Integer-only; MurmurHash3 mixers.
 */
function hashCell(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Two-octave noise: lobe (SOFT_DRAG_LOBE_CELLS) plus per-cell fringe, still in [0, 1). `floor` (not a shift) so negatives round consistently. */
function cellNoise(x: number, y: number): number {
  const lobe = hashCell(
    Math.floor(x / SOFT_DRAG_LOBE_CELLS),
    Math.floor(y / SOFT_DRAG_LOBE_CELLS),
  );
  return SOFT_DRAG_LOBE_SHARE * lobe + (1 - SOFT_DRAG_LOBE_SHARE) * hashCell(x, y);
}

/**
 * What (cx, cy) falls to when band `band` retreats: highest ground beside
 * it below the band's floor, or null (plateau interior). Mirrors
 * `canSpreadBandTo`; never invents a level.
 */
function retreatHeightAt(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): number | null {
  const floor = band * BAND_HEIGHT;
  let best: number | null = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      // Highest ceiling under the band, not top surface: a roof isn't ground to fall to.
      const h = highestCeilingBelow(map, nx, ny, floor);
      if (h === null) continue;
      if (best === null || h > best) best = h;
    }
  }
  return best;
}

/**
 * The drag region: filled to the grabbed band in waves via `canSpreadBandTo`; inward
 * drags retreat. A rim cell counts as rim only if it connects to ground outside (#152).
 */
function admitRimEnclaves(
  map: Heightmap,
  targetBand: number,
  refused: Set<number>,
  inDisc: Set<number>,
  disc: number[],
): void {
  const alreadyAtBand = (x: number, y: number): boolean => {
    const k = spanIndexCoveringBand(map, x, y, targetBand);
    return k !== null && bandOf(spanAt(map, x, y, k).ceiling) === targetBand;
  };
  // A refused cell an escape path may run through.
  const passable = (x: number, y: number): boolean =>
    inBounds(map, x, y) && refused.has(cellIndex(map, x, y)) && !alreadyAtBand(x, y);

  const reached = new Set<number>();
  const stack: number[] = [];
  const seed = (x: number, y: number): void => {
    if (!passable(x, y)) return;
    const i = cellIndex(map, x, y);
    if (reached.has(i)) return;
    reached.add(i);
    stack.push(i);
  };
  // Anything not in this region (or off-map). Asked of the region itself, not
  // a disc formula, since the region can be a union of swept discs.
  const outside = (x: number, y: number): boolean => {
    if (!inBounds(map, x, y)) return true;
    const i = cellIndex(map, x, y);
    return !inDisc.has(i) && !refused.has(i);
  };
  // Seeds are the region's boundary cells (not a `dist === radius - 1` ring,
  // which misses diagonal edge cells). Insertion order fixed by construction.
  for (const i of refused) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    if (outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1)) {
      seed(x, y);
    }
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    seed(x - 1, y);
    seed(x + 1, y);
    seed(x, y - 1);
    seed(x, y + 1);
  }
  // Enclaves: refused cells the flood never reached.
  for (const i of refused) {
    if (!reached.has(i)) disc.push(i);
  }
}

function applyDragRegion(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  raising: boolean,
  targetBand: number,
  profile: SculptProfile,
  sweepFrom: SweepOrigin | null,
  changed: Set<number>,
): void {
  const targetHeight = clampHeight(targetBand * BAND_HEIGHT);
  const ragged = profile === 'soft';

  // Pre-edit columns for touched cells only: lets pushLowerLayers tell a lip that was
  // already here from one this drag just built (pyramid bug).
  const priorSpans = new Map<number, readonly Span[]>();
  const record = (i: number): void => {
    if (!priorSpans.has(i)) priorSpans.set(i, readSpans(map, cellX(map.size, i), cellY(map.size, i)));
  };
  const hadCapAtBandBefore = (i: number, band: number): boolean => {
    const prior = priorSpans.get(i);
    if (prior !== undefined) return spansHaveCapAtBand(prior, band);
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    // Live and untouched: walk the column in place.
    const count = spanCount(map, x, y);
    for (let k = 0; k < count; k++) {
      if (bandOf(spanAt(map, x, y, k).ceiling) === band) return true;
    }
    return false;
  };

  // The footprint swept along the cursor path, not the disc at the cursor — one disc
  // per pointermove left gaps on a fast flick.
  const disc: number[] = [];
  const inDisc = new Set<number>();
  // Rim cells the noise refused. A cell refused at one sweep step but admitted at another is admitted.
  const refused = new Set<number>();
  const sweepDisc = (sx: number, sy: number): void => {
    forEachFootprintOffset(radius, (dx, dy, dist) => {
      const x = sx + dx;
      const y = sy + dy;
      if (!inBounds(map, x, y)) return;
      const i = cellIndex(map, x, y);
      if (inDisc.has(i)) return;
      // Ragged rim: each cell's own noise-share of the radius; deep cells always pass.
      if (ragged && dist >= radius * (SOFT_DRAG_MIN_REACH + (1 - SOFT_DRAG_MIN_REACH) * cellNoise(x, y))) {
        refused.add(i);
        return;
      }
      refused.delete(i);
      inDisc.add(i);
      disc.push(i);
    });
  };
  if (sweepFrom === null) sweepDisc(cx, cy);
  else forEachLineCell(sweepFrom.x, sweepFrom.y, cx, cy, sweepDisc);
  if (refused.size > 0) admitRimEnclaves(map, targetBand, refused, inDisc, disc);

  // Inward drag: cells at or above band k fall back to exposed ground, never past
  // `(k-1)·BAND_HEIGHT`. No cascade — a retreating lip crowds nothing.
  if (!raising) {
    // Swept to a fixpoint: cut cells expose the ones behind them. Terminates
    // because every write strictly lowers, so no cell is taken twice.
    let cutThisPass = true;
    while (cutThisPass) {
      cutThisPass = false;
      for (const i of disc) {
        const x = cellX(map.size, i);
        const y = cellY(map.size, i);
        // Lower land already exposed, or a level this column never owned.
        const k = spanIndexCoveringBand(map, x, y, targetBand);
        if (k === null) continue;
        const span = spanAt(map, x, y, k);
        // Defensive: spanIndexCoveringBand's contract already guarantees this.
        if (bandOf(span.ceiling) < targetBand) continue;
        const ground = retreatHeightAt(map, x, y, targetBand);
        // Interior of the plateau: no lip here to drag in.
        if (ground === null) continue;
        // Cut back to the band beneath the grab and never further.
        const exposed = Math.max(ground, (targetBand - 1) * BAND_HEIGHT);
        // A drag never removes a roof (D4): a span that would fall below its
        // own floor or thin past drawing stays standing.
        if (k > 0 && (exposed <= span.floor || !isSpanDrawn({ floor: span.floor, ceiling: exposed }))) {
          continue;
        }
        moveSpanCeiling(map, x, y, k, exposed);
        changed.add(i);
        cutThisPass = true;
      }
    }
    return;
  }

  // Swept to a fixpoint over the finite footprint; order within a pass doesn't matter.
  const raised: number[] = [];
  let filledThisPass = true;
  while (filledThisPass) {
    filledThisPass = false;
    for (const i of disc) {
      const x = cellX(map.size, i);
      const y = cellY(map.size, i);
      // `fill` says where material lands: ground below for open sky, a new
      // slab for a gap under this cell's own roof (`bandFillAt`, issue #224).
      const fill = bandFillAt(map, x, y, targetBand);
      if (fill === null) continue;
      if (!canSpreadBandTo(map, x, y, targetBand)) continue;
      record(i);
      applyBandFill(map, x, y, fill, targetHeight);
      changed.add(i);
      // Only 'extend' seeds the cascade — an overhang advances over air, crowding nothing.
      if (fill.kind === 'extend') raised.push(i);
      filledThisPass = true;
    }
  }

  // Carry the step: the level beneath gives ground too once crowded (pushLowerLayers).
  if (raised.length > 0) pushLowerLayers(map, raised, targetBand, hadCapAtBandBefore, record, changed);
}

/**
 * Nominal volume: a pure function of (radius, tool), never terrain, so both replicas
 * price identically. Nominal because some strokes move less and cost the same.
 */
export function sculptDisplacementUnits(radius: number, tool: SculptTool): number {
  assertBrushRadius(radius);

  // Carve is priced by radius alone, in full even when refused — pricing may not read
  // terrain. `tool` is required so it cannot default to brush pricing.
  if (tool === 'carve') {
    let cells = 0;
    forEachFootprintOffset(radius, () => {
      cells++;
    });
    return cells * CARVE_BANDS_PER_STROKE * BAND_HEIGHT;
  }

  // Core only: the apron is talus the rise implies, not a second stroke.
  let cells = 0;
  forEachFootprintOffset(radius, () => {
    cells++;
  });
  // |amount|: a lower costs what the raise that undoes it costs.
  const perCell =
    DEFAULT_SCULPT_AMOUNT < 0 ? -DEFAULT_SCULPT_AMOUNT : DEFAULT_SCULPT_AMOUNT;
  return cells * perCell;
}

/** Height interval a spill-contained cell may occupy for the rest of the stroke: the terrace band it started in (issue #26). */
interface SpillBand {
  readonly lo: number;
  readonly hi: number;
}

/** Band lookup for banded relaxation: null means free (unrestricted); a SpillBand caps the cell. */
type SpillBoundsOf = (index: number) => SpillBand | null;

/**
 * Both sides move by `e >> 1` (#108, sum-preserving). A capped pair moves by the
 * largest transfer both admit (#26), or is left over-steep.
 */
function movePair(
  cells: Int16Array,
  base: number,
  hiIdx: number,
  loIdx: number,
  e: number,
  boundsOf: SpillBoundsOf | null,
  spanCaps: ReadonlyMap<number, SpillBand> | null,
): boolean {
  // `base`: global index the working array starts at (0 for map.cells, band's first cell for a layer view).
  const hi = hiIdx - base;
  const lo = loIdx - base;
  // Exactly half each way (#108). Caller guarantees e >= 2.
  let drop = e >> 1;
  let rise = drop;
  if (boundsOf !== null || spanCaps !== null) {
    const hiBand = boundsOf === null ? null : boundsOf(hiIdx);
    const loBand = boundsOf === null ? null : boundsOf(loIdx);
    // How much of each half fits inside its side's band.
    let dropCap = hiBand === null ? drop : Math.min(drop, cells[hi] - hiBand.lo);
    let riseCap = loBand === null ? rise : Math.min(rise, loBand.hi - cells[lo]);
    // Layered cell's span bounds (step 4.6), intersected: span may not thin past drawing or weld to the span above.
    const hiSpan = spanCaps === null ? undefined : spanCaps.get(hiIdx);
    const loSpan = spanCaps === null ? undefined : spanCaps.get(loIdx);
    if (hiSpan !== undefined) dropCap = Math.min(dropCap, cells[hi] - hiSpan.lo);
    if (loSpan !== undefined) riseCap = Math.min(riseCap, loSpan.hi - cells[lo]);
    if (dropCap < drop || riseCap < rise) {
      const t = Math.min(dropCap, riseCap);
      // t < 0 (a cell already outside its bound, e.g. a pre-rule saved world)
      // would move the pair apart instead of together — refuse rather than risk it.
      if (t <= 0) return false;
      drop = t;
      rise = t;
    }
    if (drop === 0 && rise === 0) return false;
  }
  cells[hi] -= drop;
  cells[lo] += rise;
  return true;
}

/**
 * Triggers at excess >= 2, not MAX_STEP (#108): an excess of 1 moves nobody yet loops
 * forever. Every accepted pass strictly reduces total excess — the termination
 * argument.
 */
function relaxPair(
  cells: Int16Array,
  base: number,
  i: number,
  j: number,
  changed: Set<number>,
  boundsOf: SpillBoundsOf | null,
  layer: LayerView | null,
): boolean {
  // Open-neighbour exclusion (step 4.6): no ground at the grasped level, so out of relaxation entirely.
  if (layer !== null && (layer.excluded[i - base] === 1 || layer.excluded[j - base] === 1)) return false;
  const spanCaps = layer === null ? null : layer.spanCaps;
  const d = cells[i - base] - cells[j - base];
  let moved = false;
  if (d > MAX_STEP + RELAX_SLACK) {
    moved = movePair(cells, base, i, j, d - MAX_STEP, boundsOf, spanCaps);
  } else if (d < -(MAX_STEP + RELAX_SLACK)) {
    moved = movePair(cells, base, j, i, -d - MAX_STEP, boundsOf, spanCaps);
  }
  if (moved) {
    changed.add(i);
    changed.add(j);
  }
  return moved;
}

/**
 * Working heights for relaxation over a layered world (#129 step 4.6). `spanCaps` stops
 * a cell thinning past drawing or welding to the span above. Never closes a gap (D4).
 */
interface LayerView {
  readonly heights: Int16Array;
  readonly excluded: Uint8Array;
  readonly spanCaps: ReadonlyMap<number, SpillBand>;
  /**
   * Covers a band of whole rows, not the world (issue #275) — keeps the
   * sweep's stride arithmetic unchanged and bounds the copy to rows reached.
   */
  readonly base: number;
  readonly firstRow: number;
  readonly lastRow: number;
}

/** Rows kept above/below the sweep box so a view isn't rebuilt every pass. */
const LAYER_VIEW_SLACK_ROWS = 8;

/** Builds the view over `firstRow..lastRow`, growing from `previous` when given. */
function buildLayerView(
  map: Heightmap,
  spanBand: number | null,
  firstRow: number,
  lastRow: number,
  previous: LayerView | null,
): LayerView {
  const base = firstRow * map.size;
  const end = (lastRow + 1) * map.size;
  const heights = map.cells.slice(base, end);
  const excluded = new Uint8Array(end - base);
  const spanCaps = new Map<number, SpillBand>();
  // Unlayered columns resolve to span 0 in every case, whose ceiling is
  // `cells[i]` already; only layered columns need resolving.
  for (const i of map.columnSpans.keys()) {
    if (i < base || i >= end) continue;
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const k = layerSpanIndex(map, i, spanBand);
    if (k === null) {
      excluded[i - base] = 1;
      continue;
    }
    const span = spanAt(map, x, y, k);
    heights[i - base] = span.ceiling;
    const isTop = k === spanCount(map, x, y) - 1;
    spanCaps.set(i, {
      lo: spanLowestBandHeight(span),
      // Highest ceiling leaving a drawn gap under the span above (isGapDrawn).
      hi: isTop ? MAX_HEIGHT : spanUndersideHeight(spanAt(map, x, y, k + 1)) - 1,
    });
  }
  // Grown view inherits heights already moved by the sweep (map.cells isn't updated until commit).
  if (previous !== null) heights.set(previous.heights, previous.base - base);
  return { heights, excluded, spanCaps, base, firstRow, lastRow };
}

/** Writes the relaxed view back, once per changed column. */
function commitLayerView(map: Heightmap, view: LayerView, spanBand: number | null, changed: ReadonlySet<number>): void {
  for (const i of changed) {
    // Should always be inside the band; refuse loudly rather than read undefined (as setColumn does).
    const v = i - view.base;
    if (v < 0 || v >= view.heights.length) {
      throw new RangeError(`layer view does not cover changed cell ${i}`);
    }
    if (view.excluded[v] === 1) continue;
    if (!map.columnSpans.has(i)) {
      map.cells[i] = view.heights[v]!;
      continue;
    }
    const k = layerSpanIndex(map, i, spanBand);
    if (k === null) continue;
    moveSpanCeiling(map, cellX(map.size, i), cellY(map.size, i), k, view.heights[v]!);
  }
}

/**
 * Gradient-limit relaxation over a growing box. sum(cells) invariant (#108). At
 * SMOOTH_PASS_LIMIT the limit may stay locally violated.
 */
export function smooth(
  map: Heightmap,
  changed: Set<number>,
  bboxSeed?: ReadonlySet<number>,
  spillFree?: ReadonlySet<number>,
  anchorBounds?: ReadonlyMap<number, SpillBand>,
  spanBand: number | null = null,
): number {
  const seed = bboxSeed ?? changed;
  if (seed.size === 0) return 0;

  const { size } = map;
  // Banded strokes always need the LayerView; surface strokes only when a
  // layered column enters the box, adopted lazily (#275) — exact, since
  // otherwise layerSpanIndex resolves identically to map.cells.
  let layer: LayerView | null = null;
  let cells: Int16Array = map.cells;
  // 0 while working on map.cells; the band's first cell once a view is adopted.
  let viewBase = 0;

  /** Builds or grows the view over rows the sweep can reach, plus slack (issue #275). */
  const rebuildLayerView = (previous: LayerView | null): void => {
    const slack = previous === null
      ? LAYER_VIEW_SLACK_ROWS
      : Math.max(LAYER_VIEW_SLACK_ROWS, previous.lastRow - previous.firstRow + 1);
    let first = minY;
    let last = maxY;
    if (previous === null) {
      for (const i of changed) {
        const y = cellY(size, i);
        if (y < first) first = y;
        if (y > last) last = y;
      }
    } else {
      if (previous.firstRow < first) first = previous.firstRow;
      if (previous.lastRow > last) last = previous.lastRow;
    }
    first = Math.max(0, first - slack);
    last = Math.min(size - 1, last + slack);
    layer = buildLayerView(map, spanBand, first, last, previous);
    cells = layer.heights;
    viewBase = layer.base;
  };

  /** Grows the adopted view when the box has outrun the band it covers. */
  const growLayerView = (): void => {
    if (layer === null) return;
    if (minY < layer.firstRow || maxY > layer.lastRow) rebuildLayerView(layer);
  };

  const adoptLayerView = (x0: number, y0: number, width: number, height: number): void => {
    if (layer !== null) return;
    if (spanBand === null && !anyColumnLayered(map, x0, y0, width, height)) return;
    rebuildLayerView(null);
  };

  let boundsOf: SpillBoundsOf | null = null;
  if (spillFree !== undefined || anchorBounds !== undefined) {
    const captured = new Map<number, SpillBand>();
    boundsOf = (index: number): SpillBand | null => {
      // anchorBounds wins: more specific than spillFree's blanket freedom.
      const anchored = anchorBounds?.get(index);
      if (anchored !== undefined) return anchored;
      if (spillFree === undefined || spillFree.has(index)) return null;
      let band = captured.get(index);
      if (band === undefined) {
        // First touch: pins the pre-stroke band. No clamping needed —
        // relaxation moves strictly toward an in-range neighbour.
        const lo = bandOf(cells[index - viewBase]) * BAND_HEIGHT;
        band = { lo, hi: lo + BAND_HEIGHT - 1 };
        captured.set(index, band);
      }
      return band;
    };
  }

  // Bounding box of the initial edit.
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (const i of seed) {
    const x = cellX(size, i);
    const y = cellY(size, i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  adoptLayerView(minX, minY, maxX - minX + 1, maxY - minY + 1);

  let adjustingPasses = 0;
  for (let pass = 0; pass < SMOOTH_PASS_LIMIT; pass++) {
    const heldMinX = minX, heldMinY = minY, heldMaxX = maxX, heldMaxY = maxY;
    // One ring per pass: excess travels at most one cell per pass.
    if (minX > 0) minX--;
    if (minY > 0) minY--;
    if (maxX < size - 1) maxX++;
    if (maxY < size - 1) maxY++;

    // Box may now reach past the view's band; grow before reading the new ring.
    growLayerView();

    // Only the newly gained ring needs the layered-column test.
    if (minY < heldMinY) adoptLayerView(minX, minY, maxX - minX + 1, 1);
    if (maxY > heldMaxY) adoptLayerView(minX, maxY, maxX - minX + 1, 1);
    if (minX < heldMinX) adoptLayerView(minX, heldMinY, 1, heldMaxY - heldMinY + 1);
    if (maxX > heldMaxX) adoptLayerView(maxX, heldMinY, 1, heldMaxY - heldMinY + 1);

    let changedThisPass = false;

    for (let y = minY; y <= maxY; y++) {
      const row = y * size;
      for (let x = minX; x <= maxX; x++) {
        const i = row + x;
        // Each pair visited once, via its "forward" (right/down) neighbor.
        if (x < maxX && relaxPair(cells, viewBase, i, i + 1, changed, boundsOf, layer)) changedThisPass = true;
        if (y < maxY && relaxPair(cells, viewBase, i, i + size, changed, boundsOf, layer)) changedThisPass = true;
      }
    }

    if (!changedThisPass) break;
    adjustingPasses++;
  }
  if (layer !== null) commitLayerView(map, layer, spanBand, changed);
  return adjustingPasses;
}

/**
 * The complete sculpt: brush, relaxation, diff. Omitting `options` reproduces
 * pre-2026-08-14 behaviour, not the player default. Diff order is ascending cell index
 * — wire contract, not incidental Set order.
 */
function diffOf(map: Heightmap, changed: Set<number>): CellDiff[] {
  const indices = Array.from(changed).sort((a, b) => a - b);
  const diff: CellDiff[] = [];
  for (const i of indices) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    // Span list attached only when present. Read by cell index off the side table, per columns.ts's contract.
    const packed = map.columnSpans.get(i);
    const h = map.cells[i]!;
    diff.push(packed === undefined ? { x, y, h } : { x, y, h, spans: Array.from(packed) });
  }
  return diff;
}

/**
 * The carve (plan D6, #129 step 4.7): removes
 * `[(spanBand-1)·BAND_HEIGHT, (spanBand+CARVE_BANDS_PER_STROKE-1)·BAND_HEIGHT)`.
 * Anti-cheat: `canCarveBandAt` on every opened band. Cells collected before
 * any cut applies, so one intent can't admit its own neighbours.
 */
function applyCarve(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spanBand: number,
  changed: Set<number>,
): void {
  // Named rather than inlined so the bounds and the anti-cheat loop derive from the same pair.
  const lowestOpenedBand = spanBand;
  const highestOpenedBand = spanBand + CARVE_BANDS_PER_STROKE - 2;
  // Band k's drawn slab is [(k-1)·BAND_HEIGHT, k·BAND_HEIGHT] (bandOfPick's convention).
  const lo = (lowestOpenedBand - 1) * BAND_HEIGHT;
  const hi = (highestOpenedBand + 1) * BAND_HEIGHT;

  // No footing left under the cut. `<=` not `===`: stays right if MIN_BAND ever changes.
  if (lo <= BEDROCK_FLOOR) return;

  const admitted: number[] = [];
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    // Any overlap with [lo, hi) genuinely changes the column.
    let overlaps = false;
    const count = spanCount(map, x, y);
    for (let k = 0; k < count; k++) {
      const span = spanAt(map, x, y, k);
      if (span.floor < hi && lo < span.ceiling) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) return;
    for (let band = lowestOpenedBand; band <= highestOpenedBand; band++) {
      if (!canCarveBandAt(map, x, y, band)) return;
    }
    admitted.push(i);
  });

  for (const i of admitted) {
    carveRange(map, cellX(map.size, i), cellY(map.size, i), lo, hi);
    changed.add(i);
  }
}

export function applySculpt(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  options?: SculptOptions,
): CellDiff[] {
  const tool = options?.tool ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.tool;
  const profile = options?.profile ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.profile;
  const spill = options?.spill ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.spill;
  const anchor = options?.anchor ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor;
  const targetBand = options?.targetBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand;
  const spanBand = options?.spanBand ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand;
  const sweepFrom = options?.sweepFrom ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.sweepFrom;

  // Grasp resolved once, before any tool runs (#129 step 4.3). A band no
  // span covers is a whole-stroke no-op, not a fallback to the topmost span.
  if (spanBand !== null && spanIndexCoveringBand(map, cx, cy, spanBand) === null) {
    return [];
  }

  // Drag and carve dispatch before the band guard below, which tests only the centre
  // cell. Each tool's per-cell rule is the real anti-cheat.
  if (tool === 'carve') {
    const carveChanged = new Set<number>();
    if (spanBand !== null && amount < 0) {
      applyCarve(map, cx, cy, radius, spanBand, carveChanged);
    }
    return diffOf(map, carveChanged);
  }

  if (tool === 'drag') {
    const dragChanged = new Set<number>();
    if (targetBand !== null && amount !== 0) {
      applyDragRegion(map, cx, cy, radius, amount > 0, targetBand, profile, sweepFrom, dragChanged);
    }
    return diffOf(map, dragChanged);
  }

  // Without this, a refused band-anchored stroke still lets smooth's relaxation run —
  // it seeds from the footprint when the brush changed nothing (#12).
  if (anchor === 'band' && (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand))) {
    return [];
  }

  // The whole way to the grabbed band in one intent. Safe because canSpreadBandTo
  // proved the target adjacent: it cannot reach a height not already there.
  const strokeAmount =
    anchor === 'band' && amount !== 0
      ? (amount > 0 ? FULL_HEIGHT_SPAN : -FULL_HEIGHT_SPAN)
      : amount;

  const changed = new Set<number>();
  // Read before the brush writes, same derivation as the brushes themselves use.
  const anchoredSmooth = tool === 'smooth' && anchor !== 'free' && amount !== 0;
  const anchorTarget = anchoredSmooth
    ? anchoredTargetHeight(map, cx, cy, amount > 0, targetBand, spanBand)
    : 0;
  // The one dispatch: `hard` (either tool) or a soft+clicked+stamp core both
  // route to the level fill; radius names the core, soft adds the apron.
  const softCore = profile === 'soft' && anchor === 'clicked' && tool === 'stamp';
  // Read before the core writes: the centre is a core cell.
  const skirtCoreTarget = softCore
    ? anchoredTargetHeight(map, cx, cy, strokeAmount > 0, targetBand, spanBand)
    : 0;
  if (profile === 'hard' || softCore) {
    applyLevelFillBrush(map, cx, cy, radius, strokeAmount, changed, anchor, targetBand, spanBand);
  } else {
    applyBrush(map, cx, cy, radius, strokeAmount, changed, profile, anchor, targetBand, spanBand);
  }
  if (softCore) {
    applySoftApron(map, cx, cy, radius, strokeAmount, skirtCoreTarget, spanBand, changed);
  }
  // 'stamp' means no relaxation pass at all — the footprint is the whole edit.
  if (tool === 'smooth') {
    // Footprint serves two masters: bbox seed for a fully-clamped stroke (#12,
    // so a no-op brush still relaxes) and the spill-containment free set (#26).
    let footprint: Set<number> | undefined;
    if (changed.size === 0 || spill === 'banded' || anchoredSmooth) {
      const cells = new Set<number>();
      forEachFootprintCell(map, cx, cy, radius, (i) => cells.add(i));
      footprint = cells;
    }
    // Bounds footprint cells for relaxation: frozen past the target, else movable up to
    // it. Only the clicked cell, or `smooth` collapses into `stamp`.
    let anchorBounds: Map<number, SpillBand> | undefined;
    if (anchoredSmooth) {
      const raising = amount > 0;
      const clickedIndex = cellIndex(map, cx, cy);
      anchorBounds = new Map<number, SpillBand>();
      for (const i of footprint as Set<number>) {
        // The grasped layer's height, not the column's top: on a cave floor the
        // top is the roof, and bounding that would bound the wrong span.
        const k = layerSpanIndex(map, i, spanBand);
        if (k === null) continue;
        const h = graspedCeiling(map, i, k);
        if (raising ? h > anchorTarget : h < anchorTarget) {
          anchorBounds.set(i, { lo: h, hi: h });
        } else {
          anchorBounds.set(
            i,
            raising
              ? { lo: i === clickedIndex ? h : MIN_HEIGHT, hi: anchorTarget }
              : { lo: anchorTarget, hi: i === clickedIndex ? h : MAX_HEIGHT },
          );
        }
      }
    }
    smooth(
      map,
      changed,
      changed.size === 0 ? footprint : undefined,
      spill === 'banded' ? footprint : undefined,
      anchorBounds,
      spanBand,
    );
  }

  return diffOf(map, changed);
}
