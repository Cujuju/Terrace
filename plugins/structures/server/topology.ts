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
 * Labels every connected component of buildable ground, 8-connected.
 *
 * ONE FULL BOARD PASS, ONCE PER GENERATION, AND NOTHING IS CACHED ACROSS
 * GENERATIONS. `isBuildableCell` is called exactly once per cell — the same
 * budget GenerationSurvey's own sweep already spends every generation anyway,
 * so labelling at survey cadence at most doubles a cost the sweep was already
 * paying, on a 15 s clock (life.ts's CA_GENERATION_INTERVAL_SECONDS). That is
 * the whole price of the guarantee below, and it is deliberate.
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
 * pass, and GenerationSurvey takes it exactly once, when a sweep begins.
 *
 * The fill is an explicit stack rather than recursion: a landmass can be the
 * whole map, and a recursive fill over a quarter of a million cells is a stack
 * overflow, not an algorithm.
 */
export function computeLandmassLabels(world: StructuresWorld): LandmassLabels {
  const size = world.worldSize;
  const cells = new Int32Array(size * size).fill(NO_LANDMASS);
  const boxes: LandmassBox[] = [];
  if (size <= 0) return new Labelling(size, cells, boxes, emptyExtents([]), emptyExtents([]));

  // Which cells are buildable at all, resolved once up front: the fill below
  // revisits a cell's neighbours several times, and isBuildableCell is a
  // whole footprint survey (suitability.ts) rather than an array read.
  const buildable = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isBuildableCell(world, x, y)) buildable[y * size + x] = 1;
    }
  }

  const stack: number[] = [];
  for (let y0 = 0; y0 < size; y0++) {
    for (let x0 = 0; x0 < size; x0++) {
      const seed = y0 * size + x0;
      if (buildable[seed] === 0 || cells[seed] !== NO_LANDMASS) continue;

      const label = boxes.length;
      let minX = x0;
      let maxX = x0;
      let minY = y0;
      let maxY = y0;
      cells[seed] = label;
      stack.push(seed);
      while (stack.length > 0) {
        const index = stack.pop()!;
        const y = (index / size) | 0;
        const x = index - y * size;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (const [ox, oy] of FLOOD_OFFSETS) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nIndex = ny * size + nx;
          if (buildable[nIndex] === 0 || cells[nIndex] !== NO_LANDMASS) continue;
          cells[nIndex] = label;
          stack.push(nIndex);
        }
      }
      boxes.push({ minX, maxX, minY, maxY });
    }
  }

  // ONE MORE ROW-MAJOR PASS, for the wrap's O(1) lookups (AxisExtents). Both
  // axes are filled from this single pass: x rises within a row, and for any
  // fixed column y rises from one row to the next, so `recordExtent`'s
  // ascending-position requirement holds for rows and columns alike.
  const rows = emptyExtents(boxes.map((box) => box.maxY - box.minY + 1));
  const columns = emptyExtents(boxes.map((box) => box.maxX - box.minX + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const label = cells[y * size + x]!;
      if (label === NO_LANDMASS) continue;
      const box = boxes[label]!;
      recordExtent(rows, label, y - box.minY, x);
      recordExtent(columns, label, x - box.minX, y);
    }
  }

  return new Labelling(size, cells, boxes, rows, columns);
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
