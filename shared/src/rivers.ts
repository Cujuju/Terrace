// Rivers & springs (mechanics card 27) and the waterfalls that ride on top of
// them (card 40).
//
// CRITICAL CODE — same determinism contract as heightmap.ts: a river network
// is a PURE, DETERMINISTIC function of a heightmap (design decision Q3 — water
// is derived, never simulated state — extended here to flowing water). Given
// the same cells, server and client compute byte-identical output; nothing
// about a river or a waterfall ever travels on the wire (see docs/DESIGN.md,
// "Decisions made 2026-08-19 (Rivers & Springs; Waterfalls)"). Integer-only
// throughout; every neighbor scan runs in the one fixed order documented next
// to FLOW_DIRECTIONS below.

import { BAND_HEIGHT, SEA_LEVEL } from './constants.ts';
import { bandOf, cellIndex, cellX, cellY, heightAt, type Heightmap } from './heightmap.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Springs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far above sea level a cell must sit to qualify as a spring — one full
 * terrace band (64). "Springs on high ground" (card 27) is the only guidance
 * the card gives; a bare local maximum at, say, height 1 would put a spring on
 * the very first ripple above the coast, which reads as noise rather than
 * high ground. One band is the smallest rise a player's stamp brush can make
 * in a single click (DEFAULT_SCULPT_AMOUNT = BAND_HEIGHT), so this is exactly
 * "raise the coast once and you may have earned a spring" — the shallowest
 * threshold that still means something.
 */
export const SPRING_MIN_HEIGHT_ABOVE_SEA = BAND_HEIGHT;

/**
 * Ceiling on how many springs one recompute traces.
 *
 * A cell qualifies as a spring by a purely LOCAL test (strictly higher than
 * its in-bounds/active 4-neighbors — see `isLocalMaximum`), so the number of
 * candidates scales with how jagged the revealed terrain is, not with world
 * size: an adversarial checkerboard of alternating heights could in principle
 * make roughly half of all active cells local maxima. Tracing every one of
 * them would make the recompute's cost depend on terrain shape rather than on
 * a fixed budget (see RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER for the other
 * half of that bound). 24 is chosen as "enough dramatic rivers to make a
 * revealed area feel alive" — the card's own language is "a handful of
 * satisfying rivers", not "every knoll drains" — and keeps the worst-case
 * total trace cost (springs × per-river budget) at a small, fixed multiple of
 * one world edge. Candidates beyond the cap are the LOWER peaks: springs are
 * kept by (height descending, then cell index ascending) — see
 * `selectSprings` — so the cap always keeps the most dramatic terrain first.
 */
export const MAX_SPRINGS_PER_NETWORK = 24;

/**
 * The four flow-check directions, in FIXED scan order: north, east, south,
 * west. This order is part of the determinism contract (like the footprint
 * scan order in heightmap.ts): `traceRiver` only ever replaces its current
 * best downhill neighbor on a STRICTLY lower height, so a tie between two
 * neighbors always resolves to whichever of them appears first in this list,
 * on both server and client, every time.
 */
const FLOW_DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, -1], // north
  [1, 0], // east
  [0, 1], // south
  [-1, 0], // west
];

/** True when (x, y) is in-bounds and, if `isActive` was given, active. */
function isTraceable(
  map: Heightmap,
  x: number,
  y: number,
  isActive: (x: number, y: number) => boolean,
): boolean {
  return x >= 0 && y >= 0 && x < map.size && y < map.size && isActive(x, y);
}

/**
 * A cell is a spring candidate when it is strictly higher than every
 * in-bounds, active 4-neighbor it has, and sits at least
 * SPRING_MIN_HEIGHT_ABOVE_SEA above SEA_LEVEL.
 *
 * A neighbor that is out of bounds or inactive (locked, or — on the client —
 * never received) does not count against candidacy: the world border and the
 * reveal frontier both behave like "nothing known lies beyond here", exactly
 * like every other edge treatment in this codebase (see mirror.ts's
 * sampleRenderHeight). A cell with every neighbor excluded this way would
 * pass vacuously, which is why the height floor is the real gate, not the
 * comparison.
 *
 * STRICT inequality, deliberately: two adjacent cells tied for the summit
 * (a `hard`-profile plateau) produce NO spring at all, not two. A flat mesa is
 * not "high ground" in the sense the card means — a proper peak is — so this
 * nudges the sculpting puzzle toward building one.
 */
function isLocalMaximum(
  map: Heightmap,
  x: number,
  y: number,
  isActive: (x: number, y: number) => boolean,
): boolean {
  const h = heightAt(map, x, y);
  if (h < SEA_LEVEL + SPRING_MIN_HEIGHT_ABOVE_SEA) return false;
  for (const [dx, dy] of FLOW_DIRECTIONS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!isTraceable(map, nx, ny, isActive)) continue;
    if (heightAt(map, nx, ny) >= h) return false;
  }
  return true;
}

/**
 * Every spring candidate in the active area, in FIXED (height descending,
 * then cell index ascending) order, capped at MAX_SPRINGS_PER_NETWORK.
 *
 * The scan itself is row-major over the active area (bounded, on the server,
 * to unlocked chunks by the caller's `isActive` — see World's river cache —
 * and, on the client, to received chunks by the same mechanism), which is an
 * O(activeCells) pass; the sort that follows is O(k log k) in the candidate
 * count k. Both are cheap relative to the recompute throttle they run behind
 * — see docs/DESIGN.md's cost arithmetic.
 */
function selectSprings(
  map: Heightmap,
  isActive: (x: number, y: number) => boolean,
): number[] {
  const candidates: { index: number; height: number }[] = [];
  for (let y = 0; y < map.size; y++) {
    for (let x = 0; x < map.size; x++) {
      if (!isActive(x, y)) continue;
      if (!isLocalMaximum(map, x, y, isActive)) continue;
      candidates.push({ index: cellIndex(map, x, y), height: heightAt(map, x, y) });
    }
  }
  candidates.sort((a, b) => (b.height !== a.height ? b.height - a.height : a.index - b.index));
  return candidates.slice(0, MAX_SPRINGS_PER_NETWORK).map((c) => c.index);
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow tracing, basin pooling, and waterfalls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far (in cells of a `worldSize`-edged world) one river's ENTIRE trace may
 * travel before it is cut off — flowing steps and basin-fill cells share this
 * one budget (see `traceRiver`), so a river that spends it all pooling never
 * gets to flow further, and vice versa. Twice the world's edge is generous
 * headroom for a real steepest-descent path (which, since height strictly
 * decreases each flowing step, can never revisit a cell and so can never
 * exceed one full world's worth of cells anyway) while keeping a single
 * river's worst-case cost a small, fixed multiple of `worldSize` regardless of
 * how many basins it crosses — see docs/DESIGN.md for the arithmetic this
 * bounds.
 */
export const RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER = 2;

/** One point along a river's course, in cell coordinates. */
export interface RiverPoint {
  readonly x: number;
  readonly y: number;
  /**
   * True while this point is part of a basin's pool (a lake at its spill
   * height) rather than the flowing channel. Rendered wider/stiller than a
   * flowing point — see client/src/render/riverRig.ts.
   */
  readonly pooled: boolean;
  /**
   * The pool's SURFACE height (fillBasin's `level`) when `pooled` is true;
   * `undefined` for a flowing point. A renderer draws every pooled point of
   * the same basin at this ONE flat height — never at the submerged cell's
   * own (lower) terrain height — which is what makes a lake read as still
   * water sitting over uneven ground rather than a lumpy wet patch.
   */
  readonly poolHeight?: number;
}

/** Where a river crosses a terrace band edge and falls (card 40). */
export interface Waterfall {
  /** The plunge point — the LOWER cell the water lands in. */
  readonly x: number;
  readonly y: number;
  /** How many bands it fell. Always >= 1. */
  readonly dropBands: number;
}

export interface River {
  readonly points: readonly RiverPoint[];
  readonly waterfalls: readonly Waterfall[];
  /** The river's course reached SEA_LEVEL and terminated in the sea. */
  readonly reachedSea: boolean;
  /**
   * The trace budget (RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize)
   * ran out before the course reached the sea or a permanent, fully-resolved
   * pool. ACCEPTED RESIDUAL, named rather than hidden: an extraordinarily
   * long or basin-heavy course simply stops where its budget did, drawn as
   * whatever it resolved so far. Never observed on a player-scale course (see
   * docs/DESIGN.md); real terrain would need many large, chained basins to
   * hit this.
   */
  readonly truncated: boolean;
}

export interface RiverNetwork {
  readonly rivers: readonly River[];
}

/**
 * Options for `computeRiverNetwork`. `isActive` restricts BOTH which cells may
 * seed a spring and which cells a trace may cross — the caller's one hook for
 * bounding cost to "the area that matters": the server passes the unlocked
 * mask (nobody sees a river no one has revealed, and there is no reason to pay
 * for one), and the client's TerrainMirror is already naturally bounded to
 * received chunks without needing this at all (an unreceived cell reads flat
 * at sea level, which can never be a spring or a mid-course cell above sea
 * level). Omitted means "every in-bounds cell is active" — every unit test in
 * rivers.test.ts uses this default.
 */
export interface RiverNetworkOptions {
  readonly isActive?: (x: number, y: number) => boolean;
}

const ALWAYS_ACTIVE = (): boolean => true;

/**
 * A simple binary min-heap over {index, height}, ordered by (height
 * ascending, then index ascending) — the same tie-break the rest of this
 * module uses everywhere two cells are otherwise equal, so a flat basin floor
 * fills in a fixed, reproducible cell order. Allocated fresh per basin fill:
 * a basin is bounded by the shared per-river cell budget (a few hundred to a
 * couple of thousand cells at most — see RIVER_TRACE_BUDGET_WORLD_SIZE_
 * MULTIPLIER), so this is not a hot allocation the way per-frame render code
 * would need to avoid.
 */
class RimHeap {
  private readonly items: { index: number; height: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(index: number, height: number): void {
    const items = this.items;
    items.push({ index, height });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.isLess(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Removes and returns the lowest (height, then index) entry, or null. */
  pop(): { index: number; height: number } | null {
    const items = this.items;
    if (items.length === 0) return null;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        if (left < items.length && this.isLess(left, smallest)) smallest = left;
        if (right < items.length && this.isLess(right, smallest)) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private isLess(a: number, b: number): boolean {
    const ia = this.items[a]!;
    const ib = this.items[b]!;
    return ia.height !== ib.height ? ia.height < ib.height : ia.index < ib.index;
  }

  private swap(a: number, b: number): void {
    const items = this.items;
    const tmp = items[a]!;
    items[a] = items[b]!;
    items[b] = tmp;
  }
}

/** Outcome of trying to fill and spill one basin. */
interface BasinResult {
  /**
   * The RIM cells absorbed into the pool, in the order they were absorbed —
   * NOT including the basin's own minimum cell, which the caller already
   * owns a point for (see traceRiver's push/charge-once invariant).
   */
  readonly cells: number[];
  /** The pool's surface height — the highest rim cell absorbed. */
  readonly poolHeight: number;
  /** The first cell downhill of the pool's spillway, or null. */
  readonly spillIndex: number | null;
  /** True when the shared per-river budget ran out before an outlet was found. */
  readonly budgetExhausted: boolean;
  /** Cells consumed from the shared per-river budget. */
  readonly spent: number;
}

/**
 * Fills the basin containing `minIndex` (a local minimum: every active
 * neighbor is at or above its height) outward, one rim cell at a time in
 * ascending-height order, until it finds a neighbor STRICTLY below the
 * current pool surface — the spillway, the basin's lowest saddle — or runs out
 * of `budget` cells to spend.
 *
 * THE ALGORITHM (a bounded, single-basin priority flood — the textbook
 * depression-filling technique, restricted to one basin instead of the whole
 * map, which is what keeps its cost proportional to the basin rather than to
 * world size). `level` only ever rises (it is set to the max height absorbed
 * so far), and the rim is explored strictly in ascending height order via the
 * min-heap, so the FIRST unfilled neighbor found below `level` is provably the
 * lowest point on the basin's entire rim: every rim cell lower than it would
 * have been popped from the heap first and would itself have triggered the
 * same check.
 *
 * Deterministic: the heap's tie-break (ascending cell index) makes a
 * perfectly flat basin floor fill in the same fixed order every time, and
 * `level`/`cells` depend only on heights and that order — never on iteration
 * timing.
 */
function fillBasin(
  map: Heightmap,
  minIndex: number,
  isActive: (x: number, y: number) => boolean,
  budget: number,
): BasinResult {
  // `minIndex` itself is NOT added to `cells` or charged against `spent` here:
  // the caller (traceRiver) already pushed a point for it and charged its one
  // unit of budget the moment `current` became this cell — see traceRiver's
  // "every cell is pushed and charged exactly once, at the point it is
  // reached" invariant. `filled` still seeds membership so it is never
  // re-visited by the rim search below.
  const filled = new Set<number>([minIndex]);
  const cells: number[] = [];
  let level = map.cells[minIndex]!;
  let spent = 0;

  const heap = new RimHeap();
  const pushNeighbors = (index: number): void => {
    const x = cellX(map.size, index);
    const y = cellY(map.size, index);
    for (const [dx, dy] of FLOW_DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!isTraceable(map, nx, ny, isActive)) continue;
      const ni = cellIndex(map, nx, ny);
      if (filled.has(ni)) continue;
      heap.push(ni, map.cells[ni]!);
    }
  };
  pushNeighbors(minIndex);

  while (spent < budget) {
    const popped = heap.pop();
    if (popped === null) {
      // Heap exhausted with no escape found: a genuinely closed basin (walled
      // by the world border or the edge of the active area on every side).
      return { cells, poolHeight: level, spillIndex: null, budgetExhausted: false, spent };
    }
    if (filled.has(popped.index)) continue; // stale entry (pushed before a later fill)
    if (popped.height < level) {
      // Below the current pool surface: this is the spillway.
      return { cells, poolHeight: level, spillIndex: popped.index, budgetExhausted: false, spent };
    }
    filled.add(popped.index);
    cells.push(popped.index);
    spent++;
    if (popped.height > level) level = popped.height;
    pushNeighbors(popped.index);
  }
  return { cells, poolHeight: level, spillIndex: null, budgetExhausted: true, spent };
}

/**
 * Traces one river from a spring to the sea, a permanent closed basin, or the
 * edge of its work budget — whichever comes first.
 *
 * Each flowing step moves to the strictly-lowest active 4-neighbor (ties
 * broken by FLOW_DIRECTIONS' fixed scan order); reaching a cell with no such
 * neighbor hands off to `fillBasin`. A waterfall is recorded at the LOWER
 * side of any step (flowing or the pool's own spillway) whose two ends sit in
 * different terrace bands — see `bandOf`.
 */
function traceRiver(map: Heightmap, springIndex: number, isActive: (x: number, y: number) => boolean): River {
  const budget = map.size * RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER;
  const points: RiverPoint[] = [];
  const waterfalls: Waterfall[] = [];

  const pushPoint = (index: number, pooled: boolean, poolHeight?: number): void => {
    points.push({
      x: cellX(map.size, index),
      y: cellY(map.size, index),
      pooled,
      ...(poolHeight !== undefined ? { poolHeight } : {}),
    });
  };
  const maybeWaterfall = (fromHeight: number, toIndex: number): void => {
    const toHeight = map.cells[toIndex]!;
    const drop = bandOf(fromHeight) - bandOf(toHeight);
    if (drop > 0) {
      waterfalls.push({ x: cellX(map.size, toIndex), y: cellY(map.size, toIndex), dropBands: drop });
    }
  };

  // INVARIANT: every cell visited is pushed as a point, and charged against
  // `spent`, EXACTLY ONCE — at the point in the loop where its role (flowing
  // vs. the floor of a pool) is actually decided. This is why the sea/budget
  // termination checks and both branches below each do their own single
  // `pushPoint` for `current`, rather than pushing eagerly on assignment: a
  // cell handed to `fillBasin` has NOT been pushed yet when this function
  // calls it, so fillBasin's own `cells` (the rim it absorbed) never needs to
  // special-case or duplicate the minimum cell it started from.
  let current = springIndex;
  let spent = 0;

  for (;;) {
    const h = map.cells[current]!;
    if (h <= SEA_LEVEL) {
      pushPoint(current, false);
      return { points, waterfalls, reachedSea: true, truncated: false };
    }
    if (spent >= budget) {
      pushPoint(current, false);
      return { points, waterfalls, reachedSea: false, truncated: true };
    }

    const x = cellX(map.size, current);
    const y = cellY(map.size, current);
    let bestIndex = -1;
    let bestHeight = h;
    for (const [dx, dy] of FLOW_DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!isTraceable(map, nx, ny, isActive)) continue;
      const ni = cellIndex(map, nx, ny);
      const nh = map.cells[ni]!;
      if (nh < bestHeight) {
        bestHeight = nh;
        bestIndex = ni;
      }
    }

    if (bestIndex !== -1) {
      pushPoint(current, false);
      spent++;
      maybeWaterfall(h, bestIndex);
      current = bestIndex;
      continue;
    }

    // Local minimum: pool and look for a spillway. Reserve one unit of the
    // remaining budget for `current`/minIndex itself (fillBasin's own budget
    // counts only the rim it absorbs beyond it — see its doc comment), so the
    // total this call can spend never exceeds what is left.
    const basin = fillBasin(map, current, isActive, budget - spent - 1);
    spent += basin.spent + 1;
    pushPoint(current, true, basin.poolHeight);
    for (const cell of basin.cells) pushPoint(cell, true, basin.poolHeight);
    if (basin.spillIndex === null) {
      return { points, waterfalls, reachedSea: false, truncated: basin.budgetExhausted };
    }
    maybeWaterfall(basin.poolHeight, basin.spillIndex);
    current = basin.spillIndex;
  }
}

/**
 * Computes the whole river network for a heightmap: every spring, the course
 * each one carves to the sea (or to wherever its trace budget or a genuinely
 * closed basin stops it), and the waterfalls along the way.
 *
 * PURE AND DETERMINISTIC (see the module header): call this twice with the
 * same map and the same `isActive`, and every field of the result is
 * byte-identical. Nothing here mutates `map`.
 *
 * NOT CHEAP ENOUGH TO CALL ON EVERY TERRAIN DIFF — see docs/DESIGN.md's
 * recompute-strategy arithmetic. Callers (server/src/world/world.ts,
 * client/src/world.ts) throttle their own calls; this function itself has no
 * opinion about cadence.
 */
export function computeRiverNetwork(map: Heightmap, options?: RiverNetworkOptions): RiverNetwork {
  const isActive = options?.isActive ?? ALWAYS_ACTIVE;
  const springs = selectSprings(map, isActive);
  const rivers = springs.map((springIndex) => traceRiver(map, springIndex, isActive));
  return { rivers };
}
