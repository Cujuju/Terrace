// Where a relic appears.
//
// The requirement is "an unlocked cell, mixing land and shore". The obvious
// implementation — build the list of every unlocked cell and pick one — is
// O(worldSize²) per spawn, which is 262 144 heightAt calls on a 512² world for
// a decision that has to be made every RELIC_RESPAWN_S. So this samples
// instead: pick a cell at random, reject it if it does not qualify, try again a
// bounded number of times. Bounded rejection sampling is O(1) in the world size
// and, unlike a scan, it does not need to be re-run when the mask changes.
//
// Nothing here is terrain math, so the determinism contract in CLAUDE.md does
// not apply (it governs shared/'s heightmap ops, which must agree bit for bit
// between server and client). Relic placement is server-only and is broadcast,
// never predicted. It is nonetheless driven by a SEEDED generator whose state
// is persisted, so a world's relic sequence is reproducible across a restart
// and in tests — which is worth far more than the entropy would be.

import { BAND_HEIGHT, SEA_LEVEL, createSeededRng } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';

/** The read-only slice of the world this module needs. Keeps stubs one-line. */
export type SpawnWorld = Pick<WorldApi, 'worldSize' | 'heightAt' | 'isCellUnlocked'>;

/**
 * Seed for a world that has never spawned a relic. Fixed rather than derived
 * from the clock: a self-hoster reporting "my relics all spawned in the sea"
 * should be reproducible, and the tests below need the same sequence every run.
 * The value itself is arbitrary; only its fixedness is load-bearing.
 */
export const RELIC_RNG_DEFAULT_SEED = 0x9e3779b9;

/**
 * How far either side of the waterline still counts as SHORE, in height units.
 * One terrace band: cells that render in the band immediately above or below
 * sea level, i.e. the beach a player actually sees as a beach.
 */
export const SHORE_HEIGHT_MARGIN = BAND_HEIGHT;

/** Total placement attempts before a spawn gives up for this round. */
export const RELIC_SPAWN_ATTEMPTS = 64;

/**
 * Of those, how many insist on the preferred terrain class before the search
 * relaxes to "any unlocked cell".
 *
 * The relaxation is NOT optional politeness — it is what stops a freshly
 * generated world from starving. A brand-new world is flat at height 0, so
 * every cell is shore and a relic that demanded land would exhaust its attempts
 * forever and never appear. Half the budget is spent being picky, half is spent
 * making sure something spawns.
 */
export const RELIC_PREFERRED_TERRAIN_ATTEMPTS = RELIC_SPAWN_ATTEMPTS / 2;

/** A seeded PRNG whose whole state is one uint32, so it persists trivially. */
export interface RelicRng {
  /** Next value in [0, 1). */
  next(): number;
  /** Current internal state, for the persistence slice. */
  state(): number;
}

/**
 * mulberry32 — 32 bits of state, uniform enough for picking cells, and short
 * enough to read. Chosen over Math.random because Math.random cannot be seeded
 * and therefore cannot be persisted or reproduced; chosen over anything larger
 * because a relic position does not need cryptographic or statistical rigour.
 *
 * IMPORTED FROM @terrace/shared since seven files carried the same eight lines.
 * The stream is unchanged, which is what the persisted seed needs.
 */
export function createRelicRng(seed: number): RelicRng {
  return createSeededRng(seed);
}

/** The two terrain flavours a relic can prefer. */
export type TerrainClass = 'land' | 'shore';

/** Classifies a height. Deep water is neither, and is never chosen. */
export function terrainClassOf(height: number): TerrainClass | null {
  if (height > SEA_LEVEL + SHORE_HEIGHT_MARGIN) return 'land';
  if (height >= SEA_LEVEL - SHORE_HEIGHT_MARGIN) return 'shore';
  // Below the shore margin is open sea: a gem down there would be under water,
  // unreachable-looking, and (past a chunk of depth) invisible from above.
  return null;
}

/**
 * Picks a cell for a relic, or null if the search found nothing.
 *
 * `occupied` holds the flat cell indices of relics already in the world, so two
 * relics never stack on the same cell and become one un-clickable gem.
 *
 * A null return is not an error: it happens when the unlocked region is tiny
 * and already crowded. The caller simply retries on a later tick.
 */
export function chooseRelicCell(
  world: SpawnWorld,
  rng: RelicRng,
  occupied: ReadonlySet<number>,
  preferred: TerrainClass,
): { x: number; y: number } | null {
  const size = world.worldSize;
  if (size <= 0) return null;

  for (let attempt = 0; attempt < RELIC_SPAWN_ATTEMPTS; attempt++) {
    const x = Math.floor(rng.next() * size);
    const y = Math.floor(rng.next() * size);
    // Guard against the 1-in-2³² case where next() returns something that
    // floors to `size`; an out-of-range cell would throw inside isCellUnlocked.
    if (x >= size || y >= size) continue;

    if (occupied.has(y * size + x)) continue;
    if (!world.isCellUnlocked(x, y)) continue;

    const terrain = terrainClassOf(world.heightAt(x, y));
    if (terrain === null) continue;
    if (attempt < RELIC_PREFERRED_TERRAIN_ATTEMPTS && terrain !== preferred) continue;

    return { x, y };
  }

  return null;
}
