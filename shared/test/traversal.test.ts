import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  DEEP_WATER_MAX_HEIGHT,
  AMPHIBIOUS_WALKER_PROFILE,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  LAND_WALKER_MIN_GROUND_HEIGHT,
  LAND_WALKER_PROFILE,
  OPEN_WATER_PROFILE,
  RIVER_FORDING_WALKER_PROFILE,
  UNCONSTRAINED_MAX_GROUND_HEIGHT,
  findRoute,
  navigableWaterProfile,
  SEA_LEVEL,
  UNCONSTRAINED_GRADIENT_PER_CELL,
  canTraverseSegment,
  groundOf,
  isWalkableCell,
  withClearance,
  type TerrainSampler,
  type TraversalProfile,
  waterBandProfile,
} from '../src/index.ts';

const LAND: TraversalProfile = LAND_WALKER_PROFILE;
const WATER: TraversalProfile = waterBandProfile('deep');

/** A world whose height is a pure function of x (uniform along y). */
function fakeWorld(heightAtX: (x: number) => number, worldSize = 40): TerrainSampler {
  return { worldSize, heightAt: (x) => heightAtX(x) };
}

describe('groundOf', () => {
  it('classifies dry / shallow / deep exhaustively and disjointly', () => {
    expect(groundOf(SEA_LEVEL + 1)).toBe('dry');
    expect(groundOf(SEA_LEVEL)).toBe('shallow');
    expect(groundOf(DEEP_WATER_MAX_HEIGHT + 1)).toBe('shallow');
    expect(groundOf(DEEP_WATER_MAX_HEIGHT)).toBe('deep');
    expect(groundOf(DEEP_WATER_MAX_HEIGHT - 1)).toBe('deep');
  });
});

describe('isWalkableCell', () => {
  it('rejects world edges and the wrong ground class', () => {
    const world = fakeWorld((x) => (x < 2 ? SEA_LEVEL - BAND_HEIGHT : 2 * BAND_HEIGHT), 40);
    expect(isWalkableCell(world, LAND, 20, 20)).toBe(true);
    expect(isWalkableCell(world, LAND, 0, 20)).toBe(false); // water, wrong ground
    expect(isWalkableCell(world, LAND, -1, 20)).toBe(false); // off-world
    expect(isWalkableCell(world, LAND, 20, 1000)).toBe(false); // off-world
  });
});

describe('canTraverseSegment (gradient-limited, segment-sampled)', () => {
  function riserWorld(riseUnits: number): TerrainSampler {
    const belowHeight = SEA_LEVEL + BAND_HEIGHT;
    return fakeWorld((x) => (x < 10 ? belowHeight : belowHeight + riseUnits));
  }

  it('rejects a riser step that exceeds the profile limit', () => {
    const world = riserWorld(LAND_WALKER_MAX_GRADIENT_PER_CELL + 1);
    expect(canTraverseSegment(world, LAND, 9.5, 5, 10.5, 5)).toBe(false);
  });

  it('accepts a ramp step at exactly the limit', () => {
    const world = riserWorld(LAND_WALKER_MAX_GRADIENT_PER_CELL);
    expect(canTraverseSegment(world, LAND, 9.5, 5, 10.5, 5)).toBe(true);
  });

  it('rejects a mid-path riser even when both endpoints share a height', () => {
    // x=0 and x=2 are the SAME height; the drop is entirely inside the
    // segment, at x=1. An endpoint-only check would miss it.
    const plateauHeight = SEA_LEVEL + BAND_HEIGHT;
    const gorgeHeight = plateauHeight - (LAND_WALKER_MAX_GRADIENT_PER_CELL + 1);
    const world = fakeWorld((x) => (x >= 1 && x < 2 ? gorgeHeight : plateauHeight));
    expect(canTraverseSegment(world, LAND, 0.5, 5, 2.5, 5)).toBe(false);
  });

  it('is unconstrained for a water-ground profile regardless of gradient', () => {
    expect(UNCONSTRAINED_GRADIENT_PER_CELL).toBe(Infinity);
    const shallowFloor = SEA_LEVEL - 10;
    const world = fakeWorld((x) => (x < 10 ? shallowFloor : shallowFloor - 100));
    expect(canTraverseSegment(world, WATER, 9.5, 5, 10.5, 5)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The axes added 2026-08-20 (owner: "certain rules for different objects as to
// what they should and should not go around"). See src/traversal.ts's header.
// ─────────────────────────────────────────────────────────────────────────────

describe('minGroundHeight — the band-0 waterline fringe', () => {
  /** Dry by the settled rule (height > SEA_LEVEL), but inside band 0, so the
   *  renderer draws it AT the waterline underneath the sea plane. */
  const FRINGE = SEA_LEVEL + 1;
  const REAL_LAND = LAND_WALKER_MIN_GROUND_HEIGHT;

  it('classifies the fringe as dry, because it IS dry (design record Q3)', () => {
    expect(groundOf(FRINGE)).toBe('dry');
  });

  it('keeps a land walker off it anyway — it does not read as land', () => {
    const world = fakeWorld((x) => (x < 10 ? FRINGE : REAL_LAND));
    expect(isWalkableCell(world, LAND_WALKER_PROFILE, 5, 5)).toBe(false);
    expect(isWalkableCell(world, LAND_WALKER_PROFILE, 15, 5)).toBe(true);
  });

  it('does not constrain anything whose ground is water anyway', () => {
    const world = fakeWorld(() => DEEP_WATER_MAX_HEIGHT);
    expect(isWalkableCell(world, waterBandProfile('deep'), 5, 5)).toBe(true);
    expect(isWalkableCell(world, AMPHIBIOUS_WALKER_PROFILE, 5, 5)).toBe(true);
  });

  it('lets an amphibious walker stand on the fringe, which is the point of it', () => {
    const world = fakeWorld(() => FRINGE);
    expect(isWalkableCell(world, LAND_WALKER_PROFILE, 5, 5)).toBe(false);
    expect(isWalkableCell(world, AMPHIBIOUS_WALKER_PROFILE, 5, 5)).toBe(true);
  });
});

describe('the freshwater axis — rivers vs lakes', () => {
  /** Dry land at every cell, with a river channel at x = 5 and a lake at x = 6. */
  function riverineWorld(): TerrainSampler {
    return {
      ...fakeWorld(() => LAND_WALKER_MIN_GROUND_HEIGHT),
      freshwater: {
        at: (x: number) => (x === 5 ? 'channel' : x === 6 ? 'pool' : 'none'),
      },
    };
  }

  it('a land walker goes around both — a river is a river', () => {
    const world = riverineWorld();
    expect(isWalkableCell(world, LAND_WALKER_PROFILE, 4, 0)).toBe(true);
    expect(isWalkableCell(world, LAND_WALKER_PROFILE, 5, 0)).toBe(false);
    expect(isWalkableCell(world, LAND_WALKER_PROFILE, 6, 0)).toBe(false);
  });

  it('a river-fording walker crosses the channel but not the lake', () => {
    const world = riverineWorld();
    expect(isWalkableCell(world, RIVER_FORDING_WALKER_PROFILE, 5, 0)).toBe(true);
    expect(isWalkableCell(world, RIVER_FORDING_WALKER_PROFILE, 6, 0)).toBe(false);
  });

  it('an amphibious walker crosses both', () => {
    const world = riverineWorld();
    expect(isWalkableCell(world, AMPHIBIOUS_WALKER_PROFILE, 5, 0)).toBe(true);
    expect(isWalkableCell(world, AMPHIBIOUS_WALKER_PROFILE, 6, 0)).toBe(true);
  });

  it('is vacuous in a world that supplies no freshwater map', () => {
    // The whole point of the axis being optional: every pre-existing caller
    // keeps its previous answers rather than needing a migration.
    const world = fakeWorld(() => LAND_WALKER_MIN_GROUND_HEIGHT);
    expect(isWalkableCell(world, LAND_WALKER_PROFILE, 5, 0)).toBe(true);
    expect(isWalkableCell(world, RIVER_FORDING_WALKER_PROFILE, 5, 0)).toBe(true);
  });
});

describe('the archetypes', () => {
  it('routes a land walker AROUND a lake that splits its ground', () => {
    // A wall of standing water across the middle, with a gap at y = 0.
    const world: TerrainSampler = {
      worldSize: 12,
      heightAt: () => LAND_WALKER_MIN_GROUND_HEIGHT,
      freshwater: { at: (x, y) => (x === 5 && y > 0 ? 'pool' : 'none') },
    };
    const around = findRoute(world, LAND_WALKER_PROFILE, { x: 2, y: 5 }, { x: 8, y: 5 });
    expect(around).not.toBeNull();
    // Every cell it chose is out of the water, and it had to go up to the gap.
    for (const cell of around!.cells) expect(world.freshwater!.at(cell.x, cell.y)).toBe('none');
    expect(Math.min(...around!.cells.map((c) => c.y))).toBe(0);

    // The amphibious archetype walks straight across the same lake.
    const through = findRoute(world, AMPHIBIOUS_WALKER_PROFILE, { x: 2, y: 5 }, { x: 8, y: 5 });
    expect(through!.cells.every((c) => c.y === 5)).toBe(true);
  });

  it('gives boats the whole sea and nothing but', () => {
    expect(OPEN_WATER_PROFILE.grounds).toEqual(['shallow', 'deep']);
    const world = fakeWorld((x) => (x < 10 ? DEEP_WATER_MAX_HEIGHT : LAND_WALKER_MIN_GROUND_HEIGHT));
    expect(isWalkableCell(world, OPEN_WATER_PROFILE, 5, 5)).toBe(true);
    expect(isWalkableCell(world, OPEN_WATER_PROFILE, 15, 5)).toBe(false);
  });
});

describe('navigableWaterProfile — hull draft as a ceiling on ground', () => {
  it('rejects ground shallower than the keel and accepts ground at it, while open water accepts both', () => {
    // Both heights are shallow water by class; only the ceiling separates them.
    const DRAFT = 10;
    const profile = navigableWaterProfile(DRAFT);
    expect(UNCONSTRAINED_MAX_GROUND_HEIGHT).toBeGreaterThan(SEA_LEVEL);
    const keel = SEA_LEVEL - DRAFT;
    const world = fakeWorld((x) => (x < 10 ? keel + 1 : keel));
    expect(isWalkableCell(world, profile, 5, 5)).toBe(false); // one unit above the keel
    expect(isWalkableCell(world, profile, 15, 5)).toBe(true); // exactly at the keel
    expect(isWalkableCell(world, OPEN_WATER_PROFILE, 5, 5)).toBe(true);
    expect(isWalkableCell(world, OPEN_WATER_PROFILE, 15, 5)).toBe(true);
  });
});

describe('withClearance — the eroded sampler', () => {
  it('dilates one dry cell by its radius, and returns the world itself at radius 0', () => {
    const world: TerrainSampler = {
      worldSize: 16,
      heightAt: (x, y) =>
        Math.floor(x) === 5 && Math.floor(y) === 5 ? BAND_HEIGHT : DEEP_WATER_MAX_HEIGHT,
    };
    const eroded = withClearance(world, 1);
    // The disc over an orthogonally adjacent water cell still covers the dry
    // cell, so its max height reads dry ...
    expect(groundOf(eroded.heightAt(6, 5))).toBe('dry');
    // ... while a cell two away is outside the disc and stays deep water.
    expect(groundOf(eroded.heightAt(7, 5))).toBe('deep');
    expect(withClearance(world, 0)).toBe(world);
  });
});
