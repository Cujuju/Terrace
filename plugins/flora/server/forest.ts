// THE FOREST: which cells hold trees, how many there should be, and the
// once-every-few-seconds survey that moves the first toward the second.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SURVEY — ONE PASS, THREE PRODUCTS.
//
// Every FLORA_SURVEY_INTERVAL_SECONDS the plugin walks the cells of every
// unlocked chunk exactly once and comes back with:
//
//   1. AREA        — how many stable green cells exist. That number, divided by
//                    FLORA_CELLS_PER_TREE, is how many trees the world should
//                    hold; the difference from what it does hold is the deficit.
//   2. CANDIDATES  — a uniform random sample of up to FLORA_MAX_SPROUTS_PER_SURVEY
//                    plantable cells, taken by RESERVOIR SAMPLING inside the same
//                    pass. This is what makes the pass allocation-free: the naive
//                    version builds an array of every eligible cell (100 000+ on
//                    a green 512² world) and throws it away each survey.
//   3. CASUALTIES  — standing trees whose cell is no longer plantable at all.
//
// Cost: one heightAt, one band test and one typed-array read per cell, plus one
// rng call per cell that passes. That is ~262 000 cells on a fully revealed 512²
// world, which measures in the low milliseconds ONCE EVERY FIVE SECONDS — the
// same shape and the same order as wildlife's habitat census, which walks the
// same cells on the same cadence.
//
// WHY A SURVEY AND NOT A PER-CELL TIMER. The alternative — waking each cell up
// exactly when its stability window expires — needs a priority queue holding an
// entry per changed cell and produces a thundering herd the moment a big sculpt's
// cells all mature in the same millisecond. A poll is O(area) on a fixed cadence,
// has no queue to keep consistent with the diff stream, and gives the stochastic
// growth its natural time step for free.
// ─────────────────────────────────────────────────────────────────────────────
//
// CLOCK: simulated seconds only, accumulated from the host's `dt`. No Date.now
// anywhere, so a server at any TICK_HZ behaves identically per simulated second.

import {
  CHUNK_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
  cellsOverArea,
} from '@terrace/shared';
import { FLORA_TREE_CAP, treeCellOf, treeKey, type TreeCell } from '../protocol.ts';
import { isGreenBand, isPlantableCell, type FloraWorld } from './bands.ts';
import type { StabilityMap } from './stability.ts';

// ────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Simulated seconds between surveys.
 *
 * 5 s, the same cadence wildlife's census runs at and for the same reason: the
 * inputs (terrain, the unlock mask) only change at human pace, so a finer poll
 * would only re-derive the same answer. On the worst world this plugin can be
 * given — 512², fully revealed, every cell green and eligible — one sweep at
 * this cadence measures ~30 ms of work, i.e. ~0.6% of a core, spread evenly
 * across the ticks it spans (see Forest.advanceSurvey).
 *
 * It is also the time step the growth hazard below is expressed in, which is why
 * the two constants are read together — and why the sweep is paced to take
 * exactly one interval on every world size (server/index.ts, chunksPerTick).
 */
export const FLORA_SURVEY_INTERVAL_SECONDS = 5;

/**
 * Stable green cells per tree — the density the world is steered toward.
 *
 * Retuned twice at the owner's request ("increase the spawn rate and frequency
 * for trees", 2026-08-25; "I don't see enough trees… on the green bands",
 * same day): 12 → 8 → 4 SQUARE WORLD UNITS per tree, i.e. one tree per 64
 * cells. A full 16×16-cell chunk (16 square world units) holds 4 trees, each
 * crown spanning a fifth of the chunk's edge. Still bounded by what the ground
 * has to say:
 *
 *   * The terraces are the thing being looked at. Denser than this and the
 *     canopy starts hiding the band edges and the Godus silhouette that the
 *     whole renderer exists to produce goes with it.
 *
 * IT IS A DENSITY OVER GROUND, so it is stated in SQUARE WORLD UNITS per tree
 * and multiplied by WORLD_UNIT_CELLS twice. Left as a flat count of cells, the
 * 2026-08-21 re-sample would have put sixteen times as many trees on every
 * hillside — the same forest counted in a finer grid, not a denser one.
 */
export const FLORA_CELLS_PER_TREE = cellsOverArea(4);

/**
 * Minimum Chebyshev distance between two trees — one and a HALF WORLD UNITS,
 * converted, so the ground around a tree stays clear of other trees.
 *
 * Tightened 2026-08-25 alongside the density retune (FLORA_CELLS_PER_TREE
 * 8 → 4): the old two-unit rule capped local packing at one tree per four
 * square world units, which is exactly what the new target asks for — the
 * spacing rule, not the target, would have decided how many trees a world has.
 * At 1.5 units the cap is one tree per 2.25 square units, comfortably above
 * the target, so the two constants shape the pattern together instead of
 * fighting: the target decides how many, the spacing decides where they are not.
 *
 * It stays a MODEL constraint measured against the crown: a crown is about 0.8
 * world units across and its scale varies up to ×1.25, so the widest crown is
 * ~1.0 unit across — centres 1.5 units apart still leave a visible sliver of
 * ground between neighbours at their closest approach.
 */
export const FLORA_MIN_TREE_SPACING_CELLS = cellsAcross(1.5);

/**
 * Mean simulated seconds one missing tree waits before it sprouts.
 *
 * Each tree the world is short of carries a constant hazard of 1/W per second,
 * so with a deficit of D the expected arrivals per second are D/W and the
 * deficit decays exponentially with time constant W — INDEPENDENTLY of world
 * size, which is the property worth having: a single levelled meadow and a whole
 * revealed continent both reach ~63% of their target after W seconds, ~86% after
 * 2W, ~95% after 3W. (The same shape, and the same reasoning, as wildlife's
 * SPAWN_MEAN_WAIT_SECONDS.)
 *
 * Retuned 2026-08-25 (owner: "increase the spawn rate and frequency for trees"):
 * 60 s down to 30 s. A small meadow's first trees now arrive within a survey of
 * it stabilising and it is essentially grown in about ninety seconds. Faster
 * still and a flattened hillside pops into a forest between two glances, which
 * loses the thing the owner originally asked for — that trees arrive because the
 * ground was LEFT alone. Slower and a player never sees it happen at all.
 */
export const FLORA_MEAN_SPROUT_WAIT_SECONDS = 30;

/**
 * Hard ceiling on new trees per survey. Also the size of the candidate
 * reservoir, because there is no point sampling cells that cannot be used.
 *
 * Retuned 2026-08-25 (owner: "increase the spawn rate and frequency for trees"):
 * 24 up to 48, so a large newly-eligible area fills in visibly faster. Chosen
 * against the two things it bounds:
 *
 *   * WIRE — a growth delta is at most 48 × 6 B ≈ 288 B every 5 s (protocol.ts),
 *     still noise next to the join snapshot.
 *   * PACING — it binds only when the deficit exceeds 48 × (30 / 5) = 288 trees,
 *     i.e. only on a large area that just became eligible all at once. Below
 *     that the hazard is what paces growth, which is the intended behaviour: a
 *     meadow fills in gradually, and it is only a continent that gets rate
 *     limited. A world going from bare to the full 3000-tree cap takes
 *     3000 / 48 ≈ 63 surveys ≈ 5 minutes at the limit, which is fast against
 *     how long revealing that much territory takes in the first place.
 */
export const FLORA_MAX_SPROUTS_PER_SURVEY = 48;

/**
 * Seed for a world that has never grown a tree. Fixed rather than clock-derived,
 * exactly as relics does: a self-hoster reporting "my forest all grew in one
 * corner" should be reproducible, and the tests need the same sequence every
 * run. The value is arbitrary; only its fixedness is load-bearing.
 */
export const FLORA_RNG_DEFAULT_SEED = 0x5eed10ca;

// ────────────────────────────────────────────────────────────────────────────
// The generator
// ────────────────────────────────────────────────────────────────────────────

/** A seeded PRNG whose whole state is one uint32, so it persists trivially. */
export interface FloraRng {
  /** Next value in [0, 1). */
  next(): number;
  /** Current internal state, for the persistence slice. */
  state(): number;
}

/**
 * mulberry32 — 32 bits of state, uniform enough for picking cells, short enough
 * to read. Chosen over Math.random because Math.random cannot be seeded and
 * therefore cannot be persisted or reproduced.
 *
 * This is a COPY of the generator in plugins/relics/server/spawn.ts, not an
 * import, and that is deliberate: every plugin must build and run with any other
 * plugin deleted, so a cross-plugin import for eight lines of arithmetic would
 * trade a real independence guarantee for a trivial saving.
 */
export function createFloraRng(seed: number): FloraRng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    },
    state(): number {
      return a;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Density maths — pure, so the tests can assert it without a world
// ────────────────────────────────────────────────────────────────────────────

/**
 * How many trees a given amount of stable green ground should hold.
 *
 * The area counts every stable green cell INCLUDING the ones already holding
 * trees. Counting only empty cells would make the target shrink as the forest
 * grew, and the world would settle at area/(cells-per-tree + 1) — a different
 * number than the constant says, reached by an equilibrium nobody wrote down.
 */
export function treeTargetFor(stableGreenCells: number): number {
  const wanted = Math.floor(stableGreenCells / FLORA_CELLS_PER_TREE);
  return wanted > FLORA_TREE_CAP ? FLORA_TREE_CAP : wanted;
}

/**
 * How many trees sprout this survey, given the deficit.
 *
 * Expected value is deficit × (interval / mean wait) — the Poisson rate over one
 * survey's window. The integer count is that expectation floored plus a Bernoulli
 * draw on the fractional part (stochastic rounding), so a deficit small enough
 * that the expectation is 0.4 still produces a tree about two surveys in five
 * rather than never, and the long-run average is exactly the expectation.
 *
 * Clamped by both the per-survey ceiling and the deficit itself, so growth can
 * neither burst nor overshoot the target by even one tree.
 */
export function sproutCount(deficit: number, rng: FloraRng): number {
  if (deficit <= 0) return 0;
  const expected = deficit * (FLORA_SURVEY_INTERVAL_SECONDS / FLORA_MEAN_SPROUT_WAIT_SECONDS);
  const whole = Math.floor(expected);
  const drawn = whole + (rng.next() < expected - whole ? 1 : 0);
  return Math.min(drawn, FLORA_MAX_SPROUTS_PER_SURVEY, deficit);
}

// ────────────────────────────────────────────────────────────────────────────
// The forest itself
// ────────────────────────────────────────────────────────────────────────────

/** What one survey changed. Both lists are empty on a quiet survey. */
export interface SurveyResult {
  readonly grown: readonly TreeCell[];
  readonly felled: readonly TreeCell[];
}

const EMPTY_SURVEY: SurveyResult = { grown: [], felled: [] };

/**
 * A cell a structure currently occupies. Buildings always win (owner,
 * 2026-08-19: "if buildings are going to spawn over trees, then the trees
 * need to de-spawn"), so every survey phase below treats an occupied cell
 * exactly like one that failed isPlantableCell — never counted toward area,
 * never offered as a candidate, and culled if a tree is already standing
 * there. The default, used by every caller that passes none, is "nothing is
 * occupied" — the shape of a world with no structures plugin installed, and
 * also every existing call site in this suite that predates structures
 * occupancy (a JS function may always declare fewer parameters than its
 * caller provides).
 */
export type OccupancyPredicate = (x: number, y: number) => boolean;
const NEVER_OCCUPIED: OccupancyPredicate = () => false;

/**
 * The standing trees, keyed by cell.
 *
 * A Set of packed cell keys rather than a per-cell byte grid: at the cap it
 * holds 3000 numbers (~100 KB) against 262 KB for a Uint8 grid at 512², it
 * iterates in O(trees) rather than O(area) — which is what the broadcast and the
 * snapshot need — and O(1) membership is all the survey ever asks of it.
 */
export class Forest {
  private readonly standing = new Set<number>();

  // ── Rolling-sweep state ────────────────────────────────────────────────────
  // A survey is spread over many ticks (see advanceSurvey), so its partial
  // results have to live between them.

  /** Next chunk ordinal to visit, row-major. `totalChunks` means "sweep done". */
  private cursor = 0;
  /** Stable green cells counted so far this sweep, trees included. */
  private sweepArea = 0;
  /** Plantable cells offered to the reservoir so far — algorithm R's `n`. */
  private sweepSeen = 0;
  /** The reservoir: up to FLORA_MAX_SPROUTS_PER_SURVEY packed cell keys. */
  private readonly candidates: number[] = [];

  get count(): number {
    return this.standing.size;
  }

  has(x: number, y: number): boolean {
    return this.standing.has(treeKey(x, y));
  }

  /** Every standing tree, in planting order (Set preserves insertion order). */
  cells(): TreeCell[] {
    return Array.from(this.standing, treeCellOf);
  }

  /** Plants unconditionally. Returns false if that cell already had a tree. */
  plant(x: number, y: number): boolean {
    const key = treeKey(x, y);
    if (this.standing.has(key)) return false;
    if (this.standing.size >= FLORA_TREE_CAP) return false;
    this.standing.add(key);
    return true;
  }

  /** Fells the tree at (x, y). Returns false if there was none. */
  fell(x: number, y: number): boolean {
    return this.standing.delete(treeKey(x, y));
  }

  /** Replaces the whole forest — the restore path. Silently caps at the ceiling. */
  replaceAll(cells: Iterable<TreeCell>): void {
    this.standing.clear();
    for (const cell of cells) {
      if (this.standing.size >= FLORA_TREE_CAP) break;
      this.standing.add(treeKey(cell.x, cell.y));
    }
    // A sweep half-finished over the PREVIOUS forest has nothing to say about
    // this one.
    this.resetSweep();
  }

  /** Is any other tree within FLORA_MIN_TREE_SPACING_CELLS of this cell? */
  private isCrowded(x: number, y: number): boolean {
    const reach = FLORA_MIN_TREE_SPACING_CELLS - 1;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (this.standing.has(treeKey(x + dx, y + dy))) return true;
      }
    }
    return false;
  }

  /**
   * Fells every tree whose cell is no longer plantable — sculpted out of the
   * green bands, or (impossible today, since chunks never re-lock) outside
   * unlocked territory — OR is now occupied by a structure.
   *
   * The reactive path in ./index.ts already fells on any height change, and the
   * event-driven path in ./index.ts's onWorldEvent already fells a seeded or
   * upgraded structure cell the instant that event arrives, so in a correct
   * server with structures installed this sweep finds little. It runs anyway,
   * unconditionally, for the same reason wildlife's habitat sweep does: it
   * makes "no tree ever stands on ground that could not grow one" true BY
   * CONSTRUCTION rather than by trusting that every path in — including a
   * structure's ordinary B3/S23 birth or stir spark, which the world event
   * deliberately does not name (see ../server/structures-event.ts) —
   * remembered to call a hook. It also closes the one-time case this feature
   * shipped with: a building already standing over a tree from before this
   * plugin knew to check. It costs O(trees) — at most 3000 lookups every 5 s —
   * and the failure it insures against (a tree standing in mid-air on a cliff
   * someone carved, or inside a longhouse) is exactly the kind a player
   * screenshots.
   */
  private cull(world: FloraWorld, isOccupied: OccupancyPredicate): TreeCell[] {
    const felled: TreeCell[] = [];
    for (const key of this.standing) {
      const cell = treeCellOf(key);
      if (isPlantableCell(world, cell.x, cell.y) && !isOccupied(cell.x, cell.y)) continue;
      felled.push(cell);
    }
    for (const cell of felled) this.standing.delete(treeKey(cell.x, cell.y));
    return felled;
  }

  /** Discards a sweep in progress. */
  private resetSweep(): void {
    this.cursor = 0;
    this.sweepArea = 0;
    this.sweepSeen = 0;
    this.candidates.length = 0;
  }

  /**
   * Visits ONE chunk: counts its stable green cells and offers its plantable
   * ones to the reservoir.
   *
   * Reservoir sampling (algorithm R): the first k plantable cells fill the
   * reservoir, and the n-th one after that replaces a uniformly chosen slot with
   * probability k/n. The result is a uniform random k-subset of everything seen,
   * held in k slots, without knowing n in advance and without building the list
   * — which matters here, because the list on a green 512² world is 100 000+
   * entries that would be allocated and thrown away every five seconds. The
   * slots are exchangeable, which is what lets the caller plant a PREFIX of the
   * reservoir and still be planting a uniform random sample.
   *
   * THE UNLOCK TEST IS PER CHUNK, and that is exact rather than an
   * approximation: a cell's unlock state IS its chunk's (core's isCellUnlocked
   * resolves the cell to its chunk and tests the same mask bit), so hoisting the
   * test out of 256 iterations changes cost and nothing else. The bounds test
   * that isPlantableCell also performs is likewise redundant here — every cell
   * of an in-bounds chunk is in bounds. That leaves the green test, which is
   * called through the same predicate every other path uses, so the definition
   * of "green" still lives in exactly one place.
   */
  private scanChunk(
    world: FloraWorld,
    stability: StabilityMap,
    nowSeconds: number,
    rng: FloraRng,
    cx: number,
    cy: number,
    isOccupied: OccupancyPredicate,
  ): void {
    if (!world.isChunkUnlocked(cx, cy)) return;

    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      const y = baseY + dy;
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const x = baseX + dx;
        if (!isGreenBand(world.heightAt(x, y))) continue;
        if (!stability.isStable(x, y, nowSeconds)) continue;
        // Buildings always win: an occupied cell is ground this survey does
        // not own, so it counts toward neither area nor candidates — see
        // OccupancyPredicate's doc comment.
        if (isOccupied(x, y)) continue;

        // Treed cells count toward the area (see treeTargetFor) but are not
        // candidates.
        this.sweepArea++;
        const key = treeKey(x, y);
        if (this.standing.has(key)) continue;

        this.sweepSeen++;
        if (this.candidates.length < FLORA_MAX_SPROUTS_PER_SURVEY) {
          this.candidates.push(key);
          continue;
        }
        const slot = Math.floor(rng.next() * this.sweepSeen);
        if (slot < FLORA_MAX_SPROUTS_PER_SURVEY) this.candidates[slot] = key;
      }
    }
  }

  /**
   * Plants up to the quota from the reservoir, and reports what took.
   *
   * A candidate rejected by the spacing rule is DROPPED rather than replaced —
   * the next sweep draws a fresh sample seconds later, and retrying inside one
   * sweep would bias planting toward the sparse edges of a stand (the only
   * places a retry can succeed) and slowly turn every copse into a ring.
   *
   * EVERY CANDIDATE IS RE-VALIDATED at planting time. A sweep spans seconds and
   * a candidate was captured at some point inside that window, so the ground
   * under it can have been sculpted since — and planting a tree on cells a
   * player is actively digging is precisely the flicker the stability window
   * exists to prevent. Twenty-four re-checks per sweep is nothing against the
   * cost of getting this wrong. A structure founded on a candidate mid-sweep
   * is the same kind of staleness, so isOccupied is re-checked here too, not
   * just at the top of scanChunk.
   */
  private grow(
    world: FloraWorld,
    stability: StabilityMap,
    nowSeconds: number,
    rng: FloraRng,
    isOccupied: OccupancyPredicate,
  ): TreeCell[] {
    const deficit = treeTargetFor(this.sweepArea) - this.standing.size;
    let quota = sproutCount(deficit, rng);
    if (quota <= 0) return [];

    const grown: TreeCell[] = [];
    for (const key of this.candidates) {
      if (quota <= 0) break;
      const cell = treeCellOf(key);
      if (!isPlantableCell(world, cell.x, cell.y)) continue;
      if (!stability.isStable(cell.x, cell.y, nowSeconds)) continue;
      if (isOccupied(cell.x, cell.y)) continue;
      if (this.isCrowded(cell.x, cell.y)) continue;
      if (!this.plant(cell.x, cell.y)) continue;
      grown.push(cell);
      quota--;
    }

    return grown;
  }

  /**
   * Advances the rolling survey by at most `chunkBudget` chunks, and returns
   * what changed on the tick that COMPLETES a sweep (an empty result on every
   * other tick).
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY THE SWEEP IS AMORTISED ACROSS TICKS, measured rather than assumed.
   *
   * A whole-world pass on a fully revealed, fully green 512² world MEASURED AT
   * 55 ms in one call (10-survey mean, this machine, 2026-08-14). The server
   * tick is 100 ms at the shipped TICK_HZ of 10, so doing it in one tick would
   * spend more than half a tick on vegetation, once every five seconds, and
   * every player would feel it as a periodic hitch in a sim that also has to
   * apply and broadcast their sculpts.
   *
   * Spread over the ~50 ticks between sweeps, the SAME world measures 0.59 ms
   * mean and 0.90 ms worst per tick (500 ticks, same machine, same day) — the
   * whole plugin, tick included, well inside a millisecond and with no stall at
   * all. The per-tick cost also stays bounded as worlds grow, because the budget
   * is derived from the chunk count rather than fixed (server/index.ts).
   *
   * The rejected alternative was a FASTER full pass. Hoisting the per-cell
   * unlock and bounds tests out of the inner loop (done anyway, below) took the
   * full pass from 55 ms to ~30 ms — still a 30 ms stall, i.e. a constant-factor
   * answer to a structural problem. Amortising is the structural one.
   *
   * WHAT AMORTISING COSTS, stated: the area and the candidate sample are
   * gathered across a five-second window rather than at one instant, so a sweep
   * describes the world as it was during that window. Terrain and the unlock
   * mask move at human pace, so the difference is unobservable — and the one
   * case where it would matter (ground sculpted after its chunk was scanned) is
   * closed by re-validating each candidate at planting time (see grow).
   * ─────────────────────────────────────────────────────────────────────────
   */
  advanceSurvey(
    world: FloraWorld,
    stability: StabilityMap,
    nowSeconds: number,
    rng: FloraRng,
    chunkBudget: number,
    isOccupied: OccupancyPredicate = NEVER_OCCUPIED,
  ): SurveyResult {
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    if (totalChunks <= 0) return EMPTY_SURVEY;

    let budget = Math.floor(chunkBudget);
    if (budget <= 0) return EMPTY_SURVEY;

    while (budget > 0 && this.cursor < totalChunks) {
      this.scanChunk(
        world,
        stability,
        nowSeconds,
        rng,
        this.cursor % world.chunksPerEdge,
        Math.floor(this.cursor / world.chunksPerEdge),
        isOccupied,
      );
      this.cursor++;
      budget--;
    }

    if (this.cursor < totalChunks) return EMPTY_SURVEY;

    const felled = this.cull(world, isOccupied);
    const grown = this.grow(world, stability, nowSeconds, rng, isOccupied);
    this.resetSweep();

    return grown.length === 0 && felled.length === 0 ? EMPTY_SURVEY : { grown, felled };
  }

  /**
   * One COMPLETE survey in a single call — the shape the tests reason in, and
   * the one the amortised version is defined against. Finishes a sweep already
   * in progress rather than restarting it, which is the honest meaning of "run a
   * survey now".
   */
  survey(
    world: FloraWorld,
    stability: StabilityMap,
    nowSeconds: number,
    rng: FloraRng,
    isOccupied: OccupancyPredicate = NEVER_OCCUPIED,
  ): SurveyResult {
    return this.advanceSurvey(
      world,
      stability,
      nowSeconds,
      rng,
      world.chunksPerEdge * world.chunksPerEdge,
      isOccupied,
    );
  }
}
