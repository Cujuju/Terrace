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
//     anything else dies (under- or over-population). ONE EXCEPTION — card
//     28, "Terrace Farming" (farmland.ts): a dead buildable cell NEAR
//     FARMLAND (itself or a Moore neighbour flat and adjacent to water) is
//     also born with exactly 2 live neighbours. This is the whole "birth
//     rate rises near fed towns" mechanic; see farmland.ts's own header for
//     why it is scoped to birth only, why 2 (not some new, unbounded
//     threshold), and the measured cost of checking it.
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
import { isBlessedStructureCell } from './blessings.ts';
import { maybeAdvanceTier } from './tiers.ts';
import { isBuildableCell, type StructuresWorld } from './suitability.ts';
import { hasNearbyFarmland } from './farmland.ts';
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

/**
 * Chance, rolled once per completed generation (independently of the seed
 * roll above), that a "stir" event ignites a handful of sparks next to an
 * existing settlement — see the "Stirring" section below for the mechanism
 * and why it exists at all.
 *
 * 0.5 — a quiet, fully-settled board (every live cell a frozen still life)
 * changes SOMEWHERE roughly every other generation in expectation, i.e. about
 * every 30 s at CA_GENERATION_INTERVAL_SECONDS = 15: often enough that a
 * player watching a town does not conclude the world has stopped, rare enough
 * that a single settlement is not re-ignited on top of itself every glance
 * and never gets the chance to actually re-settle into something new before
 * the next spark lands.
 */
export const CA_STIR_PROBABILITY_PER_GENERATION = 0.5;

/** Fewest sparks one stir event ignites, drawn from `rng`. */
export const CA_STIR_MIN_SPARKS = 1;

/**
 * Most sparks one stir event ignites, drawn from `rng`.
 *
 * 3 — enough sparks that the ignited neighbourhood usually has more than one
 * new birth to interact with (a single spark next to a stable block just
 * dies again next generation under S23's own rules; two or three adjacent
 * sparks stand a real chance of perturbing the block into something that
 * actually evolves), without spending so many that one stir event alone could
 * seed what amounts to a whole new pattern.
 */
export const CA_STIR_MAX_SPARKS = 3;

/**
 * Bounded walk across live cells looking for one with spare Moore-neighbour
 * room to spark into.
 *
 * 8 — a board where every live cell's whole neighbourhood is already full
 * (hemmed in by other live cells, walls, or the map edge) simply fails to
 * stir this generation (returns null, tried again next time the roll fires)
 * rather than scanning the entire live population every time; 8 anchors is
 * already several times more than any single settlement's live-cell count
 * ordinarily reaches, so a real board exhausts real candidates long before
 * this bound bites.
 */
export const CA_STIR_MAX_ANCHOR_ATTEMPTS = 8;

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
        // Card 28 ("Terrace Farming"): a dead cell with exactly 2 live
        // neighbours — one short of ordinary B3 — is ALSO born if it is near
        // farmland. Checked only for this one neighbour count: 3 already
        // births unconditionally (fedBirth would be redundant), and no other
        // count ever births regardless of farmland — see farmland.ts's
        // header for why this is the ceiling ("births on farmland need
        // exactly what survival already needs, never less, never a new
        // threshold beyond that"). hasNearbyFarmland is therefore evaluated
        // AT MOST once per dead cell, and only for the subset that already
        // has 2 live neighbours — see farmland.ts's own cost note.
        const fedBirth =
          current === undefined && neighborCount === 2 && hasNearbyFarmland(world, x, y);
        const birthed = current === undefined && (neighborCount === 3 || fedBirth);
        if (!survives && !birthed) continue;

        if (current !== undefined) {
          const age = current.age + 1;
          // Blessing (pilgrim routes) is read at the tier gate ONLY — the
          // survives/birthed decisions above never consult it (blessings.ts).
          const tier = maybeAdvanceTier(age, current.tier, neighborCount, isBlessedStructureCell(key));
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
 * Validates one pattern at one anchor: every cell the pattern needs must be
 * simultaneously buildable AND currently dead — a pattern is never overlaid
 * onto an existing live cell, which would erase that cell's earned age/tier
 * without any terrain edit having happened. Returns the placed cells (all
 * tier 0, all age 0) or null.
 *
 * EXPORTED as the single placement authority: the CA's own seeding
 * (attemptSeed) goes through it, and a future player-placed-buildings intent
 * must go through it too, so "where may a pattern stand" can never mean two
 * different things depending on who is asking.
 */
export function placePatternAt(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  anchorX: number,
  anchorY: number,
  patternCells: ReadonlyArray<readonly [number, number]>,
): StructureCell[] | null {
  const placed: StructureCell[] = [];
  for (const [dx, dy] of patternCells) {
    const x = anchorX + dx;
    const y = anchorY + dy;
    if (live.has(structureKey(x, y)) || !isBuildableCell(world, x, y)) return null;
    placed.push({ x, y, tier: 0 });
  }
  return placed;
}

/** Row-major chunk index, the same layout every chunk loop in this plugin walks. */
function chunkIndexOfCell(world: StructuresWorld, x: number, y: number): number {
  return Math.floor(y / CHUNK_SIZE) * world.chunksPerEdge + Math.floor(x / CHUNK_SIZE);
}

/**
 * Tries to place one seed pattern on clear, buildable ground. Up to
 * CA_SEED_MAX_PLACEMENT_ATTEMPTS anchors are tried (a fresh pattern choice, a
 * fresh chunk and a fresh in-chunk offset each attempt, all drawn from `rng`)
 * before giving up for this generation. Returns the placed cells or null.
 *
 * WHERE ANCHORS COME FROM (reworked 2026-08-19, owner report: "buildings only
 * ever appear as one 2×2 block"). The original draw was uniform over the
 * whole world, but eligibility is confined to UNLOCKED chunks — a small
 * fraction of a real world — so nearly every attempt landed on locked ground
 * and missed; the rare seeds that did land decayed to a lone still life. Two
 * rules replace it:
 *
 *   * Anchors are drawn from UNLOCKED chunks only (uniform over that list,
 *     then uniform within the chunk), so the attempt budget is spent entirely
 *     on ground a seed could actually take.
 *   * Chunks that already hold a live cell are avoided while any unlocked,
 *     settlement-free chunk exists (falling back to all unlocked chunks only
 *     when every one is occupied): new colonies spring up in OTHER places, so
 *     separate settlements exist to grow toward each other — true Life
 *     interactions between patterns, not one cluster forever absorbing every
 *     seed. Deliberately chunk-granular, not distance-based: cheap, and a
 *     chunk is already the world's own unit of "somewhere else".
 *
 * The anchor is clamped so the pattern stays inside the world, which near the
 * right/bottom world edge can push it a few cells out of the drawn chunk —
 * acceptable: the cells still pass the same buildability test wherever they
 * land.
 *
 * THE CAP APPLIES TO SEEDS TOO: a pattern that would push the live population
 * past STRUCTURES_CAP is not placed (the CA's own births are already gated in
 * scanChunk; seeding around that gate was an oversight).
 */
export function attemptSeed(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  rng: StructuresRng,
): StructureCell[] | null {
  // Fixed row-major scan, so the candidate list (and therefore the RNG-driven
  // choice) is reproducible for a given world state.
  const unlocked: number[] = [];
  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      if (world.isChunkUnlocked(cx, cy)) unlocked.push(cy * world.chunksPerEdge + cx);
    }
  }
  if (unlocked.length === 0) return null;

  const occupied = new Set<number>();
  for (const key of live.keys()) {
    const cell = cellOfKey(key);
    occupied.add(chunkIndexOfCell(world, cell.x, cell.y));
  }
  const settlementFree = unlocked.filter((idx) => !occupied.has(idx));
  const pool = settlementFree.length > 0 ? settlementFree : unlocked;

  for (let attempt = 0; attempt < CA_SEED_MAX_PLACEMENT_ATTEMPTS; attempt++) {
    const patternCells = choosePatternCells(rng);
    if (live.size + patternCells.length > STRUCTURES_CAP) continue; // a smaller pattern may still fit
    let maxDx = 0;
    let maxDy = 0;
    for (const [dx, dy] of patternCells) {
      if (dx > maxDx) maxDx = dx;
      if (dy > maxDy) maxDy = dy;
    }
    if (world.worldSize <= maxDx || world.worldSize <= maxDy) continue; // pattern too big for this world

    const chunkIdx = pool[Math.floor(rng.next() * pool.length)];
    const baseX = (chunkIdx % world.chunksPerEdge) * CHUNK_SIZE;
    const baseY = Math.floor(chunkIdx / world.chunksPerEdge) * CHUNK_SIZE;
    const anchorX = Math.min(baseX + Math.floor(rng.next() * CHUNK_SIZE), world.worldSize - 1 - maxDx);
    const anchorY = Math.min(baseY + Math.floor(rng.next() * CHUNK_SIZE), world.worldSize - 1 - maxDy);

    const placed = placePatternAt(world, live, anchorX, anchorY, patternCells);
    if (placed !== null) return placed;
  }
  return null;
}

// ── Stirring: what keeps a SETTLED board from staying frozen (owner decision
// 2026-08-19) ─────────────────────────────────────────────────────────────

/**
 * Pure B3/S23 on a bounded board eventually converges into still lifes (a
 * lone 2×2 block, most often — see this file's header) — accepted and even
 * thematic when it happens once, but a world with several settlements, each
 * frozen forever the moment it happens to land on a block, reads as "the
 * simulation stopped" long before an actual quiet-WORLD problem (seeding's
 * job) would trigger. A stir event periodically drops a few sparks
 * immediately next to an EXISTING live settlement, giving the CA's own
 * B3/S23 rule fresh neighbours to react to — the spark itself does nothing;
 * it is next generation's ordinary birth/death evaluation that decides
 * whether the settlement actually changes.
 *
 * IGNITE ONLY, NEVER KILL: a stir event only ever BIRTHS dead cells. It never
 * removes a live cell itself, however the sparks are chosen — killing a live
 * cell here would erase age/tier that cell earned purely by surviving, for no
 * player action and no terrain change, which demolition (the reactive path)
 * and starvation/overcrowding (the CA's own S23 half) are the only two
 * legitimate ways to lose. Any killing a spark provokes in its neighbours
 * (e.g. overcrowding a cell that used to have room) is left entirely to the
 * CA's own S23 rule the very next generation — this function never evaluates
 * survival itself.
 *
 * MECHANICS, deterministic and integer-only, mirroring attemptSeed's shape:
 *
 *   * An empty board returns null immediately — seeding, not stirring, owns
 *     bringing a dead board back to life.
 *   * One ANCHOR is picked from the live cells: sorted ascending by key (a
 *     fixed, reproducible order), indexed by one rng draw, then walked
 *     forward through that same sorted order (wrapping) up to
 *     CA_STIR_MAX_ANCHOR_ATTEMPTS times looking for an anchor with at least
 *     one eligible neighbour.
 *   * CANDIDATES are the anchor's Moore neighbours (MOORE_OFFSETS' fixed
 *     order — the same neighbourhood B3/S23 itself counts) that are
 *     currently dead, in-bounds, and buildable — exactly placePatternAt's own
 *     buildability bar, just per-cell instead of per-pattern.
 *   * sparkCount is one rng draw in [CA_STIR_MIN_SPARKS, CA_STIR_MAX_SPARKS],
 *     then that many candidates (or fewer, if there simply aren't that many)
 *     are drawn WITHOUT replacement, each pick its own rng index.
 *
 * THE CAP APPLIES, BUT DIFFERENTLY FROM SEEDING: seeding rejects an entire
 * pattern that would push the population over STRUCTURES_CAP and tries a
 * different (possibly smaller) one instead. A stir event has no "smaller
 * pattern" to fall back to — its sparks are already independent, so instead
 * of an all-or-nothing rejection, the spark COUNT is simply capped at
 * whatever room remains (live.size + sparks ≤ STRUCTURES_CAP always holds);
 * a fully-capped board (no room at all) returns null.
 */
export function attemptStir(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  rng: StructuresRng,
): StructureCell[] | null {
  if (live.size === 0) return null; // seeding owns the empty board

  const capRoom = STRUCTURES_CAP - live.size;
  if (capRoom <= 0) return null; // no room for even one spark

  // Fixed ascending order, so the anchor walk (and therefore the RNG-driven
  // choice) is reproducible for a given board.
  const sortedKeys = Array.from(live.keys()).sort((a, b) => a - b);
  const startIndex = Math.floor(rng.next() * sortedKeys.length);

  let candidates: Array<readonly [number, number]> = [];
  const anchorAttempts = Math.min(CA_STIR_MAX_ANCHOR_ATTEMPTS, sortedKeys.length);
  for (let attempt = 0; attempt < anchorAttempts; attempt++) {
    const anchor = cellOfKey(sortedKeys[(startIndex + attempt) % sortedKeys.length]);
    candidates = [];
    for (const [ox, oy] of MOORE_OFFSETS) {
      const nx = anchor.x + ox;
      const ny = anchor.y + oy;
      if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
      if (live.has(structureKey(nx, ny))) continue; // ignite only — never overlap a live cell
      if (!isBuildableCell(world, nx, ny)) continue;
      candidates.push([nx, ny]);
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;

  const sparkRoll = CA_STIR_MIN_SPARKS + Math.floor(rng.next() * (CA_STIR_MAX_SPARKS - CA_STIR_MIN_SPARKS + 1));
  const sparkCount = Math.min(sparkRoll, candidates.length, capRoom);

  // Partial Fisher-Yates: each pick is its own rng draw over the shrinking
  // pool, so sparks are chosen without replacement.
  const pool = candidates.slice();
  const sparks: StructureCell[] = [];
  for (let i = 0; i < sparkCount; i++) {
    const pickIndex = Math.floor(rng.next() * pool.length);
    const [x, y] = pool[pickIndex];
    pool.splice(pickIndex, 1);
    sparks.push({ x, y, tier: 0 });
  }
  return sparks;
}
