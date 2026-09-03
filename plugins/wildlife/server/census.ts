// Reading the world: habitat validity for one cell, and the periodic area
// census that drives population targets.
//
// Everything here is a pure function of the world's current state — no mutable
// plugin state, no side effects — which is what lets the tests assert the
// population maths directly against a hand-built world.

import {
  AVOID_TURN_ATTEMPTS,
  AVOID_TURN_STEP_RADIANS,
  CHUNK_SIZE,
  LAND_WALKER_PROFILE,
  canProceedAlong,
  canTraverseSegment,
  cellsOverArea,
  isWalkableCell as sharedIsWalkableCell,
  waterBandProfile,
  type FreshwaterMap,
  type TraversalProfile,
} from '@terrace/shared';
import { WILDLIFE_HABITAT_SPECIES, type WildlifeHabitatSpecies } from '../protocol.ts';
import { type Habitat, habitatOf, profileOf, spawnGroundConstrains } from './species.ts';
import { SPAWN_AT_ANY_HEIGHT } from './species/profile.ts';

/**
 * Adapts one species onto a shared traversal archetype (shared/src/
 * traversal.ts). `habitatOf`'s three-value `Habitat` union
 * ('land'/'shallow'/'deep') differs from shared's `TerrainGround`
 * ('dry'/'shallow'/'deep') by one name only — see species.ts's habitatOf doc
 * — so the one 'land' → 'dry' translation lives here, at the single seam
 * where a wildlife species crosses into the shared contract.
 *
 * PICKS AN ARCHETYPE, does not build a literal (2026-08-20). A grazer is
 * shared's land walker in every respect there is, including the two axes this
 * plugin never had an opinion about — the band-0 waterline fringe not being
 * ground, and rivers and lakes being things to walk around. Building a
 * literal here is how this contract drifted the first time (see traversal.ts's
 * header on pilgrims shipping wildlife's pre-fix rule); the archetype cannot
 * drift.
 *
 * ASSUMPTION, named because it is a behaviour change and not merely a
 * refactor: a grazer declining the coastal fringe and declining to graze
 * through a river is the intended reading of "a legged animal on dry ground".
 * If a future species genuinely wades, it earns its own archetype in
 * traversal.ts rather than a literal here.
 *
 * EXPORTED (2026-08-21) for movement.ts's steering probe, which hands the same
 * archetype to shared's `steerAvoiding`. One resolution of species → archetype,
 * read by both the census predicates here and the steering there, so the cell a
 * creature may STAND on and the cell it may STEER toward cannot come apart.
 *
 * ONE AXIS OF THE ARCHETYPE IS NOW OVERRIDDEN BY THE ROW — the gradient limit,
 * so the ibex can climb what the archetype refuses. See `walkerProfileFor`
 * below for why that is a fix rather than the drift this note warns about: the
 * other three axes are still the archetype's, untouched.
 */
export function walkerProfileOf(species: WildlifeHabitatSpecies): TraversalProfile {
  return WALKER_PROFILES[species];
}

/**
 * The archetype for one species, with its DECLARED gradient limit written in.
 *
 * THE OVERRIDE IS A BUG FIX, not a generalisation (2026-09-02). Every profile
 * declared `maxGradientPerCell` and this function never read it: it picked an
 * archetype by habitat and handed the archetype's own limit on. That was
 * invisible while the four original rows all happened to state exactly the
 * limit their archetype already carried — the water species Infinity, the
 * grazer LAND_WALKER_MAX_GRADIENT_PER_CELL — and it would have silently
 * discarded the ibex's doubled limit (./species/ibex.ts), which is the entire
 * species. So the row wins, and for the four rows that already agreed this
 * builds a profile identical field for field to the one they got before.
 *
 * The other three axes stay the ARCHETYPE'S, and that is still the 2026-08-20
 * decision: which ground classes count, the band-0 fringe, and rivers-vs-lakes
 * are facts about a kind of mover, not per-species dials, and building a
 * literal here is how this contract drifted the first time.
 */
function walkerProfileFor(species: WildlifeHabitatSpecies): TraversalProfile {
  const profile = profileOf(species);
  const archetype =
    profile.habitat === 'land' ? LAND_WALKER_PROFILE : waterBandProfile(profile.habitat);
  return { ...archetype, maxGradientPerCell: profile.maxGradientPerCell };
}

/**
 * Built once at module load, in WILDLIFE_HABITAT_SPECIES order.
 *
 * `walkerProfileOf` is on the steering hot path — shared's `steerAvoiding` asks
 * for it once per candidate heading per creature per tick — so the spread in
 * `walkerProfileFor` must not run there. Nothing mutates a profile, so one
 * object per species is safe to share.
 */
const WALKER_PROFILES: Readonly<Record<WildlifeHabitatSpecies, TraversalProfile>> =
  Object.fromEntries(
    WILDLIFE_HABITAT_SPECIES.map((species) => [species, walkerProfileFor(species)]),
  ) as Record<WildlifeHabitatSpecies, TraversalProfile>;

/** The slice of the server's WorldApi this plugin actually reads. */
export interface HabitatWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  heightAt(x: number, y: number): number;
  isChunkUnlocked(cx: number, cy: number): boolean;
  isCellUnlocked(x: number, y: number): boolean;
  /**
   * Where the rivers and lakes are, per cell — supplied by core's WorldApi and
   * consumed by `shared/`'s traversal predicates, which read it off whatever
   * `TerrainSampler` they are handed.
   *
   * DECLARED HERE EVEN THOUGH `TerrainSampler.freshwater` IS OPTIONAL. Leaving
   * it out would still compile and would still work in the running server —
   * the concrete object passed in is the WorldApi, which has the property
   * regardless of what this interface says — but it would work by accident:
   * the rule would be live in production and silently absent from every test
   * that builds a stand-in world, which is the one place a rivers-vs-lakes
   * regression would otherwise be caught. Naming it makes the dependency
   * checked rather than incidental. Optional so a test may still omit it and
   * mean "this world has no fresh water".
   */
  readonly freshwater?: FreshwaterMap;
}

// WILDLIFE_POPULATION_CAP MOVED TO ../protocol.ts (2026-08-29): it is the cap
// the CLIENT half's draw budget is written against (part B of
// docs/plans/frame-budget-growth-and-draw-calls.md), and a client half may not
// import a plugin's server half. Re-exported here so every importer that had it
// from this module keeps working.
import { WILDLIFE_POPULATION_CAP } from '../protocol.ts';
export { WILDLIFE_POPULATION_CAP };

/**
 * Seconds between habitat censuses. Habitat only changes when terrain or the
 * unlock mask changes, both of which are human-paced, so a per-tick census
 * would be answering the same question 50 times over.
 *
 * COST, MEASURED (issue #268, 2026-09-01) — the previous note here claimed
 * "262 144 cells on a fully revealed 512² world, ~1 ms" and was stale on both
 * axes: worlds are 2048² now (4 194 304 cells over 16 384 chunks), and a full
 * scan of one measures **94.6 ms**, ~95% of a 100 ms tick, not 1 ms. The scan
 * is gone: ./census-index.ts holds per-chunk habitat counts and re-counts only
 * the chunks a sculpt or an unlock actually touched, so what runs on this
 * timer is an O(chunks) sum over cached counts (sub-millisecond) plus the
 * dirty chunks themselves. The interval stays at 5 s because it now bounds
 * how stale a population target may be, not how often the world is walked.
 */
export const HABITAT_CENSUS_INTERVAL_SECONDS = 5;

/**
 * Is this cell somewhere `species` may be? Three conditions, all required:
 * inside the world, inside unlocked territory, and the right habitat class.
 *
 * Used by spawning, by the movement look-ahead, and by the habitat-loss sweep —
 * one predicate, so those three can never disagree about what "valid" means.
 * That is the whole reason it lives here rather than being re-expressed at each
 * of the three call sites.
 */
export function isValidCellFor(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): boolean {
  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  // Bounds MUST be checked before isCellUnlocked: that call has no bounds
  // guard of its own and throws on an out-of-range chunk. sharedIsWalkableCell
  // repeats this same bounds test as part of its own bounds+ground check
  // below — harmless duplication, and the price of not having to expose a
  // bounds-only helper from shared for one caller.
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  // Unlock state is server/world-specific, not terrain math, so it stays
  // here rather than in the shared predicate — shared has no concept of a
  // mask.
  if (!world.isCellUnlocked(x, y)) return false;
  return sharedIsWalkableCell(world, walkerProfileOf(species), x, y);
}

/**
 * Can `species` walk in a straight line from (fromX, fromY) to (toX, toY)
 * without crossing a slope steeper than its own SpeciesProfile.
 * maxGradientPerCell (species.ts)?
 *
 * Separate from isValidCellFor ABOVE, on purpose: that predicate has no
 * "from" cell to compare against (spawning and the habitat-loss sweep pick
 * or lose a cell with nowhere to have walked from), so a gradient term
 * cannot live there without forcing a fake "from" on callers that have none.
 * This predicate is the "from" one: for the two callers that DO have a
 * previous position — the movement look-ahead probe and the per-tick
 * destination re-check, both in movement.ts — call both predicates.
 *
 * A THIN SPECIES → WALKER-PROFILE ADAPTER over shared's `canTraverseSegment`
 * (shared/src/traversal.ts) — the segment-sampled gradient math itself moved
 * there 2026-08-19 so pilgrims' land walkers can share it byte-for-byte
 * instead of carrying their own copy. See that function's own doc for the
 * "why sample the whole segment, not just the endpoints" argument.
 */
export function canTraverse(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  return canTraverseSegment(world, walkerProfileOf(species), fromX, fromY, toX, toY);
}

/**
 * How many of the eight compass directions this species could actually LEAVE
 * (cellX, cellY) along — its own body length of travel, ground and slope
 * sampled the whole way.
 *
 * WHY IT EXISTS (owner, 2026-08-24: grazers should "spawn in fairly flat
 * areas", and their "pathing [is] fixed so they don't get stuck"). Both halves
 * of that are the same missing question. `isValidCellFor` above asks only what
 * ONE cell is; it cannot tell a hillside from a one-cell pinnacle, because a
 * pinnacle's own cell is perfectly good dry land. A land walker placed on one
 * is stuck the moment it exists — every direction crosses a riser steeper than
 * LAND_WALKER_MAX_GRADIENT_PER_CELL — and no amount of steering can fix a
 * position that should never have been chosen.
 *
 * SO THIS IS A COUNT, NOT A PREDICATE, and the two callers read it at their own
 * thresholds (population.ts): spawning demands a MAJORITY of the compass, which
 * is what "fairly flat" means in the only units this simulation has; the
 * habitat sweep only despawns at ZERO, which is what "walled in" means. One
 * measurement, two decisions, and a wide gap between them so a creature that
 * merely walked somewhere snug is never culled for it.
 *
 * IT ASKS EXACTLY THE QUESTION STEERING ASKS, deliberately: the same eight
 * candidate headings the sweep tries (shared's AVOID_TURN_ATTEMPTS ×
 * AVOID_TURN_STEP_RADIANS), the same `canProceedAlong` along the probe, and the
 * same `isValidCellFor` veto at its far end. A direction this function calls
 * open is one `steerAvoiding` would accept, so "there is somewhere to go" and
 * "the mover will find it" cannot come apart.
 *
 * THE PROBE IS ONE BODY LENGTH — the species' own, unscaled. Shorter and a
 * ledge narrower than the animal itself reads as open ground; longer and a
 * perfectly walkable saddle reads as a wall. It is also the floor `movement.ts`
 * already uses for its look-ahead (`lookaheadCellsFor`), so the distance a
 * creature is placed against is the distance it will steer against.
 */
export function openDirectionCount(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): number {
  const profile = walkerProfileOf(species);
  const probeCells = profileOf(species).bodyLengthCells;
  let open = 0;

  for (let direction = 0; direction < AVOID_TURN_ATTEMPTS; direction++) {
    const heading = direction * AVOID_TURN_STEP_RADIANS;
    const toX = cellX + Math.cos(heading) * probeCells;
    const toY = cellY + Math.sin(heading) * probeCells;
    if (!canProceedAlong(world, profile, cellX, cellY, toX, toY)) continue;
    if (!isValidCellFor(world, species, toX, toY)) continue;
    open++;
  }

  return open;
}

/**
 * How many of the eight compass directions from (cellX, cellY) are steps a
 * PLAIN LAND WALKER could not take but `species` can — the measure of BROKEN
 * ground.
 *
 * WHY IT IS THE MIRROR OF `openDirectionCount` AND NOT ITS COMPLEMENT. The
 * complement of "open to me" is "closed to me", which counts the world's edge,
 * locked territory and the sea alongside the risers — every one of them a
 * direction this species cannot go, none of them the thing being asked about.
 * What the ibex's spawn rule wants (./species/ibex.ts) is ground that is
 * IMPASSABLE TO ORDINARY ANIMALS AND PASSABLE TO THIS ONE, which is a
 * difference between two profiles over the same direction, so both have to be
 * probed.
 *
 * The reference is shared's LAND_WALKER_PROFILE itself rather than another
 * species' row: "steep" means steeper than a legged animal on dry ground can
 * cross, which is a fact about the terrain contract (its gradient limit is half
 * the terrain's own relaxation cap), not about whichever species happens to sit
 * in the table today. A world with no grazer in it would still have risers.
 *
 * Same probe as `openDirectionCount` in every other respect — the same eight
 * headings, the same one-body-length distance, the same `isValidCellFor` veto
 * at the far end — so "steep" and "open" are answers to the same question asked
 * of two movers, and a direction can be neither (off the map) but never both.
 */
export function steepDirectionCount(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): number {
  const profile = walkerProfileOf(species);
  const probeCells = profileOf(species).bodyLengthCells;
  let steep = 0;

  for (let direction = 0; direction < AVOID_TURN_ATTEMPTS; direction++) {
    const heading = direction * AVOID_TURN_STEP_RADIANS;
    const toX = cellX + Math.cos(heading) * probeCells;
    const toY = cellY + Math.sin(heading) * probeCells;
    // Passable to an ordinary walker — then it is not broken ground, whatever
    // else it is.
    if (canProceedAlong(world, LAND_WALKER_PROFILE, cellX, cellY, toX, toY)) continue;
    if (!canProceedAlong(world, profile, cellX, cellY, toX, toY)) continue;
    if (!isValidCellFor(world, species, toX, toY)) continue;
    steep++;
  }

  return steep;
}

/**
 * Does the ground around (cellX, cellY) satisfy this species' spawn-ground rule
 * (species/profile.ts's `SpawnGround`)?
 *
 * THE ONE PLACE THE RULE IS INTERPRETED. Both placement call sites — the seed
 * cell and the scattered members of a group (population.ts) — ask this rather
 * than reading a threshold off the profile themselves, which is what makes
 * adding a THIRD reading of the eight-direction probe a change to one function
 * instead of a change to every caller that thought it knew what the field meant.
 */
export function satisfiesSpawnGround(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): boolean {
  const rule = profileOf(species).spawnGround;
  if (!spawnGroundConstrains(rule)) return true;
  return rule.kind === 'open'
    ? openDirectionCount(world, species, cellX, cellY) >= rule.minOpenDirections
    : steepDirectionCount(world, species, cellX, cellY) >= rule.minSteepDirections;
}

/**
 * Is the cell's own height inside this species' spawn window (species/
 * profile.ts's `SpawnHeights`)? Vacuously true for a species with none.
 *
 * THE ONE PLACE THE WINDOW IS INTERPRETED, for the same reason
 * `satisfiesSpawnGround` is: both placement call sites go through
 * population.ts's `canSettleAt`, which asks this and never reads the field
 * itself. One cell read — the cell the animal would stand on, floored the way
 * `isValidCellFor` floors it — where the ground-shape rule probes eight, which
 * is why the settle gate asks this one first.
 */
export function withinSpawnHeights(
  world: HabitatWorld,
  species: WildlifeHabitatSpecies,
  cellX: number,
  cellY: number,
): boolean {
  const heights = profileOf(species).spawnHeights;
  if (heights === SPAWN_AT_ANY_HEIGHT) return true;
  const height = world.heightAt(Math.floor(cellX), Math.floor(cellY));
  return height >= heights.minHeight && height < heights.maxHeightExclusive;
}

export interface Census {
  /** Habitat cells inside unlocked chunks, by class. */
  readonly cellsByHabitat: Readonly<Record<Habitat, number>>;
  /** The unlocked chunks themselves — the pool spawning samples from. */
  readonly chunks: ReadonlyArray<readonly [number, number]>;
}

/**
 * The habitat classes in their storage order — the one place the mapping from
 * `Habitat` to a slot in a counts array is decided. `census-index.ts` stores
 * three Int32 counts per chunk against these positions; `takeCensus` below
 * reads them back through the same table, so the cached and the scanned answer
 * cannot disagree about which number is which.
 */
export const HABITAT_CLASSES = ['land', 'shallow', 'deep'] as const;

/** How many counts one chunk's slice of a habitat-counts array holds. */
export const HABITAT_CLASS_COUNT = HABITAT_CLASSES.length;

/**
 * Which slot in a counts array each habitat class occupies. Exported so
 * `census-index.ts` can read a chunk's three counts back by name instead of by
 * a literal offset — the mapping is decided here, once.
 */
export const HABITAT_CLASS_SLOT: Readonly<Record<Habitat, number>> = {
  land: 0,
  shallow: 1,
  deep: 2,
};

/**
 * Classifies every cell of ONE chunk into `out[offset + slot]`, overwriting
 * whatever was there.
 *
 * THE SINGLE COUNTING LOOP in this plugin, deliberately (issue #268): the
 * incremental index re-counts a dirty chunk with this, and `takeCensus` below
 * scans a whole world with it, so "what the cache holds" and "what a full scan
 * would find" are the same arithmetic over the same cells in the same order —
 * which is the property the incremental census is only correct because of.
 *
 * The caller has already established that (cx, cy) is in range; this reads
 * `CHUNK_SIZE²` heights and nothing else.
 */
export function countChunkHabitat(
  world: HabitatWorld,
  cx: number,
  cy: number,
  out: Int32Array,
  offset: number,
): void {
  out[offset] = 0;
  out[offset + 1] = 0;
  out[offset + 2] = 0;

  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  for (let dy = 0; dy < CHUNK_SIZE; dy++) {
    for (let dx = 0; dx < CHUNK_SIZE; dx++) {
      out[offset + HABITAT_CLASS_SLOT[habitatOf(world.heightAt(baseX + dx, baseY + dy))]]++;
    }
  }
}

/**
 * Counts habitat cells and collects unlocked chunks in one pass — a FULL scan
 * of every unlocked cell.
 *
 * NOT THE PER-TICK PATH ANY MORE (issue #268). `population.ts` reconciles
 * through `census-index.ts`, which re-counts only dirty chunks; this stays as
 * the reference implementation that definition is checked against (the tests
 * and the equivalence bench both compare the two), and as the answer for any
 * caller that holds no index.
 */
export function takeCensus(world: HabitatWorld): Census {
  const cellsByHabitat: Record<Habitat, number> = { land: 0, shallow: 0, deep: 0 };
  const chunks: Array<readonly [number, number]> = [];
  const chunkCounts = new Int32Array(HABITAT_CLASS_COUNT);

  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      if (!world.isChunkUnlocked(cx, cy)) continue;
      chunks.push([cx, cy]);

      countChunkHabitat(world, cx, cy, chunkCounts, 0);
      for (let slot = 0; slot < HABITAT_CLASS_COUNT; slot++) {
        cellsByHabitat[HABITAT_CLASSES[slot]] += chunkCounts[slot];
      }
    }
  }

  return { cellsByHabitat, chunks };
}

/**
 * All-zero per-species counts, over the census-driven species only.
 *
 * DERIVED FROM THE SPECIES LIST, not typed out (2026-09-02). It used to be an
 * object literal of four names, which the compiler did check for completeness —
 * but only because the return type says so, and the failure it produces is four
 * unrelated type errors in the file a species was NOT added to. Built from
 * WILDLIFE_HABITAT_SPECIES, "every species starts at zero" is true by
 * construction and adding a row to the table is one edit.
 */
export function emptySpeciesCounts(): Record<WildlifeHabitatSpecies, number> {
  return Object.fromEntries(WILDLIFE_HABITAT_SPECIES.map((species) => [species, 0])) as Record<
    WildlifeHabitatSpecies,
    number
  >;
}

/**
 * Habitat area → per-species targets, then the global cap.
 *
 * The cap is applied by scaling every species down proportionally rather than by
 * truncating whichever species happened to be counted last: an ocean world that
 * asks for 260 fish should end up with a smaller but still correctly-shaped
 * ecosystem, not with the fish quota eating the whales.
 *
 * These are TARGETS, not a quota that gets filled on sight — population.ts
 * approaches them stochastically and lets creatures leave again, so the living
 * count sits a little under target and never stops moving.
 */
/**
 * The population a habitat gets the moment it is big enough to be a habitat at
 * all, regardless of what the density below would round to. A BREEDING PAIR.
 *
 * WHY THIS EXISTS (owner, 2026-08-23: "just substantially reduce the
 * requirements needed to spawn these things"). Every density in species.ts is
 * an area PER INDIVIDUAL calibrated against a fully-revealed half-land world —
 * a grazer wants 2 700 square world units — and the target is a floor division,
 * so any habitat smaller than one individual's share rounds to ZERO. That is
 * fine for the ocean a world starts as, and wrong for every world a player
 * actually builds: measured on the only sculpted world on this machine
 * (Frostwick Hollows, 2026-08-23), the island a player had raised came to 462
 * square world units of land — 17% of what the FIRST grazer costs. The hillside
 * was empty not because it was poor habitat but because it was not yet worth a
 * whole grazer's share of a world sixteen times its size.
 *
 * TWO, because that is the smallest number that is a population rather than a
 * curiosity, and because the ecology reads better: one animal alone on an
 * island is a stranded animal.
 *
 * A FLOOR RATHER THAN A CHEAPER DENSITY, deliberately, and this is the whole
 * design choice. Cutting `habitatCellsPerIndividual` far enough to put grazers
 * on a 462-unit island (roughly 90 units each, a thirtyfold cut) would ask for
 * ~1 456 of them on a fully-revealed world; WILDLIFE_POPULATION_CAP scales
 * every species down PROPORTIONALLY, so the sea would collapse from 72 fish to
 * six to pay for them. The complaint is entirely at the small end, so the fix
 * belongs entirely at the small end: below the threshold the density never
 * applied anyway, above it the density is already larger than this and wins.
 * Large worlds are bit-for-bit unchanged.
 */
export const FOUNDING_POPULATION = 2;

/**
 * The smallest habitat that gets a founding population at all, in CELLS.
 *
 * SIXTY-FOUR SQUARE WORLD UNITS — an 8×8-unit patch. Derived, not picked: the
 * largest-bodied land species is about one world unit long (species.ts's
 * grazer, `cellsAcross(1.1)`), so this is a territory roughly seven body
 * lengths across — enough that a pair can walk, turn and keep apart in it
 * rather than stand shoulder to shoulder. Anything smaller is a rock, and a
 * rock with two grazers welded to it is a worse bug than an empty hillside.
 *
 * ONE THRESHOLD FOR EVERY SPECIES, like the archetype resolution above: the
 * water species are smaller-bodied than the grazer, so a patch this size is
 * comfortable for all of them, and a per-species floor would be four numbers
 * expressing one idea. A future species that genuinely needs elbow room earns
 * its own field on the profile rather than a literal here.
 */
export const MIN_FOUNDING_HABITAT_CELLS = cellsOverArea(64);

export function targetsFor(
  cellsByHabitat: Readonly<Record<Habitat, number>>,
): Record<WildlifeHabitatSpecies, number> {
  const raw = emptySpeciesCounts();
  let total = 0;
  for (const species of WILDLIFE_HABITAT_SPECIES) {
    const profile = profileOf(species);
    const cells = cellsByHabitat[profile.habitat];
    const byDensity = Math.floor(cells / profile.habitatCellsPerIndividual);
    // The founding pair, for a habitat too small to be worth one individual's
    // share of a big world but big enough to live in. Never a REDUCTION: on any
    // habitat the density already fills, `byDensity` is the larger number and
    // this changes nothing.
    const count =
      cells >= MIN_FOUNDING_HABITAT_CELLS ? Math.max(byDensity, FOUNDING_POPULATION) : byDensity;
    raw[species] = count;
    total += count;
  }

  if (total <= WILDLIFE_POPULATION_CAP) return raw;

  const scale = WILDLIFE_POPULATION_CAP / total;
  const capped = emptySpeciesCounts();
  for (const species of WILDLIFE_HABITAT_SPECIES) capped[species] = Math.floor(raw[species] * scale);
  return capped;
}
