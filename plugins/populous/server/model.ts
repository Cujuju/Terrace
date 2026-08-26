// THE POPULOUS GROWTH MODEL (Bullfrog, 1989), as it applies to this world.
//
// In Populous the player does not place buildings: they FLATTEN LAND, and the
// people build on what they are given. A dwelling's size is the size of the
// flat plot it stands in — a hut on a scrap of level ground, a castle in the
// middle of a plain — and the people inside it multiply until it is full, at
// which point somebody walks out to found the next one. That is the whole
// loop, and all three of its parts are facts about TERRAIN rather than about
// neighbours:
//
//   * A HOUSE IS FOUNDED ONLY BY A WALKER ARRIVING. There is no birth rule.
//     Under this model structures' board only ever gains a cell through
//     `foundStructure` — pilgrims' settlers — which is exactly how a Populous
//     settlement spreads.
//   * A HOUSE'S TIER IS THE FLAT GROUND AROUND IT, recomputed every step, and
//     it can go DOWN: raise a mountain beside a castle and it is a hut again.
//     That is the player's whole verb in Populous, so it must be live rather
//     than a one-way ratchet.
//   * A HOUSE DIES ONLY FROM THE TERRAIN. No loneliness, no overcrowding —
//     those are Conway's rules, not Bullfrog's. A house goes when the ground
//     under it stops being ground.
//
// PURE, AND IT EMITS NOBODY. `stepPopulous` REPORTS the cells that want to
// send a settler out; ../server/index.ts is what actually asks pilgrims, over
// a bridge that may find nobody home. That split is what makes every rule
// above testable with no world, no host and no sibling plugin — and it is what
// keeps the step deterministic, since a bridge call's success depends on
// another plugin's state.
//
// DETERMINISTIC, INTEGER-ONLY, FIXED ITERATION ORDER (CLAUDE.md's hard rule).
// No rng is needed anywhere: every quantity here is a count of neighbours or a
// sum of integers, and the board is walked in ascending cell-key order rather
// than in map-insertion order, so two servers handed the same board produce
// the same next board cell for cell.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODEL DOES NOT NAME. Buildability, the tier ceiling and the board
// cap all belong to structures (its suitability.ts and protocol.ts) and arrive
// through the step's context. This plugin must build and run with structures
// deleted, so it may not import that plugin — every type below is this
// plugin's own, structurally compatible with the seam's, exactly as pilgrims'
// structures-bridge.ts duck-types the surface it calls.
// ─────────────────────────────────────────────────────────────────────────────

/** The read-only slice of the world this model reads. Duck-typed (see header). */
export interface PopulousWorld {
  readonly worldSize: number;
}

/** One cell of the board, as structures' growth-model seam defines it. */
export interface PopulousCellRecord {
  readonly age: number;
  readonly tier: number;
  /** Absent on a house the Conway CA wrote, or one just founded. Reads as zero. */
  readonly population?: number;
}

/** A cell on the wire: structures' StructureCell. */
export interface PopulousStructureCell {
  readonly x: number;
  readonly y: number;
  readonly tier: number;
}

/** The facts structures hands in rather than letting this model re-derive. */
export interface PopulousContext {
  isBuildable(x: number, y: number): boolean;
  readonly maxTier: number;
  /**
   * Does any BUILDING (`tier > 0`) other than (x, y) itself stand within
   * structures' keep-clear separation of it? Supplied by that plugin (its
   * clearance.ts), because the separation distance and the "teepees may
   * cluster, buildings may not" reading are ITS rules about ITS board — this
   * model may not import them and must not restate them (see the header).
   *
   * `cells` is whichever board the caller wants the question asked of, which
   * is what lets `stepPopulous` ask it of the half-decided board it is
   * building. Not a member of the board's own type for the same reason.
   */
  hasBuildingWithinSeparation(
    cells: ReadonlyMap<number, PopulousCellRecord>,
    x: number,
    y: number,
  ): boolean;
}

/** One completed step, in structures' GrowthStepResult shape. */
export interface PopulousStepResult {
  readonly nextLive: Map<number, PopulousCellRecord>;
  readonly born: PopulousStructureCell[];
  readonly upgraded: PopulousStructureCell[];
  readonly died: Array<{ x: number; y: number }>;
  /** The cells that want a settler sent out. Acted on after the board swap. */
  readonly emitted: ReadonlyArray<{ x: number; y: number }>;
}

/**
 * Cell → integer key: `y * STRIDE + x`. 65536 — RESTATED, not imported, like
 * every other cross-plugin constant here, and it must equal structures'
 * STRUCTURES_CELL_KEY_STRIDE exactly: this model is handed that plugin's map
 * and hands one back. The value is forced by the same fact on both sides — the
 * heightmap's Int16 storage caps a world edge at 32767 — so neither side can
 * move without the other becoming impossible.
 */
export const POPULOUS_CELL_KEY_STRIDE = 65536;

function cellOfKey(key: number): { x: number; y: number } {
  return {
    x: key % POPULOUS_CELL_KEY_STRIDE,
    y: Math.floor(key / POPULOUS_CELL_KEY_STRIDE),
  };
}

/** The eight cells whose ground decides a house's size. Fixed order. */
const MOORE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

/**
 * The house ladder, indexed by how many of the eight Moore neighbours are flat
 * buildable ground: hut on a scrap, castle on a plain.
 *
 * SIX TIERS AND NINE COUNTS, so the mapping cannot be one-to-one; it is the
 * even split, with the two ends given a whole count of their own because they
 * are the readable extremes:
 *
 *   0–1 → 0 (camp)          nothing around it but cliff or water
 *   2   → 1 (hut)           a corner of level ground
 *   3–4 → 2 (timber-house)  an edge or a corner plot
 *   5   → 3 (longhouse)     most of a plot
 *   6–7 → 4 (stone-cottage) a plot missing a corner
 *   8   → 5 (watchtower)    the middle of a plain — the only count that earns it
 *
 * MONOTONIC BY CONSTRUCTION, and asserted so: "more flat ground is never a
 * worse house" is the rule a player learns in the first minute of levelling
 * terrain, and a table is exactly the kind of thing that can quietly stop
 * obeying it.
 *
 * A TABLE RATHER THAN ARITHMETIC (`floor(count * tiers / 9)`) because the
 * grouping is a design decision — the top tier costing all eight, the bottom
 * covering two — and arithmetic would hide it behind a rounding rule.
 */
export const POPULOUS_TIER_BY_FLAT_NEIGHBORS: readonly number[] = [0, 0, 1, 2, 2, 3, 4, 4, 5];

/**
 * The highest tier this table names. 5 — structures' MAX_STRUCTURE_TIER at the
 * time of writing, restated for the same reason every cross-plugin constant
 * here is, and used ONLY as this module's own self-consistency bound: the tier
 * a house actually gets is clamped to the ceiling the LIVE structures build
 * reports (`PopulousContext.maxTier`), so a structures with fewer tiers than
 * this table assumes is served correctly rather than handed a tier its client
 * cannot draw.
 */
export const POPULOUS_MAX_TIER_FALLBACK = 5;

/**
 * People a house gains per step, at every tier.
 *
 * 1, and deliberately flat: the tier ladder already decides how fast a house
 * fills, through its CAPACITY below, and a second per-tier rate would be a
 * second dial doing the same job — two numbers to tune where the mechanic has
 * one meaning ("a bigger house sends people out sooner"). Integer, so the
 * whole model stays integer arithmetic (CLAUDE.md's determinism rule).
 */
export const POPULOUS_GROWTH_PER_STEP = 1;

/**
 * People a house of each tier holds before somebody walks out, indexed by tier.
 *
 * FALLING WITH TIER — the Populous rule stated as numbers: a castle turns out
 * settlers far faster than a hut, which is what makes levelling ground the
 * player's productive act rather than a cosmetic one.
 *
 * The values are set against structures' generation interval (15 s), which is
 * the clock this model steps on: a camp takes 8 steps ≈ 2 minutes to send
 * anyone out, a watchtower 3 steps ≈ 45 seconds. The slow end is slow enough
 * that a settlement on bad ground reads as struggling rather than as broken;
 * the fast end still costs a player most of a minute, so a plain does not
 * flood with settlers faster than they can be watched. The spread — under
 * three to one — keeps every tier worth having without making the low ones
 * pointless.
 */
export const POPULOUS_CAPACITY_BY_TIER: readonly number[] = [8, 7, 6, 5, 4, 3];

/**
 * What a house is left with after its settler walks out.
 *
 * 0 — the household that left WAS the surplus, and the house begins filling
 * again from empty. Any other value would be a per-tier head start, i.e. a
 * third dial on the same mechanic (see POPULOUS_GROWTH_PER_STEP).
 */
export const POPULOUS_POPULATION_AFTER_EMIT = 0;

/**
 * The tier a cell is held at when a building already stands within structures'
 * keep-clear separation of it.
 *
 * 0 — a camp, i.e. the bottom of the same ladder, rather than a separate
 * "refused" state. There is no such thing as a house with no tier on this
 * board, and inventing one would put a value on the wire that structures'
 * client has no model for. A camp is exactly what a plot that may not build
 * yet looks like.
 */
const CLEARANCE_REFUSED_TIER = 0;

/**
 * The tier a house earns from `flatNeighbors` flat neighbours, clamped to the
 * live board's ceiling. One definition, so the step and its tests cannot
 * disagree about the ladder.
 */
export function populousTierFor(flatNeighbors: number, maxTier: number): number {
  const index = Math.max(0, Math.min(POPULOUS_TIER_BY_FLAT_NEIGHBORS.length - 1, flatNeighbors));
  const tier = POPULOUS_TIER_BY_FLAT_NEIGHBORS[index];
  return Math.max(0, Math.min(maxTier, tier));
}

/** The capacity of a tier, clamped to the table's ends for an out-of-range tier. */
function capacityForTier(tier: number): number {
  const index = Math.max(0, Math.min(POPULOUS_CAPACITY_BY_TIER.length - 1, tier));
  return POPULOUS_CAPACITY_BY_TIER[index];
}

/** How many of (x, y)'s eight Moore neighbours are flat, buildable ground. */
function flatNeighborsAround(
  world: PopulousWorld,
  ctx: PopulousContext,
  x: number,
  y: number,
): number {
  let count = 0;
  for (const [ox, oy] of MOORE_OFFSETS) {
    const nx = x + ox;
    const ny = y + oy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
    if (ctx.isBuildable(nx, ny)) count++;
  }
  return count;
}

/**
 * ONE STEP OF THE MODEL. Pure: nothing outside the returned value changes, and
 * the settlers this step wants sent are REPORTED, in `emitted`, rather than
 * sent — ../server/index.ts does that from structures' post-swap hook (see
 * this file's header, and structures' GrowthModel.afterSwap).
 *
 * The board is walked in ascending key order — not the map's insertion order —
 * so `died`, `upgraded` and `emitted` come back in the same order on every
 * server regardless of the order houses happened to be founded in. That order
 * is also the CLEARANCE TIE-BREAK (below): when two cells both want to be
 * buildings and cannot both be, the lower key wins. It has to be decided by
 * SOMETHING, and the only tie-break available that is identical on every
 * server is the one the walk already imposes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CLEARANCE. structures does not allow two buildings within
 * STRUCTURE_SEPARATION_CELLS of each other, and that is a rule about the
 * BOARD, not about the Conway CA that used to be the only thing enforcing it.
 * A cell may therefore hold `tier > 0` only if no OTHER building stands within
 * separation of it — asked of the board AS THIS STEP IS LEAVING IT: cells
 * already decided this step carry their new tier, cells not yet reached carry
 * the tier they came in with. That is the same half-decided view the CA's own
 * sweep reasons about, and it is what keeps two cells that arrive already
 * overlapping (an older save, or a board this rule never touched) from BOTH
 * yielding and flipping camp/building forever.
 *
 * HELD AT 0, NOT DEMOLISHED. A refused cell becomes a camp and keeps standing.
 * Deaths in this model are terrain-only by design — "a house goes when the
 * ground under it stops being ground" — so demolishing a house for being in
 * somebody's way would be a second, unrelated death rule, and it would delete
 * a settler's home for a reason the player cannot see in the landscape. A camp
 * still fills and still sends people out, at tier 0's capacity.
 *
 * DEATHS ARE DECIDED FIRST, in their own pass, so a house that this very step
 * loses its ground cannot block a neighbour from building on the way past.
 *
 * `born` is always empty and that is the model, not an omission: a house
 * appears only when a walker arrives and structures' own `foundStructure`
 * writes it, which happens between steps and is broadcast by that plugin on
 * its own path. It stays in the result shape because the seam's contract is
 * one outcome type for every model.
 */
export function stepPopulous(
  world: PopulousWorld,
  live: ReadonlyMap<number, PopulousCellRecord>,
  ctx: PopulousContext,
): PopulousStepResult {
  const nextLive = new Map<number, PopulousCellRecord>();
  const upgraded: PopulousStructureCell[] = [];
  const died: Array<{ x: number; y: number }> = [];
  const emitted: Array<{ x: number; y: number }> = [];

  const keys = [...live.keys()].sort((a, b) => a - b);

  // PASS ONE — WHO IS STILL STANDING AT ALL.
  //
  // THE ONLY WAY A HOUSE DIES. Its own ground stopped being ground —
  // sculpted away, drowned, or claimed by another plugin's reservation (all of
  // which is structures' isBuildableCell, over the context). A house whose
  // NEIGHBOURS moved merely changes size.
  //
  // Separated from the tier pass so the clearance question below is asked of
  // survivors only: a house losing its ground this very step must not reserve
  // a square it will not be standing in by the end of it.
  const surviving = new Map<number, PopulousCellRecord>();
  for (const key of keys) {
    const { x, y } = cellOfKey(key);
    if (!ctx.isBuildable(x, y)) {
      died.push({ x, y });
      continue;
    }
    surviving.set(key, live.get(key)!);
  }

  // PASS TWO — SIZE, PEOPLE AND CLEARANCE, in ascending key order.
  //
  // `undecided` is the survivors this pass has NOT reached yet, still carrying
  // the tier they came in with; `nextLive` is the ones it has, carrying their
  // new one. Between them they are the board as this step is leaving it, which
  // is the board the clearance question has to be asked of.
  const undecided = new Map(surviving);
  for (const key of keys) {
    const record = surviving.get(key);
    if (record === undefined) continue; // died in pass one
    const { x, y } = cellOfKey(key);
    undecided.delete(key);

    // A cell is never obstructed by its own ambition — the predicate excludes
    // (x, y) itself — so this asks only about OTHER buildings.
    const obstructed =
      ctx.hasBuildingWithinSeparation(nextLive, x, y) ||
      ctx.hasBuildingWithinSeparation(undecided, x, y);
    const earned = populousTierFor(flatNeighborsAround(world, ctx, x, y), ctx.maxTier);
    const tier = obstructed ? CLEARANCE_REFUSED_TIER : earned;
    if (tier !== record.tier) upgraded.push({ x, y, tier });

    // GROW, THEN CHECK — so a house that has just been promoted into a
    // smaller capacity than its current population sends somebody out on this
    // very step rather than sitting over its own ceiling for another one.
    const capacity = capacityForTier(tier);
    let population = (record.population ?? 0) + POPULOUS_GROWTH_PER_STEP;
    if (population >= capacity) {
      population = POPULOUS_POPULATION_AFTER_EMIT;
      emitted.push({ x, y });
    }

    // `age` is structures' own counter — generations survived — and this model
    // keeps advancing it even though nothing here reads it: it is the field
    // every OTHER consumer of that plugin uses for "has stood a while"
    // (pilgrims picks the towns that send pilgrims by it), and a model that
    // froze it at zero would silently switch those consumers off.
    nextLive.set(key, { age: record.age + 1, tier, population });
  }

  return { nextLive, born: [], upgraded, died, emitted };
}
