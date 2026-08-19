// THE CA — Conway's Game of Life (classic B3/S23), run over the world's
// buildable ground. This is the whole growth mechanism for the plugin: no
// settlement seeding, no per-cell "left alone" timer. A structure exists
// exactly where a live cell exists.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULES, restated precisely because "classic B3/S23" hides one choice
// that is easy to get backwards: TERRAIN IS THE BOARD'S WALLS.
//
//   * A cell that is NOT buildable (water, too steep, locked — see
//     suitability.ts's isBuildableCell, which is exactly the same predicate
//     the wall test) is dead THIS GENERATION, unconditionally — it can never
//     be born into, whatever its neighbour count says, and if it were
//     somehow alive it dies. It still COUNTS as a dead neighbour for the
//     cells around it, which is the ordinary behaviour of a dead cell; a
//     wall needs no special-case in the neighbour count, only in whether it
//     can itself be alive.
//   * Otherwise, standard B3/S23: a dead buildable cell with exactly 3 live
//     neighbours is born; a live cell with 2 or 3 live neighbours survives;
//     anything else dies (under- or over-population).
//   * All eight Moore neighbours, all updates SIMULTANEOUS — every cell's
//     next state is a function of the CURRENT generation only, never of
//     another cell's next state. This module never mutates the board it is
//     reading; every step builds a fresh next-generation map and only swaps
//     it in once the whole board has been evaluated (see GenerationSurvey).
//
// Pure B3/S23 on a bounded board dies out or freezes into still lifes; that
// is accepted, and even thematic (a stable block is a settled town — see
// tiers.ts) — SEEDING (below) is what keeps a world from going quiet forever.
// ─────────────────────────────────────────────────────────────────────────────
//
// TERRAIN EDITS ARE NOT A CA EVENT. A live cell whose OWN ground is edited is
// demolished immediately, outside any generation (index.ts's reactive path) —
// the same instant-felling flora and the old design both kept. A live cell
// whose NEIGHBOUR is edited (which can, via isBuildableCell's flatness test,
// silently break ITS OWN buildability without its own height moving) is left
// alone until the next generation notices — at most CA_GENERATION_INTERVAL_
// SECONDS later. That lag is a named, accepted residual: every generation is
// already a full, fresh recomputation of buildability for the whole board, so
// unlike the pre-CA design (which had no periodic full recheck at all) this
// is a short, bounded wait for a self-correcting mechanism that already runs
// continuously, not a coverage gap plugged by a separate defensive sweep.

import { CHUNK_SIZE } from '@terrace/shared';
import { STRUCTURES_CAP, cellOfKey, structureKey, type StructureCell } from '../protocol.ts';
import { maybeAdvanceTier } from './tiers.ts';
import { isBuildableCell, type StructuresWorld } from './suitability.ts';
import type { StructuresRng } from './rng.ts';

// ── Tuning constants ─────────────────────────────────────────────────────────

/**
 * Simulated seconds per CA generation.
 *
 * 15 s — the plugin's one world-scale clock, chosen so a player watching a
 * lively patch of board sees a visible change (a birth, a death, an
 * oscillator flipping) within one glance-length pause, while the tier-upgrade
 * arc (CA_GENERATIONS_PER_TIER × MAX_STRUCTURE_TIER generations, tiers.ts)
 * still reads as a multi-minute settling process rather than flicker. Faster
 * and the board reads as noise; slower and a demo session may never see a
 * second generation.
 */
export const CA_GENERATION_INTERVAL_SECONDS = 15;

/**
 * Chance, rolled once per completed generation, that a fresh seed pattern is
 * attempted somewhere on the board.
 *
 * 0.35 — a quiet world (little or no live population) gets a new seed roughly
 * every ~2.9 generations (~43 s) in expectation, which is frequent enough
 * that a freshly-unlocked, empty world does not sit blank for long, and rare
 * enough that a lively board is not perpetually overwritten faster than its
 * own patterns can settle. The roll happens whether or not the board is
 * currently empty — a thriving board can absorb an extra pattern same as
 * a quiet one.
 */
export const CA_SEED_PROBABILITY_PER_GENERATION = 0.35;

/**
 * Bounded random search for a clear patch of buildable ground to seed on.
 *
 * 12 attempts: a world with almost no buildable land simply fails to seed
 * some generations (returns null, tried again next time the roll fires)
 * rather than searching without end. Each attempt is a handful of
 * isBuildableCell calls at most (a soup's 5×5 box), so even the worst case is
 * cheap.
 */
export const CA_SEED_MAX_PLACEMENT_ATTEMPTS = 12;

/** Side length of the "random soup" seed pattern's bounding box. */
export const CA_SOUP_SIZE = 5;

/**
 * Per-cell chance a soup pattern's cell is alive (its centre cell is always
 * forced alive — see randomSoupCells — so a soup can never place zero cells).
 * 0.4 keeps a typical soup somewhere around 8-10 of the 25 cells: enough to
 * almost certainly contain something that survives at least one generation,
 * without being dense enough to behave like a solid block on arrival.
 */
export const CA_SOUP_FILL_PROBABILITY = 0.4;

// ── The board ─────────────────────────────────────────────────────────────────

/** What one live cell remembers between generations. */
export interface LiveCellRecord {
  /** Generations survived continuously. Resets to 0 on every birth. */
  readonly age: number;
  /** Current tier, 0..MAX_STRUCTURE_TIER — see tiers.ts's maybeAdvanceTier. */
  readonly tier: number;
}

const MOORE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

function countLiveNeighbors(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
): number {
  let count = 0;
  for (const [ox, oy] of MOORE_OFFSETS) {
    const nx = x + ox;
    const ny = y + oy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
    if (live.has(structureKey(nx, ny))) count++;
  }
  return count;
}

/** What one completed generation changed. */
export interface GenerationOutcome {
  readonly nextLive: Map<number, LiveCellRecord>;
  readonly born: StructureCell[];
  readonly upgraded: StructureCell[];
  readonly died: Array<{ x: number; y: number }>;
}

/**
 * Advances the CA one generation, spread over ticks with the same fractional
 * chunk-budget amortisation flora's Forest sweep uses (see
 * generationChunksPerTick), and for the identical reason: a whole-board pass
 * is cheap once but not once every tick, and rounding the per-tick budget up
 * to whole chunks would make a small world's generations complete faster than
 * a large world's — see flora/server/index.ts's chunksPerTick for the
 * measured numbers this design avoids repeating.
 *
 * DOUBLE-BUFFERED BY CONSTRUCTION: every cell read during a sweep (`live`,
 * the CURRENT generation) is never written to until the whole board has been
 * scanned and `advance` swaps in the result — a chunk scanned early in a
 * multi-tick sweep sees exactly the same board a chunk scanned late does.
 */
export class GenerationSurvey {
  private cursor = 0;
  private readonly staged = new Map<number, LiveCellRecord>();

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
  }

  private scanChunk(
    world: StructuresWorld,
    live: ReadonlyMap<number, LiveCellRecord>,
    cx: number,
    cy: number,
  ): void {
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      const y = baseY + dy;
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const x = baseX + dx;

        // Cheapest check first: a wall cell is dead next generation no
        // matter what, so the (up to) eight neighbour lookups below are
        // skipped entirely for it — the majority of a typical world (open
        // water) never pays for neighbour counting at all.
        if (!isBuildableCell(world, x, y)) continue;

        const key = structureKey(x, y);
        const current = live.get(key);
        const neighborCount = countLiveNeighbors(live, world, x, y);
        const survives = current !== undefined && (neighborCount === 2 || neighborCount === 3);
        const birthed = current === undefined && neighborCount === 3;
        if (!survives && !birthed) continue;

        if (current !== undefined) {
          const age = current.age + 1;
          const tier = maybeAdvanceTier(age, current.tier, neighborCount);
          this.staged.set(key, { age, tier });
        } else {
          // The population cap throttles BIRTHS ONLY. Every survivor was
          // already counted in the PREVIOUS generation's (already-capped)
          // live set, so admitting every survivor unconditionally can never
          // push the total past the cap — only new births need gating, and
          // gating them is what keeps an already-standing structure from
          // being evicted by scan-order bad luck the way capping survivors
          // too would risk.
          if (this.staged.size >= STRUCTURES_CAP) continue;
          this.staged.set(key, { age: 0, tier: 0 });
        }
      }
    }
  }

  /**
   * Advances by at most `chunkBudget` chunks. Returns the generation's
   * outcome only on the tick that completes a full-board sweep (null
   * otherwise) — the same contract flora's Forest.advanceSurvey keeps.
   */
  advance(
    world: StructuresWorld,
    live: ReadonlyMap<number, LiveCellRecord>,
    chunkBudget: number,
  ): GenerationOutcome | null {
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    if (totalChunks <= 0) return null;

    let budget = Math.floor(chunkBudget);
    if (budget <= 0) return null;

    while (budget > 0 && this.cursor < totalChunks) {
      this.scanChunk(world, live, this.cursor % world.chunksPerEdge, Math.floor(this.cursor / world.chunksPerEdge));
      this.cursor++;
      budget--;
    }
    if (this.cursor < totalChunks) return null;

    const born: StructureCell[] = [];
    const upgraded: StructureCell[] = [];
    const died: Array<{ x: number; y: number }> = [];

    for (const [key, record] of this.staged) {
      const previous = live.get(key);
      const cell = cellOfKey(key);
      if (previous === undefined) {
        born.push({ x: cell.x, y: cell.y, tier: record.tier });
      } else if (previous.tier !== record.tier) {
        upgraded.push({ x: cell.x, y: cell.y, tier: record.tier });
      }
    }
    for (const key of live.keys()) {
      if (this.staged.has(key)) continue;
      const cell = cellOfKey(key);
      died.push({ x: cell.x, y: cell.y });
    }

    const nextLive = new Map(this.staged);
    this.resetSweep();
    return { nextLive, born, upgraded, died };
  }
}

/**
 * ONE COMPLETE GENERATION in a single call — the shape the CA-correctness
 * tests reason in (a blinker oscillates, a block is stable, a glider
 * translates), and the one the amortised sweep above is defined against: a
 * fresh survey run with the WHOLE board as its own budget always completes in
 * one call (see `advance`'s loop condition), the identical trick flora's
 * `Forest.survey` uses against its own `advanceSurvey`.
 */
export function stepGeneration(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
): GenerationOutcome {
  const survey = new GenerationSurvey();
  const result = survey.advance(world, live, world.chunksPerEdge * world.chunksPerEdge);
  // A positive budget covering every chunk always finishes in the one call
  // above — see the non-null return analysis in advance's own doc.
  return result as GenerationOutcome;
}

/**
 * Chunk-per-tick budget that paces one generation to take exactly
 * CA_GENERATION_INTERVAL_SECONDS, whatever the world size — flora's
 * chunksPerTick derivation, restated (not imported: independent-plugin rule,
 * and the two intervals differ).
 */
export function generationChunksPerTick(world: StructuresWorld, dt: number): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerGeneration = Math.max(1, Math.round(CA_GENERATION_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerGeneration;
}

// ── Seeding: what keeps a quiet board from staying quiet ────────────────────

/** One classic pattern, as offsets from an anchor cell. */
interface SeedPattern {
  readonly name: string;
  readonly cells: ReadonlyArray<readonly [number, number]>;
}

/** Four still lifes/oscillators/spaceships still small enough to place blind. */
const CA_BLOCK: SeedPattern = { name: 'block', cells: [[0, 0], [1, 0], [0, 1], [1, 1]] };
const CA_BLINKER: SeedPattern = { name: 'blinker', cells: [[0, 0], [1, 0], [2, 0]] };
const CA_GLIDER: SeedPattern = { name: 'glider', cells: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]] };
const CA_R_PENTOMINO: SeedPattern = {
  name: 'r-pentomino',
  cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
};

/**
 * The fixed pattern library, in a fixed order — the order is not meaningful
 * on its own, only stable, since `choosePatternCells` indexes into it with an
 * RNG draw and the sequence must be reproducible.
 */
export const CA_FIXED_SEED_PATTERNS: readonly SeedPattern[] = [
  CA_BLOCK,
  CA_BLINKER,
  CA_GLIDER,
  CA_R_PENTOMINO,
];

/**
 * A small random soup: a CA_SOUP_SIZE² box, each cell independently alive at
 * CA_SOUP_FILL_PROBABILITY, EXCEPT the centre cell, which is always forced
 * alive so a soup can never place zero cells (a seed attempt that places
 * nothing would still have consumed its placement attempt for nothing).
 */
function randomSoupCells(rng: StructuresRng): ReadonlyArray<readonly [number, number]> {
  const cells: Array<readonly [number, number]> = [];
  const center = Math.floor(CA_SOUP_SIZE / 2);
  for (let dy = 0; dy < CA_SOUP_SIZE; dy++) {
    for (let dx = 0; dx < CA_SOUP_SIZE; dx++) {
      if (dx === center && dy === center) {
        cells.push([dx, dy]);
        continue;
      }
      if (rng.next() < CA_SOUP_FILL_PROBABILITY) cells.push([dx, dy]);
    }
  }
  return cells;
}

/**
 * Picks a pattern deterministically from the RNG: one of the fixed library
 * (uniform), or a freshly-rolled soup — the soup is one extra "slot" in the
 * same draw rather than a separate coin flip, so the whole choice is one RNG
 * call.
 */
function choosePatternCells(rng: StructuresRng): ReadonlyArray<readonly [number, number]> {
  const choice = Math.floor(rng.next() * (CA_FIXED_SEED_PATTERNS.length + 1));
  if (choice < CA_FIXED_SEED_PATTERNS.length) return CA_FIXED_SEED_PATTERNS[choice].cells;
  return randomSoupCells(rng);
}

/**
 * Tries to place one seed pattern on clear, buildable ground. Every cell the
 * chosen pattern needs must be simultaneously buildable AND currently dead —
 * a pattern is never overlaid onto an existing live cell, which would erase
 * that cell's earned age/tier without any terrain edit having happened. Up
 * to CA_SEED_MAX_PLACEMENT_ATTEMPTS anchor points are tried (a fresh pattern
 * choice and a fresh anchor each attempt, both drawn from `rng`) before
 * giving up for this generation. Returns the placed cells (all tier 0, all
 * age 0) or null.
 */
export function attemptSeed(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  rng: StructuresRng,
): StructureCell[] | null {
  for (let attempt = 0; attempt < CA_SEED_MAX_PLACEMENT_ATTEMPTS; attempt++) {
    const patternCells = choosePatternCells(rng);
    let maxDx = 0;
    let maxDy = 0;
    for (const [dx, dy] of patternCells) {
      if (dx > maxDx) maxDx = dx;
      if (dy > maxDy) maxDy = dy;
    }
    if (world.worldSize <= maxDx || world.worldSize <= maxDy) continue; // pattern too big for this world

    const anchorX = Math.floor(rng.next() * (world.worldSize - maxDx));
    const anchorY = Math.floor(rng.next() * (world.worldSize - maxDy));

    const placed: StructureCell[] = [];
    let clear = true;
    for (const [dx, dy] of patternCells) {
      const x = anchorX + dx;
      const y = anchorY + dy;
      if (live.has(structureKey(x, y)) || !isBuildableCell(world, x, y)) {
        clear = false;
        break;
      }
      placed.push({ x, y, tier: 0 });
    }
    if (clear) return placed;
  }
  return null;
}
