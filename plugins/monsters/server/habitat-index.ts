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
 * What the unlock-generation check reports for a world that cannot answer it —
 * a hand-built test world with no chunk mask. Distinct from any real count, so
 * two such worlds never look like "the mask changed".
 */
const UNLOCK_GENERATION_UNAVAILABLE = -1;

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
  /** Unlocked chunk count this was built at; see `syncedHabitatIndex`. */
  readonly unlockGeneration: number;
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
 * How many chunks of this world are unlocked, as a change detector for the
 * unlock mask.
 *
 * A COUNT AND NOT A HOOK, deliberately. The plugin contract's only unlock hook
 * (`onChunkUnlockedForToken`) fires for per-token reveals and NEVER for
 * `WorldApi.unlockChunk`'s world-wide unlock, so a plugin that trusted it
 * would miss half the ways `isCellUnlocked` can change — and habitat is
 * defined against the union mask, which both paths grow. Within one world's
 * life unlocking is monotonic (nothing re-locks a chunk), so a count is a
 * sound generation number, and it is `chunksPerEdge²` reads — 256 on a 512²
 * world with 32-cell chunks — once per survey rather than per cell. The one
 * event that can SHRINK the mask is a rollback, which replaces the world
 * wholesale and drops this index outright (server/index.ts's onWorldCreate),
 * so a shrunk count never reaches a comparison here.
 */
function unlockGenerationOf(world: LairWorld): number {
  const perEdge = world.chunksPerEdge;
  if (perEdge === undefined || world.isChunkUnlocked === undefined) {
    return UNLOCK_GENERATION_UNAVAILABLE;
  }
  let unlocked = 0;
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      if (world.isChunkUnlocked(cx, cy)) unlocked++;
    }
  }
  return unlocked;
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

    regimes.set(regime.id, { regime, rules: fitRules, probes, habitat, fit });
  }

  return {
    size,
    heights,
    unlocked,
    regimes,
    repairStamp: new Uint32Array(cellCount),
    unlockGeneration: unlockGenerationOf(world),
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
 * index yet, a different world size (a world switch), a moved unlock mask, or
 * a fit-rule list this one was not built against.
 *
 * Called by the survey, so the rebuild lands on the survey's cadence and never
 * inside a sculpt.
 */
export function syncedHabitatIndex(
  world: LairWorld,
  specs: readonly HabitatIndexSpec[],
): HabitatIndex {
  const stale =
    live === null ||
    live.size !== world.worldSize ||
    live.unlockGeneration !== unlockGenerationOf(world) ||
    !specs.every(({ regime, fitRules }) => indexAnswers(live!, world, regime, fitRules));

  if (stale) live = buildHabitatIndex(world, specs);
  return live!;
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
      if (repairGeneration >= MAX_REPAIR_GENERATION) {
        repairStamp.fill(0);
        repairGeneration = 0;
      }
      const generation = ++repairGeneration;

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
}

/** Drops the maintained index (the plugin's reset seam). */
export function releaseHabitatIndex(): void {
  live = null;
}
