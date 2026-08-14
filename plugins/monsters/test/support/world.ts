// Test worlds with real terrain, and a deterministic random source.
//
// The shipped harness (server/test/support/harness.ts) only builds FLAT worlds,
// which are entirely shallow water — no deep basin, so no lair. This adds the
// two things the monsters plugin needs to be tested at all: a height field,
// built through the same World.restore path a snapshot uses, and a seeded
// generator so the summon roll is reproducible in CI.
//
// (The wildlife plugin's test support has the same world builder. It is copied
// rather than imported: a plugin's tests must not fail because a DIFFERENT
// plugin was uninstalled or refactored.)

import {
  chunkIndex,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  unlockChunk,
} from '@terrace/shared';
import { World } from '../../../../server/src/world/world.ts';

/**
 * Builds a world whose height at each cell comes from `heightOf`, with every
 * chunk unlocked unless `isChunkLocked` says otherwise.
 */
export function worldWithTerrain(
  size: number,
  heightOf: (x: number, y: number) => number,
  isChunkLocked: (cx: number, cy: number) => boolean = () => false,
): World {
  const map = createHeightmap(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      map.cells[y * size + x] = heightOf(x, y);
    }
  }

  const mask = createChunkMask(size);
  const chunkEdge = chunksPerEdge(size);
  for (let cy = 0; cy < chunkEdge; cy++) {
    for (let cx = 0; cx < chunkEdge; cx++) {
      if (isChunkLocked(cx, cy)) continue;
      unlockChunk(mask, chunkIndex(size, cx, cy));
    }
  }

  return World.restore(size, map.cells, mask);
}

/**
 * A seeded uniform generator, for tests that need the summon roll to behave like
 * randomness without being random.
 *
 * Mulberry32 — a 32-bit state PRNG with an avalanche finaliser. The obvious
 * alternative, a plain LCG, was tried first and REJECTED on measurement: the
 * summon gate compares against a probability of 4.2e-4 per tick, so the only
 * thing under test is the very top of the generator's output range, and an LCG's
 * lattice structure there skewed the measured mean wait to 1.5× the configured
 * one. Mulberry32's finaliser mixes the high bits, and the same measurement
 * lands within a few percent. Eight lines, no dependency (this repo asks before
 * adding one) and it is test-only — nothing in the plugin's own code path uses
 * it.
 */
export function seededRandom(seed: number): () => number {
  const UINT32_RANGE = 2 ** 32;
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
  };
}
