// What a brand-new world is made of.
//
// These tests exist because the failure they guard against is silent in exactly
// the same way the mask-filter ones are: a world whose seabed sits AT sea level
// looks fine — it renders, it sculpts, it saves — while having no water column
// at all, so anything that classifies water by depth has nothing to classify.
// That is how deep-water wildlife came to have nowhere to live (owner report,
// 2026-08-14). Genesis is now a stated profile — shelf, slope ring, open sea —
// and this is where it is stated in executable form.

import { BAND_HEIGHT, CHUNK_SIZE, MIN_HEIGHT, SEA_LEVEL, isWater } from '@terrace/shared';
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

  it('gives each region its own band, by Chebyshev distance from the shelf', () => {
    const world = World.createFresh(WORLD_SIZE);
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

    // Open sea: one cell past the ring, and the far corner of the world.
    expect(world.heightAt(shelfMaxCell + FRESH_SLOPE_WIDTH_CELLS + 1, centre)).toBe(
      FRESH_SEABED_HEIGHT,
    );
    expect(world.heightAt(0, 0)).toBe(FRESH_SEABED_HEIGHT);
    expect(world.heightAt(WORLD_SIZE - 1, WORLD_SIZE - 1)).toBe(FRESH_SEABED_HEIGHT);
  });

  it('holds exactly the three genesis heights and nothing else, everywhere', () => {
    const world = World.createFresh(WORLD_SIZE);
    const seen = new Set<number>();
    for (const height of world.map.cells) seen.add(height);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      [FRESH_SEABED_HEIGHT, FRESH_SLOPE_HEIGHT, FRESH_SHELF_HEIGHT].sort((a, b) => a - b),
    );
    expect(world.map.cells).toHaveLength(WORLD_SIZE * WORLD_SIZE);
  });

  it('is deterministic: two fresh worlds of a size are identical', () => {
    // No RNG in genesis. If one ever appears, snapshot round-trips and every
    // "expected height" in the suite become untestable, so pin it here.
    const a = World.createFresh(WORLD_SIZE);
    const b = World.createFresh(WORLD_SIZE);
    expect(Array.from(a.map.cells)).toEqual(Array.from(b.map.cells));
  });

  it('degrades to a one-chunk shelf on a world too small to divide', () => {
    // 128² is the smallest shipped configuration: 8×8 chunks, so the unlock
    // square is the whole world and the shelf is 8/FRESH_SHELF_SPAN_DIVISOR
    // chunks. The clamp only matters below that, and it must never produce a
    // zero-width shelf.
    const tiny = World.createFresh(CHUNK_SIZE * 2);
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

  it('costs one band-step per band of depth to reach dry land', () => {
    // The stated price of giving the ocean a volume, and the reason the shelf
    // exists: raising an island where the game starts you costs two sculpts,
    // out in the open sea it costs four. Asserted so both are on record.
    const stepsToDryLand = (height: number) =>
      Math.ceil((SEA_LEVEL + 1 - height) / BAND_HEIGHT);

    expect(stepsToDryLand(FRESH_SHELF_HEIGHT)).toBe(FRESH_SHELF_BANDS_BELOW_SEA + 1);
    expect(stepsToDryLand(FRESH_SEABED_HEIGHT)).toBe(FRESH_SEABED_BANDS_BELOW_SEA + 1);
  });

  it('keeps the starter unlock square unchanged', () => {
    // Genesis reads the unlock footprint; it must not move it. INITIAL_UNLOCK_
    // CHUNK_SPAN² chunks, centred, exactly as before.
    const { startChunk, spanChunks } = initialUnlockFootprint(WORLD_SIZE);
    expect(spanChunks).toBe(INITIAL_UNLOCK_CHUNK_SPAN);

    const world = World.createFresh(WORLD_SIZE);
    expect(world.isChunkUnlocked(startChunk, startChunk)).toBe(true);
    expect(world.isChunkUnlocked(startChunk - 1, startChunk)).toBe(false);
    expect(world.isChunkUnlocked(startChunk + spanChunks, startChunk)).toBe(false);
  });
});
