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
import { type Habitat, habitatOf, profileOf } from './species.ts';

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
 */
export function walkerProfileOf(species: WildlifeHabitatSpecies): TraversalProfile {
  const profile = profileOf(species);
  if (profile.habitat === 'land') return LAND_WALKER_PROFILE;
  return waterBandProfile(profile.habitat);
}

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

/**
 * Hard ceiling on living creatures, whatever the habitat census says.
 *
 * 850 is a bandwidth number, not an ecology one (100 → 150 on 2026-08-14 with
 * the density retune in species.ts; 150 → 850 on 2026-08-23). The full-state
 * broadcast costs roughly 58 B per creature once msgpack has encoded the six
 * keys and their values — 52 B for the original five, plus 6 B for the `size`
 * key and its single-byte class index (protocol.ts) — so:
 *
 *   850 × 58 B          = 48.1 KB per message
 *   × 5 Hz              = 240.7 KB/s ≈ 1.97 Mbit/s of steady downstream PER CLIENT
 *   × ~10 players       ≈ 19.7 Mbit/s of server upstream on wildlife alone
 *
 * (The 5 Hz cadence and why it is not 10 Hz are argued in server/index.ts.)
 *
 * WHY IT MOVED, AND WHAT IT COSTS (owner, 2026-08-23: "increase the wildlife
 * population cap and restore the numbers for fish, deep sea, and whales"). The
 * grazer density was cut 27-fold the same day (species.ts), which on a fully
 * revealed world takes the total ask from 270 to 1 532 — and because this cap
 * divides the budget PROPORTIONALLY, holding it at 150 would have paid for the
 * hillside out of the sea: 72 fish down to 12, 21 whales down to 3. 850 is the
 * number that leaves fish, deepsea and whales at exactly the counts they had
 * before the grazer cut (72 / 28 / 21); anything from 845 to 853 does, and 850
 * is the round one.
 *
 * THE HONEST PRICE is the table above: 348 kbit/s per client becomes 1.97
 * Mbit/s, and ten concurrent players now cost ~19.7 Mbit/s of upstream on
 * wildlife alone. That is no longer a fraction of a modest home connection, and
 * it is what stops this going higher — a self-hoster on domestic upstream is
 * the constraint, not the client's ability to render the creatures.
 *
 * IT STILL BINDS only on a fully revealed 512-unit world, which is a
 * hypothetical: every world that exists is ocean with an island, where the
 * total ask is a handful and this number is never reached. See species.ts's
 * header table and the exact assertion in wildlife.test.ts.
 *
 * SCOPE, since 2026-08-14: this caps the HABITAT population only. Birds are not
 * censused and do not consume it (server/flocks.ts); their own hard ceiling is
 * MAX_BIRDS_ALOFT, and the two together are what the broadcast actually costs.
 * The combined arithmetic lives in server/index.ts's header, in one place, so
 * there is a single answer to "what does a full message weigh".
 */
export const WILDLIFE_POPULATION_CAP = 850;

/**
 * Seconds between habitat censuses. The census walks every cell of every
 * unlocked chunk (262 144 cells on a fully revealed 512² world, ~1 ms), so it
 * must not run per tick; but habitat only changes when terrain or the unlock
 * mask changes, both of which are human-paced. 5 s is imperceptible for
 * population drift and costs on the order of 0.02% of a core.
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

export interface Census {
  /** Habitat cells inside unlocked chunks, by class. */
  readonly cellsByHabitat: Readonly<Record<Habitat, number>>;
  /** The unlocked chunks themselves — the pool spawning samples from. */
  readonly chunks: ReadonlyArray<readonly [number, number]>;
}

/** Counts habitat cells and collects unlocked chunks in one pass. */
export function takeCensus(world: HabitatWorld): Census {
  const cellsByHabitat: Record<Habitat, number> = { land: 0, shallow: 0, deep: 0 };
  const chunks: Array<readonly [number, number]> = [];

  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      if (!world.isChunkUnlocked(cx, cy)) continue;
      chunks.push([cx, cy]);

      const baseX = cx * CHUNK_SIZE;
      const baseY = cy * CHUNK_SIZE;
      for (let dy = 0; dy < CHUNK_SIZE; dy++) {
        for (let dx = 0; dx < CHUNK_SIZE; dx++) {
          cellsByHabitat[habitatOf(world.heightAt(baseX + dx, baseY + dy))]++;
        }
      }
    }
  }

  return { cellsByHabitat, chunks };
}

/** All-zero per-species counts, over the census-driven species only. */
export function emptySpeciesCounts(): Record<WildlifeHabitatSpecies, number> {
  return { fish: 0, whale: 0, deepsea: 0, grazer: 0 };
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
