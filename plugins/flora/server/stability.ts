// HOW LONG HAS THIS CELL BEEN LEFT ALONE — the mechanism the whole feature
// hangs off ("trees spawn in the green layers when they've been stable for a
// short period of time", owner, 2026-08-14).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DESIGN, AND THE ONE IT BEAT.
//
// CHOSEN — a per-cell LAST-CHANGED STAMP, written from the terrain-change hook.
//   One Int32 per cell holding the simulated second at which that cell's height
//   last moved. Writing costs one store per changed cell, and core already hands
//   the plugin the exact list (onTerrainChanged's full diff), so there is no
//   scan at all. Reading is one typed-array load.
//
// REJECTED — a HEIGHT MIRROR DIFFED PER SURVEY (the shape the brief offered as
//   the alternative: keep a copy of the heightmap, compare it every survey, and
//   count consecutive unchanged surveys per cell). It loses on both axes:
//
//     * COST. An Int16 mirror is 512 KB at 512², and the "how many surveys
//       unchanged" counter it still needs is another 256 KB as Uint8 — 768 KB,
//       versus 1 MB here, so it is barely cheaper in memory and it adds a
//       262 144-cell compare every survey that this design does not do at all.
//     * CORRECTNESS, which is what actually settles it. A mirror only sees the
//       state at survey boundaries. A player who raises a cell and puts it back
//       between two surveys leaves the mirror equal, so the cell reads as never
//       having changed and its tree survives a sculpt that plainly hit it. A
//       last-changed stamp is written from the EVENT, so nothing can happen
//       between two observations without being recorded.
//
// MEMORY, exactly:
//
//   world   cells      Int32Array
//   128²     16 384    64 KB
//   256²     65 536   256 KB
//   512²    262 144     1 MB
//
// One megabyte on the largest world, allocated once at world create and never
// resized — the same order as the heightmap it shadows (512 KB of Int16), and
// two orders below the 100 MB-ish a Node server idles at. The alternative that
// scales with CHURN instead of with area (a Map of recently-changed cells,
// evicted past the window) was also considered and rejected: it is smaller in
// the common case but its worst case is unbounded-ish (a player sculpting
// continuously for the whole window puts tens of thousands of boxed entries in
// it), and a fixed 1 MB that a self-hoster can reason about beats a variable
// cost that is only usually smaller.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulated seconds a cell's height must go unchanged before anything will grow
 * on it. The owner's "a short period of time", made concrete.
 *
 * 90 s, bounded from both sides by how people actually sculpt:
 *
 *   * NOT SHORTER, because a build is not one edit. Shaping a plateau is bursts
 *     of strokes separated by pauses to orbit the camera and look — call it
 *     10–30 s of standing still. A window inside that range would sprout
 *     saplings in the middle of an unfinished build and fell them again on the
 *     next stroke, which reads as flickering rather than as growth. 90 s is
 *     several times the longest such pause.
 *   * NOT LONGER, because the point is that the player connects the two events.
 *     Someone who flattens a green shelf and keeps playing nearby should watch
 *     it green over while they are still there; past a couple of minutes the
 *     causal link between "I made this" and "trees appeared" is gone and the
 *     forest reads as weather.
 *
 * It is the FIRST of two delays a new meadow waits out; the second is the
 * stochastic sprouting itself (FLORA_MEAN_SPROUT_WAIT_SECONDS, forest.ts), so
 * the visible answer to "I levelled this, when do I get trees" is "the first
 * ones in about two minutes, filled in over five".
 */
export const FLORA_STABILITY_SECONDS = 90;

/**
 * Per-cell record of when the ground last moved, in simulated seconds.
 *
 * CLOCK: simulated seconds accumulated from the host's `dt`, never a wall clock
 * — the same rule wildlife keeps, so a server at any TICK_HZ behaves identically
 * per simulated second, and so a test can advance time by calling tick.
 */
export class StabilityMap {
  /**
   * Simulated second of each cell's last height change, row-major.
   *
   * Int32 rather than Float32: the values are whole seconds and must stay exact
   * for the whole life of a world, and Float32 stops representing consecutive
   * integers past 2²⁴ ≈ 194 days of uptime — at which point stability
   * comparisons would silently start rounding. Int32 is exact to 68 years.
   *
   * ZERO-FILLED, which is the correct initial state and not merely a convenient
   * one: a freshly created (or freshly restored) world has been what it is since
   * simulated second 0, so every cell becomes eligible once the server has been
   * up for FLORA_STABILITY_SECONDS. A restore does NOT carry these stamps (see
   * ./persistence.ts) — trees persist, the stability clock restarts.
   */
  private readonly lastChangedSeconds: Int32Array;

  /** Cells per world edge. Fixed for the life of the world. */
  readonly worldSize: number;

  // NOT a parameter property (`constructor(readonly worldSize: number)`), which
  // is what this was and which does not boot: the server runs plugin TypeScript
  // through Node's type STRIPPING, and a parameter property is syntax that has
  // to be transformed rather than erased. `erasableSyntaxOnly` in this plugin's
  // tsconfig is what now makes that a compile error instead of a crash at
  // discovery — the same rule design/CLAUDE.md states for shared/, which applies
  // to every module Node loads directly.
  constructor(worldSize: number) {
    this.worldSize = worldSize;
    this.lastChangedSeconds = new Int32Array(worldSize * worldSize);
  }

  private indexOf(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.worldSize || y >= this.worldSize) return -1;
    return y * this.worldSize + x;
  }

  /**
   * Records that (x, y) just moved. `nowSeconds` is floored, so a cell is judged
   * stable at most one second later than it truly is — irrelevant against a
   * 90-second window, and it keeps the store exact.
   *
   * Out-of-bounds cells are ignored rather than throwing: the diff this is fed
   * from is core's own and is always in bounds, so a guard here is cheap
   * insurance against a future caller, not a case that happens.
   */
  markChanged(x: number, y: number, nowSeconds: number): void {
    const index = this.indexOf(x, y);
    if (index < 0) return;
    this.lastChangedSeconds[index] = Math.floor(nowSeconds);
  }

  /** Simulated seconds since this cell last moved. 0 for out-of-bounds cells. */
  secondsSinceChange(x: number, y: number, nowSeconds: number): number {
    const index = this.indexOf(x, y);
    if (index < 0) return 0;
    return nowSeconds - this.lastChangedSeconds[index];
  }

  /** Has this cell been left alone for the whole window? */
  isStable(x: number, y: number, nowSeconds: number): boolean {
    return this.secondsSinceChange(x, y, nowSeconds) >= FLORA_STABILITY_SECONDS;
  }
}
