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

import { CHUNK_SIZE, isSettlingDay } from '@terrace/shared';
import { STRUCTURES_CAP, cellOfKey, structureKey, type StructureCell } from '../protocol.ts';
import { isBlessedStructureCell } from './blessings.ts';
import { maybeAdvanceTier } from './tiers.ts';
import { isBuildableCell, type StructuresWorld } from './suitability.ts';
import { hasNearbyFarmland } from './farmland.ts';
import {
  hasBuildingWithinSeparation,
  livingCellsWithinSeparation,
} from './clearance.ts';
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
 * SETTLERS ARRIVE ON MONDAYS, AND ONLY WHEN THERE IS NO ONE LEFT (owner,
 * 2026-08-23: "the settlement seeder only runs once per seven in-game days if
 * the entire colony has been wiped out … it seeds on a Monday. Like the world
 * was created on Monday and on Sunday the Creator rested").
 *
 * WHAT THIS REPLACES, and why the old rule had to go rather than be re-tuned:
 * seeding used to be a 0.35 coin flip every generation — an attempt every ~43
 * simulated seconds, fired whether or not anyone was alive. Two things were
 * wrong with it beyond the pacing. It re-seeded a LIVING world, so a thriving
 * board was perpetually overwritten faster than its own patterns could settle;
 * and it drew its target from every unlocked chunk, which on the live world
 * meant 19 chunks in 429 held any buildable ground at all and 95.6% of attempts
 * were thrown into open water (measured, snapshot 345, 2026-08-22).
 *
 * The rule now reads as one sentence: when a world has no settlements left, the
 * next Monday brings new settlers. `attemptSeed` draws only from chunks that
 * actually have somewhere to build, so the one attempt a week is a real one.
 *
 * SUNDAY IS FLAVOUR, NOT MECHANICS (owner's call, same conversation): nothing
 * in the simulation pauses on the seventh day. A settlement automaton that
 * visibly froze for a seventh of its life would read as a bug rather than a
 * joke, and the joke survives perfectly well as the day before the settlers
 * come. See shared/src/calendar.ts, which owns the week.
 */
export function shouldSeed(
  live: ReadonlyMap<number, LiveCellRecord>,
  day: number,
  lastSeedDay: number,
): boolean {
  // Only into an empty world: this is repopulation, not immigration.
  if (live.size > 0) return false;
  if (!isSettlingDay(day)) return false;
  // ONCE per Monday, not once per generation on a Monday — a day is ~96
  // generations, and without this the "once a week" rule would be a
  // ninety-six-times-a-week rule for as long as the board stayed empty.
  return day !== lastSeedDay;
}

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

/**
 * How many patterns one Monday's arrival plants, across DIFFERENT chunks.
 *
 * FIVE, and the number is doing real work rather than being generous
 * (measured, 2026-08-23). Seeding a single pattern and then waiting a week is
 * what the weekday rule literally asks for, and it produces a dead world: a
 * lone random soup under B3/S23 almost always dies within a few generations,
 * so a simulated fortnight ran `day 0: peaks at 26, dead by minute 12; days
 * 1-6 empty; day 7: 4 cells, dead within the hour` — empty about 95% of the
 * time. The old per-generation coin flip hid that by re-seeding every ~43 s;
 * what looked like a population was churn, which is also why the live world's
 * saga reads "pitched a new camp" / "Ruin took N homes" over and over.
 *
 * A week's wait has to buy a REGION, not four cells (owner, 2026-08-23). Five
 * scattered patterns give the arrival several independent chances to leave
 * something standing, and — because they are placed in different chunks and
 * therefore far apart — they evolve independently instead of colliding into
 * one mutual annihilation.
 *
 * WHY NOT "ALWAYS PLANT A STILL LIFE", the other obvious fix: a block never
 * dies, so it would guarantee survival by guaranteeing that nothing ever
 * happens — the board would freeze into the same four cells forever, which is
 * the exact failure attemptStir was written to prevent. Several patterns keep
 * the automaton alive in both senses.
 */
export const CA_SEED_PATTERNS_PER_ARRIVAL = 5;

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
 * DOUBLE-BUFFERED BY A SNAPSHOT TAKEN AT THE START OF EACH SWEEP, not by the
 * caller's promise not to write. Every cell read during a sweep comes from
 * `board` below — a copy of the live map made on the tick the sweep begins —
 * so a chunk scanned early sees exactly the board a chunk scanned late does,
 * whatever happens to the caller's own map in between.
 *
 * IT USED TO BE THE PROMISE, AND THE PROMISE WAS BROKEN (2026-08-24). A sweep
 * spans many ticks, and `foundStructure` — a settler moving in, from outside
 * this plugin, at a moment nobody schedules — writes straight into the live
 * map. A home founded into a chunk this sweep had ALREADY scanned was absent
 * from `staged`, and the swap at the end of the sweep therefore deleted it:
 * four houses appeared, stood for up to fifteen seconds, and vanished. The
 * board the CA reasons about now belongs to the CA for the length of the
 * sweep, so no outside write can be half-seen by it, and cells that appeared
 * mid-sweep are CARRIED into the next generation rather than silently dropped
 * (see `advance`).
 */
export class GenerationSurvey {
  private cursor = 0;
  private readonly staged = new Map<number, LiveCellRecord>();
  /**
   * CELLS THAT DIED MID-SWEEP, from either of the two directions the swept
   * `board` cannot see. A key on this set is skipped for BOTH survival and
   * birth when its chunk is scanned later in the sweep, and un-staged if its
   * chunk was scanned earlier. Cleared with the sweep in resetSweep.
   *
   *   * A NEW BUILDING CLEARED ITS KEEP-CLEAR SQUARE (scanChunk's
   *     teepee→building step): re-staging one of those cells would resurrect
   *     a teepee inside a building's reserved ground mid-generation.
   *   * SOMETHING OUTSIDE THIS SWEEP DELETED THE CELL — a town that burned
   *     down (index.ts's structuresBurnedOut) or ground dug out from under a
   *     house (reactToTerrain), both of which delete straight from the live
   *     map and broadcast the loss, on a tick this sweep does not control.
   *     They reach the sweep through `evict` below.
   *
   * THE SECOND SOURCE IS THE DELETE-SHAPED HALF OF THE 2026-08-24 BUG. That
   * fix gave the sweep a private snapshot so an outside WRITE could not be
   * half-seen; the snapshot by construction also preserves an outside
   * DELETE's victim, which then gets staged straight back into the next
   * generation. Until 2026-08-26 that mostly self-healed — a resurrected cell
   * faced S23 again and usually died the generation after — but buildings are
   * now permanent (see scanChunk's `survives`), so a resurrected BUILDING
   * never dies: it stands forever on ground the client was told it lost, and
   * holds its whole keep-clear square against every future placement. A
   * snapshot that survives outside writes has to survive outside deletes too.
   */
  private readonly demolishedThisSweep = new Set<number>();
  /**
   * The generation being scanned — a copy taken when the sweep starts, and
   * the ONLY board `scanChunk` reads. Null between sweeps.
   */
  private board: ReadonlyMap<number, LiveCellRecord> | null = null;

  /**
   * TELLS AN ACTIVE SWEEP THAT A CELL IS GONE — the eviction half of the
   * board snapshot's contract, called by every path that deletes a live cell
   * from outside this sweep (index.ts: structuresBurnedOut, reactToTerrain).
   *
   * The snapshot itself is deliberately NOT edited. Its whole purpose is that
   * every chunk of one sweep reasons about the SAME generation — neighbour
   * counts included — so a chunk scanned at second 3 and one scanned at
   * second 12 cannot disagree about how crowded a neighbourhood was. Removing
   * the cell from `board` mid-sweep would reintroduce exactly that split
   * view. The cell therefore still COUNTS as a neighbour for the generation
   * it was alive at the start of, and simply does not survive into the next
   * one — the same bounded, one-generation lag life.ts's header already names
   * for a cell whose neighbour was sculpted.
   *
   * Idempotent, and safe to call between sweeps: a key evicted while no sweep
   * is running is cleared by the next resetSweep before that sweep begins.
   */
  evict(key: number): void {
    this.staged.delete(key);
    this.demolishedThisSweep.add(key);
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
    this.demolishedThisSweep.clear();
    this.board = null;
  }

  /**
   * DEMOLISHES every live, non-building cell within the keep-clear square of
   * a building that has JUST been founded at (x, y) — the sweep-side half of
   * the 2026-08-26 rule that a building never shares its ground: without the
   * clear, the teepees standing where the building now rises would survive
   * indefinitely as overlapping models (survival deliberately never consults
   * clearance — see clearance.ts's header — so nothing else would ever remove
   * them).
   *
   * Two sources are walked, because a sweep spans many chunks and "live"
   * means something slightly different for each:
   *
   *   * the swept BOARD — cells alive last generation, including ones already
   *     staged earlier in this sweep (un-staged here so they drop out of the
   *     outcome's swap); and
   *   * cells STAGED but not yet on the board — births from earlier chunks of
   *     this same sweep, which would otherwise slip through having passed the
   *     birth gate before this square had any building in it.
   *
   * Both walks go through livingCellsWithinSeparation, which refuses to
   * return buildings: a building never demolishes another building. Every
   * demolished cell lands in `died` automatically — board-live ones because
   * they are absent from `staged` at outcome time (advance computes `died`
   * from exactly that difference), staged-born ones because they were never
   * broadcast as founded in the first place (births only reach the wire at
   * sweep completion), so there is simply nothing to announce for them.
   *
   * Keys land in demolishedThisSweep so chunks scanned LATER in this sweep
   * skip these cells outright (scanChunk's suppression check).
   */
  private clearKeepClearSquare(
    world: StructuresWorld,
    live: ReadonlyMap<number, LiveCellRecord>,
    x: number,
    y: number,
  ): void {
    // The swept board first — the ordinary case: teepees standing where the
    // building now rises.
    for (const key of livingCellsWithinSeparation(live, world, x, y)) {
      this.staged.delete(key);
      this.demolishedThisSweep.add(key);
    }
    // Then this sweep's own earlier births, which are in `staged` alone.
    for (const key of livingCellsWithinSeparation(this.staged, world, x, y)) {
      this.staged.delete(key);
      this.demolishedThisSweep.add(key);
    }
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
        // MID-SWEEP DEATH SUPPRESSION: a cell that died earlier this sweep —
        // cleared by a new building's keep-clear square, or burned down or
        // sculpted away from outside (see demolishedThisSweep) — is skipped
        // for BOTH survival and birth. It is already rubble, and the swept
        // board still holds it: staging it would resurrect either a teepee
        // inside a building's reserved ground or a house the client has
        // already been told it lost. Chunks are scanned in fixed row-major
        // order, so this is what makes a mid-sweep death bite cells the sweep
        // has not reached yet; earlier ones were un-staged directly, by
        // clearKeepClearSquare or by evict.
        if (this.demolishedThisSweep.has(key)) continue;

        const current = live.get(key);
        const neighborCount = countLiveNeighbors(live, world, x, y);
        // BUILDINGS ARE PERMANENT (keep-clear rule, 2026-08-26): a cell with
        // tier > 0 survives regardless of its neighbour count, though it is
        // still killed by the isBuildableCell wall test above (sculpting,
        // water, a temple reservation) — that path is unchanged and must stay:
        // losing one's GROUND remains fatal whatever stands on it.
        //
        // WHY THE EXEMPTION IS FORCED, NOT A LOYALTY BONUS: a building now
        // stands ALONE by construction — founding it demolished everything in
        // its keep-clear square, and nothing may be placed back inside — so
        // under ordinary S23 it would have 0 neighbours the moment it spawned,
        // die of underpopulation instantly, and every building in the game
        // would live exactly one generation. The exemption is what makes the
        // keep-clear rule and the CA describable by the same simulation.
        const survives =
          current !== undefined &&
          (current.tier > 0 || neighborCount === 2 || neighborCount === 3);
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
        let birthed = current === undefined && (neighborCount === 3 || fedBirth);
        // NO BIRTH INSIDE A BUILDING'S SQUARE (keep-clear rule, 2026-08-26):
        // checked against the swept board AND against cells staged earlier in
        // this sweep — a building founded mid-sweep reserves its square at the
        // moment it forms, not at the next generation boundary. Without this
        // gate the cleared ring would simply refill on the very next
        // generation, since survival never consults clearance.
        if (
          birthed &&
          (hasBuildingWithinSeparation(live, world, x, y) ||
            hasBuildingWithinSeparation(this.staged, world, x, y))
        ) {
          birthed = false;
        }
        if (!survives && !birthed) continue;

        if (current !== undefined) {
          const age = current.age + 1;
          // Blessing (pilgrim routes) is read at the tier gate ONLY — the
          // survives/birthed decisions above never consult it (blessings.ts).
          let tier = maybeAdvanceTier(age, current.tier, neighborCount, isBlessedStructureCell(key));
          // THE TEEPEE→BUILDING STEP IS REFUSED when another building already
          // stands within STRUCTURE_SEPARATION_CELLS — on the board or staged
          // mid-sweep, same as the birth gate above. This is the PHYSICAL
          // footprint rule (two buildings may not interpenetrate), not a
          // prosperity gate: blessing waives the NEIGHBOUR requirement in
          // tiers.ts's maybeAdvanceTier, never this check. The refused cell
          // keeps surviving as a teepee and may retry once the obstruction is
          // gone; which candidate wins when two qualify in one generation is
          // decided deterministically by this scan's fixed row-major order.
          // TIER 0 ONLY: a standing building advancing 1→2→… needs no check —
          // it cleared its square at birth, and grandfathered saves' adjacent
          // old buildings must still be allowed to age onward (the owner
          // declined retroactive reconciliation).
          if (
            current.tier === 0 &&
            tier > current.tier &&
            (hasBuildingWithinSeparation(live, world, x, y) ||
              hasBuildingWithinSeparation(this.staged, world, x, y))
          ) {
            tier = current.tier;
          } else if (current.tier === 0 && tier > current.tier) {
            // The step succeeded: A NEW BUILDING CLEARS ITS SQUARE. Every
            // teepee within STRUCTURE_SEPARATION_CELLS is demolished — see
            // clearKeepClearSquare for why both the board and the staged set
            // are walked, and how each demolished cell reaches `died`.
            this.clearKeepClearSquare(world, live, x, y);
          }
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

    // The sweep's own copy of the generation it is scanning — see the class
    // header. Taken on the tick the sweep starts and read by every chunk of
    // it; the caller's map may change underneath without the CA seeing half
    // of the change.
    if (this.board === null) this.board = new Map(live);
    const board = this.board;

    while (budget > 0 && this.cursor < totalChunks) {
      this.scanChunk(world, board, this.cursor % world.chunksPerEdge, Math.floor(this.cursor / world.chunksPerEdge));
      this.cursor++;
      budget--;
    }
    if (this.cursor < totalChunks) return null;

    // CELLS THAT APPEARED MID-SWEEP ARE CARRIED, NOT JUDGED. They were founded
    // from outside (foundStructure) after this generation's board was fixed,
    // so B3/S23 has not been applied to them and must not be: they enter the
    // next generation exactly as founded and face the rules from the sweep
    // after this one — the same "evaluated starting next generation, never the
    // one that just ran" rule attemptSeed and attemptStir keep. Nor are they
    // reported as born: the founding path broadcast them when it happened.
    //
    // EXCEPT ONTO GROUND A BUILDING TOOK WHILE THEY WERE APPEARING. The
    // carry is the one path into the next generation that never passed
    // through scanChunk, so it is also the one path clearKeepClearSquare
    // cannot reach: that walks the swept board and the staged set, and a
    // mid-sweep founding is in NEITHER. Without this guard a settler who
    // moved in at 17:00:03 onto ground a building claimed at 17:00:07 would
    // be carried straight into the next generation standing inside that
    // building — the exact overlap the keep-clear rule exists to make
    // impossible, arriving through the one door the rule does not watch.
    // The cell is dropped and REPORTED DEAD rather than dropped silently,
    // because `foundStructure` already broadcast it as founded: the client
    // is holding a structure that no longer exists, and `died` is how this
    // plugin says so. It cannot be reported by the board-difference loop
    // below, which only knows cells that were on the swept board.
    //
    // ASKED AGAINST `staged`, NOT AGAINST demolishedThisSweep: that set holds
    // the cells the clear actually FOUND, and a mid-sweep founding is
    // invisible to it by the same absence that makes this guard necessary.
    // `staged` at this point is the next generation entire — every building
    // that survived the sweep and every one founded during it — so it is the
    // one board that can answer "is this cell inside a building's square?"
    // for ground claimed at any point in the sweep.
    const carriedOntoClaimedGround: number[] = [];
    for (const [key, record] of live) {
      if (board.has(key) || this.staged.has(key)) continue;
      const cell = cellOfKey(key);
      if (hasBuildingWithinSeparation(this.staged, world, cell.x, cell.y)) {
        carriedOntoClaimedGround.push(key);
        continue;
      }
      this.staged.set(key, record);
    }

    const born: StructureCell[] = [];
    const upgraded: StructureCell[] = [];
    const died: Array<{ x: number; y: number }> = [];

    for (const key of carriedOntoClaimedGround) {
      const cell = cellOfKey(key);
      died.push({ x: cell.x, y: cell.y });
    }

    for (const [key, record] of this.staged) {
      // Against the SWEPT board, never against `live`: a cell carried in above
      // is in `live` and not in `board`, and reporting it born would send a
      // second copy of a founding already on the wire.
      if (!board.has(key) && live.has(key)) continue;
      const previous = board.get(key);
      const cell = cellOfKey(key);
      if (previous === undefined) {
        born.push({ x: cell.x, y: cell.y, tier: record.tier });
      } else if (previous.tier !== record.tier) {
        upgraded.push({ x: cell.x, y: cell.y, tier: record.tier });
      }
    }
    for (const key of board.keys()) {
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
    // KEEP-CLEAR (2026-08-26): a pattern is refused if ANY of its cells has a
    // building within STRUCTURE_SEPARATION_CELLS — every cell of the pattern
    // would be a standing structure the moment it lands. The predicate lives
    // in clearance.ts so this path and the CA's birth/tier gates cannot
    // disagree about where a building's ground ends.
    if (hasBuildingWithinSeparation(live, world, x, y)) return null;
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
/**
 * Does this chunk contain anywhere a structure could stand?
 *
 * Scanned rather than cached, and that is affordable BECAUSE of the new
 * cadence: this runs at most once per world-day now (shouldSeed gates it), not
 * up to twice a minute. A cache would have to be invalidated by every terrain
 * edit — the reactive path in index.ts sees them — and buying that complexity
 * to speed up a once-a-week scan would be the wrong trade. If seeding ever
 * becomes frequent again, this is the line that needs the cache.
 *
 * Returns on the FIRST buildable cell, so a chunk with any land at all is cheap
 * and only all-water chunks pay the full 256 probes.
 */
function chunkHasBuildableCell(world: StructuresWorld, cx: number, cy: number): boolean {
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  for (let dy = 0; dy < CHUNK_SIZE; dy++) {
    for (let dx = 0; dx < CHUNK_SIZE; dx++) {
      if (isBuildableCell(world, baseX + dx, baseY + dy)) return true;
    }
  }
  return false;
}

export function attemptSeed(
  world: StructuresWorld,
  live: ReadonlyMap<number, LiveCellRecord>,
  rng: StructuresRng,
): StructureCell[] | null {
  // Fixed row-major scan, so the candidate list (and therefore the RNG-driven
  // choice) is reproducible for a given world state.
  //
  // THE POOL IS CHUNKS WITH SOMEWHERE TO BUILD, not merely unlocked ones
  // (2026-08-23). An unlocked chunk is usually open water — on the live world,
  // 19 of 429 unlocked chunks held a single buildable cell, so the old pool
  // spent 95.6% of its attempts placing a settlement in the sea and the twelve
  // tries below were mostly spent before one landed. Now that a world gets ONE
  // attempt a week (see shouldSeed), an attempt that cannot succeed is not a
  // slower world, it is a world that never repopulates.
  const unlocked: number[] = [];
  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      if (world.isChunkUnlocked(cx, cy) && chunkHasBuildableCell(world, cx, cy)) {
        unlocked.push(cy * world.chunksPerEdge + cx);
      }
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

  // ONE ARRIVAL PLANTS SEVERAL PATTERNS, in different chunks — see
  // CA_SEED_PATTERNS_PER_ARRIVAL for why one is not enough. Each gets its own
  // budget of placement attempts, and a pattern that cannot be placed anywhere
  // is skipped rather than failing the whole arrival: four settlements founded
  // is not a failed Monday.
  //
  // `planted` accumulates across patterns and is passed to placePatternAt as
  // part of the occupied set, so two patterns in the same arrival can never be
  // laid on top of each other — placePatternAt reads `live`, which does not yet
  // contain anything this arrival placed (the caller writes them in afterwards).
  const planted: StructureCell[] = [];
  const claimed = new Map<number, LiveCellRecord>(live);
  const usedChunks = new Set<number>();

  for (let pattern = 0; pattern < CA_SEED_PATTERNS_PER_ARRIVAL; pattern++) {
    // A chunk holds at most one of this arrival's patterns, so a settlement
    // region is spread over the map rather than stacked in one corner.
    const available = pool.filter((idx) => !usedChunks.has(idx));
    if (available.length === 0) break;

    for (let attempt = 0; attempt < CA_SEED_MAX_PLACEMENT_ATTEMPTS; attempt++) {
      const patternCells = choosePatternCells(rng);
      if (claimed.size + patternCells.length > STRUCTURES_CAP) break; // the board is full
      let maxDx = 0;
      let maxDy = 0;
      for (const [dx, dy] of patternCells) {
        if (dx > maxDx) maxDx = dx;
        if (dy > maxDy) maxDy = dy;
      }
      if (world.worldSize <= maxDx || world.worldSize <= maxDy) continue; // too big for this world

      const chunkIdx = available[Math.floor(rng.next() * available.length)]!;
      const baseX = (chunkIdx % world.chunksPerEdge) * CHUNK_SIZE;
      const baseY = Math.floor(chunkIdx / world.chunksPerEdge) * CHUNK_SIZE;
      const anchorX = Math.min(baseX + Math.floor(rng.next() * CHUNK_SIZE), world.worldSize - 1 - maxDx);
      const anchorY = Math.min(baseY + Math.floor(rng.next() * CHUNK_SIZE), world.worldSize - 1 - maxDy);

      const placed = placePatternAt(world, claimed, anchorX, anchorY, patternCells);
      if (placed === null) continue;

      for (const cell of placed) claimed.set(structureKey(cell.x, cell.y), { age: 0, tier: 0 });
      planted.push(...placed);
      usedChunks.add(chunkIdx);
      break;
    }
  }

  // Null, not an empty array: the caller's contract is "a placement or
  // nothing", and an arrival that planted nothing is nothing.
  return planted.length > 0 ? planted : null;
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
      // KEEP-CLEAR (2026-08-26): a spark is a NEW PLACEMENT like any other,
      // so it may not land inside a standing building's reserved square —
      // the same predicate the CA's birth rule and placePatternAt use.
      if (hasBuildingWithinSeparation(live, world, nx, ny)) continue;
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
