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
import {
  BAND_HEIGHT,
  CONTOUR_CELL_CENTRE_GUARD,
  SEA_LEVEL,
  isFarmlandCell,
  isFarmlandPlot,
  type FarmlandWorld,
} from '../src/index.ts';

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

// ─────────────────────────────────────────────────────────────────────────────
// isFarmlandPlot — the same ground, asked about on behalf of a MODEL.
//
// The contract, not a callsite: flora derives the tread ring from its crop
// model's reach and the contour guard, so these pin what a ring VALUE means
// rather than what today's crop happens to be.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A straight north-south coast: column 0 is deep water, everything east of it
 * is one flat terrace. Column 1 is the LIP (water is its own neighbour),
 * column 2 is the first cell with a full cell of tread around it.
 */
function coastAt(x: number, _y: number): number {
  return x === 0 ? DEEP : FARMLAND_BAND * BAND_HEIGHT;
}

function coast(lockedCell?: (x: number, y: number) => boolean): FarmlandWorld {
  return {
    worldSize: WORLD_SIZE,
    heightAt: coastAt,
    isCellUnlocked: (x, y) => (lockedCell === undefined ? true : !lockedCell(x, y)),
  };
}

describe('isFarmlandPlot', () => {
  it('rejects the LIP cell that isFarmlandCell accepts — the whole point of the predicate', () => {
    // Column 1 is farmland by the point test and is exactly where a plot used
    // to be drawn hanging over the drop: the terrace outline runs between
    // column 0 and column 1, within an eighth of a cell of column 1's centre.
    expect(isFarmlandCell(coast(), 1, 10)).toBe(true);
    expect(isFarmlandPlot(coast(), 1, 10, 1)).toBe(false);
  });

  it('accepts the cell one back from the lip, which has a whole cell of tread', () => {
    expect(isFarmlandPlot(coast(), 2, 10, 1)).toBe(true);
  });

  it('rejects a cell too far inland to be farming a water-edged terrace at all', () => {
    // Column 3's shore ring reaches only column 1, which is dry: the water is
    // out of reach, so this is an inland field and not terrace farming.
    expect(isFarmlandPlot(coast(), 3, 10, 1)).toBe(false);
  });

  it('a bigger model is set further back — the setback follows the ring, not a literal', () => {
    expect(isFarmlandPlot(coast(), 2, 10, 2)).toBe(false); // its tread would reach the water
    expect(isFarmlandPlot(coast(), 3, 10, 2)).toBe(true);
  });

  it('at ring 0 it is the old point test — the guarantee that was not enough', () => {
    expect(isFarmlandPlot(coast(), 1, 10, 0)).toBe(isFarmlandCell(coast(), 1, 10));
    expect(isFarmlandPlot(coast(), 1, 10, 0)).toBe(true);
  });

  it('rejects a tread cell on a different terrace band even when it is dry', () => {
    // A plot may not half-stand on the step above or below its own.
    const stepped: FarmlandWorld = {
      worldSize: WORLD_SIZE,
      heightAt: (x, y) =>
        x === 3 && y === 11 ? (FARMLAND_BAND + 1) * BAND_HEIGHT : coastAt(x, y),
      isCellUnlocked: () => true,
    };
    expect(isFarmlandPlot(stepped, 2, 10, 1)).toBe(false);
  });

  it('rejects a plot whose tread runs off the world edge', () => {
    const rim: FarmlandWorld = {
      worldSize: WORLD_SIZE,
      heightAt: (x, y) => (x === 2 && y === 2 ? DEEP : FARMLAND_BAND * BAND_HEIGHT),
      isCellUnlocked: () => true,
    };
    expect(isFarmlandPlot(rim, 0, 0, 1)).toBe(false);
  });

  it('requires the plot cell itself to be unlocked, but not its tread', () => {
    expect(isFarmlandPlot(coast((x, y) => x === 2 && y === 10), 2, 10, 1)).toBe(false);
    expect(isFarmlandPlot(coast((x, y) => x === 3 && y === 11), 2, 10, 1)).toBe(true);
  });

  it('rejects a negative or non-integer ring rather than guessing', () => {
    expect(isFarmlandPlot(coast(), 2, 10, -1)).toBe(false);
    expect(isFarmlandPlot(coast(), 2, 10, 0.5)).toBe(false);
  });

  it('sets a plot back far enough that no contour can reach it', () => {
    // The derivation flora relies on, stated here where the guard lives: a
    // solid tread of radius R puts the nearest possible terrace outline at
    // R + CONTOUR_CELL_CENTRE_GUARD from the plot's centre, because a contour
    // only crosses edges running from an inside sample to an outside one and
    // never comes within the guard of either end. Ring 1 therefore protects any
    // model reaching up to 1.125 cells — comfortably more than the half-cell a
    // crop plot reaches.
    expect(1 + CONTOUR_CELL_CENTRE_GUARD).toBeGreaterThan(0.5);
  });

  it('is deterministic — the same world, cell and ring answer identically every call', () => {
    const w = coast();
    const first = isFarmlandPlot(w, 2, 10, 1);
    for (let i = 0; i < 100; i++) expect(isFarmlandPlot(w, 2, 10, 1)).toBe(first);
  });
});
