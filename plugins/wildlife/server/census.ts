// Reading the world: habitat validity for one cell, and the periodic area
// census that drives population targets.
//
// Everything here is a pure function of the world's current state — no mutable
// plugin state, no side effects — which is what lets the tests assert the
// population maths directly against a hand-built world.

import { CHUNK_SIZE } from '@terrace/shared';
import { WILDLIFE_SPECIES, type WildlifeSpecies } from '../protocol.ts';
import { type Habitat, habitatOf, profileOf } from './species.ts';

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
 * roughly 52 B per creature once msgpack has encoded the five keys and their
 * values, so:
 *
 *   150 × 52 B          = 7.8 KB per message
 *   × 5 Hz              = 39 KB/s  ≈ 312 kbit/s of steady downstream PER CLIENT
 *   × ~10 players       ≈ 3.1 Mbit/s of server upstream on wildlife alone
 *
 * (The 5 Hz cadence and why it is not 10 Hz are argued in server/index.ts.)
 * That is up from ~210 kbit/s per client at the old cap of 100 — still a
 * fraction of a modest home upstream, so the "roughly ten concurrent players
 * with room left for terrain diffs" figure survives the raise; it is what stops
 * the cap going higher. The cap is the dial to turn, and it is here.
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
  species: WildlifeSpecies,
  cellX: number,
  cellY: number,
): boolean {
  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return habitatOf(world.heightAt(x, y)) === profileOf(species).habitat;
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

/** All-zero per-species counts. */
export function emptySpeciesCounts(): Record<WildlifeSpecies, number> {
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
): Record<WildlifeSpecies, number> {
  const raw = emptySpeciesCounts();
  let total = 0;
  for (const species of WILDLIFE_SPECIES) {
    const profile = profileOf(species);
    const count = Math.floor(cellsByHabitat[profile.habitat] / profile.habitatCellsPerIndividual);
    raw[species] = count;
    total += count;
  }

  if (total <= WILDLIFE_POPULATION_CAP) return raw;

  const scale = WILDLIFE_POPULATION_CAP / total;
  const capped = emptySpeciesCounts();
  for (const species of WILDLIFE_SPECIES) capped[species] = Math.floor(raw[species] * scale);
  return capped;
}
