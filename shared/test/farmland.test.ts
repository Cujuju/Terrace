// The farmland predicate's CONTRACT (src/farmland.ts, card 28).
//
// These live here rather than in a plugin because the predicate does. It has
// two consumers — structures' CA birth rule and flora's crop renderer — and it
// briefly shipped as two identical per-plugin copies; testing the contract once
// at the contract layer is the other half of collapsing them (the plugins keep
// only the tests that are about their OWN use of it: structures' isFlatEnough
// divergence proof and its hasNearbyFarmland neighbourhood, flora's crop
// survey).

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, SEA_LEVEL, isFarmlandCell, type FarmlandWorld } from '../src/index.ts';

const WORLD_SIZE = 64;

/** The band ordinary farmland sits on in the fixture below. */
const FARMLAND_BAND = 2;
/** Unambiguously water: ten bands under the sea, nowhere near band 0. */
const DEEP = SEA_LEVEL - 10 * BAND_HEIGHT;

/**
 * A DRY height strictly inside band 0, `fifth` fifths of the way up it.
 *
 * The (40,40) case needs four DISTINCT dry heights that nonetheless all share
 * band 0 with the waterline — that sharing is the whole point of the case. They
 * were the literals 5/10/15/20, which sat inside band 0 only while a band was
 * 64 units tall; re-terracing the world to 16 pushed 20 into band 1 and the
 * fixture stopped testing what it claimed to. Fifths of a band say the actual
 * requirement, and stay distinct for any BAND_HEIGHT the world can have.
 */
const dryInBand0 = (fifth: number): number => Math.floor((BAND_HEIGHT * fifth) / 5);

/**
 * One worked example carrying every case, so each assertion names a cell
 * rather than rebuilding a world:
 *
 *   (10,10) flat terrace with deep water at (11,10) — the accepting case.
 *   (20,20) flat and dry with no water anywhere near it.
 *   (30,30) touches water at (30,29) but its dry neighbour (29,30) is one
 *           band higher — flat-among-its-land fails.
 *   (40,40) the band-0 boundary: dry just above the sea, with water at EXACTLY
 *           SEA_LEVEL beside it. Both are band 0, so a band-match test alone
 *           would call that neighbour land; isWater must still win.
 *   (50,50) is itself water, ringed by otherwise-perfect dry neighbours.
 *
 * Everything unnamed is flat farmland-band ground, which is what makes the
 * off-map case (a cell on the world edge) testable without extra setup.
 */
function terrainAt(x: number, y: number): number {
  if (x === 11 && y === 10) return DEEP;

  if (x === 29 && y === 30) return (FARMLAND_BAND + 1) * BAND_HEIGHT;
  if (x === 30 && y === 29) return DEEP;

  if (x === 40 && y === 40) return dryInBand0(1);
  if (x === 39 && y === 40) return dryInBand0(2);
  if (x === 41 && y === 40) return SEA_LEVEL;
  if (x === 40 && y === 39) return dryInBand0(4);
  if (x === 40 && y === 41) return dryInBand0(3);

  if (x === 50 && y === 50) return SEA_LEVEL;
  if (x === 49 && y === 50) return dryInBand0(1);
  if (x === 51 && y === 50) return dryInBand0(1);
  if (x === 50 && y === 49) return dryInBand0(1);
  if (x === 50 && y === 51) return dryInBand0(1);

  return FARMLAND_BAND * BAND_HEIGHT;
}

function world(lockedCell?: (x: number, y: number) => boolean): FarmlandWorld {
  return {
    worldSize: WORLD_SIZE,
    heightAt: terrainAt,
    isCellUnlocked: (x, y) => (lockedCell === undefined ? true : !lockedCell(x, y)),
  };
}

describe('isFarmlandCell', () => {
  it('accepts a flat terrace edged by ordinary (deep) water', () => {
    expect(isFarmlandCell(world(), 10, 10)).toBe(true);
  });

  it('rejects flat, dry ground with no water neighbour anywhere', () => {
    expect(isFarmlandCell(world(), 20, 20)).toBe(false);
  });

  it('rejects a cell touching water that is not flat among its DRY neighbours', () => {
    expect(isFarmlandCell(world(), 30, 30)).toBe(false);
  });

  it('treats a water neighbour as the terrace edge, not a flatness violation', () => {
    // THE DELIBERATE DIVERGENCE from structures' isFlatEnough, stated as a
    // test: (10,10)'s water neighbour sits ten bands lower, which a
    // whole-neighbourhood band-match rule would reject outright. A terrace IS
    // a plateau that steps down to water at its edge, so it must be accepted —
    // see src/farmland.ts's header for the measurement showing the stricter
    // rule makes farmland vacuous on any world this game generates.
    expect(isFarmlandCell(world(), 10, 10)).toBe(true);
  });

  it('counts height exactly SEA_LEVEL as water even though it shares band 0 with the dry cell beside it', () => {
    expect(isFarmlandCell(world(), 40, 40)).toBe(true);
  });

  it('rejects a cell that is itself water, however farmland-like its neighbours look', () => {
    expect(isFarmlandCell(world(), 50, 50)).toBe(false);
  });

  it('rejects a cell whose neighbourhood runs off the world edge', () => {
    expect(isFarmlandCell(world(), 0, 10)).toBe(false);
    expect(isFarmlandCell(world(), WORLD_SIZE - 1, 10)).toBe(false);
  });

  it('rejects a cell outside the world entirely', () => {
    expect(isFarmlandCell(world(), -1, 10)).toBe(false);
    expect(isFarmlandCell(world(), WORLD_SIZE, 10)).toBe(false);
  });

  it('rejects non-integer coordinates rather than silently flooring them', () => {
    expect(isFarmlandCell(world(), 10.5, 10)).toBe(false);
    expect(isFarmlandCell(world(), 10, 10.5)).toBe(false);
  });

  it('requires the CELL ITSELF to be unlocked', () => {
    expect(isFarmlandCell(world((x, y) => x === 10 && y === 10), 10, 10)).toBe(false);
  });

  it('does NOT require its NEIGHBOURS to be unlocked', () => {
    // Mirrors isBuildableCell/isFlatEnough: gating on a neighbour's lock state
    // would let farmland eligibility flip based on territory a player has not
    // earned yet, which is a different fact than "is this ground farmable".
    expect(isFarmlandCell(world((x, y) => x === 11 && y === 10), 10, 10)).toBe(true);
  });

  it('is deterministic — the same world and cell answer identically every call', () => {
    const w = world();
    const first = isFarmlandCell(w, 10, 10);
    for (let i = 0; i < 100; i++) expect(isFarmlandCell(w, 10, 10)).toBe(first);
  });
});
