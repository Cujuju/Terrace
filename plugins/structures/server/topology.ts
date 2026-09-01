// BOARD TOPOLOGY — what the CA's board is SHAPED like, as opposed to what its
// rule is. life.ts owns B3/S23; this file owns the answer to "who is next to
// whom", which on a world made almost entirely of sea is the thing that was
// actually broken.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS EXISTS FOR: BOUNDARY STARVATION.
//
// Terrain is the board's walls (life.ts's header). On a real Terrace world the
// walls are not a frame around a playable field — they ARE the field: measured
// on snapshot 345, 19 of 429 unlocked chunks held any buildable cell at all,
// so the buildable board is a scatter of small plateaus, and almost every cell
// on one of them is within a cell or two of open water. Under hard-walled
// B3/S23 that means almost every cell is permanently under-neighboured: a
// wall neighbour contributes exactly nothing, so a plateau's edge can only
// ever lose. The board dies, or it freezes into the one still life that fits.
//
// attemptSeed (the Monday arrival) and attemptStir (the periodic spark) were
// both written to counter that from OUTSIDE the rule. They stay — but they are
// backstops now, not the mechanism, because the mechanism is here: the board
// itself is given a topology under which a small landmass is a viable world.
//
// TWO RULES, BOTH PURELY ABOUT NEIGHBOUR LOOKUP. Neither touches B3/S23's
// thresholds, and neither can put a live cell on unbuildable ground — the wall
// test in GenerationSurvey.scanChunk is untouched and still authoritative.
//
//   1. PHANTOM WALL NEIGHBOURS (life.ts's WALL_PHANTOM_NUMERATOR /
//      _DENOMINATOR, and scaledNeighborCount). A dead end is worth a FRACTION
//      of a live neighbour, so a cliff edge reads as sparse company rather
//      than as void. Integer arithmetic throughout — see life.ts.
//   2. PER-LANDMASS WRAP (this file). A step that would walk off a landmass
//      comes back in at that landmass's OPPOSITE edge, so a glider crossing a
//      headland re-enters the headland instead of falling into the sea. Each
//      connected component of buildable ground is its own little torus.
//      CONSTANT TIME per slot: the labelling carries, per landmass and per
//      line, where that landmass starts and stops (AxisExtents), so a wrap is
//      two array reads rather than a walk along the bounding box.
//
// WHY PER-LANDMASS AND NOT PER-WORLD. Wrapping at the WORLD's edge would join
// two settlements that a player can see are a thousand cells apart, and would
// do nothing whatsoever for an inland plateau — the case that is actually
// starving. The component IS the world, as far as its own cells are concerned.
//
// WHAT THE WRAP IS NOT: A GUARANTEE FOR ANY ONE PATTERN. Measured on a lone
// island, a glider that classic hard walls turn into a 4-cell still life dies
// outright under the wrap instead — it comes back round and collides with its
// own tail. That is Life on a small torus behaving like Life on a small torus,
// and it is the right trade: across eight seeded arrivals the same island
// holds ~3× the population and never freezes (see the measured table on
// life.ts's WALL_PHANTOM_NUMERATOR). The rules are aggregate anti-starvation,
// not a promise about any individual spaceship.
//
// DETERMINISM. Labels are assigned by a row-major outer scan, so a given
// heightfield always produces the same numbering; the flood fill's own visit
// order cannot affect the result (it only paints a set). Every lookup below is
// integer-only, with no floating point and no RNG.

import { isBuildableCell, type StructuresWorld } from './suitability.ts';

/** The axis-aligned extent of one landmass, in cells, inclusive on both ends. */
export interface LandmassBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * A labelling of the whole board: which connected component of buildable
 * ground each cell belongs to, and how far each component reaches.
 *
 * A cell index is `y * worldSize + x` — the board's own row-major layout, NOT
 * protocol.ts's structureKey (whose 65536 stride exists to survive a world
 * resize and would waste an order of magnitude of memory here).
 */
export interface LandmassLabels {
  readonly worldSize: number;
  /** How many landmasses the board has. Labels run 0 … count-1. */
  readonly count: number;
  /** Bounding box per label, indexed by label. */
  readonly boxes: readonly LandmassBox[];
  /** Label at (x, y), or -1 for wall, water, locked ground and out of bounds. */
  labelAt(x: number, y: number): number;
  /**
   * WHERE A LANDMASS RE-ENTERS ROW `y`, travelling in direction `step`
   * (+1 east, -1 west): the row-major index of the cell of `label` nearest the
   * edge the traveller comes in at, skipping `skipIndex`, or -1 if the
   * landmass does not reach that row (or reaches it only at `skipIndex`).
   *
   * O(1) — see the extents below. This replaced an inward scan of the whole
   * bounding-box row, which cost O(worldSize) per neighbour slot and was worst
   * on exactly the shapes the wrap exists for: a comb or a ring, where the box
   * is large and the land in it is thin.
   */
  rowEntry(label: number, y: number, step: number, skipIndex: number): number;
  /** rowEntry's transpose: where the landmass re-enters column `x`. */
  columnEntry(label: number, x: number, step: number, skipIndex: number): number;
}

/** Sentinel label for "not buildable ground at all". */
const NO_LANDMASS = -1;

/**
 * The eight directions the flood fill spreads through — the SAME Moore
 * neighbourhood B3/S23 counts, which is what makes "one landmass" mean "cells
 * that can actually be each other's neighbours". Four-connectivity would split
 * a diagonal isthmus into two boards whose cells are nonetheless neighbours in
 * the rule, and the wrap would then send a glider crossing that isthmus to the
 * wrong side of the map.
 */
const FLOOD_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

/**
 * WHERE A LANDMASS STARTS AND STOPS ALONG EVERY LINE IT TOUCHES — the first
 * two and the last two positions it occupies on each row (and, in the second
 * instance, each column) of its own bounding box.
 *
 * WHY TWO AT EACH END RATHER THAN ONE. The wrap must never hand a cell back to
 * itself (see wrappedNeighborIndex's "A CELL IS NEVER ITS OWN NEIGHBOUR"), and
 * the only step that can re-enter on the very cell it left is one that did not
 * change the line being scanned — a purely horizontal step scanning its own
 * row, a purely vertical one scanning its own column. Such a cell is by
 * definition the extreme cell at whichever end that scan starts from, so the
 * RUNNER-UP is the only other answer the old inward scan could ever have
 * produced. Two per end is therefore not a heuristic depth; it is exactly the
 * information the scan could yield, and nothing more.
 *
 * ONE FLAT SLICE PER LANDMASS rather than four small arrays each: a real world
 * is a scatter of many small landmasses (topology.ts's header), and eight
 * typed-array allocations per landmass per generation is churn for nothing.
 * `offsets[label]` is where that landmass's lines begin; the line's own slot is
 * `offsets[label] + (line - box.min)`.
 */
interface AxisExtents {
  readonly offsets: Int32Array;
  readonly first: Int32Array;
  readonly second: Int32Array;
  readonly last: Int32Array;
  readonly penultimate: Int32Array;
}

/** Allocates the slices, `spans[label]` lines long each, all empty. */
function emptyExtents(spans: readonly number[]): AxisExtents {
  const offsets = new Int32Array(spans.length);
  let total = 0;
  for (let label = 0; label < spans.length; label++) {
    offsets[label] = total;
    total += spans[label]!;
  }
  return {
    offsets,
    first: new Int32Array(total).fill(NO_LANDMASS),
    second: new Int32Array(total).fill(NO_LANDMASS),
    last: new Int32Array(total).fill(NO_LANDMASS),
    penultimate: new Int32Array(total).fill(NO_LANDMASS),
  };
}

/**
 * Notes that `label` occupies `position` on `line`.
 *
 * MUST BE CALLED IN ASCENDING `position` ORDER for a given line — the caller's
 * single row-major pass guarantees it on both axes (x rises within a row; y
 * rises across rows, which for a fixed column is the same statement). That is
 * what lets "the two smallest" and "the two largest" be maintained without
 * sorting or a second pass.
 */
function recordExtent(extents: AxisExtents, label: number, line: number, position: number): void {
  const slot = extents.offsets[label]! + line;
  if (extents.first[slot]! < 0) extents.first[slot] = position;
  else if (extents.second[slot]! < 0) extents.second[slot] = position;
  if (extents.last[slot]! >= 0) extents.penultimate[slot] = extents.last[slot]!;
  extents.last[slot] = position;
}

/**
 * The position the traveller meets first on `line`, and the one behind it —
 * `[nearest, runnerUp]`, either of which may be -1 for "nobody". `step > 0`
 * enters from the low end, `step < 0` from the high end.
 */
function extentsOn(
  extents: AxisExtents,
  label: number,
  line: number,
  step: number,
): readonly [number, number] {
  const slot = extents.offsets[label]! + line;
  return step > 0
    ? [extents.first[slot]!, extents.second[slot]!]
    : [extents.last[slot]!, extents.penultimate[slot]!];
}

// Plain fields and an explicit constructor body — parameter properties are not
// erasable syntax, and this plugin's server half is loaded through Node's type
// stripping (see tsconfig.json's erasableSyntaxOnly).
class Labelling implements LandmassLabels {
  readonly worldSize: number;
  readonly boxes: readonly LandmassBox[];
  private readonly cells: Int32Array;
  private readonly rows: AxisExtents;
  private readonly columns: AxisExtents;

  constructor(
    worldSize: number,
    cells: Int32Array,
    boxes: readonly LandmassBox[],
    rows: AxisExtents,
    columns: AxisExtents,
  ) {
    this.worldSize = worldSize;
    this.cells = cells;
    this.boxes = boxes;
    this.rows = rows;
    this.columns = columns;
  }

  get count(): number {
    return this.boxes.length;
  }

  labelAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.worldSize || y >= this.worldSize) return NO_LANDMASS;
    return this.cells[y * this.worldSize + x]!;
  }

  rowEntry(label: number, y: number, step: number, skipIndex: number): number {
    const box = this.boxes[label];
    if (box === undefined || y < box.minY || y > box.maxY) return NO_LANDMASS;
    const [nearest, runnerUp] = extentsOn(this.rows, label, y - box.minY, step);
    if (nearest < 0) return NO_LANDMASS;
    const index = y * this.worldSize + nearest;
    if (index !== skipIndex) return index;
    if (runnerUp < 0) return NO_LANDMASS;
    return y * this.worldSize + runnerUp;
  }

  columnEntry(label: number, x: number, step: number, skipIndex: number): number {
    const box = this.boxes[label];
    if (box === undefined || x < box.minX || x > box.maxX) return NO_LANDMASS;
    const [nearest, runnerUp] = extentsOn(this.columns, label, x - box.minX, step);
    if (nearest < 0) return NO_LANDMASS;
    const index = nearest * this.worldSize + x;
    if (index !== skipIndex) return index;
    if (runnerUp < 0) return NO_LANDMASS;
    return runnerUp * this.worldSize + x;
  }
}

/**
 * Labels every connected component of buildable ground, 8-connected, asking
 * `isBuildableCell` about every cell itself.
 *
 * THE SLOW ENTRY POINT, AND NO LONGER THE ONE THE SWEEP USES PER GENERATION.
 * The whole-board `isBuildableCell` prepass below IS the cost of labelling —
 * the flood fill over the resulting bitmap is cheap — and GenerationSurvey's
 * own chunk scan already asks `isBuildableCell` the same question about the
 * same cells, amortised across the generation. So the sweep feeds its own
 * answers to `computeLandmassLabelsFromBuildable` instead, and this function
 * remains for the callers that have no such bitmap to hand: the FIRST sweep of
 * a fresh survey (life.ts's `advance`) and the tests.
 *
 * WHY NO CACHE (2026-08-25). A cache here has to be invalidated by everything
 * `isBuildableCell` reads, and it reads THREE moving things: the terrain, the
 * UNLOCKED set, and another plugin's reservations (reservations.ts). Only the
 * first announces itself, as a CellDiff — so an invalidate-on-terrain cache
 * silently disagreed with `isBuildableCell` about every cell that unlocked or
 * was released from a reservation, and a cell the labelling calls NO_LANDMASS
 * is not merely mis-weighted: `wrappedNeighborIndex` returns -1 for ALL EIGHT
 * of its slots (it refuses an unlabelled origin outright), so such a cell can
 * never be born, and one that is somehow alive there keeps every neighbour
 * count it is part of wrong for as long as the cache stands. The board's
 * shape is cheap; being wrong about it is not.
 *
 * The caller must still not treat this as free PER TICK — it is a whole-board
 * pass, and nothing amortises it.
 */
export function computeLandmassLabels(world: StructuresWorld): LandmassLabels {
  const size = world.worldSize;
  // Which cells are buildable at all, resolved once up front: the fill below
  // revisits a cell's neighbours several times, and isBuildableCell is a
  // whole footprint survey (suitability.ts) rather than an array read.
  const buildable = new Uint8Array(Math.max(0, size * size));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isBuildableCell(world, x, y)) buildable[y * size + x] = 1;
    }
  }
  return computeLandmassLabelsFromBuildable(size, buildable);
}

/**
 * THE FLOOD FILL ITSELF — the only one in this file, and the entry point for a
 * caller that already knows which cells are buildable: `buildable[y * size + x]`
 * non-zero means buildable, and the array must be exactly `size * size` long,
 * laid out row-major in the same board indexing `LandmassLabels` uses.
 *
 * `computeLandmassLabels` above is this function plus a prepass, so the two can
 * never disagree about what a landmass is — the whole reason there is one
 * implementation rather than two.
 *
 * THE BITMAP IS THE CALLER'S SNAPSHOT OF BUILDABILITY, AND ITS AGE IS THE
 * CALLER'S PROBLEM. This function has no access to the world and cannot check
 * the bitmap against it; GenerationSurvey's own header states the lag it
 * accepts by feeding one gathered across a whole sweep.
 *
 * The fill is an explicit stack rather than recursion: a landmass can be the
 * whole map, and a recursive fill over a quarter of a million cells is a stack
 * overflow, not an algorithm.
 *
 * SINGLE-SHOT, AND THE ONLY FORM THAT IS. The fill itself lives in
 * `IncrementalLandmassLabeller` below; this is that class run to completion in
 * one call, for callers with a whole tick to spend on it (the tests, and
 * `computeLandmassLabels` above). A per-tick caller drives the class instead —
 * see #271 and the class's own header for what this call costs at 2048.
 */
export function computeLandmassLabelsFromBuildable(
  size: number,
  buildable: Uint8Array,
): LandmassLabels {
  const labeller = new IncrementalLandmassLabeller();
  labeller.begin(size, buildable);
  // A budget no board can exhaust: the pass charges a handful of units per
  // cell (LABEL_UNITS_PER_BOARD_CELL), and MAX_SAFE_INTEGER is ten orders of
  // magnitude above that for any world this engine can address. `begin`
  // therefore always leaves the pass finished after one `advance`, which is
  // what makes the non-null assertion below a statement rather than a hope.
  return labeller.advance(Number.MAX_SAFE_INTEGER)!;
}

/**
 * WHAT ONE FLOOD POP COSTS, in the pass's own work units.
 *
 * NOT ONE. The unit is meant to be a comparable slice of a tick, and a pop is
 * not comparable to a cell of the clear (a memset) or of the extents pass: it
 * examines all eight FLOOD_OFFSETS, each with a bounds test, a bitmap read and
 * a label read. Eight — one per neighbour slot — is that ratio stated in the
 * only terms the fill actually has.
 *
 * MEASURED, because a plausible ratio is not a justified one. At 2048, driven
 * by the per-tick credit a generation gives (see LABEL_UNITS_PER_BOARD_CELL),
 * the worst single tick of the whole pass falls from 25.3 ms at a weight of 1
 * to 9.3 ms at 8 on the all-land board — the case the perf review (#271) calls
 * unreachable in a real world — and to single-digit-fraction ms on the
 * water-heavy masks a real world is made of (1.6–4.2 ms). Beyond 8 there is
 * nothing left to win: what remains is the pass's own average tick, which no
 * reweighting can move.
 */
const FLOOD_UNITS_PER_POP = 8;

/**
 * WHAT THE EXTENTS ALLOCATION CAN COST PER CELL, in the same units — one per
 * line it allocates (`beginExtents`), on each of the two axes.
 *
 * TWO IS THE CEILING AND IT IS TIGHT: a landmass allocates one row line per
 * row of its box and one column line per column, so the most lines a board of
 * `cells` cells can ever ask for is two per cell — reached exactly when every
 * buildable cell is its own 1x1 landmass. That is also the case the term is
 * for; it is a rounding error on a board of one big landmass.
 */
const EXTENTS_LINE_UNITS_PER_CELL = 2;

/**
 * WORK UNITS THE PASS CHARGES PER CELL OF THE BOARD, over its whole life —
 * the number a caller must multiply a per-tick cell allowance by if it wants
 * the pass to finish inside the ticks a whole-board sweep takes.
 *
 * One per time the pass touches a cell — the clear, the seed scan and the
 * extents pass — plus at most one flood pop at its own weight (only buildable
 * cells are ever pushed, and each is pushed exactly once, because it is
 * labelled at push time), plus the extents allocation above.
 *
 * A CEILING NO BOARD REACHES, deliberately. Its two big terms are mutually
 * exclusive — eight pops a cell needs one landmass covering the board, two
 * extents lines a cell needs every cell to be its own — so a real pass spends
 * well under this and finishes with ticks to spare. That margin is the point:
 * a caller pacing the fill against its sweep hands the finished labelling over
 * at the sweep's end, and a pass that ran even one tick long would miss that
 * handover and leave the topology a whole generation staler (see life.ts).
 * An all-water board spends three of these thirteen.
 */
export const LABEL_UNITS_PER_BOARD_CELL =
  3 + FLOOD_UNITS_PER_POP + EXTENTS_LINE_UNITS_PER_CELL;

/** Which part of the pass `advance` is currently working through. */
type LabelPhase = 'idle' | 'clear' | 'flood' | 'extents';

/**
 * THE FLOOD FILL, RESUMABLE — the same labelling as a single call, cut into
 * slices small enough to sit inside one server tick.
 *
 * WHY THIS EXISTS (#271). The single-shot form above is a whole-board pass:
 * at 2048 it allocates and clears 16.8 MB, seeds over 4.19 M cells, floods,
 * and walks all 4.19 M again for the extents. Measured, that is 20.5 ms on an
 * all-water board — the floor, paid whatever the mask says — 67-83 ms at a
 * realistic buildability and 307 ms on all land. GenerationSurvey's chunk scan
 * is amortised across the whole generation; this was not, so the entire cost
 * landed on the one tick in ~150 where the sweep's cursor came home.
 *
 * ONE IMPLEMENTATION, NOT TWO. `computeLandmassLabelsFromBuildable` is this
 * class driven with an inexhaustible budget, for the same reason
 * `computeLandmassLabels` is that function plus a prepass: a second copy of
 * the fill would be a second opinion about what a landmass is. The slicing
 * therefore cannot change the answer — where the pass PAUSES is decided by
 * the budget, and every piece of state the fill carries (the seed cursor, the
 * explicit stack, the open component's box) survives the pause, so identical
 * bitmaps give identical labels, boxes and extents at any budget.
 *
 * DETERMINISM is the single-shot function's, unchanged: the seed scan is
 * row-major, so labels are numbered in the order their components are first
 * met, and the fill's own visit order still cannot affect a result it only
 * paints.
 *
 * THE BITMAP IS BORROWED, NOT COPIED. `begin` keeps the caller's array by
 * reference for the whole pass — a copy would put 4.19 MB back on the tick
 * this class exists to unload. A caller that refills its mask while a pass is
 * running would be feeding the fill two generations at once; GenerationSurvey
 * keeps two masks and alternates them for exactly this reason.
 *
 * THE CELL ARRAY IS DOUBLE-BUFFERED, so a published labelling is never the
 * one being written. `advance` returns a `Labelling` wrapping one of the two
 * Int32Arrays this class owns; the next `begin` writes the OTHER. That is the
 * whole coherence mechanism on this side: a consumer holding the result of a
 * finished pass can read it for a full further pass without seeing a cell
 * change under it. Reused across generations, the pair is also why a steady
 * state allocates nothing: two 16.8 MB arrays held, versus 16.8 MB of garbage
 * per generation before.
 */
export class IncrementalLandmassLabeller {
  /** Board edge of the pass in flight; 0 when idle and never begun. */
  private size = 0;
  /** The caller's bitmap, borrowed for the length of the pass. */
  private buildable: Uint8Array | null = null;
  /** The two cell arrays; `write` says which one the pass in flight fills. */
  private buffers: [Int32Array, Int32Array] = [new Int32Array(0), new Int32Array(0)];
  private write = 0;
  private phase: LabelPhase = 'idle';
  /**
   * How far the current phase's linear scan has got, in cells: the clear's
   * fill front, then the seed scan's cursor, then the extents pass's cursor.
   * Reset at each phase change.
   */
  private cursor = 0;
  /** The flood's explicit stack — see the single-shot function on why. */
  private stack: number[] = [];
  /** Boxes closed so far; `boxes.length` is the next label to hand out. */
  private boxes: LandmassBox[] = [];
  /** Whether a component is open — flooded, but its box not yet closed. */
  private componentOpen = false;
  private label = 0;
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;
  private rows: AxisExtents | null = null;
  private columns: AxisExtents | null = null;

  /** True between `begin` and the `advance` that returns the labelling. */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /**
   * Starts a pass over `buildable`, discarding any pass still in flight.
   *
   * The caller owns the "still in flight" decision (`active`): abandoning a
   * pass is cheap and correct — nothing outside has seen a cell of it — but
   * it also means that generation's topology never gets published, so
   * GenerationSurvey only calls this when the previous pass has finished.
   */
  begin(size: number, buildable: Uint8Array): void {
    // `size > 0 ?` rather than `Math.max(0, size * size)`: a negative edge
    // squares to a positive count, and every index test below is written
    // against `size`. A board with no positive edge simply has no cells —
    // which is what the labelling it publishes says, since `labelAt` refuses
    // every coordinate against a non-positive `worldSize`.
    const cellCount = size > 0 ? size * size : 0;
    if (this.buffers[this.write].length !== cellCount) {
      // Both, not just the one about to be written: the other is this pass's
      // successor and must match the board too, and a stale-sized array kept
      // alive would be the larger waste of the two.
      this.buffers = [new Int32Array(cellCount), new Int32Array(cellCount)];
    }
    this.size = size;
    this.buildable = buildable;
    this.cursor = 0;
    this.stack.length = 0;
    this.boxes = [];
    this.componentOpen = false;
    this.rows = null;
    this.columns = null;
    // A board with no cells has nothing to clear and nothing to flood, and
    // still owes its caller the empty labelling the single-shot form returns.
    this.phase = cellCount <= 0 ? 'extents' : 'clear';
  }

  /**
   * Throws away the pass in flight and releases the bitmap it borrowed.
   *
   * For the one thing that invalidates a pass outright: a world resize, after
   * which the bitmap describes a board of another shape. Cheap and always
   * safe — nothing outside has seen a cell of an unfinished pass — and it
   * deliberately keeps the cell buffers, which `begin` resizes.
   */
  abandon(): void {
    this.phase = 'idle';
    this.buildable = null;
    this.stack.length = 0;
    this.boxes = [];
    this.componentOpen = false;
    this.rows = null;
    this.columns = null;
  }

  /**
   * Spends up to `cellBudget` work units on the pass in flight, and returns
   * the finished labelling on the call that completes it (null otherwise, and
   * null when no pass is in flight).
   *
   * The unit is one cell touched once, so a caller pacing this against a
   * whole-board sweep wants `cellsPerTick * LABEL_UNITS_PER_BOARD_CELL`.
   */
  advance(cellBudget: number): LandmassLabels | null {
    let budget = Math.floor(cellBudget);
    while (budget > 0 && this.phase !== 'idle') {
      if (this.phase === 'clear') budget = this.stepClear(budget);
      else if (this.phase === 'flood') budget = this.stepFlood(budget);
      else return this.stepExtents(budget);
    }
    return null;
  }

  /**
   * NO_LANDMASS everywhere, in slices. The fill writes ahead of the seed
   * cursor — a component met at row 0 can reach row 2047 — so this cannot be
   * folded into the seed scan and must finish before it starts.
   */
  private stepClear(budget: number): number {
    const total = this.buffers[this.write].length;
    const take = Math.min(budget, total - this.cursor);
    this.buffers[this.write].fill(NO_LANDMASS, this.cursor, this.cursor + take);
    this.cursor += take;
    if (this.cursor >= total) {
      this.cursor = 0;
      this.phase = 'flood';
    }
    return budget - take;
  }

  /**
   * The row-major seed scan and the flood it drives, interleaved so that
   * either can be interrupted: a single landmass can be the whole board, so
   * bounding only the seed scan would leave the 4.19 M-cell case unbounded.
   */
  private stepFlood(budget: number): number {
    const size = this.size;
    const cells = this.buffers[this.write];
    const total = cells.length;
    const buildable = this.buildable!;
    const stack = this.stack;
    while (budget > 0) {
      if (stack.length > 0) {
        const index = stack.pop()!;
        budget -= FLOOD_UNITS_PER_POP;
        const y = (index / size) | 0;
        const x = index - y * size;
        if (x < this.minX) this.minX = x;
        if (x > this.maxX) this.maxX = x;
        if (y < this.minY) this.minY = y;
        if (y > this.maxY) this.maxY = y;
        for (const [ox, oy] of FLOOD_OFFSETS) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nIndex = ny * size + nx;
          if (buildable[nIndex] === 0 || cells[nIndex] !== NO_LANDMASS) continue;
          cells[nIndex] = this.label;
          stack.push(nIndex);
        }
        continue;
      }
      // The stack is empty, so the open component is complete: close its box
      // before the scan is allowed to hand out the next label. Charged
      // nothing — the work was already paid for when its cells were popped.
      if (this.componentOpen) {
        this.boxes.push({ minX: this.minX, maxX: this.maxX, minY: this.minY, maxY: this.maxY });
        this.componentOpen = false;
        continue;
      }
      if (this.cursor >= total) {
        return budget - this.beginExtents();
      }
      const seed = this.cursor++;
      budget--;
      if (buildable[seed] === 0 || cells[seed] !== NO_LANDMASS) continue;
      const y0 = (seed / size) | 0;
      this.label = this.boxes.length;
      this.minX = seed - y0 * size;
      this.maxX = this.minX;
      this.minY = y0;
      this.maxY = y0;
      this.componentOpen = true;
      cells[seed] = this.label;
      stack.push(seed);
    }
    return budget;
  }

  /**
   * Sizes the extents slices, which needs every box closed — so it is the one
   * piece of the pass that cannot be cut, and it returns what it cost.
   *
   * IT IS CHARGED because it is not free: eight Int32Arrays, allocated and
   * filled, one slot per line every landmass touches. One unit per line,
   * counted on both axes, is exactly what it allocates, and charging it stops
   * a slice of the extents pass from landing on the same tick.
   *
   * THE ONE SPIKE THE SLICING DOES NOT REMOVE, and it is honest to say so: a
   * board of very many tiny landmasses makes this allocation itself the
   * expensive thing. Measured at 2048 on a synthetic mask of 159 563 of them,
   * this single tick is 8–9 ms, against ~3 ms for the pass's ordinary tick and
   * ~81 ms for the whole-board call it replaces. Cutting it further means
   * one flat allocation behind AxisExtents rather than eight, which is a
   * change to that structure's shape and was not worth making for a mask no
   * real world produces (#271: a real board is a scatter of plateaus over a
   * few hundred chunks, not a stripe pattern over every cell).
   */
  private beginExtents(): number {
    const rowSpans = this.boxes.map((box) => box.maxY - box.minY + 1);
    const columnSpans = this.boxes.map((box) => box.maxX - box.minX + 1);
    this.rows = emptyExtents(rowSpans);
    this.columns = emptyExtents(columnSpans);
    this.cursor = 0;
    this.phase = 'extents';
    let lines = 0;
    for (let label = 0; label < rowSpans.length; label++) {
      lines += rowSpans[label]! + columnSpans[label]!;
    }
    return lines;
  }

  /**
   * ONE MORE ROW-MAJOR PASS, for the wrap's O(1) lookups (AxisExtents). Both
   * axes are filled from this single pass: x rises within a row, and for any
   * fixed column y rises from one row to the next, so `recordExtent`'s
   * ascending-position requirement holds for rows and columns alike — and it
   * survives being cut into slices, because the cuts do not reorder it.
   */
  private stepExtents(budget: number): LandmassLabels | null {
    const size = this.size;
    const cells = this.buffers[this.write];
    const total = cells.length;
    const rows = this.rows ?? emptyExtents([]);
    const columns = this.columns ?? emptyExtents([]);
    const end = Math.min(total, this.cursor + budget);
    for (let index = this.cursor; index < end; index++) {
      const label = cells[index]!;
      if (label === NO_LANDMASS) continue;
      const y = (index / size) | 0;
      const x = index - y * size;
      const box = this.boxes[label]!;
      recordExtent(rows, label, y - box.minY, x);
      recordExtent(columns, label, x - box.minX, y);
    }
    this.cursor = end;
    if (this.cursor < total) return null;

    const published = new Labelling(size, cells, this.boxes, rows, columns);
    // Hand the next pass the OTHER buffer, so the one just published stays
    // readable for as long as its holder wants it.
    this.write ^= 1;
    this.phase = 'idle';
    this.buildable = null;
    this.stack.length = 0;
    return published;
  }
}

// ── The wrap ─────────────────────────────────────────────────────────────────

/**
 * The corner case, literally: a DIAGONAL step that left the landmass on both
 * axes at once re-enters at the opposite corner, travelling along the same
 * diagonal. One bounded 1-D scan rather than a 2-D search of the box — a
 * diagonal exit is a diagonal entry, and searching the whole box would cost
 * width×height per neighbour for no better answer.
 */
function scanDiagonal(
  labels: LandmassLabels,
  label: number,
  box: LandmassBox,
  stepX: number,
  stepY: number,
  selfIndex: number,
): number {
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const span = width < height ? width : height;
  const startX = stepX > 0 ? box.minX : box.maxX;
  const startY = stepY > 0 ? box.minY : box.maxY;
  for (let i = 0; i < span; i++) {
    const x = startX + i * stepX;
    const y = startY + i * stepY;
    if (labels.labelAt(x, y) !== label) continue;
    const index = y * labels.worldSize + x;
    if (index === selfIndex) continue;
    return index;
  }
  return -1;
}

/**
 * WHO IS AT (x+dx, y+dy), AS FAR AS THE CELL AT (x, y) IS CONCERNED.
 *
 * Returns a row-major cell index (`y * worldSize + x`), or -1 for "nobody" —
 * which is life.ts's cue to count a phantom wall. The three cases, in a fixed
 * order that is part of the contract because a diagonal step can satisfy more
 * than one of them:
 *
 *   1. The direct neighbour, if it is on the SAME landmass. Since the fill is
 *      8-connected, any buildable Moore neighbour of a cell on landmass L is
 *      by construction on L too — so this case failing means, exactly, "that
 *      neighbour is wall".
 *   2. Wrap along X (only if the step moved in X), keeping the stepped-to row:
 *      re-enter from the box's opposite vertical edge. `rowEntry`, O(1).
 *   3. Wrap along Y (only if the step moved in Y), keeping the stepped-to
 *      column. `columnEntry`, O(1).
 *   4. For a diagonal step where neither single-axis wrap found anything, the
 *      opposite corner (scanDiagonal).
 *
 * CASE 4 IS STILL A SCAN, and stays one. There is no O(1) answer for it: the
 * extents describe rows and columns, and a diagonal is neither, so answering
 * it in constant time would need a third index keyed on every diagonal of
 * every landmass — more memory than the whole labelling, to serve the rarest
 * case there is. Downgrading it to a wall instead was considered and rejected:
 * it would change the board, not just its cost, and the equivalence this
 * refactor is worth anything for is exactness. It remains bounded by the
 * SHORTER side of the bounding box, and it is reached only when a diagonal
 * step found nothing on either axis — an outright corner exit.
 *
 * X BEFORE Y IS ARBITRARY BUT FIXED, and it only ever decides between two
 * cells that are both legitimate re-entries for the same diagonal step. What
 * matters is that it is the same every time, on every machine — the
 * determinism contract.
 *
 * A CELL IS NEVER ITS OWN NEIGHBOUR. On a landmass one cell wide the scan
 * would otherwise come straight back to the cell it started from (a width-1
 * torus really does wrap onto itself), and a cell counting itself as company
 * is not a neighbourhood rule, it is a bug that keeps hermits alive by
 * arithmetic. Such a step is a dead end and is counted as a phantom wall
 * instead. Two DIFFERENT steps may still land on the same cell on a very
 * narrow landmass, exactly as they would on a narrow torus; that is wrapping
 * working, not double counting.
 */
export function wrappedNeighborIndex(
  labels: LandmassLabels,
  x: number,
  y: number,
  dx: number,
  dy: number,
): number {
  const label = labels.labelAt(x, y);
  if (label === NO_LANDMASS) return -1;

  const size = labels.worldSize;
  const nx = x + dx;
  const ny = y + dy;
  if (labels.labelAt(nx, ny) === label) return ny * size + nx;

  const box = labels.boxes[label]!;
  const selfIndex = y * size + x;

  if (dx !== 0) {
    const wrapped = labels.rowEntry(label, ny, dx, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  if (dy !== 0) {
    const wrapped = labels.columnEntry(label, nx, dy, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  if (dx !== 0 && dy !== 0) {
    const wrapped = scanDiagonal(labels, label, box, dx, dy, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  return -1;
}
