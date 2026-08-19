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
  DEFAULT_SCULPT_AMOUNT,
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
 * How a sculpt treats the terrain AROUND its footprint (decision 2026-08-14).
 *
 * - `stamp`  — the brush changes exactly its footprint and nothing else. No
 *              relaxation pass runs, so repeated radius-1 raises stack into a
 *              true vertical spire and lowering digs a sheer pit. This is the
 *              player-facing default on the wire (see protocol.ts).
 * - `smooth` — brush THEN the gradient-limit relaxation: the Populous
 *              fabric-pull, kept verbatim as a deliberate blending tool and as
 *              the library default for API compatibility (plugins tuned their
 *              terraforms against relaxation).
 */
export type SculptTool = 'stamp' | 'smooth';

/**
 * How the brush distributes its amount ACROSS its footprint.
 *
 * - `soft` — the original linear falloff from the centre (design decision Q2).
 * - `hard` — LEVEL-FILLS, under either tool (decision 2026-08-14; widened
 *            from stamp-only to the whole profile 2026-08-19 — see
 *            applySculpt's supersession note): it finishes the lowest terrace
 *            band under the brush before starting the next one, giving
 *            plateaus and clean holes with sheer edges. See
 *            `applyLevelFillBrush` and the dispatch in `applySculpt`. (The
 *            flat per-cell delta this profile originally meant survives only
 *            in `brushDelta`, whose arithmetic still prices a hard sculpt —
 *            see sculptDisplacementUnits.)
 */
export type SculptProfile = 'soft' | 'hard';

/** Every valid tool, in wire/UI order. Validation and the HUD both read this. */
export const SCULPT_TOOLS: readonly SculptTool[] = ['stamp', 'smooth'];

/** Every valid profile, in wire/UI order. */
export const SCULPT_PROFILES: readonly SculptProfile[] = ['soft', 'hard'];

/**
 * How far the `smooth` tool's relaxation may move terrain OUTSIDE the brush
 * footprint (owner decision 2026-08-19, issue #26).
 *
 * - `banded` — the fabric-pull still drags neighbouring terrain, but a cell
 *              outside the footprint may only move WITHIN the terrace band it
 *              occupied when the stroke first touched it: the spill can slope
 *              ground, it can never create or erase a rendered level anywhere
 *              the player did not aim. This is what every PLAYER sculpt runs
 *              (see WIRE_DEFAULT_SCULPT_OPTIONS / sculptOptionsOf in
 *              protocol.ts — the wire never carries the field, because it is
 *              not the client's to choose).
 * - `free`   — the original unbounded relaxation, verbatim. The library
 *              default, for the same compatibility reason the library tool
 *              default is `smooth` (see LIBRARY_DEFAULT_SCULPT_OPTIONS):
 *              plugin terraforms were tuned against the unbounded spill.
 *
 * NOT a wire field: unlike tool/profile (which change what an edit looks
 * like), containment is a fairness rule, so it is fixed server-side and
 * mirrored into prediction through the one shared resolver.
 */
export type SculptSpill = 'banded' | 'free';

/** Caller-supplied sculpt options; every field defaults when absent. */
export interface SculptOptions {
  readonly tool?: SculptTool;
  readonly profile?: SculptProfile;
  readonly spill?: SculptSpill;
}

/** Sculpt options with nothing left to default — what the math actually runs. */
export interface ResolvedSculptOptions {
  readonly tool: SculptTool;
  readonly profile: SculptProfile;
  readonly spill: SculptSpill;
}

/**
 * What `applySculpt` runs when it is called WITHOUT options.
 *
 * COMPATIBILITY CONTRACT: this is deliberately NOT the player-facing default.
 * Every pre-2026-08-14 caller of applySculpt — the plugin `WorldApi.sculpt`
 * path above all — was written and tuned against brush + gradient relaxation,
 * so an absent options argument must keep reproducing that behaviour bit for
 * bit. The new player-facing default (stamp) lives on the wire instead:
 * `WIRE_DEFAULT_SCULPT_OPTIONS` in protocol.ts. Tested in heightmap.test.ts,
 * "an ABSENT options argument is byte-identical to explicit smooth+soft".
 */
export const LIBRARY_DEFAULT_SCULPT_OPTIONS: ResolvedSculptOptions = {
  tool: 'smooth',
  profile: 'soft',
  // 'free' for the same reason the tool is 'smooth': an absent options
  // argument must reproduce the pre-2026-08-14 behaviour bit for bit, and
  // that behaviour had no spill containment (issue #26 added it for PLAYER
  // sculpts only — see SculptSpill and WIRE_DEFAULT_SCULPT_OPTIONS).
  spill: 'free',
};

/**
 * THE BRUSH FOOTPRINT, DEFINED EXACTLY ONCE. Visits every offset `(dx, dy)`
 * whose integer distance `d = floor(sqrt(dx² + dy²))` from the centre is
 * `< radius`; offsets at `d >= radius` are not in the footprint and are never
 * visited. Math.sqrt is IEEE-exact and immediately floored, so the footprint is
 * identical on every platform, and the scan order (dy outer, dx inner, both
 * ascending) is part of the determinism contract — see the module header.
 *
 * WHY IT IS A FUNCTION AND NOT A LOOP EACH CALLER WRITES OUT. Three callers
 * must agree on this set of cells, and each disagreement is a real defect:
 *   applyBrush            — which cells one sculpt moves;
 *   applyLevelFillBrush   — which cells it SURVEYS for the fill level, and then
 *                           moves; surveying a different set than it edits is
 *                           how a "level" fill would leave a cell behind;
 *   sculptDisplacementUnits — what a sculpt COSTS, so a cell counted here but
 *                           never touched is mana charged for nothing.
 * These were three verbatim copies of one loop; one function is what makes
 * "they agree" a fact rather than a comment. EXPORTED (2026-08-14) for a
 * fourth consumer with the same must-agree stake: the client's brush-outline
 * preview (client/src/render/brushPreview.ts) — an outline drawn from any
 * other loop would promise cells the brush does not touch.
 *
 * The callback takes the OFFSET, not a cell: bounds are the caller's business
 * (sculptDisplacementUnits has no map at all — it prices an intent, not a
 * position, so a brush overhanging the map edge still costs full price).
 */
export function forEachFootprintOffset(
  radius: number,
  visit: (dx: number, dy: number, dist: number) => void,
): void {
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      const dist = Math.floor(Math.sqrt(dx * dx + dy * dy));
      if (dist >= radius) continue;
      visit(dx, dy, dist);
    }
  }
}

/**
 * `forEachFootprintOffset` narrowed to CELLS: turns each offset into an
 * absolute (x, y), drops it if off-map, and hands the caller the cell index
 * and distance directly. Built on top of forEachFootprintOffset so the scan
 * order and the `floor(sqrt) < radius` footprint test still exist exactly
 * once — this only adds the offset→bounds-check→index step, and adds it once.
 *
 * Off-map cells are excluded: a brush overhanging the map edge loses the
 * cells outside it, because they are not part of this world. That matters
 * beyond applyBrush — applyLevelFillBrush's survey pass and fill pass must
 * see exactly the same in-bounds set or the fill is not level (see its doc),
 * and sharing this iterator is what makes that true by construction.
 */
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
    if (!inBounds(map, x, y)) return; // brush overhanging the map edge
    visit(cellIndex(map, x, y), dist);
  });
}

/**
 * The per-cell delta a brush of `profile` applies at distance `dist` from its
 * centre, for a stroke of `amount` over the given `radius`. Shared by
 * applyBrush (which applies it) and sculptDisplacementUnits (which prices it)
 * so the two agree by construction rather than by review — see
 * sculptDisplacementUnits's doc for why that agreement matters.
 *
 * 'hard': the same flat delta everywhere in the footprint (sheer edges).
 * 'soft': linear falloff; trunc (toward zero) keeps raise/lower symmetric.
 * At radius 1 the two are identical — the footprint is the centre alone.
 */
function brushDelta(
  amount: number,
  radius: number,
  dist: number,
  profile: SculptProfile,
): number {
  return profile === 'hard' ? amount : Math.trunc((amount * (radius - dist)) / radius);
}

/**
 * The radius precondition every brush entry point shares. Untrusted input is
 * validated in protocol.ts; reaching the math with garbage is a programming
 * error, so this throws rather than clamping.
 */
function assertBrushRadius(radius: number): void {
  if (
    !Number.isInteger(radius) ||
    radius < MIN_BRUSH_RADIUS ||
    radius > MAX_BRUSH_RADIUS
  ) {
    throw new RangeError(`brush radius ${radius} outside [${MIN_BRUSH_RADIUS}, ${MAX_BRUSH_RADIUS}]`);
  }
}

/**
 * The full precondition set for a brush that touches terrain: an in-bounds
 * centre, a legal radius, an integer amount. Checked in that order so the
 * thrown message names the first thing wrong, exactly as before this was one
 * function rather than one copy per brush.
 */
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
 * Applies the sculpt brush over its footprint (see forEachFootprintOffset):
 * cells at integer distance `d = floor(sqrt(dx² + dy²))` from the centre with
 * `d < radius`. Cells at `d >= radius` are never touched by the brush itself.
 *
 * The per-cell delta depends on `profile`:
 *   soft — `trunc(amount * (radius - d) / radius)`: linear falloff, radius 1
 *          degenerating to the Populous point brush (design decision Q2).
 *   hard — `amount` at every footprint cell, edge included: a flat plateau or
 *          a clean hole with sheer edges (decision 2026-08-14).
 * `trunc` (toward zero) is what keeps raise and lower exact mirrors of each
 * other; `hard` is trivially symmetric for the same reason.
 *
 * Results clamp to [MIN_HEIGHT, MAX_HEIGHT].
 *
 * Changed cell indices are added to `changed` (for the caller to smooth and
 * diff). Throws on invalid center/radius — validation of untrusted input
 * happens in protocol.ts; reaching here with garbage is a programming error.
 *
 * NOT the whole story for the `hard` profile: applySculpt routes it (under
 * either tool, since 2026-08-19; stamp-only before that) to
 * applyLevelFillBrush instead. This function stays the plain per-cell-delta
 * brush the `soft` combinations (and every direct caller) run.
 */
export function applyBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  profile: SculptProfile = LIBRARY_DEFAULT_SCULPT_OPTIONS.profile,
): void {
  assertBrushArgs(map, cx, cy, radius, amount);

  // Each cell is written at most once, so the fixed scan order only matters for
  // reproducibility of the `changed` set's insertion order.
  forEachFootprintCell(map, cx, cy, radius, (i, dist) => {
    const delta = brushDelta(amount, radius, dist, profile);
    if (delta === 0) return;
    const h = clampHeight(map.cells[i] + delta);
    if (h !== map.cells[i]) {
      map.cells[i] = h;
      changed.add(i);
    }
  });
}

/**
 * THE LEVEL-FILL BRUSH — what the `hard` profile runs under either tool
 * (stamp-only 2026-08-14 → whole profile 2026-08-19, see applySculpt's
 * supersession note; the original owner request:
 * "I would also like the hard edge brush to only work at one level at a time
 * until it fills out everything at that level. So if I'm at level 2 and I'm
 * trying to fill out all the ground at a level 2, I don't want it to start
 * building level 3 until everything within that brush edge is level 2").
 *
 * SEMANTICS. Raising (`amount > 0`):
 *   1. SURVEY the footprint's in-bounds cells and take the LOWEST terrace band
 *      present, `minBand = min(bandOf(h))`.
 *   2. The target is the FLOOR OF THE NEXT BAND UP: `(minBand + 1) *
 *      BAND_HEIGHT`, clamped into the height range.
 *   3. Every cell already at or above the target is left completely alone.
 *      Every cell below it rises by `amount`, stopping AT the target — never
 *      through it.
 * Lowering (`amount < 0`) is the same algorithm with the extremes swapped: the
 * HIGHEST band present, the floor of the band below it, and only cells above
 * the target descend, stopping at it.
 *
 * The consequence the owner asked for: repeated strokes flatten the lowest
 * ground under the brush up to one uniform level, and only once every cell in
 * the footprint has reached that level does the next stroke start on the level
 * above. The brush can never build a step inside its own footprint.
 *
 * ONE BAND PER STROKE, EVEN IF `amount` IS BIGGER. `amount` is server
 * configuration and a plugin may modify it; the target clamp means a stroke
 * carrying two bands' worth of height still advances the footprint by one band.
 * That is the request ("don't start building level 3"), not an oversight — the
 * amount still governs the stroke on ground that is BELOW the target, which is
 * where a partially-filled level actually lives.
 *
 * RAISE AND LOWER ARE THE SAME OPERATION MIRRORED, exactly on the band-aligned
 * terrain the stamp tool produces (a footprint flat at `B * BAND_HEIGHT` goes to
 * `(B ± 1) * BAND_HEIGHT`). On terrain that is NOT band-aligned — only the
 * `smooth` tool's relaxation makes such heights — the two differ by the
 * half-open band convention `[B·H, (B+1)·H)` that `bandOf` (floor division)
 * defines and that terraced rendering draws. That is the right asymmetry to
 * have: a cell at height 70 renders on band 1, so lowering it must leave it
 * rendering on band 0, and raising it must leave it rendering on band 2. A
 * perfect negation mirror would instead drop it to 64 — still band 1, a stroke
 * with no visible effect.
 *
 * DETERMINISM. Integer-only throughout; both passes use the one fixed-order
 * footprint iterator; min/max over a set is order-independent anyway. Server and
 * client therefore land on identical cells (this is the whole point of shared/).
 *
 * Changed cell indices are added to `changed`, exactly as applyBrush does.
 * Throws on the same invalid arguments applyBrush throws on.
 */
export function applyLevelFillBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
): void {
  assertBrushArgs(map, cx, cy, radius, amount);
  // A zero-amount sculpt moves nothing and has no direction to fill in; without
  // this, the survey below would still run and pick a meaningless target.
  if (amount === 0) return;

  const raising = amount > 0;

  // PASS 1 — SURVEY. The extreme band across the footprint's in-bounds cells.
  // Off-map cells are excluded for the same reason applyBrush skips them: they
  // are not part of this world, so they cannot hold back a fill in it.
  let surveyed = false;
  let extremeBand = 0;
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    const band = bandOf(map.cells[i]);
    if (!surveyed) {
      extremeBand = band;
      surveyed = true;
      return;
    }
    if (raising ? band < extremeBand : band > extremeBand) extremeBand = band;
  });
  // assertBrushArgs proved the CENTRE is in bounds and the centre is always in
  // the footprint, so this cannot fire — belt and braces against a future
  // change to either fact leaving `extremeBand` an invented number.
  if (!surveyed) return;

  // The level being filled: the floor of the band adjacent to the extreme one.
  // ±1 band is the semantics, not a tunable — "the next level up/down" is what
  // the brush means, so there is no other value it could take.
  // Clamped here rather than per cell: the top band's ceiling (band 16 at
  // BAND_HEIGHT 64) is MAX_HEIGHT + BAND_HEIGHT, i.e. off the map's range, and
  // the same one band below MIN_HEIGHT.
  const targetHeight = clampHeight((extremeBand + (raising ? 1 : -1)) * BAND_HEIGHT);

  // PASS 2 — FILL. Same footprint, same order.
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    const h = map.cells[i];
    // Already at or past the level being filled: untouched. This is what stops
    // the brush from starting the next level while this one is unfinished.
    if (raising ? h >= targetHeight : h <= targetHeight) return;
    // Move by `amount`, but never THROUGH the target — that would build a step
    // above the level the stroke is filling, which is the whole thing this
    // brush exists to prevent.
    const moved = h + amount;
    const next = raising
      ? moved > targetHeight ? targetHeight : moved
      : moved < targetHeight ? targetHeight : moved;
    // `next` lies between `h` and the already-clamped `targetHeight`, so for
    // in-range terrain this clamp is a no-op; it is kept so that this brush
    // gives the same guarantee applyBrush does — nothing it writes is ever
    // outside [MIN_HEIGHT, MAX_HEIGHT] — whatever it was handed.
    const clamped = clampHeight(next);
    if (clamped !== h) {
      map.cells[i] = clamped;
      changed.add(i);
    }
  });
}

/**
 * HOW MUCH TERRAIN ONE SCULPT NOMINALLY MOVES: the sum, over the brush
 * footprint, of the ABSOLUTE per-cell delta a sculpt of DEFAULT_SCULPT_AMOUNT
 * would apply. Height units × cells — a volume, in the only units this project
 * has for one. Deterministic and integer, like every other number in here.
 *
 * WHY IT LIVES BESIDE applyBrush AND NOT IN THE PLUGIN THAT PRICES SCULPTS.
 * This is terrain math: it is the SAME loop, the same footprint test
 * (`floor(sqrt(dx² + dy²)) < radius`) and the same per-cell delta expression
 * (including the same `Math.trunc`) that applyBrush runs, and the two must
 * agree exactly or a price would be charged for an edit that never happens.
 * shared/ is where math that both sides must agree on lives (CLAUDE.md), and
 * the regression test in heightmap.test.ts pins this function against
 * applyBrush's own observed output for every radius × profile rather than
 * against a re-derivation of it.
 *
 * "NOMINALLY" — four deliberate exclusions, each of which would make the
 * number depend on WHERE the player clicked rather than on WHAT they asked for:
 *
 *   clamping     — a brush hitting MAX_HEIGHT moves less terrain than the same
 *                  brush in open ground. Pricing that would make a sculpt
 *                  cheaper exactly where it does nothing, which is a refund for
 *                  failure, not a discount.
 *   map edges    — a brush overhanging the border loses the cells outside it.
 *                  Same argument: the intent is identical, so the price is.
 *   relaxation   — the `smooth` tool's gradient-limit spill moves further
 *                  terrain still, and is DELIBERATELY FREE. `tool` is therefore
 *                  not a parameter here at all. This preserves exactly what the
 *                  flat per-sculpt price did before volume pricing (it ignored
 *                  the spill too), and it is the honest answer: the spill's size
 *                  depends on the terrain that is already there, so charging for
 *                  it would price the world's history rather than the player's
 *                  action, and would make an identical intent cost two different
 *                  amounts in two places.
 *   level fill   — the `hard` profile runs applyLevelFillBrush (under either
 *                  tool since 2026-08-19), which skips cells
 *                  already at the level being filled and stops the rest AT it,
 *                  so it moves at most (usually less than) the flat-delta volume
 *                  priced here. DECIDED 2026-08-14: the price does not move.
 *                  Two reasons, and the first is not a preference:
 *                    (a) THE PRICE MUST NOT DEPEND ON THE TERRAIN. The mana
 *                        plugin gates a stroke locally, on the client, before it
 *                        is sent (plugins/mana/pricing.ts), and the server
 *                        charges the same number. A level-fill's real volume is
 *                        a function of the heights under the brush — heights the
 *                        client holds only as base-plus-predictions, and not at
 *                        all in a locked chunk. Pricing it would make the gate
 *                        and the server disagree, which is exactly the phantom
 *                        stroke and clawback the shared price exists to remove.
 *                    (b) It is the same rule as `clamping` above: a stroke that
 *                        moves less because the ground was already level is not
 *                        a cheaper request, it is the same request landing on
 *                        flatter ground.
 *                  So a level-fill stroke displaces less and is priced the same.
 *
 * This function is therefore about `applyBrush`'s arithmetic specifically, and
 * is pinned to it by test rather than to whatever applySculpt dispatches to.
 *
 * The result is a pure function of (radius, profile), which is what lets the
 * client price an intent identically to the server without knowing the terrain.
 *
 * Throws on an out-of-range radius, exactly as applyBrush does.
 */
export function sculptDisplacementUnits(
  radius: number,
  profile: SculptProfile,
): number {
  assertBrushRadius(radius);

  let units = 0;
  // The footprint comes from the one iterator applyBrush uses, and the delta
  // comes from brushDelta, the one function applyBrush itself calls, with
  // `amount` fixed to DEFAULT_SCULPT_AMOUNT — the amount a sculpt intent
  // actually carries (it is server configuration, never client input, see
  // protocol.ts). Iteration order is irrelevant to a sum of non-negative
  // integers, but sharing the iterator AND the delta function is what keeps
  // "the cells priced are the cells brushed" true by construction rather than
  // by review.
  forEachFootprintOffset(radius, (_dx, _dy, dist) => {
    const delta = brushDelta(DEFAULT_SCULPT_AMOUNT, radius, dist, profile);
    // |delta|: raising and lowering displace the same volume, so a lower
    // costs exactly what the raise that undoes it costs. DEFAULT_SCULPT_AMOUNT
    // is positive today, so this branch is defensive — but the contract this
    // function states is "sum of ABSOLUTE deltas", and a plugin-configured
    // negative amount must not price out as a negative volume.
    units += delta < 0 ? -delta : delta;
  });
  return units;
}

/**
 * The height interval a spill-contained cell may occupy for the rest of the
 * stroke: the terrace band it was in when the stroke first touched it
 * (issue #26). `hi` is the band's last height, `lo * BAND_HEIGHT`-aligned;
 * bandOf(h) is constant over [lo, hi] by construction.
 */
interface SpillBand {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Band lookup for banded relaxation: null means the cell is FREE (inside the
 * brush footprint — unrestricted, exactly as before #26); a SpillBand means
 * the cell is outside the footprint and capped to it. The whole free/banded
 * dispatch below rides on this being null for the `free` spill mode, which is
 * what keeps that mode's arithmetic bit-identical to the pre-#26 code.
 */
type SpillBoundsOf = (index: number) => SpillBand | null;

/**
 * Moves the excess `e` (the amount a pair exceeds MAX_STEP by) between the
 * higher cell `hiIdx` and the lower cell `loIdx`: higher loses `floor(e/2)`,
 * lower gains the rest, leaving the pair at exactly MAX_STEP — the original
 * relaxation arithmetic, verbatim, when `boundsOf` is null.
 *
 * BANDED CLAMPING (issue #26). When either side is band-capped and its half
 * of the move does not fit, BOTH sides move by the same reduced amount `t`
 * (the largest transfer both caps admit) instead: the transfer stays coupled,
 * so the unrestricted side never keeps shedding height a capped neighbour
 * cannot absorb — uncoupled clamping would bleed a mound away at the brush
 * ring, one orphaned half-move per pass. When not even `t = 1` fits, the pair
 * is left alone and reported UNCHANGED, which is what lets the sweep still
 * converge (a capped pair that cannot move must not count as progress).
 *
 * STANDING RESIDUAL (issue #26, measured 2026-08-19): where a band cap binds,
 * the pair is left exceeding MAX_STEP — an over-steep wall at the brush ring.
 * Banded relaxation can NEVER repair it: the capped side cannot rise past its
 * band, and the coupled rule then refuses to move the free side either
 * (t = 0), so further banded smooth strokes leave the wall standing however
 * many are thrown at it (measured: hundreds of strokes, excess never falls).
 * It is removed only by deliberately LOWERING the high side — brush deltas
 * are uncapped inside the footprint — or by a 'free' (plugin) sculpt covering
 * it. That permanence is consistent with the game's own precedent: the stamp
 * tool deliberately builds sheer walls that relaxation never touches.
 *
 * REJECTED ALTERNATIVE: resolving a capped pair by moving ONLY the free side
 * down to `capped + MAX_STEP`. It would "repair" the wall by eroding the
 * mound at its ring (~25k height-units lost on a measured slope scenario) and
 * would cap every smooth-built structure at the ring's band + MAX_STEP —
 * a worse trade than a standing wall the player built on purpose.
 */
function movePair(
  cells: Int16Array,
  hiIdx: number,
  loIdx: number,
  e: number,
  boundsOf: SpillBoundsOf | null,
): boolean {
  let drop = e >> 1;
  let rise = e - drop;
  if (boundsOf !== null) {
    const hiBand = boundsOf(hiIdx);
    const loBand = boundsOf(loIdx);
    // How much of each half actually fits inside its side's band. A capture
    // happens before a cell's first move, and every later move stays inside
    // the captured band, so these can never be negative.
    const dropCap = hiBand === null ? drop : Math.min(drop, cells[hiIdx] - hiBand.lo);
    const riseCap = loBand === null ? rise : Math.min(rise, loBand.hi - cells[loIdx]);
    if (dropCap < drop || riseCap < rise) {
      const t = Math.min(dropCap, riseCap);
      drop = t;
      rise = t;
    }
    if (drop === 0 && rise === 0) return false;
  }
  cells[hiIdx] -= drop;
  cells[loIdx] += rise;
  return true;
}

/**
 * Relaxes one 4-neighbor pair toward the gradient limit: if `cells[i]` and
 * `cells[j]` differ by more than MAX_STEP, the higher of the two loses
 * `floor(e/2)` (`e` the excess over MAX_STEP) and the lower gains the rest,
 * leaving the pair at exactly MAX_STEP — subject to band caps when `boundsOf`
 * is non-null (see movePair). Both indices are added to `changed`, in (i, j)
 * caller order and even when one side's own delta rounded to zero — the
 * pre-#26 behaviour, kept so free mode's changed-set is bit-identical in
 * contents AND insertion order. Returns whether the pair was adjusted, so a
 * sweep can tell whether the pass changed anything.
 */
function relaxPair(
  cells: Int16Array,
  i: number,
  j: number,
  changed: Set<number>,
  boundsOf: SpillBoundsOf | null,
): boolean {
  const d = cells[i] - cells[j];
  let moved = false;
  if (d > MAX_STEP) {
    moved = movePair(cells, i, j, d - MAX_STEP, boundsOf);
  } else if (d < -MAX_STEP) {
    moved = movePair(cells, j, i, -d - MAX_STEP, boundsOf);
  }
  if (moved) {
    changed.add(i);
    changed.add(j);
  }
  return moved;
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
 * constants.ts) is a safety cap sized so every single-stroke cascade a player
 * can construct converges first (#12); if it is ever hit, the gradient
 * invariant may be locally violated until a later edit resumes relaxation —
 * accepted and documented residual, observable via the returned pass count.
 *
 * Every adjusted cell's index is added to `changed`. `bboxSeed`, when given,
 * supplies the cells the initial bounding box is computed from instead of
 * `changed` — the smooth tool passes the brush footprint when the brush
 * itself changed nothing (a fully clamped stroke), so the stroke still
 * relaxes the ground under the brush (#12).
 *
 * Returns the number of passes that adjusted at least one pair. A return
 * value strictly below SMOOTH_PASS_LIMIT proves a clean pass ran, i.e. the
 * cascade converged.
 *
 * INVARIANT (tested): starting from a map that satisfies the gradient limit,
 * applyBrush + smooth leaves no 4-neighbor pair exceeding MAX_STEP.
 * Relaxation moves values strictly toward each other, so it can never leave
 * [MIN_HEIGHT, MAX_HEIGHT] and never needs clamping.
 *
 * BANDED SPILL CONTAINMENT (issue #26). When `spillFree` is given, it is the
 * set of cells (the brush footprint) allowed to move without restriction;
 * every OTHER cell is capped, on the stroke's first touch of it, to the
 * terrace band it occupied at that moment — captured lazily because a cell
 * relaxation never reaches needs no bookkeeping, and a cell it does reach is
 * still at its pre-stroke height the first time it is looked at (only this
 * sweep moves cells, and every move goes through the same lookup first). The
 * MAX_STEP invariant above is then explicitly NOT guaranteed where a cap
 * binds — see movePair's ACCEPTED RESIDUAL note. Omitting `spillFree` is the
 * pre-#26 relaxation, bit for bit.
 */
export function smooth(
  map: Heightmap,
  changed: Set<number>,
  bboxSeed?: ReadonlySet<number>,
  spillFree?: ReadonlySet<number>,
): number {
  const seed = bboxSeed ?? changed;
  if (seed.size === 0) return 0;

  const { size, cells } = map;

  let boundsOf: SpillBoundsOf | null = null;
  if (spillFree !== undefined) {
    const captured = new Map<number, SpillBand>();
    boundsOf = (index: number): SpillBand | null => {
      if (spillFree.has(index)) return null;
      let band = captured.get(index);
      if (band === undefined) {
        // First touch: the cell is at its pre-stroke height (see the doc
        // above), so this pins the band the player saw before the stroke.
        // No clamping to [MIN_HEIGHT, MAX_HEIGHT]: relaxation moves cells
        // strictly toward a neighbour, which is itself in range, so a cap
        // endpoint outside the range is simply never reached.
        const lo = bandOf(cells[index]) * BAND_HEIGHT;
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

  let adjustingPasses = 0;
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
        if (x < maxX && relaxPair(cells, i, i + 1, changed, boundsOf)) changedThisPass = true;
        if (y < maxY && relaxPair(cells, i, i + size, changed, boundsOf)) changedThisPass = true;
      }
    }

    if (!changedThisPass) break;
    adjustingPasses++;
  }
  return adjustingPasses;
}

/**
 * The complete sculpt operation both sides run: brush → (relaxation) → diff.
 * The server runs it authoritatively and broadcasts the returned diff; the
 * client runs it for instant prediction and reconciles against that diff.
 * Diff order is ascending cell index — deterministic wire order.
 *
 * `options` picks the tool and the edge profile; the two are orthogonal, so
 * hard+smooth (level-fill, then let it slump) is a legal, meaningful combination.
 * The third field, `spill`, bounds how far the smooth tool's relaxation may
 * move terrain outside the footprint (see SculptSpill); it is meaningless for
 * `stamp`, which never touches an outside cell in the first place.
 * OMITTING `options` ENTIRELY reproduces the pre-2026-08-14 behaviour bit for
 * bit — see LIBRARY_DEFAULT_SCULPT_OPTIONS for why that, and not the new
 * player-facing default, is what an absent argument means.
 *
 * THE `hard` PROFILE ALWAYS LEVEL-FILLS (owner report, 2026-08-19), whatever
 * the tool: applyLevelFillBrush finishes the lowest band under the footprint
 * before starting the next one, and never lifts a cell already at or above
 * the fill target. Under `smooth`, relaxation then runs on the FILL's result
 * — fill-then-slump — so the brush itself can no longer push an adjacent
 * higher level's cells up a band ("I'm clicking on level six and it is
 * adjusting level seven … seven sometimes contracts like it's getting pushed
 * away. That does not feel natural" — the flat +amount delta was lifting the
 * band-7 cells inside the footprint to band 8, so band 7's own contour
 * retreated from the click).
 *
 * SUPERSEDED (2026-08-19, by the owner report above) — the level fill used to
 * be `stamp`+`hard` only, and the reasons hard+smooth kept the plain flat
 * delta were:
 *   - the `smooth` tool relaxes the footprint the instant the brush lifts, so a
 *     level it had just filled would be sloped again before it was drawn. "Fill
 *     this level flat" is a promise that tool cannot keep;
 *   - hard+smooth's meaning was settled in docs/DESIGN.md as "stamp a plateau,
 *     let it slump";
 *   - the owner's original request named the hard EDGE BRUSH: the stamp.
 * The first point is still true and still matters: relaxation may slope a
 * just-filled level, so "fill this level FLAT and leave it standing" remains
 * stamp+hard's promise alone. What the supersession changes is narrower and
 * is the part the flat delta got wrong: `hard` never STARTS the next level
 * anywhere, under either tool.
 *
 * DETERMINISM: both branches are integer-only over the same fixed iteration
 * order, so server and client predicting with the same options land on the
 * same cells. Predicting with DIFFERENT options than the server applies is a
 * mismatch like any other and resolves through normal reconciliation — which
 * is exactly why both sides normalise an intent through one shared function
 * (`sculptOptionsOf`, protocol.ts) rather than each defaulting for itself.
 */
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

  const changed = new Set<number>();
  // The one dispatch in the sculpt path. Both branches are integer-only over the
  // same footprint, and both sides of the prediction contract reach them through
  // this one function, so client and server cannot pick different branches.
  // `hard` dispatches on the PROFILE alone (2026-08-19 supersession above):
  // the level fill is what "hard" means now, under either tool.
  if (profile === 'hard') {
    applyLevelFillBrush(map, cx, cy, radius, amount, changed);
  } else {
    applyBrush(map, cx, cy, radius, amount, changed, profile);
  }
  // 'stamp' is the ABSENCE of the relaxation pass, not a variant of it: the
  // footprint is the entire extent of the edit, so a spire stays a spire.
  if (tool === 'smooth') {
    // The footprint set serves two masters, built by forEachFootprintCell —
    // the same offset→bounds-check→index step every brush runs, shared so the
    // agreement is structural (see forEachFootprintOffset's doc):
    //   - the bounding-box seed of a fully clamped stroke (#12): a brush that
    //     changed nothing (e.g. stroking a MAX_HEIGHT plateau) used to make
    //     the smooth tool a silent no-op that left standing cliffs
    //     unrelaxed; seeding from the footprint keeps the stroke's promise
    //     while `changed` (and the diff) still carries only cells relaxation
    //     actually moved;
    //   - the spill-containment free set (#26): the cells relaxation may move
    //     without a band cap.
    // Strokes with spill 'free' whose brush DID move cells keep the pre-#12
    // call shape (no footprint computed at all) bit for bit.
    let footprint: Set<number> | undefined;
    if (changed.size === 0 || spill === 'banded') {
      const cells = new Set<number>();
      forEachFootprintCell(map, cx, cy, radius, (i) => cells.add(i));
      footprint = cells;
    }
    smooth(
      map,
      changed,
      changed.size === 0 ? footprint : undefined,
      spill === 'banded' ? footprint : undefined,
    );
  }

  const indices = Array.from(changed).sort((a, b) => a - b);
  const diff: CellDiff[] = [];
  for (const i of indices) {
    diff.push({ x: cellX(map.size, i), y: cellY(map.size, i), h: map.cells[i] });
  }
  return diff;
}
