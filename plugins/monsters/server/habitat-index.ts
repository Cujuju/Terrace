// The world as the lair survey needs to read it: flat typed arrays, kept in
// step with the terrain instead of re-derived from it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS (2026-08-26, measured).
//
// `surveyLairs` used to CLASSIFY while it walked: every cell it touched asked
// `isLairCell` (a `worldSize` getter, an `isCellUnlocked` and a `heightAt`,
// each through the plugin host's `bound()` indirection in
// server/src/plugins/world-api.ts), and after the fit rules landed it asked
// `isLairPose` once per kind on top — a centre probe plus
// BODY_RIM_PROBE_COUNT rim probes, so about nineteen `isLairCell` calls per
// habitat cell. On a 512² world that is a walk of ~100 ms PER SURVEY, not the
// ~1 ms the old comment claimed, and `onTerrainChanged` asked for one on every
// applied diff: a held sculpt brush (one intent every ~120 ms) had the server
// event loop 72 % busy and pushed sculpt round-trips from <1 ms to a 50–70 ms
// median.
//
// The classification is not what is expensive — the RE-classification is. A
// sculpt moves a handful of cells; the answer for every other cell of the
// world is exactly what it was a tick ago. So the answers are kept:
//
//   * `heights`   — one Int32 per cell, updated from the diff;
//   * `unlocked`  — one byte per cell, the chunk mask flattened;
//   * `habitat`   — one byte per cell per REGIME: the `isLairCell` answer;
//   * `fit`       — one byte per cell per FIT RULE: the `isLairPose` answer for
//                   a body of that rule's radius centred on the cell.
//
// and a diff repairs only the cells it touched (plus, for the fit bitmaps, the
// window of centres whose body reaches one of them). The survey then floods
// over `habitat` and counts set bits in `fit`, with no WorldApi call per cell
// at all.
//
// THE FIT BITMAP IS EXACT, NOT AN APPROXIMATION, and one identity is what
// makes it so: `isLairPose` floors `centreX + ux * radiusCells` where the
// centre is `x + CELL_CENTRE_OFFSET` and `x` is a whole cell, so
// `floor(x + 0.5 + ux·r) === x + floor(0.5 + ux·r)`. The eight rim probes are
// therefore a fixed pair of INTEGER cell offsets per rule, computed once — the
// bitmap answers the same question the predicate does, cell for cell.
// ─────────────────────────────────────────────────────────────────────────────

import type { CellDiff } from '@terrace/shared';
import {
  BODY_RIM_PROBE_OFFSETS,
  CELL_CENTRE_OFFSET,
  type HabitatRegime,
  type HabitatRegimeId,
  type LairFitRule,
  type LairWorld,
  isHabitatHeight,
} from './habitat.ts';

/**
 * Set/clear values of every bitmap here. One byte per cell, not packed bits:
 * the survey reads these in its innermost loop, and a packed bit would trade a
 * megabyte for a shift and a mask on every read.
 *
 * `HABITAT_BIT_SET` is exported because habitat.ts's flood fill reads the same
 * arrays and must test them against the same value; nothing outside this file
 * WRITES one, so its partner stays local.
 */
export const HABITAT_BIT_SET = 1;
const HABITAT_BIT_CLEAR = 0;

/**
 * Last generation `noteTerrainChangedInIndex` may stamp before it resets its
 * scratch. Uint32's ceiling: one generation is spent per fit rule per applied
 * diff, so at four rules and a sculpt every 120 ms this is reached after about
 * forty years of continuous sculpting — the reset exists so that the answer is
 * still right if it ever is, not because it is expected.
 */
const MAX_REPAIR_GENERATION = 0xffffffff;

/**
 * How much of the board the survey's dirty list may cover before repairing it
 * cell-by-cell stops being cheaper than re-flooding the whole thing.
 *
 * DERIVED, NOT PICKED. A whole-board survey pays about
 * FULL_SURVEY_PASSES_PER_CELL whole-board passes before any flooding — the
 * `fill(UNLABELLED)` and the row-major seed scan — while a repair pays about
 * REPAIR_TOUCHES_PER_DIRTY_CELL touches per listed cell (the cell and its four
 * neighbours) before it floods anything. So the repair can only win while
 *
 *     dirty × REPAIR_TOUCHES_PER_DIRTY_CELL < cells × FULL_SURVEY_PASSES_PER_CELL
 *
 * which is the fraction below. A sculpt diff is tens of cells and an unlocked
 * chunk is CHUNK_SIZE² of them, so the cap is reached only by something
 * board-scale — which is exactly the case a full re-flood should serve.
 */
const FULL_SURVEY_PASSES_PER_CELL = 2;
const REPAIR_TOUCHES_PER_DIRTY_CELL = 5;

/**
 * The dirty-list length past which `surveyLairs` re-floods instead of repairing.
 * Writers stop appending one past it, so the list never outgrows its own cap.
 */
export function repairableDirtyCellCap(cellCount: number): number {
  return Math.floor((cellCount * FULL_SURVEY_PASSES_PER_CELL) / REPAIR_TOUCHES_PER_DIRTY_CELL);
}

/** One rule's rim probes, as the whole-cell offsets the identity above gives. */
export interface FitProbe {
  /** Cell offsets of the rim samples; empty for a rule with no body width. */
  readonly offsets: readonly (readonly [number, number])[];
  /** Chebyshev reach of those offsets — the fit window a changed cell dirties. */
  readonly windowCells: number;
}

/** Everything the index holds about ONE habitat regime. */
export interface RegimeIndex {
  readonly regime: HabitatRegime;
  readonly rules: readonly LairFitRule[];
  readonly probes: readonly FitProbe[];
  /** The `isLairCell` answer per cell. */
  readonly habitat: Uint8Array;
  /** The `isLairPose` answer per cell, one array per rule (index-aligned). */
  readonly fit: readonly Uint8Array[];
  /**
   * Cells whose height or habitat bit has moved since the lair survey last read
   * this regime — the survey's repair list, drained by `surveyLairs`.
   *
   * PER REGIME AND NOT PER INDEX, because the two regimes are surveyed
   * independently and one may be gated out (summoning.ts) for many ticks while
   * the other keeps up: a shared list would be emptied by whichever regime ran
   * first and the other would repair against nothing.
   *
   * Writers stop appending once the list is longer than
   * `repairableDirtyCellCap`, which the survey reads as "re-flood whole".
   */
  readonly dirtyCells: number[];
}

/** The maintained world view a survey reads. */
export interface HabitatIndex {
  readonly size: number;
  /**
   * Cell heights.
   *
   * Int32 and not Int16 even though MAX_HEIGHT fits in sixteen bits: heights
   * are the one field a diff writes straight through from `CellDiff.h`, and a
   * silent wrap on a future taller world would corrupt the habitat answer
   * rather than fail. One extra megabyte on a 512² world buys that.
   */
  readonly heights: Int32Array;
  readonly unlocked: Uint8Array;
  readonly regimes: ReadonlyMap<HabitatRegimeId, RegimeIndex>;
  /**
   * Scratch for `noteTerrainChangedInIndex`: the generation each centre cell
   * was last recomputed at, so one diff recomputes each centre ONCE.
   *
   * A STAMP AND NOT A CLEARED FLAG ARRAY, because clearing is the cost being
   * avoided — a `fill(0)` per rule per diff is a whole-board write for a few
   * hundred dirty centres. Uint32 with a wrap-around reset (see
   * MAX_REPAIR_GENERATION) rather than a Set: the inner test is a typed-array
   * read against an integer, which is what the window loop can afford.
   */
  readonly repairStamp: Uint32Array;
  /**
   * The unlock mask as this index last saw it: one byte per CHUNK, row-major
   * over `chunksPerEdge²`, or null for a world that cannot report one (a
   * hand-built test world).
   *
   * A MASK AND NOT A COUNT (2026-09-01). It used to be the count of unlocked
   * chunks, and any change in it threw the whole index away and rebuilt it —
   * 127-221 ms for ONE newly-opened chunk, and the reveal plugin opens a chunk
   * for every sculpt that touches locked ground, so a frontier stroke paid it
   * every time. The mask says WHICH chunks moved, which is what turns the
   * rebuild into a diff (`applyNewlyUnlockedChunks`).
   */
  readonly unlockedChunks: Uint8Array | null;
  /** Chunks per world edge for `unlockedChunks`; 0 when there is no mask. */
  readonly chunksPerEdge: number;
}

/** One regime and the fit rules the caller wants counted in it. */
export interface HabitatIndexSpec {
  readonly regime: HabitatRegime;
  readonly fitRules: readonly LairFitRule[];
}

function fitProbeFor(rule: LairFitRule): FitProbe {
  // `isLairPose` with a radius of zero degenerates to the centre test, and so
  // does a probe list with no offsets — the same degeneracy, spelled once.
  if (rule.radiusCells <= 0) return { offsets: [], windowCells: 0 };

  const offsets = BODY_RIM_PROBE_OFFSETS.map(
    ([ux, uy]) =>
      [
        Math.floor(CELL_CENTRE_OFFSET + ux * rule.radiusCells),
        Math.floor(CELL_CENTRE_OFFSET + uy * rule.radiusCells),
      ] as const,
  );
  let windowCells = 0;
  for (const [dx, dy] of offsets) {
    windowCells = Math.max(windowCells, Math.abs(dx), Math.abs(dy));
  }
  return { offsets, windowCells };
}

/**
 * The world's unlock mask, one byte per chunk, or null for a world that cannot
 * report one (a hand-built test world, which has no chunk grid).
 *
 * A MASK AND NOT A COUNT (2026-09-01; it was `unlockGenerationOf`). The count
 * was a sound CHANGE DETECTOR — unlocking is monotonic within one world's life,
 * so the count only ever rises — but it is not a change DESCRIPTION, and the
 * only repair a description-less change admits is a full rebuild. Keeping the
 * bytes costs `chunksPerEdge²` of them (16 KB at 2048² with 16-cell chunks) and
 * tells `syncedHabitatIndex` exactly which chunks to repair.
 *
 * STILL NOT A HOOK, for the reason the count was not: the plugin contract's
 * only unlock hook (`onChunkUnlockedForToken`) fires for per-token reveals and
 * NEVER for `WorldApi.unlockChunk`'s world-wide unlock (server/src/plugins/
 * host.ts), so a plugin that trusted it would miss half the ways
 * `isCellUnlocked` can change — and habitat is defined against the union mask,
 * which both paths grow.
 */
function readUnlockedChunks(world: LairWorld): Uint8Array | null {
  const perEdge = world.chunksPerEdge;
  const isChunkUnlocked = world.isChunkUnlocked;
  if (perEdge === undefined || perEdge <= 0 || isChunkUnlocked === undefined) return null;
  const mask = new Uint8Array(perEdge * perEdge);
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      mask[cy * perEdge + cx] = isChunkUnlocked.call(world, cx, cy)
        ? HABITAT_BIT_SET
        : HABITAT_BIT_CLEAR;
    }
  }
  return mask;
}

/**
 * `isLairCell`'s answer for one cell of an index, from the arrays alone.
 *
 * ONE DEFINITION, because both writers of the habitat bitmap — the full build
 * and the per-diff repair — have to agree with each other AND with
 * habitat.ts's predicate. Two copies of this expression is two chances for the
 * repair to drift from the build, and the drift would only ever show up as a
 * survey reporting a region that is not there.
 *
 * The bounds check `isLairCell` opens with is the caller's job here: every
 * caller is already iterating in-bounds cell indices.
 */
function habitatBitAt(
  regime: HabitatRegime,
  unlocked: Uint8Array,
  heights: Int32Array,
  index: number,
): number {
  if (unlocked[index] !== HABITAT_BIT_SET) return HABITAT_BIT_CLEAR;
  return isHabitatHeight(regime, heights[index]!) ? HABITAT_BIT_SET : HABITAT_BIT_CLEAR;
}

/** Recomputes one regime's fit bit for one centre cell from its habitat bits. */
function recomputeFitBit(
  size: number,
  habitat: Uint8Array,
  fit: Uint8Array,
  probe: FitProbe,
  x: number,
  y: number,
): void {
  const index = y * size + x;
  if (habitat[index] !== HABITAT_BIT_SET) {
    fit[index] = HABITAT_BIT_CLEAR;
    return;
  }
  for (const [dx, dy] of probe.offsets) {
    const rimX = x + dx;
    const rimY = y + dy;
    if (rimX < 0 || rimY < 0 || rimX >= size || rimY >= size) {
      fit[index] = HABITAT_BIT_CLEAR;
      return;
    }
    if (habitat[rimY * size + rimX] !== HABITAT_BIT_SET) {
      fit[index] = HABITAT_BIT_CLEAR;
      return;
    }
  }
  fit[index] = HABITAT_BIT_SET;
}

/**
 * Builds a whole index from the world, one WorldApi call per cell — the cost
 * the maintained bitmaps exist to pay ONCE rather than per survey.
 *
 * Paid on plugin init, on a world switch (a different `worldSize`), on a
 * snapshot restore, and when the unlock mask has moved. All four are
 * human-paced or once-per-process.
 */
export function buildHabitatIndex(
  world: LairWorld,
  specs: readonly HabitatIndexSpec[],
): HabitatIndex {
  const size = world.worldSize;
  const cellCount = size * size;
  const heights = new Int32Array(cellCount);
  const unlocked = new Uint8Array(cellCount);

  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      heights[row + x] = world.heightAt(x, y);
      unlocked[row + x] = world.isCellUnlocked(x, y) ? HABITAT_BIT_SET : HABITAT_BIT_CLEAR;
    }
  }

  const regimes = new Map<HabitatRegimeId, RegimeIndex>();
  for (const { regime, fitRules } of specs) {
    const habitat = new Uint8Array(cellCount);
    for (let index = 0; index < cellCount; index++) {
      habitat[index] = habitatBitAt(regime, unlocked, heights, index);
    }

    const probes = fitRules.map(fitProbeFor);
    const fit = probes.map((probe) => {
      const bits = new Uint8Array(cellCount);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // Only habitat centres can fit anything, so the rim probes are read
          // for the habitat cells alone — on a world that is mostly land the
          // water pass never leaves the first branch.
          recomputeFitBit(size, habitat, bits, probe, x, y);
        }
      }
      return bits;
    });

    regimes.set(regime.id, { regime, rules: fitRules, probes, habitat, fit, dirtyCells: [] });
  }

  const unlockedChunks = readUnlockedChunks(world);
  return {
    size,
    heights,
    unlocked,
    regimes,
    repairStamp: new Uint32Array(cellCount),
    unlockedChunks,
    chunksPerEdge: unlockedChunks === null ? 0 : (world.chunksPerEdge ?? 0),
  };
}

/**
 * Does this index answer the exact question the caller is about to ask — same
 * world size, same regime, same fit rules?
 *
 * The fit bitmaps are built AGAINST a rule list, so a survey handed a
 * different one must not read them. Compared by value rather than by identity
 * because `lairFitRulesInHabitat` is precomputed and a test may pass a
 * hand-written equivalent.
 */
export function indexAnswers(
  index: HabitatIndex,
  world: LairWorld,
  regime: HabitatRegime,
  fitRules: readonly LairFitRule[],
): boolean {
  if (index.size !== world.worldSize) return false;
  const regimeIndex = index.regimes.get(regime.id);
  if (regimeIndex === undefined) return false;
  if (regimeIndex.rules.length !== fitRules.length) return false;
  for (let rule = 0; rule < fitRules.length; rule++) {
    const held = regimeIndex.rules[rule]!;
    const wanted = fitRules[rule]!;
    if (held.radiusCells !== wanted.radiusCells) return false;
    if (held.minReachBands !== wanted.minReachBands) return false;
  }
  return true;
}

// ── The maintained instance ──────────────────────────────────────────────────
// One per process, matching every other piece of this plugin's module state.

let live: HabitatIndex | null = null;

/**
 * Monotonic stamp for `noteTerrainChangedInIndex`'s dirty-centre union. Lives
 * beside `live` rather than on it because it must keep rising across a rebuild:
 * a fresh index brings a zeroed `repairStamp`, and a counter that restarted at
 * zero with it would collide with stamps this one never wrote.
 */
let repairGeneration = 0;

/**
 * The maintained index, rebuilt only when it cannot be repaired in place: no
 * index yet, a different world size (a world switch), a fit-rule list this one
 * was not built against, or an unlock mask that moved BACKWARDS.
 *
 * A MOVED UNLOCK MASK IS NOW A REPAIR, NOT A REBUILD (2026-09-01, #267). It
 * used to be the fourth rebuild trigger, on a raw COUNT of unlocked chunks —
 * so one newly-opened chunk threw away 56 MB of exact answers and re-derived
 * every one of them: 223 ms measured on a synthetic 2048² board, and
 * plugins/reveal opens a chunk for every sculpt that touches locked ground, so
 * a player working the frontier paid it about once per stroke. The mask diff
 * names the chunks that opened and `applyNewlyUnlockedChunks` repairs exactly
 * those cells and the fit windows around them: 0.9 ms on the same board, and
 * the arrays it leaves are byte-for-byte what the rebuild produced.
 *
 * Called by the survey, so any surviving rebuild lands on the survey's cadence
 * and never inside a sculpt.
 */
export function syncedHabitatIndex(
  world: LairWorld,
  specs: readonly HabitatIndexSpec[],
): HabitatIndex {
  const shapeStale =
    live === null ||
    live.size !== world.worldSize ||
    !specs.every(({ regime, fitRules }) => indexAnswers(live!, world, regime, fitRules));

  if (shapeStale) {
    live = buildHabitatIndex(world, specs);
    return live;
  }

  const held = live!;
  const mask = readUnlockedChunks(world);
  // Neither side has a mask (a hand-built world): nothing can have unlocked.
  if (mask === null && held.unlockedChunks === null) return held;
  // The world gained or lost its chunk grid, or changed shape under us — the
  // only honest answer is to read it all again.
  if (mask === null || held.unlockedChunks === null || mask.length !== held.unlockedChunks.length) {
    live = buildHabitatIndex(world, specs);
    return live;
  }

  const opened: number[] = [];
  for (let chunk = 0; chunk < mask.length; chunk++) {
    const now = mask[chunk]!;
    const before = held.unlockedChunks[chunk]!;
    if (now === before) continue;
    // A chunk that RE-LOCKED. Unlocking is a one-way ratchet within a world's
    // life (the one event that reverses it is a rollback, which replaces the
    // world and drops this index outright), so this is a world we do not
    // understand — rebuild rather than repair half of it.
    if (now !== HABITAT_BIT_SET) {
      live = buildHabitatIndex(world, specs);
      return live;
    }
    opened.push(chunk);
  }

  if (opened.length > 0) applyNewlyUnlockedChunks(held, world, mask, opened);
  return held;
}

/**
 * A fresh `repairStamp` generation, resetting the scratch on the one wrap that
 * Uint32 allows (see MAX_REPAIR_GENERATION).
 */
function nextRepairGeneration(repairStamp: Uint32Array): number {
  if (repairGeneration >= MAX_REPAIR_GENERATION) {
    repairStamp.fill(0);
    repairGeneration = 0;
  }
  return ++repairGeneration;
}

/** The widest fit window any of this regime's rules dirties around a cell. */
function maxProbeReach(regimeIndex: RegimeIndex): number {
  let reach = 0;
  for (const probe of regimeIndex.probes) reach = Math.max(reach, probe.windowCells);
  return reach;
}

/**
 * Records, for the lair survey's region repair, every cell of this regime whose
 * ANSWER moved because the cells in `rects` did.
 *
 * THE WINDOW AND NOT THE CHANGED CELLS THEMSELVES, and the difference is a
 * correctness one rather than a margin: a region's `fittingCells` counts a fit
 * bit per cell, and a fit bit belongs to a CENTRE up to `maxProbeReach` away
 * from the habitat bit that decided it. A repair list of only the moved cells
 * would leave a region whose fit counts changed unrepaired, and the count is
 * what gate 3 (summoning.ts `bestLairFor`) reads.
 *
 * Deduplicated through `repairStamp` on its own generation, so overlapping
 * windows list each centre once.
 *
 * Appends one past `repairableDirtyCellCap` and no further, which the survey
 * reads as "this change is board-scale, re-flood whole".
 */
function markDirtyWindows(
  index: HabitatIndex,
  regimeIndex: RegimeIndex,
  rects: readonly (readonly [number, number, number, number])[],
  cap: number,
): void {
  const { size, repairStamp } = index;
  const reach = maxProbeReach(regimeIndex);
  const generation = nextRepairGeneration(repairStamp);
  const dirty = regimeIndex.dirtyCells;

  for (const [rectX0, rectY0, rectX1, rectY1] of rects) {
    const minX = Math.max(0, rectX0 - reach);
    const maxX = Math.min(size - 1, rectX1 + reach);
    const minY = Math.max(0, rectY0 - reach);
    const maxY = Math.min(size - 1, rectY1 + reach);
    for (let y = minY; y <= maxY; y++) {
      const row = y * size;
      for (let x = minX; x <= maxX; x++) {
        if (repairStamp[row + x] === generation) continue;
        repairStamp[row + x] = generation;
        if (dirty.length > cap) return;
        dirty.push(row + x);
      }
    }
  }
}

/**
 * Folds newly-unlocked chunks into the maintained index in place — the repair
 * that replaced "any change in the unlocked count rebuilds everything".
 *
 * THREE PASSES, IN THIS ORDER, and the order is the same correctness argument
 * `noteTerrainChangedInIndex` makes one cell at a time: every `unlocked` and
 * `heights` byte the unlock moves has to be settled before any habitat bit is
 * derived from it, and every habitat bit has to be settled before any fit bit
 * reads its rim. Interleaving them would recompute a fit window against a rim
 * that is about to change.
 *
 * COST is bounded by the opened chunks, not by the world: one chunk is
 * (size / chunksPerEdge)² cells for the first two passes, and that square grown
 * by the rule's probe reach for the third. The whole-index build it replaces
 * read every cell of the board through the host's `bound()` indirection.
 */
function applyNewlyUnlockedChunks(
  index: HabitatIndex,
  world: LairWorld,
  mask: Uint8Array,
  opened: readonly number[],
): void {
  const { size, heights, unlocked, regimes, repairStamp } = index;
  const perEdge = index.chunksPerEdge;
  if (perEdge <= 0) return;
  /** Cells per chunk edge, derived from this world rather than assumed. */
  const chunkCells = size / perEdge;
  const cap = repairableDirtyCellCap(size * size);

  for (const chunk of opened) {
    const cx = chunk % perEdge;
    const cy = (chunk - cx) / perEdge;
    const x0 = cx * chunkCells;
    const y0 = cy * chunkCells;
    for (let y = y0; y < y0 + chunkCells; y++) {
      const row = y * size;
      for (let x = x0; x < x0 + chunkCells; x++) {
        heights[row + x] = world.heightAt(x, y);
        unlocked[row + x] = world.isCellUnlocked(x, y) ? HABITAT_BIT_SET : HABITAT_BIT_CLEAR;
      }
    }
  }

  /** The opened chunks as inclusive cell rectangles, for the dirty windows. */
  const openedRects = opened.map((chunk) => {
    const cx = chunk % perEdge;
    const cy = (chunk - cx) / perEdge;
    return [
      cx * chunkCells,
      cy * chunkCells,
      cx * chunkCells + chunkCells - 1,
      cy * chunkCells + chunkCells - 1,
    ] as const;
  });

  for (const regimeIndex of regimes.values()) {
    const { regime, habitat } = regimeIndex;
    for (const chunk of opened) {
      const cx = chunk % perEdge;
      const cy = (chunk - cx) / perEdge;
      const x0 = cx * chunkCells;
      const y0 = cy * chunkCells;
      for (let y = y0; y < y0 + chunkCells; y++) {
        const row = y * size;
        for (let x = x0; x < x0 + chunkCells; x++) {
          const cellIndex = row + x;
          habitat[cellIndex] = habitatBitAt(regime, unlocked, heights, cellIndex);
        }
      }
    }
    markDirtyWindows(index, regimeIndex, openedRects, cap);
  }

  for (const regimeIndex of regimes.values()) {
    for (let rule = 0; rule < regimeIndex.fit.length; rule++) {
      const probe = regimeIndex.probes[rule]!;
      const bits = regimeIndex.fit[rule]!;
      const reach = probe.windowCells;
      const generation = nextRepairGeneration(repairStamp);

      for (const chunk of opened) {
        const cx = chunk % perEdge;
        const cy = (chunk - cx) / perEdge;
        const minX = Math.max(0, cx * chunkCells - reach);
        const maxX = Math.min(size - 1, cx * chunkCells + chunkCells - 1 + reach);
        const minY = Math.max(0, cy * chunkCells - reach);
        const maxY = Math.min(size - 1, cy * chunkCells + chunkCells - 1 + reach);
        for (let centreY = minY; centreY <= maxY; centreY++) {
          const row = centreY * size;
          for (let centreX = minX; centreX <= maxX; centreX++) {
            if (repairStamp[row + centreX] === generation) continue;
            repairStamp[row + centreX] = generation;
            recomputeFitBit(size, regimeIndex.habitat, bits, probe, centreX, centreY);
          }
        }
      }
    }
  }

  index.unlockedChunks?.set(mask);
}

/**
 * Repairs the maintained index for one applied terrain diff — the whole point
 * of the file, and the reason `onTerrainChanged` no longer costs a survey.
 *
 * TWO PASSES, and they cannot be one: a fit bit reads the habitat bits of its
 * rim, so every habitat bit the diff moves has to be settled before any fit
 * bit is recomputed. Doing both per cell would read a rim that is about to
 * change and leave the answer wrong until the next full rebuild.
 *
 * EACH DIRTY CENTRE IS RECOMPUTED ONCE (2026-08-26, measured). A diff is a
 * brush disc, and the fit windows of its ~37 cells overlap almost completely:
 * recomputing the window per diff cell profiled at 2.5 ms per applied sculpt —
 * the largest single thing this plugin did once the survey stopped being it,
 * and forty per cent of the whole server's busy time under a held brush. The
 * windows are unioned through `repairStamp` instead, which is the same set of
 * centres visited once each.
 *
 * A no-op when no index has been built yet: the first survey builds one from
 * the world as it is by then, which already includes this diff.
 */
export function noteTerrainChangedInIndex(diff: readonly CellDiff[]): void {
  const index = live;
  if (index === null || diff.length === 0) return;

  const { size, heights, unlocked, regimes, repairStamp } = index;

  for (const cell of diff) {
    const x = cell.x;
    const y = cell.y;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    heights[y * size + x] = cell.h;
  }

  for (const { regime, habitat } of regimes.values()) {
    for (const cell of diff) {
      const x = cell.x;
      const y = cell.y;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const cellIndex = y * size + x;
      habitat[cellIndex] = habitatBitAt(regime, unlocked, heights, cellIndex);
    }
  }

  for (const regimeIndex of regimes.values()) {
    for (let rule = 0; rule < regimeIndex.fit.length; rule++) {
      const probe = regimeIndex.probes[rule]!;
      const bits = regimeIndex.fit[rule]!;
      const reach = probe.windowCells;

      // A fresh stamp per rule, so one rule's visits never mask another's.
      const generation = nextRepairGeneration(repairStamp);

      for (const cell of diff) {
        const x = cell.x;
        const y = cell.y;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        // Every centre whose body could sample this cell — a Chebyshev square
        // of the probe reach, which is a superset of the eight probe offsets
        // and far cheaper to iterate than their exact inverse set.
        const minX = Math.max(0, x - reach);
        const maxX = Math.min(size - 1, x + reach);
        const minY = Math.max(0, y - reach);
        const maxY = Math.min(size - 1, y + reach);
        for (let centreY = minY; centreY <= maxY; centreY++) {
          const row = centreY * size;
          for (let centreX = minX; centreX <= maxX; centreX++) {
            if (repairStamp[row + centreX] === generation) continue;
            repairStamp[row + centreX] = generation;
            recomputeFitBit(size, regimeIndex.habitat, bits, probe, centreX, centreY);
          }
        }
      }
    }
  }

  // The survey's repair list, last: the windows are the same shape the fit
  // recompute above just walked, so a change is listed exactly where an answer
  // moved (see markDirtyWindows).
  const cap = repairableDirtyCellCap(size * size);
  const diffRects = diff
    .filter((cell) => cell.x >= 0 && cell.y >= 0 && cell.x < size && cell.y < size)
    .map((cell) => [cell.x, cell.y, cell.x, cell.y] as const);
  for (const regimeIndex of regimes.values()) {
    markDirtyWindows(index, regimeIndex, diffRects, cap);
  }
}

/** Drops the maintained index (the plugin's reset seam). */
export function releaseHabitatIndex(): void {
  live = null;
}
