// What a brand-new world is made of.
//
// These tests exist because the failure they guard against is silent in exactly
// the same way the mask-filter ones are: a world whose seabed sits AT sea level
// looks fine — it renders, it sculpts, it saves — while having no water column
// at all, so anything that classifies water by depth has nothing to classify.
// That is how deep-water wildlife came to have nowhere to live (owner report,
// 2026-08-14). Genesis is now a stated profile — shelf, slope ring, seeded
// outer terrain — and this is where it is stated in executable form.
//
// 2026-08-18: genesis gained a random seed and a noise-based outer terrain (see
// the file-header comment in server/src/world/world.ts). The shelf and slope
// ring stay exactly what they were — the wildlife plugin's day-one census
// depends on that geometry, and this change's scope cannot touch plugins/ — so
// those tests are unchanged below. Everything that used to assert an exact,
// single flat "open sea" height now asserts the weaker, still load-bearing
// things: bounds, band-alignment, determinism from a seed, variation across
// seeds, and the hard deep-water guarantee.

import { BAND_HEIGHT, CHUNK_SIZE, MAX_HEIGHT, MIN_HEIGHT, SEA_LEVEL, isWater } from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import { INITIAL_UNLOCK_CHUNK_SPAN, initialUnlockFootprint } from '../src/world/initial-unlock.ts';
import {
  FRESH_SEABED_BANDS_BELOW_SEA,
  FRESH_SEABED_HEIGHT,
  FRESH_SHELF_BANDS_BELOW_SEA,
  FRESH_SHELF_HEIGHT,
  FRESH_SLOPE_BANDS_BELOW_SEA,
  FRESH_SLOPE_HEIGHT,
  FRESH_SLOPE_WIDTH_CELLS,
  World,
  freshGenesisProfile,
} from '../src/world/world.ts';
import { worldWithUnlockedChunks } from './support/harness.ts';

/** Big enough that shelf, slope and open sea all exist and none is clamped. */
const WORLD_SIZE = 256;

/**
 * A size with room outside the starter unlock square (128² at
 * INITIAL_UNLOCK_CHUNK_SPAN = 8, CHUNK_SIZE = 16), so tests that need
 * genuinely seed-varied outer terrain — as opposed to the starter square's
 * fixed, deep-clamped remainder — have somewhere to look.
 */
const WORLD_SIZE_WITH_OUTER_TERRAIN = 512;

/** Every valid world size the project ships: multiples of CHUNK_SIZE, 64..4096. */
const VALID_SIZES = [64, 80, 128, 144, 256, 512, 1024, 4096];

/** Small, fixed seeds so a failing assertion is easy to reproduce by hand. */
const SEEDS = Array.from({ length: 20 }, (_, i) => i * 104729 + 1); // 104729 is prime; just decorrelates the sequence

describe('the fresh-world genesis profile', () => {
  it('is three descending terraces, all water, inside the sculpt range', () => {
    expect(FRESH_SHELF_BANDS_BELOW_SEA).toBeLessThan(FRESH_SLOPE_BANDS_BELOW_SEA);
    expect(FRESH_SLOPE_BANDS_BELOW_SEA).toBeLessThan(FRESH_SEABED_BANDS_BELOW_SEA);

    for (const [bands, height] of [
      [FRESH_SHELF_BANDS_BELOW_SEA, FRESH_SHELF_HEIGHT],
      [FRESH_SLOPE_BANDS_BELOW_SEA, FRESH_SLOPE_HEIGHT],
      [FRESH_SEABED_BANDS_BELOW_SEA, FRESH_SEABED_HEIGHT],
    ] as const) {
      expect(Number.isInteger(bands)).toBe(true);
      expect(height).toBe(SEA_LEVEL - bands * BAND_HEIGHT);
      // Every genesis height is an exact band floor, so the terraced renderer
      // draws it without quantising anything away.
      expect(height % BAND_HEIGHT === 0).toBe(true);
      expect(isWater(height)).toBe(true);
      expect(height).toBeGreaterThan(MIN_HEIGHT);
    }
  });

  it('places the shelf concentric with, and strictly inside, the starter unlock square', () => {
    const { startChunk, spanChunks } = initialUnlockFootprint(WORLD_SIZE);
    const unlockMin = startChunk * CHUNK_SIZE;
    const unlockMax = unlockMin + spanChunks * CHUNK_SIZE - 1;
    const { shelfMinCell, shelfMaxCell } = freshGenesisProfile(WORLD_SIZE);

    // Inside the unlocked square: the census that drives habitat plugins only
    // counts unlocked cells, so a shelf outside it would be invisible to them.
    expect(shelfMinCell).toBeGreaterThan(unlockMin);
    expect(shelfMaxCell).toBeLessThan(unlockMax);
    // Concentric: equal margins on both sides.
    expect(shelfMinCell - unlockMin).toBe(unlockMax - shelfMaxCell);
    // And strictly smaller, or the open sea would have no room in the starter
    // region at all — which is the failure this whole profile exists to avoid.
    expect(shelfMaxCell - shelfMinCell).toBeLessThan(unlockMax - unlockMin);
  });

  it('gives the shelf and slope ring their own exact band, by Chebyshev distance from the shelf', () => {
    // Shelf and slope are UNCHANGED by the 2026-08-18 noise pass — the
    // wildlife plugin's day-one census depends on this exact geometry (see
    // plugins/wildlife/test/wildlife.test.ts), so pin it here the same way it
    // always was. Seeded explicitly (rather than left to the random default)
    // so a failure here is reproducible without re-running the suite.
    const world = World.createFresh(WORLD_SIZE, undefined, undefined, 1);
    const { shelfMinCell, shelfMaxCell } = freshGenesisProfile(WORLD_SIZE);
    const centre = Math.floor((shelfMinCell + shelfMaxCell) / 2);

    // Shelf: centre, an edge, and a CORNER — the corner is what a Euclidean
    // radius would have got wrong.
    expect(world.heightAt(centre, centre)).toBe(FRESH_SHELF_HEIGHT);
    expect(world.heightAt(shelfMinCell, centre)).toBe(FRESH_SHELF_HEIGHT);
    expect(world.heightAt(shelfMinCell, shelfMinCell)).toBe(FRESH_SHELF_HEIGHT);
    expect(world.heightAt(shelfMaxCell, shelfMaxCell)).toBe(FRESH_SHELF_HEIGHT);

    // Slope ring: the first cell outside the shelf, and the last one still in
    // the ring — the two cells that pin the ring's width exactly.
    expect(world.heightAt(shelfMinCell - 1, centre)).toBe(FRESH_SLOPE_HEIGHT);
    expect(world.heightAt(shelfMaxCell + FRESH_SLOPE_WIDTH_CELLS, centre)).toBe(FRESH_SLOPE_HEIGHT);
    expect(world.heightAt(shelfMinCell - 1, shelfMinCell - 1)).toBe(FRESH_SLOPE_HEIGHT);
  });

  it('keeps the rest of the starter square deep — at least as deep as the old fixed abyss — regardless of seed', () => {
    // Beyond the slope ring but still inside the starter square, height is no
    // longer pinned to exactly FRESH_SEABED_HEIGHT (outer terrain noise can
    // push it deeper for texture), but it can never come back up: the census
    // plugins/wildlife/test/wildlife.test.ts runs against this exact region
    // counts on every one of these cells classifying as deep water, always.
    const { shelfMinCell, shelfMaxCell } = freshGenesisProfile(WORLD_SIZE);
    const centre = Math.floor((shelfMinCell + shelfMaxCell) / 2);
    const justOutsideSlope = shelfMaxCell + FRESH_SLOPE_WIDTH_CELLS + 1;

    for (const seed of SEEDS.slice(0, 5)) {
      const world = World.createFresh(WORLD_SIZE, undefined, undefined, seed);
      expect(world.heightAt(justOutsideSlope, centre)).toBeLessThanOrEqual(FRESH_SEABED_HEIGHT);
    }
  });

  it('is deterministic: two fresh worlds from the same size and seed are identical', () => {
    const a = World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN, undefined, undefined, 42);
    const b = World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN, undefined, undefined, 42);
    expect(Array.from(a.map.cells)).toEqual(Array.from(b.map.cells));
  });

  it('varies with the seed: two fresh worlds from different seeds differ', () => {
    // A size with outer terrain to draw on: two arbitrary seeds are all but
    // certain to differ somewhere in that (much larger) region, so a single
    // fixed pair is a reliable, reproducible check here.
    const a = World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN, undefined, undefined, 1);
    const b = World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN, undefined, undefined, 2);
    expect(Array.from(a.map.cells)).not.toEqual(Array.from(b.map.cells));
  });

  it('varies with the seed even at the smallest shipped size — but only probabilistically', () => {
    // A 128² world IS the starter square, so its only seed-driven texture is
    // the deep-water clamp's "how much deeper than FRESH_SEABED_HEIGHT" — and
    // that clamp is a one-way ratchet (never shallower, see
    // freshGenesisHeightAt): whenever a seed's outer-terrain noise never dips
    // past the clamp anywhere on the map, the WHOLE starter square collapses
    // to the same flat FRESH_SEABED_HEIGHT plate as any other seed with the
    // same non-dipping property. That collapse is correct and load-bearing
    // (it's what keeps the wildlife census exact — see the file header), not
    // a bug, but it does mean any ONE fixed pair of seeds can legitimately
    // coincide at this size (two of the suite's own SEEDS did, before this
    // test was written to account for it). So this checks a wider sample —
    // several seeds, not just a pair — for at least one difference, the same
    // "don't trust a single roll" shape as the default-seed test above.
    const worlds = SEEDS.slice(0, 6).map((seed) =>
      Array.from(World.createFresh(128, undefined, undefined, seed).map.cells),
    );
    const allIdenticalToFirst = worlds.every((cells) => cells.every((h, i) => h === worlds[0][i]));
    expect(allIdenticalToFirst).toBe(false);
  });

  it('draws a fresh, non-reproducible seed when none is supplied', () => {
    // World.createFresh's default seed comes from Math.random via
    // drawGenesisSeed — the one intentionally non-deterministic call in
    // genesis (mirrors generateWorldName's own default). Any two default-
    // seeded worlds should essentially never collide, but "essentially never"
    // is still not zero for a single pair (two independent "calm" roughness
    // draws landing on the same rounded baseline — see the comment on
    // buildOuterTerrainLattice), so this compares several worlds rather than
    // trusting one pair: only ALL of them coinciding pairwise would produce a
    // false failure, which is astronomically less likely than any one pair.
    const worlds = Array.from({ length: 4 }, () =>
      Array.from(World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN).map.cells),
    );
    const allIdenticalToFirst = worlds.every((cells) =>
      cells.every((h, i) => h === worlds[0][i]),
    );
    expect(allIdenticalToFirst).toBe(false);
  });

  it('guarantees water at least as deep as FRESH_SEABED_HEIGHT, at every valid size, across many seeds', () => {
    // THE hard invariant this change must not regress: every generated world
    // has somewhere for deep-water wildlife to live. Enforced by construction
    // in World.createFresh (the starter-square clamp) and re-checked there at
    // runtime (throws if ever violated) — this test is the empirical half of
    // that guarantee, swept across sizes and seeds rather than trusted once.
    for (const size of [64, 80, 128, 256]) {
      for (const seed of SEEDS) {
        const world = World.createFresh(size, undefined, undefined, seed);
        let deepest = MAX_HEIGHT;
        for (const h of world.map.cells) if (h < deepest) deepest = h;
        expect(deepest).toBeLessThanOrEqual(FRESH_SEABED_HEIGHT);
      }
    }
  });

  it('keeps every height an integer, band-aligned, and inside [MIN_HEIGHT, MAX_HEIGHT]', () => {
    // A plain loop with one `expect` per world, not per cell: vitest's matcher
    // overhead per `expect()` call dominates at hundreds of thousands of
    // calls, so this scans in raw JS and only asserts a summary — the same
    // "keep the loop cheap, keep the assertion at the boundary" shape as the
    // deep-water sweep below.
    for (const size of [64, 144, 256]) {
      for (const seed of SEEDS.slice(0, 5)) {
        const world = World.createFresh(size, undefined, undefined, seed);
        let allValid = true;
        for (const h of world.map.cells) {
          // h % BAND_HEIGHT === 0, not `h % BAND_HEIGHT`: the remainder can be
          // -0 for a negative exact multiple, which is a fine boolean check
          // but a confusing thing to fold into a single "invalid heights"
          // count, so this stays a boolean AND rather than a magnitude.
          if (
            !Number.isInteger(h) ||
            h % BAND_HEIGHT !== 0 ||
            h < MIN_HEIGHT ||
            h > MAX_HEIGHT
          ) {
            allValid = false;
            break;
          }
        }
        expect(allValid).toBe(true);
      }
    }
  });

  it('accepts every valid world size without throwing', () => {
    // multiples of CHUNK_SIZE from 64 to 4096 — the documented valid range.
    // 4096 only at one seed; it is a 16M-cell sweep and this is a smoke test,
    // not the deep-water sweep above.
    for (const size of VALID_SIZES) {
      expect(size % CHUNK_SIZE).toBe(0);
      expect(() => World.createFresh(size, undefined, undefined, 7)).not.toThrow();
    }
  });

  it('still guarantees deep water on a world too small for the slope ring to fit at all', () => {
    // config.ts enforces no minimum WORLD_SIZE beyond "a positive multiple of
    // CHUNK_SIZE" — well below the documented valid range (64..4096) this
    // change is scoped to — and FRESH_SLOPE_WIDTH_CELLS is a fixed cell count,
    // so a small enough world lets shelf + slope ring cover every cell,
    // leaving nothing for the usual starter-square clamp to act on. A single
    // chunk (CHUNK_SIZE²) is the extreme case: the shelf alone is the whole
    // world. World.createFresh's fallback carve (see carveFallbackAbyss) must
    // still make the guarantee hold rather than throw.
    const single = World.createFresh(CHUNK_SIZE, undefined, undefined, 1);
    let deepest = MAX_HEIGHT;
    for (const h of single.map.cells) if (h < deepest) deepest = h;
    expect(deepest).toBeLessThanOrEqual(FRESH_SEABED_HEIGHT);
  });

  it('degrades to a one-chunk shelf on a world too small to divide', () => {
    // 128² is the smallest shipped configuration: 8×8 chunks, so the unlock
    // square is the whole world and the shelf is 8/FRESH_SHELF_SPAN_DIVISOR
    // chunks. The clamp only matters below that, and it must never produce a
    // zero-width shelf.
    const tiny = World.createFresh(CHUNK_SIZE * 2, undefined, undefined, 1);
    const { shelfMinCell, shelfMaxCell } = freshGenesisProfile(CHUNK_SIZE * 2);
    expect(shelfMaxCell - shelfMinCell + 1).toBeGreaterThanOrEqual(CHUNK_SIZE);
    expect(tiny.heightAt(shelfMinCell, shelfMinCell)).toBe(FRESH_SHELF_HEIGHT);
  });

  it('leaves a snapshot-restored world exactly as it was stored', () => {
    // Genesis is a property of world CREATION, not of the World class. A world
    // that came back from disk must be byte-identical to what was saved, or
    // every existing self-hosted world would silently gain a coastline on the
    // next restart.
    const stored = new Int16Array(WORLD_SIZE * WORLD_SIZE);
    stored.fill(SEA_LEVEL);
    stored[0] = BAND_HEIGHT;

    const restored = World.restore(WORLD_SIZE, stored, World.createFresh(WORLD_SIZE).mask);

    expect(restored.heightAt(0, 0)).toBe(BAND_HEIGHT);
    expect(restored.heightAt(1, 0)).toBe(SEA_LEVEL);
  });

  it('does not change the flat worlds the test harness builds', () => {
    // The harness fixtures stay pinned at 0 on purpose: tests that reason cell
    // by cell about sculpt arithmetic want a flat datum, not an ocean.
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    expect(world.heightAt(0, 0)).toBe(SEA_LEVEL);
  });

  it('costs one band-step per band of depth to reach dry land from the shelf', () => {
    // The stated price of giving the ocean a volume, and the reason the shelf
    // exists: raising an island where the game starts you costs two sculpts.
    // (Open sea now varies by seed, so only the fixed shelf figure is pinned
    // here — see the seabed sweep above for the depth guarantee that used to
    // anchor a matching "four sculpts in the open sea" figure.)
    const stepsToDryLand = (height: number) => Math.ceil((SEA_LEVEL + 1 - height) / BAND_HEIGHT);
    expect(stepsToDryLand(FRESH_SHELF_HEIGHT)).toBe(FRESH_SHELF_BANDS_BELOW_SEA + 1);
  });

  it('keeps the starter unlock square unchanged', () => {
    // Genesis reads the unlock footprint; it must not move it. INITIAL_UNLOCK_
    // CHUNK_SPAN² chunks, centred, exactly as before.
    const { startChunk, spanChunks } = initialUnlockFootprint(WORLD_SIZE);
    expect(spanChunks).toBe(INITIAL_UNLOCK_CHUNK_SPAN);

    const world = World.createFresh(WORLD_SIZE, undefined, undefined, 1);
    expect(world.isChunkUnlocked(startChunk, startChunk)).toBe(true);
    expect(world.isChunkUnlocked(startChunk - 1, startChunk)).toBe(false);
    expect(world.isChunkUnlocked(startChunk + spanChunks, startChunk)).toBe(false);
  });
});
