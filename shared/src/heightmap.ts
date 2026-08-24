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

/**
 * THE BAND RANGE THE WORLD CAN HOLD — the bands of its own height limits, so
 * these move with MIN_HEIGHT/MAX_HEIGHT and BAND_HEIGHT rather than restating
 * any of them. Used to bound a `targetBand` arriving off the wire (protocol.ts):
 * a band outside this range names no ground that could exist, so it is rejected
 * structurally rather than left to clamp into something plausible.
 */
export const MIN_BAND = bandOf(MIN_HEIGHT);
export const MAX_BAND = bandOf(MAX_HEIGHT);

/**
 * The furthest any single cell in a valid world can have to move: the whole
 * height range. What a `band`-anchored stroke uses as its amount — see
 * applySculpt — so "fill to the grabbed band" needs no special case in the
 * brushes, only an amount large enough that the target clamp is what stops it.
 * DERIVED, so it cannot fall behind a change to either limit.
 */
export const FULL_HEIGHT_SPAN = MAX_HEIGHT - MIN_HEIGHT;

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
 * - `drag`   — THE LAYER-EDGE PULL (owner decision 2026-08-24, issue #99, and
 *              the model Godus shipped as its first god power). Not a brush at
 *              all: the player grabs a terrace lip and pulls it sideways, and
 *              the edit is the REGION swept between where the lip was and
 *              where the cursor is. It changes how far a band extends and
 *              never which bands exist, so the vertical stays entirely the
 *              stamp's. See `applyDragRegion` for the region's exact shape and
 *              `DragPull` for what the wire carries.
 */
export type SculptTool = 'stamp' | 'smooth' | 'drag';

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
export const SCULPT_TOOLS: readonly SculptTool[] = ['stamp', 'smooth', 'drag'];

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

/**
 * What level a stroke's own brush writes are locked to (owner decision
 * 2026-08-19: raising must be "locked at that layer that I'm clicking on" —
 * the periphery of a brush must never end up above its centre).
 *
 * - `clicked` — the stroke computes ONE target level from the CENTRE cell's
 *               pre-stroke band: raising, the floor of the band above it;
 *               lowering, the floor of the band below it. Footprint cells
 *               already at/past that level are untouched; every other cell
 *               moves by its profile's delta but never past the target. This
 *               is what every PLAYER sculpt runs (WIRE_DEFAULT_SCULPT_OPTIONS)
 *               — for `soft` it caps the falloff cone, for `hard` it anchors
 *               the level fill to the clicked cell instead of the footprint
 *               survey (see applyLevelFillBrush's supersession note).
 * - `free`    — the unanchored originals, verbatim: soft's cone grows without
 *               a ceiling, hard's fill targets the footprint's own extreme
 *               band. The library default, for the same compatibility reason
 *               as `spill` (plugin terraforms were tuned against it).
 *
 * THE CEILING BINDS ONLY THE BRUSH'S OWN WRITES. The smooth tool's relaxation
 * afterwards is governed by `spill` alone: outside the footprint it is
 * band-capped ('banded') or unbounded ('free'); INSIDE the footprint it stays
 * unrestricted either way, exactly as before — slump may still redistribute
 * what the anchored brush deposited. The two options compose; neither reads
 * the other.
 *
 * `clicked` and `free` are NOT wire fields, same as `spill`: the anchor is what
 * clicking MEANS, not a brush shape, so it is fixed policy and mirrored into
 * prediction through the one shared resolver (sculptOptionsOf). `band` is the
 * exception, and the paragraph below it says why that is safe.
 *
 * - `band`   — THE DRAG ANCHOR (owner decision 2026-08-23: the drag tool owns
 *              the horizontal). The target is a band the player physically
 *              GRABBED — a terrace lip they clicked on — carried alongside as
 *              `targetBand`, and the level is that band's floor exactly:
 *              `targetBand · BAND_HEIGHT`, not one band off the cell under the
 *              cursor. That is the whole difference from `clicked`, and it is
 *              what lets a drag EXTEND an existing terrace over ground several
 *              bands below it instead of building a new step one band up.
 *
 *              A drag never changes WHICH bands exist, only how far one
 *              extends, and that is enforced by construction rather than by
 *              intent: `canSpreadBandTo` below requires the band to already be
 *              present in the cell's own neighbourhood, so the level can only
 *              ever creep outward from ground that is already at it.
 *
 * IT IS THE ONE ANCHOR THAT IS PARTLY CLIENT INPUT, unlike the two above
 * (which are fixed policy — see sculptOptionsOf in protocol.ts). It has to be:
 * the band comes from a lip the player picked out on screen, which is a fact
 * about their aim and not about the terrain alone. It is safe because the
 * server never trusts the number on its own — canSpreadBandTo re-derives, from
 * the server's own heightmap, whether that band is genuinely adjacent to the
 * cell being sculpted, and a band that is not simply does nothing.
 */
export type SculptAnchor = 'clicked' | 'free' | 'band';

/**
 * WHETHER BAND `band` MAY SPREAD ONTO CELL (cx, cy) — the drag anchor's whole
 * anti-cheat story, and the reason `targetBand` can be a wire field at all.
 *
 * True when any of the eight neighbours of (cx, cy) already stands at or above
 * `band · BAND_HEIGHT`. A band-anchored sculpt is therefore never a way to
 * conjure height: it can only pull a level onto ground that is already
 * touching that level, one cell at a time. Dragging a terrace across a plain
 * is a WALK — each intent extends the lip by one cell, and the next intent's
 * legality is created by the previous one's result — which is exactly the
 * "how far one extends" semantics, and it makes a forged `targetBand` on an
 * unrelated cell a no-op rather than an exploit.
 *
 * EIGHT NEIGHBOURS, NOT FOUR. The lip a player grabs is a marching-squares
 * contour over the cell lattice (see the client's layer-edge overlay), and
 * that contour cuts diagonally across a cell corner wherever the region turns.
 * With four-neighbour adjacency a drag following such a corner would stall on
 * a lip it is visibly touching, which reads as the tool breaking. Off-map
 * neighbours are simply absent — the world's border holds nothing up.
 *
 * Reads the map only; the caller decides what to do with a false answer (both
 * brushes treat it as "this stroke moves nothing").
 */
export function canSpreadBandTo(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): boolean {
  const threshold = band * BAND_HEIGHT;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      if (map.cells[cellIndex(map, nx, ny)]! >= threshold) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LAYER-EDGE DRAG (owner decision 2026-08-24, issues #99/#119/#120).
//
// WHY A REGION AND NOT A TRAIL. The first build painted the cells the cursor
// crossed, one per intent, each one legal only if the previous had landed. It
// produced a wandering one-cell ribbon with gaps, and the gaps were not a bug
// in the walk: a chain whose links are separate messages breaks whenever one
// link is dropped, and the server may drop one for reasons no client-side fix
// can reach. A drag's unit of meaning is a REGION, so the intent carries the
// region — absolute, idempotent, validated once. Re-sending the same stroke
// with a larger pull is a strict superset of the smaller one, which is what
// makes a dropped packet self-heal on the next pointer move instead of
// severing the stroke for good.
//
// WHY THE NORMAL IS FROZEN AT THE GRAB. The cursor cannot name the pull on its
// own. Sliding ALONG a lip would otherwise sweep a region sideways, and
// re-asking "which lip is under the cursor" mid-stroke would let the drag
// re-grab the edge it just built — the wander of #119, which is the edit
// chasing its own result. The client freezes the grabbed lip's outward normal
// on pointerdown and sends it with every intent of the stroke; only the
// ACROSS-EDGE component of the cursor's displacement becomes pull depth. This
// is the CAD "pull a wall" interaction, and it is the reason a drag is stable
// under its own edits.

/**
 * The fixed-point scale the frozen lip normal is expressed in: `normalX` and
 * `normalY` are a unit vector times this number, rounded to integers.
 *
 * FIXED POINT RATHER THAN A FLOAT PAIR because the normal crosses the wire and
 * then drives cell arithmetic on two machines that must agree bit for bit
 * (design §3.1). A float would be exact over the wire too, but every later
 * derivation from it would be a float chain; scaled integers keep the whole
 * region derivation in integer arithmetic apart from two documented divisions
 * (see `dragRayCell`).
 *
 * 1024 is chosen so the worst-case rounding of the normal — half a unit in
 * 1024 — stays well under one cell over the longest pull the radius allows,
 * and so `normalX² + normalY²` (~2²⁰) times a cell coordinate stays far inside
 * the exact-integer range of a double.
 */
export const DRAG_NORMAL_SCALE = 1024;

/**
 * The horizontal pull of a `drag` stroke: where the grabbed lip faced, and
 * where the player has pulled it to. Absolute — every intent in a stroke
 * describes the WHOLE pull so far, not the increment since the last one.
 */
export interface DragPull {
  /**
   * The grabbed lip's outward normal — the direction the terrace face looked
   * when the player grabbed it — as a unit vector scaled by
   * DRAG_NORMAL_SCALE. Frozen at pointerdown for the life of the stroke.
   */
  readonly normalX: number;
  readonly normalY: number;
  /**
   * The cell the cursor is over now, in world cell coordinates. Only its
   * component along the normal counts (see `dragPullDepth`); the along-lip
   * component is deliberately discarded, which is what stops a drag from
   * smearing when the hand wanders sideways.
   */
  readonly toX: number;
  readonly toY: number;
}

/** Caller-supplied sculpt options; every field defaults when absent. */
export interface SculptOptions {
  readonly tool?: SculptTool;
  readonly profile?: SculptProfile;
  readonly spill?: SculptSpill;
  readonly anchor?: SculptAnchor;
  /**
   * The band a `band`-anchored stroke fills toward — the terrace lip the
   * player grabbed. Meaningful ONLY with `anchor: 'band'`; null (and ignored)
   * for every other anchor, which derive their level from the clicked cell or
   * the footprint survey instead.
   */
  readonly targetBand?: number | null;
  /**
   * The horizontal pull of a `drag` stroke. Meaningful ONLY with
   * `tool: 'drag'`; null (and ignored) for the brushes, which have no lip to
   * move. A `drag` stroke with no pull is a no-op, not an error — that is the
   * state on the very first frame of a stroke, before the cursor has moved.
   */
  readonly drag?: DragPull | null;
}

/** Sculpt options with nothing left to default — what the math actually runs. */
export interface ResolvedSculptOptions {
  readonly tool: SculptTool;
  readonly profile: SculptProfile;
  readonly spill: SculptSpill;
  readonly anchor: SculptAnchor;
  /**
   * The band a `band`-anchored stroke fills toward — the terrace lip the
   * player grabbed. Meaningful ONLY with `anchor: 'band'`; null (and ignored)
   * for every other anchor, which derive their level from the clicked cell or
   * the footprint survey instead.
   */
  readonly targetBand: number | null;
  /**
   * The horizontal pull of a `drag` stroke. Meaningful ONLY with
   * `tool: 'drag'`; null (and ignored) for the brushes, which have no lip to
   * move. A `drag` stroke with no pull is a no-op, not an error — that is the
   * state on the very first frame of a stroke, before the cursor has moved.
   */
  readonly drag: DragPull | null;
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
  // 'free' by the same contract once more: the clicked-cell ceiling
  // (2026-08-19) is player-sculpt policy; plugin terraforms rely on the
  // unanchored cone/fill. See SculptAnchor.
  anchor: 'free',
  // No band to fill toward: only the 'band' anchor reads this, and the
  // library default is not it.
  targetBand: null,
  // No pull: only the 'drag' tool reads this, and the library default is not
  // it. Plugin terraforms are brushes and always will be — the drag is a
  // pointer gesture, and there is no pointer behind a plugin.
  drag: null,
};

/**
 * THE BRUSH FOOTPRINT, DEFINED EXACTLY ONCE. Visits every offset `(dx, dy)`
 * with `dx² + dy² < radius·(radius−1)` — a TIGHT integer disc — except
 * radius 1, which is the centre cell alone (the product is 0 there, and a
 * point brush is the point of radius 1). Integer arithmetic only, so the
 * footprint is identical on every platform, and the scan order (dy outer, dx
 * inner, both ascending) is part of the determinism contract — see the module
 * header.
 *
 * WHY r·(r−1) AND NOT r² (owner decision 2026-08-19: a rounder,
 * Populous-feeling brush). The old test, `floor(sqrt(dx²+dy²)) < r`, is
 * algebraically `dx²+dy² < r²`, and on the integer lattice that fills the
 * whole bounding square at small radii — radius 2 was a 3×3 block and
 * radius 3 a full 5×5, which is why the brush read as square. r·(r−1) is the
 * geometric-mean radius between r−1 and r, and it carves the corners off at
 * every size:
 *
 *   radius 1 →  1 cell  (centre; special-cased)
 *   radius 2 →  5 cells (the plus/diamond — the old 3×3 minus its corners)
 *   radius 3 → 21 cells (5×5 minus its 4 corners)
 *   radius 4 → 37 cells (rounded octagon; the old shape kept its corners)
 *
 * `dist` handed to the callback is unchanged — `floor(sqrt(dx²+dy²))`, the
 * soft profile's falloff ring index — only MEMBERSHIP tightened.
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
  if (radius === 1) {
    // r·(r−1) = 0 would exclude even the centre; radius 1 IS the point brush.
    visit(0, 0, 0);
    return;
  }
  const discBound = radius * (radius - 1);
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      const dSquared = dx * dx + dy * dy;
      if (dSquared >= discBound) continue;
      visit(dx, dy, Math.floor(Math.sqrt(dSquared)));
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
 * THE ANCHOR TARGET — the one derivation of "the level the clicked cell
 * implies": the floor of the band adjacent (above when raising, below when
 * lowering) to the CENTRE cell's band, clamped into the height range. Read
 * from the map BEFORE any write of the stroke — the centre is itself a
 * footprint cell, and a target computed after it moved would anchor the
 * stroke to the wrong band.
 *
 * Extracted (2026-08-19, owner bug report) because THREE call sites must
 * agree bit for bit or the anchored stroke contradicts itself: applyBrush's
 * ceiling, applyLevelFillBrush's fill level, and applySculpt's relaxation
 * containment for anchored smooth strokes.
 */
function anchoredTargetHeight(
  map: Heightmap,
  cx: number,
  cy: number,
  raising: boolean,
  targetBand: number | null = null,
): number {
  // THE DRAG CASE (`anchor: 'band'`, 2026-08-23). The player grabbed a lip, so
  // the level is that band's own floor — NOT one band off whatever happens to
  // lie under the cursor. `raising` is deliberately unread here: which way the
  // ground has to move to reach a grabbed level is a consequence of where it
  // already is, not a separate choice, and fillTowardTarget/applyBrush already
  // leave cells at or past the target alone.
  if (targetBand !== null) return clampHeight(targetBand * BAND_HEIGHT);
  return clampHeight(
    (bandOf(map.cells[cellIndex(map, cx, cy)]) + (raising ? 1 : -1)) * BAND_HEIGHT,
  );
}

/**
 * Applies the sculpt brush over its footprint — the tight integer disc
 * forEachFootprintOffset defines. Cells outside the footprint are never
 * touched by the brush itself.
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
 *
 * THE CLICKED-CELL CEILING (`anchor: 'clicked'`, owner decision 2026-08-19:
 * "everything at the edge or peripheral of that brush should not be going
 * higher than the center of the brush, like it should be locked at that layer
 * that I'm clicking on"). Raising, the target is the floor of the band above
 * the CENTRE cell's pre-stroke band; cells already at/above it are untouched,
 * every other cell's falloff delta stops AT it. Lowering mirrors (the floor of
 * the band below; cells at/below it untouched). The soft cone therefore fills
 * toward the level the player pointed at instead of stacking past it wherever
 * the ground under the falloff already ran high. `'free'` (the default, for
 * the library-compatibility contract) is the pre-2026-08-19 arithmetic, bit
 * for bit — the target computation does not even run.
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
): void {
  assertBrushArgs(map, cx, cy, radius, amount);

  // THE DRAG'S SPREAD RULE (`anchor: 'band'`): a grabbed level may only creep
  // onto ground that already touches it. Checked before anything is written,
  // from the map alone, so a forged band on an unrelated cell moves nothing.
  if (anchor === 'band' && (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand))) {
    return;
  }

  // The ceiling/floor is pinned from the centre BEFORE any write: the centre
  // is itself a footprint cell, and computing the target mid-scan (after the
  // centre moved) would anchor the periphery to the wrong band. amount === 0
  // has no direction to anchor and writes nothing anyway.
  const raising = amount > 0;
  const anchored = anchor !== 'free' && amount !== 0;
  const target = anchored ? anchoredTargetHeight(map, cx, cy, raising, targetBand) : 0;

  // Each cell is written at most once, so the fixed scan order only matters for
  // reproducibility of the `changed` set's insertion order.
  forEachFootprintCell(map, cx, cy, radius, (i, dist) => {
    const delta = brushDelta(amount, radius, dist, profile);
    if (delta === 0) return;
    const before = map.cells[i];
    if (anchored && (raising ? before >= target : before <= target)) return;
    let moved = before + delta;
    if (anchored) {
      moved = raising
        ? moved > target ? target : moved
        : moved < target ? target : moved;
    }
    const h = clampHeight(moved);
    if (h !== before) {
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
 *
 * THE ANCHOR (2026-08-19, second decision of the day — supersedes the SURVEY
 * for player sculpts). With `anchor: 'clicked'` the fill level is derived
 * from the CENTRE cell's pre-stroke band — the level the player is pointing
 * at — and the survey pass does not run at all. The owner chose this knowing
 * the trade: a hole under the brush's edge no longer holds the fill back the
 * way the original 2026-08-14 request ("don't start building level 3 until
 * everything within that brush edge is level 2") had it — the brush builds
 * toward the CLICKED level over whatever lies beneath, and low cells simply
 * rise by `amount` toward it. `'free'` (the default) keeps the surveyed
 * extreme, bit for bit, for direct library callers.
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
): void {
  assertBrushArgs(map, cx, cy, radius, amount);
  // A zero-amount sculpt moves nothing and has no direction to fill in; without
  // this, the survey below would still run and pick a meaningless target.
  if (amount === 0) return;

  // THE DRAG'S SPREAD RULE — see canSpreadBandTo, and applyBrush's identical
  // guard. Both brushes carry it because both are reachable with this anchor.
  if (anchor === 'band' && (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand))) {
    return;
  }

  const raising = amount > 0;

  if (anchor !== 'free') {
    // ANCHORED: the level the player pointed at ('clicked') or grabbed
    // ('band'), read before any write — the same derivation the other two
    // anchored call sites use.
    const targetHeight = anchoredTargetHeight(map, cx, cy, raising, targetBand);
    fillTowardTarget(map, cx, cy, radius, amount, changed, raising, targetHeight);
    return;
  }

  let extremeBand = 0;
  {
    // PASS 1 — SURVEY. The extreme band across the footprint's in-bounds cells.
    // Off-map cells are excluded for the same reason applyBrush skips them: they
    // are not part of this world, so they cannot hold back a fill in it.
    let surveyed = false;
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
  }

  // The level being filled: the floor of the band adjacent to the extreme one.
  // ±1 band is the semantics, not a tunable — "the next level up/down" is what
  // the brush means, so there is no other value it could take.
  // Clamped here rather than per cell: the top band's ceiling (band 16 at
  // BAND_HEIGHT 64) is MAX_HEIGHT + BAND_HEIGHT, i.e. off the map's range, and
  // the same one band below MIN_HEIGHT.
  const targetHeight = clampHeight((extremeBand + (raising ? 1 : -1)) * BAND_HEIGHT);
  fillTowardTarget(map, cx, cy, radius, amount, changed, raising, targetHeight);
}

/**
 * PASS 2 of the level fill — one footprint sweep moving every cell short of
 * `targetHeight` by `amount`, stopping AT the target, leaving cells at or past
 * it untouched. Shared by both of applyLevelFillBrush's target derivations
 * (anchored and surveyed) so the fill semantics cannot fork between them.
 */
function fillTowardTarget(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  raising: boolean,
  targetHeight: number,
): void {
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
 * HOW FAR THE LIP HAS BEEN PULLED, in cells, along the frozen normal.
 *
 * Only the ACROSS-EDGE component of the cursor's displacement counts: the dot
 * product with the frozen normal, divided back out of DRAG_NORMAL_SCALE. The
 * along-lip component is discarded, which is the whole reason sliding sideways
 * over a lip does nothing (see the drag header above).
 *
 * Integer in, integer out. `dot` is an exact integer (cell offsets times a
 * scaled unit vector, both far inside the exact range of a double), and
 * DRAG_NORMAL_SCALE is a power of two, so the division is exact in binary
 * floating point and the floor merely takes the integer part. Identical on
 * every platform, which is what the determinism contract needs.
 *
 * Zero or negative means the cursor is level with the lip or behind it — no
 * pull at all, and an outward drag does nothing.
 */
function dragPullDepth(gx: number, gy: number, drag: DragPull): number {
  const dot = (drag.toX - gx) * drag.normalX + (drag.toY - gy) * drag.normalY;
  return Math.floor(dot / DRAG_NORMAL_SCALE);
}

/**
 * The cell `j` steps out along the normal and `t` steps along the lip from the
 * grabbed cell.
 *
 * The tangent is the normal rotated a quarter turn — (−normalY, normalX) — so
 * both axes carry the same DRAG_NORMAL_SCALE and one division serves both.
 *
 * EXACT, NOT MERELY DETERMINISTIC-IN-PRACTICE: DRAG_NORMAL_SCALE is a power of
 * two and every numerator is an exact integer, so `num / DRAG_NORMAL_SCALE` is
 * exact in binary floating point; `+ 0.5` then `Math.floor` is round-half-up
 * over an exact value. There is no platform-dependent rounding anywhere in the
 * expression.
 */
function dragRayCell(
  gx: number,
  gy: number,
  drag: DragPull,
  j: number,
  t: number,
): { x: number; y: number } {
  const numX = drag.normalX * j - drag.normalY * t;
  const numY = drag.normalY * j + drag.normalX * t;
  return {
    x: gx + Math.floor(numX / DRAG_NORMAL_SCALE + 0.5),
    y: gy + Math.floor(numY / DRAG_NORMAL_SCALE + 0.5),
  };
}

/**
 * THE DRAG REGION — every cell the grabbed lip has been pulled across, filled
 * to the grabbed band's floor.
 *
 * SHAPE. A fan of rays: one per step `t` along the lip, over the span the
 * brush radius names, each running `j = 1…depth` cells outward along the
 * frozen normal. The profile decides how the depth varies along that span, and
 * it is the SAME axis the brushes already use for their footprint edge (owner
 * decision 2026-08-24):
 *
 * - `soft` — the pull tapers to nothing at the ends of the span, so the lip
 *            bulges into a bay. The falloff is `brushDelta`'s verbatim —
 *            `trunc(depth · (radius − |t|) / radius)` — because "soft edge"
 *            must mean one thing in this codebase, not two.
 * - `hard` — the full pull across the whole span, so the lip moves as a
 *            straight front with square ends.
 *
 * RAISE ONLY (2026-08-24). Pulling a lip INWARD is the same gesture with the
 * sign flipped, but it is the direction where the stop rule has to be real
 * code: dropping a cell to band k−1 when it actually stands at band 6 would
 * strip everything above it. Issue #99 step 3. A lowering drag is a no-op here
 * rather than an approximation of one.
 *
 * WHY A RAY STOPS. Two conditions end a ray early, and both are the owner's
 * "a drag stops at a higher band's edge, it does not strip the ground standing
 * on it":
 *
 * 1. The cell already stands AT OR ABOVE the grabbed band. The pull is blocked
 *    by that ground; it does not skip over it and resume on the far side,
 *    which would leave a band-k island beyond a mesa the player never crossed.
 * 2. `canSpreadBandTo` refuses the cell. This is the same anti-cheat rule the
 *    band anchor has always run — a grabbed band may only creep onto ground it
 *    already touches — re-derived here from the SERVER's own heightmap, so a
 *    forged normal or a forged `toX/toY` can at worst waste the sender's own
 *    intent. It is what keeps "clients send intents, never heights" true of a
 *    message that names a band and a direction.
 *
 * The region is ABSOLUTE and IDEMPOTENT: it is derived entirely from the grab
 * cell, the frozen normal, the cursor cell and the radius, none of which
 * depend on what any earlier intent did. Applying the same drag twice changes
 * nothing the second time (every cell is already at the band), and applying a
 * deeper pull is a strict superset of a shallower one. That is what makes a
 * dropped intent heal on the next pointer move instead of severing the stroke
 * — the failure that killed the per-cell chain (issue #120).
 */
function applyDragRegion(
  map: Heightmap,
  gx: number,
  gy: number,
  radius: number,
  raising: boolean,
  targetBand: number,
  drag: DragPull,
  profile: SculptProfile,
  changed: Set<number>,
): void {
  // Inward drags are step 3 of issue #99 and deliberately do nothing yet.
  if (!raising) return;

  const depth = dragPullDepth(gx, gy, drag);
  if (depth <= 0) return;

  const targetHeight = clampHeight(targetBand * BAND_HEIGHT);
  // The lip stretch the grab covers, in cells either side of it. Radius 1 is
  // the single-ray drag for the same reason it is the single-cell brush.
  const halfSpan = radius - 1;

  // Scan order is part of the determinism contract, exactly as the brush
  // footprint's is (see forEachFootprintOffset): `t` ascending outer, `j`
  // ascending inner. `j` ascending is also load-bearing rather than merely
  // fixed — each cell a ray fills becomes the neighbour that lets
  // canSpreadBandTo admit the next one, so a ray extends the band outward one
  // step at a time instead of teleporting it.
  for (let t = -halfSpan; t <= halfSpan; t++) {
    const rayDepth =
      profile === 'hard'
        ? depth
        : // trunc (toward zero) for the same reason brushDelta uses it: it
          // keeps the two directions symmetric. depth is positive here, so
          // this is a floor, but the convention is the shared one.
          Math.trunc((depth * (radius - (t < 0 ? -t : t))) / radius);
    for (let j = 1; j <= rayDepth; j++) {
      const cell = dragRayCell(gx, gy, drag, j, t);
      // Off the world: the ray has run out of land, and there is nothing
      // beyond the edge for a later step to reach either.
      if (!inBounds(map, cell.x, cell.y)) break;
      const i = cellIndex(map, cell.x, cell.y);
      const h = map.cells[i]!;
      // Stop 1: higher ground blocks the pull (see the doc above).
      if (h >= targetHeight) {
        // Ground already AT the band is the lip itself, or land an earlier
        // ray already filled — the pull passes through it rather than being
        // blocked by it. Only ground standing ABOVE the band stops the ray.
        if (h > targetHeight) break;
        continue;
      }
      // Stop 2: the band does not reach this cell, so it may not be spread
      // there. Re-derived from the map, never trusted from the wire.
      if (!canSpreadBandTo(map, cell.x, cell.y, targetBand)) break;
      map.cells[i] = targetHeight;
      changed.add(i);
    }
  }
}

/**
 * HOW MUCH TERRAIN ONE SCULPT NOMINALLY MOVES: the sum, over the brush
 * footprint, of the ABSOLUTE per-cell delta a sculpt of DEFAULT_SCULPT_AMOUNT
 * would apply. Height units × cells — a volume, in the only units this project
 * has for one. Deterministic and integer, like every other number in here.
 *
 * WHY IT LIVES BESIDE applyBrush AND NOT IN THE PLUGIN THAT PRICES SCULPTS.
 * This is terrain math: it is the SAME loop, the same footprint test (the
 * tight disc in forEachFootprintOffset) and the same per-cell delta expression
 * (including the same `Math.trunc`) that applyBrush runs, and the two must
 * agree exactly or a price would be charged for an edit that never happens.
 * shared/ is where math that both sides must agree on lives (CLAUDE.md), and
 * the regression test in heightmap.test.ts pins this function against
 * applyBrush's own observed output for every radius × profile rather than
 * against a re-derivation of it.
 *
 * "NOMINALLY" — five deliberate exclusions, each of which would make the
 * number depend on WHERE the player clicked rather than on WHAT they asked for:
 *
 *   anchor       — the clicked-cell ceiling (`anchor: 'clicked'`, 2026-08-19)
 *                  stops the brush's own deltas at the level above/below the
 *                  centre's band, so an anchored stroke usually moves less
 *                  than the flat cone priced here. Same rule and same two
 *                  reasons as `level fill` below: the ceiling's bite depends
 *                  on the terrain under the brush, which the client cannot be
 *                  required to know to agree on a price.
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
 *
 * ANCHOR CONTAINMENT (2026-08-19, owner bug report "smooth, soft appears to
 * be broken"). When `anchorBounds` is given (applySculpt builds it for
 * anchored smooth strokes, one entry per footprint cell), those cells are
 * bounded INSIDE the footprint too: relaxation may not carry any footprint
 * cell past the stroke's anchor target, and may not move at all a cell that
 * started past it — the cells the anchored brush promised to leave alone
 * (the higher terrace under a raising brush) can no longer be eroded by the
 * relaxation pass that follows it. Where a bound bites, the pair is left
 * over-steep — the SAME accepted residual as the banded spill above, for the
 * same reason: the wall the player deliberately kept is not relaxation's to
 * repair. `anchorBounds` takes precedence over `spillFree` membership; cells
 * in neither behave exactly as before.
 */
export function smooth(
  map: Heightmap,
  changed: Set<number>,
  bboxSeed?: ReadonlySet<number>,
  spillFree?: ReadonlySet<number>,
  anchorBounds?: ReadonlyMap<number, SpillBand>,
): number {
  const seed = bboxSeed ?? changed;
  if (seed.size === 0) return 0;

  const { size, cells } = map;

  let boundsOf: SpillBoundsOf | null = null;
  if (spillFree !== undefined || anchorBounds !== undefined) {
    const captured = new Map<number, SpillBand>();
    boundsOf = (index: number): SpillBand | null => {
      // Anchored footprint cells carry their own interval; it wins over the
      // footprint's blanket freedom because it is strictly more specific —
      // the whole reason it exists is to bound cells `spillFree` would free.
      const anchored = anchorBounds?.get(index);
      if (anchored !== undefined) return anchored;
      if (spillFree === undefined || spillFree.has(index)) return null;
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
 * `stamp`, which never touches an outside cell in the first place. The
 * fourth, `anchor`, locks the brush's own writes to the level the clicked
 * cell implies (see SculptAnchor) — it governs the brush pass, never the
 * relaxation, so the two compose without reading each other.
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
/**
 * The broadcast diff for a set of changed cell indices, in ASCENDING INDEX
 * ORDER. The order is part of the contract, not an accident of the Set: both
 * sides of the prediction compare these diffs, and two orderings of the same
 * cells are two different messages.
 *
 * Shared by every exit from applySculpt — the brushes and the drag — so the
 * two cannot disagree about what an applied edit looks like on the wire.
 */
function diffOf(map: Heightmap, changed: Set<number>): CellDiff[] {
  const indices = Array.from(changed).sort((a, b) => a - b);
  const diff: CellDiff[] = [];
  for (const i of indices) {
    diff.push({ x: cellX(map.size, i), y: cellY(map.size, i), h: map.cells[i]! });
  }
  return diff;
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
  const drag = options?.drag ?? LIBRARY_DEFAULT_SCULPT_OPTIONS.drag;

  // THE DRAG'S SPREAD RULE, DECIDED FOR THE WHOLE STROKE (2026-08-23). Both
  // brushes carry the same guard, but the decision belongs here too: a refused
  // drag must be a NO-OP, and returning from the brush alone would still let
  // the smooth tool's relaxation run (it seeds from the footprint when the
  // brush changed nothing — issue #12) and reshape terrain the stroke was not
  // allowed to touch. Belt and suspenders: this bounds the stroke, the brush
  // guards bound the brush, and neither depends on the other being right.
  if (anchor === 'band' && (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand))) {
    return [];
  }

  // THE DRAG IS ITS OWN EDIT, NOT A BRUSH VARIANT (owner decision 2026-08-24).
  // It shares this entry point on purpose — the server pipeline, the client's
  // prediction store and the brush preview all reach the sculpt through
  // applySculpt, so a drag that returned here would have needed three new call
  // sites to agree with each other, which is exactly the drift the one
  // dispatch below exists to prevent. What it does NOT share is the brush: no
  // footprint disc, no per-cell amount, and no relaxation pass, because the
  // drag moves a level sideways and the vertical belongs to the stamp.
  //
  // A drag with no band or no pull is a NO-OP rather than a fallback to a
  // brush: silently stamping where the player asked to drag would apply a
  // differently-shaped edit than the sender predicted, and desync the
  // prediction for a round trip (the same argument protocol.ts's validator
  // makes for rejecting an unknown tool outright).
  if (tool === 'drag') {
    const dragChanged = new Set<number>();
    if (targetBand !== null && drag !== null && amount !== 0) {
      applyDragRegion(
        map,
        cx,
        cy,
        radius,
        amount > 0,
        targetBand,
        drag,
        profile,
        dragChanged,
      );
    }
    return diffOf(map, dragChanged);
  }

  // A DRAG ARRIVES IN ONE INTENT (owner decision 2026-08-23, after the first
  // build felt wrong: "grab the lip and pull the terrace out to here" has to
  // finish in one pass). Every other stroke moves by `amount` — one band per
  // click, the server's own DEFAULT_SCULPT_AMOUNT — and repeats to climb; a
  // drag that did the same would raise each cell the cursor crossed by a
  // single band, so extending a band-6 terrace would mean sweeping the same
  // ground six times. A drag instead moves each cell ALL THE WAY to the band
  // the player grabbed, in one go.
  //
  // THIS IS NOT A STRONGER SCULPT, and that is why it can be safe while the
  // amount stays server-owned everywhere else. The target is a band that is
  // already standing next to this cell (canSpreadBandTo would have refused it
  // otherwise), so the stroke can only ever LEVEL a cell with the terrace
  // beside it. It cannot reach a height that is not already there, which is
  // exactly the property that makes "clients send intents, never heights"
  // hold: the height came from the world, not from the message.
  //
  // Implemented as an amount rather than a special case in the brushes because
  // the target clamp in fillTowardTarget/applyBrush already stops at the band
  // — an amount that cannot be the binding constraint means "go the whole way"
  // without a second code path to keep in agreement.
  // amount === 0 stays 0: a zero-amount stroke has no direction, and turning it
  // into a full-span move in either direction would invent one.
  const strokeAmount =
    anchor === 'band' && amount !== 0
      ? (amount > 0 ? FULL_HEIGHT_SPAN : -FULL_HEIGHT_SPAN)
      : amount;

  const changed = new Set<number>();
  // The anchor target for the RELAXATION containment below, read before the
  // brush writes anything — the same pre-stroke-centre derivation the brushes
  // themselves use (anchoredTargetHeight), or the three would disagree.
  // 'band' is contained exactly as 'clicked' is: a drag that let relaxation
  // carry ground past the grabbed level would be changing the vertical, which
  // is the one thing the drag tool is defined not to do.
  const anchoredSmooth = tool === 'smooth' && anchor !== 'free' && amount !== 0;
  const anchorTarget = anchoredSmooth
    ? anchoredTargetHeight(map, cx, cy, amount > 0, targetBand)
    : 0;
  // The one dispatch in the sculpt path. Both branches are integer-only over the
  // same footprint, and both sides of the prediction contract reach them through
  // this one function, so client and server cannot pick different branches.
  // `hard` dispatches on the PROFILE alone (2026-08-19 supersession above):
  // the level fill is what "hard" means now, under either tool. `anchor`
  // reaches both branches — it decides where the fill/ceiling level comes
  // from (the clicked cell for players, the old derivations for the library).
  if (profile === 'hard') {
    applyLevelFillBrush(map, cx, cy, radius, strokeAmount, changed, anchor, targetBand);
  } else {
    applyBrush(map, cx, cy, radius, strokeAmount, changed, profile, anchor, targetBand);
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
    if (changed.size === 0 || spill === 'banded' || anchoredSmooth) {
      const cells = new Set<number>();
      forEachFootprintCell(map, cx, cy, radius, (i) => cells.add(i));
      footprint = cells;
    }
    // ANCHOR CONTAINMENT (2026-08-19, owner bug report). The anchored brush
    // promised two things relaxation used to break in the very next pass:
    // cells past the target stay byte-untouched (the higher terrace beside a
    // raising brush was being eroded down — "it sometimes resets top layers"),
    // and nothing the stroke moves ends past the target (raised ground was
    // relaxed above the clicked ceiling). So an anchored smooth stroke bounds
    // its own footprint cells for the relaxation pass, from their pre-relax
    // heights: past the target → frozen; short of it → movable up to the
    // target in the stroke's direction, and NO FURTHER BACK THAN THE BRUSH
    // JUST PUT IT. Both are per-stroke intervals, deterministic, and the map
    // is only ever read via .get — no iteration-order dependence.
    //
    // THE CLICKED CELL MAY NOT BE UNDONE BY ITS OWN STROKE (2026-08-22, owner
    // bug report "shift click lowering does not always work"). The
    // against-the-stroke end of that interval used to be the world's own limit
    // for EVERY footprint cell — MIN_HEIGHT raising, MAX_HEIGHT lowering —
    // which licensed the stroke's own relaxation pass to put the cell the
    // player aimed at back where it started. Lowering wore it worst, because
    // movePair hands the odd unit of every excess to the LOW cell, so
    // relaxation is a net height source and refilled a pit as fast as the
    // brush dug it: measured on rolling terrain at the default brush, 137 of
    // 200 lower clicks left the clicked cell's drawn band unchanged, and 131
    // of those cells could not be lowered a band by FORTY clicks. Raising, the
    // same bias worked with the brush instead of against it — 30 of 200, none
    // permanent.
    //
    // The fix is upstream of that rounding bias, which is why it is here and
    // not in movePair: inverting the bias reproduces the identical bug
    // mirrored onto raising (127 of 200), and this bound holds either way.
    //
    // ONLY THE CLICKED CELL, AND THAT BOUND IS LOAD-BEARING. Applying it to
    // the whole footprint also fixes the click — and collapses `smooth` into
    // `stamp`. An anchored stroke leaves most of its footprint sitting exactly
    // ON the target, so bounding every cell there freezes them all, and #26's
    // coupled transfer then refuses to move their neighbours either: measured
    // on a stamped spire, the ring one cell outside a radius-4 footprint went
    // from 15 units to 0, and the stroke moved only its own 37 footprint
    // cells. Bounding the ONE cell whose result the stroke actually promises
    // leaves the spill byte-identical to before (24.4 / 38.6 / 49.2 cells
    // moved outside the footprint at radius 4 / 8 / 16, unchanged) while
    // holding the click at 0 of 200 failures in both directions.
    //
    // KNOWN BOUNDARY, stated rather than discovered later: at radius 1 the
    // footprint IS the clicked cell, so a one-cell smooth stroke can no longer
    // shed into its neighbours and behaves as a stamp. THE PICKER OFFERS THAT
    // BRUSH — client/src/state/hudState.ts's BRUSH_RADII leads with
    // MIN_BRUSH_RADIUS, shown as the 0.25 rung — so this is a player-reachable
    // combination, not a hand-made wire message. Verified in the running game
    // (2026-08-22): at radius 1 the clicked cell still falls a full band on
    // every click, 10 of 10; what it no longer does is drag its neighbours.
    // Plugin terraforms are unaffected either way — they run `anchor: 'free'`,
    // which never reaches this code.
    //
    // NOT the relaxation height leak itself. movePair still manufactures
    // height (a 401-unit cliff relaxes into 1,073,664 units from nowhere);
    // that is a real defect, it is what made the two directions asymmetric,
    // and it is deliberately left for its own change — every rounding fix
    // measured either broke the exact MAX_STEP invariant this keeps or
    // quadrupled the pass count on a tall cliff.
    //
    // PLAYER STROKES ONLY. anchorBounds is built for `anchor: 'clicked'`, and
    // the library default is `anchor: 'free'` — plugin terraforms are
    // byte-identical across this change.
    let anchorBounds: Map<number, SpillBand> | undefined;
    if (anchoredSmooth) {
      const raising = amount > 0;
      const clickedIndex = cellIndex(map, cx, cy);
      anchorBounds = new Map<number, SpillBand>();
      for (const i of footprint as Set<number>) {
        const h = map.cells[i];
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
    );
  }

  return diffOf(map, changed);
}
