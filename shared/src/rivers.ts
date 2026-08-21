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

import { SEA_LEVEL } from './constants.ts';
import { bandOf, cellIndex, cellX, cellY, heightAt, type Heightmap } from './heightmap.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Springs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far above sea level a cell must sit to qualify as a spring, in HEIGHT
 * UNITS. "Springs on high ground" (card 27) is the only guidance the card
 * gives; a bare local maximum at, say, height 1 would put a spring on the very
 * first ripple above the coast, which reads as noise rather than high ground.
 *
 * A HEIGHT, NOT A CLICK (2026-08-20). This used to be spelled BAND_HEIGHT and
 * justified as "the smallest rise a player's stamp brush can make in a single
 * click" — true then, and it happened to equal 64. When the world was
 * re-terraced a click became four times finer, and following it down would
 * have put the threshold at a quarter of its old rise: the very first ripple
 * above the coast, which is precisely what the paragraph above rules out. The
 * threshold is a statement about the LAND, so it keeps the land value (64, or
 * four terrace bands at today's resolution) and lets the click move without
 * it. What it costs is the tidy "raise the coast once and you may have earned
 * a spring"; that reading is now "raise the coast four times", and the
 * spring's position in the world is unchanged, which is the half that matters.
 */
export const SPRING_MIN_HEIGHT_ABOVE_SEA = 64;

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
 * best downhill neighbor on a STRICTLY lower height, so neighbors tied for
 * lowest accumulate in this list's order — the first continues the course it
 * is on and the rest fork off it, in this order, on both server and client,
 * every time. (A tie no longer DISCARDS the later neighbors; see
 * `traceRiver`'s split rule.)
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

/**
 * ONE unbroken run of a river, in flow order: a polyline a renderer can draw
 * as a ribbon without lifting the pen (client/src/render/riverRig.ts does
 * exactly that).
 *
 * A river has more than one course whenever its descent SPLITS — see
 * `traceRiver`'s distributary rule. The first course in `River.courses` is
 * always the trunk (the one that starts at the spring); every later one
 * begins at the junction that spawned it.
 *
 * COURSES OVERLAP AT THEIR JUNCTIONS, DELIBERATELY. A branch course repeats
 * the junction cell as its own first point, and a course that flows back into
 * a cell this river already owns repeats that confluence cell as its own last
 * point. Both repeats exist so the drawn ribbons MEET rather than leaving a
 * half-cell gap at every fork; consumers that ask per-cell questions
 * (freshwater.ts) are set-based and unaffected by the duplication.
 */
export interface RiverCourse {
  readonly points: readonly RiverPoint[];
}

export interface River {
  /**
   * Every run of this river, trunk first. Not a flat point list: see
   * `riverPoints` for that view.
   */
  readonly courses: readonly RiverCourse[];
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
 * Every point of every course of one river, trunk first, in course order.
 *
 * THE FLAT VIEW, DERIVED — not a second stored copy. Callers that ask a
 * per-cell question (buildFreshwaterMap, the world tests) want this; callers
 * that draw want `River.courses`. May contain the same cell twice where two
 * courses meet at a junction (see `RiverCourse`), so this is safe to feed a
 * set or a `Map`, and never a running total.
 */
export function riverPoints(river: River): RiverPoint[] {
  const points: RiverPoint[] = [];
  for (const course of river.courses) points.push(...course.points);
  return points;
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
  /**
   * EVERY cell downhill of the pool's spillway, in ascending cell index —
   * empty when the basin is closed (or the budget ran out first).
   *
   * More than one when the basin's rim has two or more saddles at EXACTLY the
   * same height: a pool that brims over in two places genuinely drains in two
   * places, so the caller starts a distributary course down each of them (see
   * `traceRiver`). Bounded by the rim, and in practice by the four-neighbour
   * fan-out of the cells at that height.
   */
  readonly spillIndices: number[];
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
      return { cells, poolHeight: level, spillIndices: [], budgetExhausted: false, spent };
    }
    if (filled.has(popped.index)) continue; // stale entry (pushed before a later fill)
    if (popped.height < level) {
      // Below the current pool surface: this is the spillway. Every FURTHER
      // rim cell at exactly this height is an equally-low saddle — the heap
      // pops in (height asc, index asc) order, so they are precisely the
      // entries that follow before the first strictly-higher one. Draining
      // through all of them is what makes a brimming pool fork.
      const spillIndices = [popped.index];
      const seen = new Set<number>([popped.index]);
      for (;;) {
        const next = heap.pop();
        if (next === null || next.height !== popped.height) break;
        if (filled.has(next.index) || seen.has(next.index)) continue;
        seen.add(next.index);
        spillIndices.push(next.index);
      }
      return { cells, poolHeight: level, spillIndices, budgetExhausted: false, spent };
    }
    filled.add(popped.index);
    cells.push(popped.index);
    spent++;
    if (popped.height > level) level = popped.height;
    pushNeighbors(popped.index);
  }
  return { cells, poolHeight: level, spillIndices: [], budgetExhausted: true, spent };
}

/**
 * One not-yet-traced branch of a river, waiting its turn in `traceRiver`'s
 * queue.
 */
interface CourseSeed {
  /** The cell this course starts its own descent from. */
  readonly index: number;
  /**
   * The junction point to repeat as this course's first point, so the drawn
   * ribbon starts ON its parent's centre-line instead of half a cell away.
   * Null for the trunk (which starts at the spring itself) and for a course
   * leaving a pool (which starts on the lake surface already drawn there).
   */
  readonly junction: RiverPoint | null;
}

/**
 * Traces one river from a spring to the sea, a permanent closed basin, or the
 * edge of its work budget — whichever comes first, DOWN EVERY PATH THE WATER
 * ACTUALLY HAS.
 *
 * SPLITS (2026-08-21, owner: "anywhere a river has multiple paths, it should
 * follow those multiple paths"). A flowing step moves to the lowest active
 * 4-neighbour strictly below the current cell — and when two or more
 * neighbours TIE for that lowest height, the water goes down all of them: the
 * first becomes this course's continuation and each of the others is queued
 * as a new course forking from this cell. The same rule applies to a pool
 * that brims over at two equally-low saddles (`fillBasin`'s `spillIndices`).
 * This REPLACES the old tie-break "whichever neighbour FLOW_DIRECTIONS lists
 * first wins, the rest are dropped", which silently threw away half of a
 * symmetric slope's drainage — the very thing a player's radially-symmetric
 * brush stroke produces.
 *
 * EXACT TIES ONLY, deliberately. Heights are integers, so "equally downhill"
 * is an exact, order-free test that gives server and client byte-identical
 * forks; a tolerance ("within N units") would be a tuning knob whose value
 * decides how braided the world looks, and a wrong one turns every gentle
 * slope into a delta. FLOW_DIRECTIONS' fixed scan order still fixes WHICH
 * branch continues the current course and in what order the rest are queued,
 * so the output is fully determined.
 *
 * MERGES fall out of the same walk: a branch that flows into a cell this
 * river has already visited stops there, repeating that cell as its last
 * point so the ribbons meet, rather than re-tracing (and re-charging) a
 * course that is already drawn.
 *
 * Branches are traced breadth-first in the order they were queued — a fixed
 * order, and the one that spends the shared budget on the widest reach rather
 * than on the first branch's full descent.
 *
 * COST IS UNCHANGED BY BRANCHING. A junction can fan out to at most the four
 * cells FLOW_DIRECTIONS names, and — the part that actually bounds the work —
 * every cell a river reaches down any branch is claimed, pushed and charged
 * exactly once against the SAME per-river budget the single-path trace used
 * (RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize). Branching therefore
 * spends that budget across more courses; it never spends more of it.
 *
 * A waterfall is recorded at the LOWER side of any step (flowing or a pool's
 * spillway) whose two ends sit in different terrace bands — see `bandOf`.
 * With branching, two courses can plunge into the SAME cell; a plunge point
 * is a place rather than an event, so waterfalls are deduplicated by cell,
 * keeping the largest drop seen there.
 */
function traceRiver(map: Heightmap, springIndex: number, isActive: (x: number, y: number) => boolean): River {
  const budget = map.size * RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER;
  const courses: RiverCourse[] = [];
  /** Plunge cell index → the largest band drop recorded there. Insertion-ordered. */
  const waterfallDrops = new Map<number, number>();

  const pointAt = (index: number, pooled: boolean, poolHeight?: number): RiverPoint => ({
    x: cellX(map.size, index),
    y: cellY(map.size, index),
    pooled,
    ...(poolHeight !== undefined ? { poolHeight } : {}),
  });
  const maybeWaterfall = (fromHeight: number, toIndex: number): void => {
    const toHeight = map.cells[toIndex]!;
    const drop = bandOf(fromHeight) - bandOf(toHeight);
    if (drop <= 0) return;
    const existing = waterfallDrops.get(toIndex);
    if (existing === undefined || drop > existing) waterfallDrops.set(toIndex, drop);
  };

  // INVARIANT (unchanged by branching): every cell this river reaches is
  // pushed as a point, and charged against `spent`, EXACTLY ONCE — at the
  // point in the loop where its role (flowing vs. the floor of a pool) is
  // actually decided. `visited` is what extends that invariant across
  // branches: a cell is added to it the moment it is CLAIMED (queued as a
  // branch head, stepped onto, or absorbed into a pool), so no two courses
  // can ever both charge it. The junction/confluence points repeated for
  // geometric continuity are copies of a point some course already owns —
  // they are never charged, and never claim anything.
  const visited = new Set<number>([springIndex]);
  const queue: CourseSeed[] = [{ index: springIndex, junction: null }];
  let spent = 0;
  let reachedSea = false;
  let truncated = false;

  /**
   * Records the waterfall into each candidate, claims the ones no course of
   * this river owns yet, and returns the first of those for the CURRENT
   * course to continue onto — queueing the rest as new courses. Null when
   * every candidate is already claimed, which is how a merging course learns
   * it has nothing left to trace.
   */
  const claimBranches = (
    candidates: readonly number[],
    junction: RiverPoint | null,
    fromHeight: number,
  ): number | null => {
    let continueWith: number | null = null;
    for (const candidate of candidates) {
      maybeWaterfall(fromHeight, candidate);
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      if (continueWith === null) continueWith = candidate;
      else queue.push({ index: candidate, junction });
    }
    return continueWith;
  };

  while (queue.length > 0) {
    const seed = queue.shift()!;
    const points: RiverPoint[] = [];
    if (seed.junction !== null) points.push(seed.junction);
    let current = seed.index;

    for (;;) {
      const h = map.cells[current]!;
      if (h <= SEA_LEVEL) {
        points.push(pointAt(current, false));
        reachedSea = true;
        break;
      }
      if (spent >= budget) {
        points.push(pointAt(current, false));
        truncated = true;
        break;
      }

      // Every active neighbour tied for the lowest height strictly below this
      // cell. `lowest` starts at `h`, so the `=== lowest` arm can only fire
      // once a strictly-lower neighbour has already been found.
      const x = cellX(map.size, current);
      const y = cellY(map.size, current);
      const downhill: number[] = [];
      let lowest = h;
      for (const [dx, dy] of FLOW_DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!isTraceable(map, nx, ny, isActive)) continue;
        const ni = cellIndex(map, nx, ny);
        const nh = map.cells[ni]!;
        if (nh < lowest) {
          lowest = nh;
          downhill.length = 0;
          downhill.push(ni);
        } else if (nh === lowest && lowest < h) {
          downhill.push(ni);
        }
      }

      if (downhill.length > 0) {
        const point = pointAt(current, false);
        points.push(point);
        spent++;
        const next = claimBranches(downhill, point, h);
        if (next === null) {
          // Every way down already belongs to this river: this course ends at
          // the confluence. Repeat the cell it joins so the ribbons meet.
          points.push(pointAt(downhill[0]!, false));
          break;
        }
        current = next;
        continue;
      }

      // Local minimum: pool and look for a spillway. Reserve one unit of the
      // remaining budget for `current`/minIndex itself (fillBasin's own budget
      // counts only the rim it absorbs beyond it — see its doc comment), so the
      // total this call can spend never exceeds what is left.
      const basin = fillBasin(map, current, isActive, budget - spent - 1);
      spent += basin.spent + 1;
      points.push(pointAt(current, true, basin.poolHeight));
      for (const cell of basin.cells) {
        visited.add(cell);
        points.push(pointAt(cell, true, basin.poolHeight));
      }
      if (basin.spillIndices.length === 0) {
        truncated = truncated || basin.budgetExhausted;
        break;
      }
      // A course leaving a pool starts AT the spillway: the lake tile it
      // drains from is already drawn under it, so it needs no junction point.
      const next = claimBranches(basin.spillIndices, null, basin.poolHeight);
      if (next === null) break;
      current = next;
    }

    courses.push({ points });
  }

  const waterfalls: Waterfall[] = [];
  for (const [index, dropBands] of waterfallDrops) {
    waterfalls.push({ x: cellX(map.size, index), y: cellY(map.size, index), dropBands });
  }
  return { courses, waterfalls, reachedSea, truncated };
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
