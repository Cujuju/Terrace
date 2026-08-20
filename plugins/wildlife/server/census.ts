// Reading the world: habitat validity for one cell, and the periodic area
// census that drives population targets.
//
// Everything here is a pure function of the world's current state — no mutable
// plugin state, no side effects — which is what lets the tests assert the
// population maths directly against a hand-built world.

import {
  CHUNK_SIZE,
  canTraverseSegment,
  isWalkableCell as sharedIsWalkableCell,
  type WalkerProfile,
} from '@terrace/shared';
import { WILDLIFE_HABITAT_SPECIES, type WildlifeHabitatSpecies } from '../protocol.ts';
import { type Habitat, habitatOf, profileOf } from './species.ts';

/**
 * Adapts one species' SpeciesProfile onto the shared WalkerProfile shape
 * (shared/src/traversal.ts). `habitatOf`'s three-value `Habitat` union
 * ('land'/'shallow'/'deep') differs from shared's `TerrainGround`
 * ('dry'/'shallow'/'deep') by one name only — see species.ts's habitatOf doc
 * — so the one 'land' → 'dry' translation lives here, at the single seam
 * where a wildlife species profile crosses into the shared contract.
 */
function walkerProfileOf(species: WildlifeHabitatSpecies): WalkerProfile {
  const profile = profileOf(species);
  return {
    ground: profile.habitat === 'land' ? 'dry' : profile.habitat,
    maxGradientPerCell: profile.maxGradientPerCell,
  };
}

/** The slice of the server's WorldApi this plugin actually reads. */
export interface HabitatWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  heightAt(x: number, y: number): number;
  isChunkUnlocked(cx: number, cy: number): boolean;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * Hard ceiling on living creatures, whatever the habitat census says.
 *
 * 150 is a bandwidth number, not an ecology one (raised from 100 on 2026-08-14
 * with the density retune in species.ts). The full-state broadcast costs
 * roughly 58 B per creature once msgpack has encoded the six keys and their
 * values — 52 B for the original five, plus 6 B for the `size` key and its
 * single-byte class index (protocol.ts) — so:
 *
 *   150 × 58 B          = 8.7 KB per message
 *   × 5 Hz              = 43.5 KB/s ≈ 348 kbit/s of steady downstream PER CLIENT
 *   × ~10 players       ≈ 3.5 Mbit/s of server upstream on wildlife alone
 *
 * (The 5 Hz cadence and why it is not 10 Hz are argued in server/index.ts.)
 * That is up from ~210 kbit/s per client at the old cap of 100 — still a
 * fraction of a modest home upstream, so the "roughly ten concurrent players
 * with room left for terrain diffs" figure survives the raise; it is what stops
 * the cap going higher. The cap is the dial to turn, and it is here.
 *
 * It now BINDS on a fully revealed 512² world (the densities ask for 246 there,
 * see species.ts), which is the accepted cost of enough fish to see schools.
 *
 * SCOPE, since 2026-08-14: this caps the HABITAT population only. Birds are not
 * censused and do not consume it (server/flocks.ts); their own hard ceiling is
 * MAX_BIRDS_ALOFT, and the two together are what the broadcast actually costs.
 * The combined arithmetic lives in server/index.ts's header, in one place, so
 * there is a single answer to "what does a full message weigh".
 */
export const WILDLIFE_POPULATION_CAP = 150;

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
export function targetsFor(
  cellsByHabitat: Readonly<Record<Habitat, number>>,
): Record<WildlifeHabitatSpecies, number> {
  const raw = emptySpeciesCounts();
  let total = 0;
  for (const species of WILDLIFE_HABITAT_SPECIES) {
    const profile = profileOf(species);
    const count = Math.floor(cellsByHabitat[profile.habitat] / profile.habitatCellsPerIndividual);
    raw[species] = count;
    total += count;
  }

  if (total <= WILDLIFE_POPULATION_CAP) return raw;

  const scale = WILDLIFE_POPULATION_CAP / total;
  const capped = emptySpeciesCounts();
  for (const species of WILDLIFE_HABITAT_SPECIES) capped[species] = Math.floor(raw[species] * scale);
  return capped;
}
