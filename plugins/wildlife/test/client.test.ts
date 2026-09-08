import { describe, expect, it } from 'vitest';
import { SEA_LEVEL, cellsAcross } from '@terrace/shared';
import {
  DEFAULT_SIZE_CLASS,
  DEFAULT_SIZE_CLASS_INDEX,
  WILDLIFE_SIZE_CLASSES,
  WILDLIFE_SIZE_MODEL_SCALE,
  WILDLIFE_SPECIES,
  parseEntitiesPayload,
  sizeClassAt,
  sizeClassIndex,
  type WildlifeEntityState,
} from '../protocol.ts';
import {
  DEFAULT_INTERPOLATION_SECONDS,
  MAX_INTERPOLATION_SECONDS,
  WildlifeInterpolator,
  lerpAngle,
} from '../client/interpolation.ts';
import {
  BIRD_ALTITUDE_HEADROOM_WORLD_UNITS,
  BIRD_FLIGHT_WORLD_Y,
  FLIGHT_ALTITUDES,
  MAX_TERRAIN_WORLD_Y,
  SEA_SURFACE_WORLD_Y,
  SWIM_PROFILES,
  UNKNOWN_TERRAIN_WORLD_Y,
  creatureWorldY,
  placementKindOf,
  WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES,
  WALKER_FOOTPRINT_HALF_EXTENT_CELLS_BY_SPECIES,
  walkerGroundY,
} from '../client/placement.ts';

function entity(
  id: number,
  overrides: Partial<WildlifeEntityState> = {},
): WildlifeEntityState {
  return {
    id,
    species: 'fish',
    x: 0,
    y: 0,
    heading: 0,
    size: DEFAULT_SIZE_CLASS_INDEX,
    climbHeight: null,
    falling: false,
    stance: null,
    ...overrides,
  };
}

describe('entities payload parsing', () => {
  it('accepts well-formed entries, defaults a missing or unknown size to medium, strips the school, and drops malformed entries individually', () => {
    const parsed = parseEntitiesPayload({
      entities: [
        { id: 3, species: 'whale', x: 1.25, y: -2.5, heading: 1.5, size: 0 },
        { id: 4, species: 'fish', x: 0, y: 0, heading: 0 },
        { id: 5, species: 'fish', x: 0, y: 0, heading: 0, size: 99 },
        { id: 6, species: 'fish', x: 0, y: 0, heading: 0, size: -1 },
        { id: 7, species: 'fish', x: 0, y: 0, heading: 0, size: 'big' },
        { id: 8, species: 'fish', x: 0, y: 0, heading: 0, size: 0, schoolId: 7 },
        null,
        { id: 1, species: 'dragon', x: 0, y: 0, heading: 0 },
        { id: 2, species: 'fish', x: NaN, y: 0, heading: 0 },
        { id: 9, species: 'fish', x: 0, y: 0 },
        { id: 10, species: 'grazer', x: 1, y: 2, heading: 0.5, size: 1 },
      ],
    });
    expect(parsed).toEqual([
      { id: 3, species: 'whale', x: 1.25, y: -2.5, heading: 1.5, size: 0, climbHeight: null, falling: false, stance: null },
      { id: 4, species: 'fish', x: 0, y: 0, heading: 0, size: DEFAULT_SIZE_CLASS_INDEX, climbHeight: null, falling: false, stance: null },
      { id: 5, species: 'fish', x: 0, y: 0, heading: 0, size: DEFAULT_SIZE_CLASS_INDEX, climbHeight: null, falling: false, stance: null },
      { id: 6, species: 'fish', x: 0, y: 0, heading: 0, size: DEFAULT_SIZE_CLASS_INDEX, climbHeight: null, falling: false, stance: null },
      { id: 7, species: 'fish', x: 0, y: 0, heading: 0, size: DEFAULT_SIZE_CLASS_INDEX, climbHeight: null, falling: false, stance: null },
      { id: 8, species: 'fish', x: 0, y: 0, heading: 0, size: 0, climbHeight: null, falling: false, stance: null },
      { id: 10, species: 'grazer', x: 1, y: 2, heading: 0.5, size: 1, climbHeight: null, falling: false, stance: null },
    ]);
    expect(sizeClassAt(DEFAULT_SIZE_CLASS_INDEX)).toBe(DEFAULT_SIZE_CLASS);
  });

  it('returns null when the payload is not an entity list at all', () => {
    for (const bad of [null, undefined, 7, 'x', {}, { entities: 5 }]) {
      expect(parseEntitiesPayload(bad)).toBeNull();
    }
  });
});

describe('size classes', () => {
  it('round-trips every class through its wire index, and orders the model scales smallest to largest', () => {
    for (const sizeClass of WILDLIFE_SIZE_CLASSES) {
      expect(sizeClassAt(sizeClassIndex(sizeClass))).toBe(sizeClass);
    }

    const scales = WILDLIFE_SIZE_CLASSES.map((sizeClass) => WILDLIFE_SIZE_MODEL_SCALE[sizeClass]);
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThan(scales[i - 1]);
  });

  it('keeps the largest fish inside its own swim clearance', () => {
    const FISH_AUTHORED_BODY_HEIGHT = 0.26;
    const largestHalfHeight = (FISH_AUTHORED_BODY_HEIGHT * WILDLIFE_SIZE_MODEL_SCALE.large) / 2;
    expect(largestHalfHeight).toBeLessThan(SWIM_PROFILES.fish!.minSubmergence);
    expect(largestHalfHeight).toBeLessThan(SWIM_PROFILES.fish!.minClearance);
  });
});

describe('lerpAngle', () => {
  it('takes the short way round the circle, and is exact at both ends', () => {
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    const half = lerpAngle(from, to, 0.5);
    expect(Math.abs(half - from)).toBeCloseTo((10 * Math.PI) / 180, 6);

    expect(lerpAngle(0.3, 1.2, 0)).toBeCloseTo(0.3, 10);
    expect(lerpAngle(0.3, 1.2, 1)).toBeCloseTo(1.2, 10);
  });
});

describe('WildlifeInterpolator', () => {
  it('places a newly seen creature where the server put it, walks between the last two states, clamps at the target, and never lerps the size class', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 0, y: 20, heading: 0.5, size: 0 })]);
    expect(interpolator.sample().get(1)).toMatchObject({ x: 0, y: 20, heading: 0.5 });

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([entity(1, { x: 10, y: 20, heading: 0.5, size: 0 })]);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(0, 6);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    const halfway = interpolator.sample().get(1);
    expect(halfway?.x).toBeCloseTo(5, 6);
    expect(halfway?.size).toBe(0);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(10, 6);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS * 5);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(10, 6);
    expect(interpolator.progress()).toBe(1);
  });

  it('starts each segment from the pose it was actually rendering', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([entity(1, { x: 10 })]);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(5, 6);
    interpolator.receive([entity(1, { x: 20 })]);

    expect(interpolator.sample().get(1)?.x).toBeCloseTo(5, 6);
  });

  it('never adopts a stalled gap as the interpolation window', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 0 })]);
    interpolator.advance(30);
    interpolator.receive([entity(1, { x: 10 })]);

    interpolator.advance(MAX_INTERPOLATION_SECONDS);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(10, 6);
  });

  it('drops creatures the server has stopped reporting, and forgets everything on clear', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1), entity(2)]);
    expect(interpolator.sample().size).toBe(2);

    interpolator.receive([entity(2)]);
    const sampled = interpolator.sample();
    expect(sampled.has(1)).toBe(false);
    expect(sampled.has(2)).toBe(true);

    interpolator.clear();
    expect(interpolator.sample().size).toBe(0);
  });
});

describe('vertical placement', () => {
  it('stands land species on the rendered ground, and on band 0 before the first snapshot arrives', () => {
    expect(creatureWorldY('grazer', 4, DEFAULT_SIZE_CLASS)).toBe(4);
    expect(creatureWorldY('grazer', -1.5, DEFAULT_SIZE_CLASS)).toBe(-1.5);
    expect(creatureWorldY('grazer', null, DEFAULT_SIZE_CLASS)).toBe(UNKNOWN_TERRAIN_WORLD_Y);
  });

  it('keeps every swimmer inside the water column, stacked surface → mid → seabed', () => {
    expect(SEA_SURFACE_WORLD_Y).toBe(SEA_LEVEL);
    expect(SEA_SURFACE_WORLD_Y).toBe(0);

    for (const seabedY of [-20, -8, -3, -1.5, -0.9]) {
      for (const species of ['fish', 'whale', 'deepsea'] as const) {
        const y = creatureWorldY(species, seabedY, DEFAULT_SIZE_CLASS);
        expect(y).toBeGreaterThanOrEqual(seabedY);
        expect(y).toBeLessThanOrEqual(SEA_SURFACE_WORLD_Y);
      }
    }

    const seabedY = -8;
    const fish = creatureWorldY('fish', seabedY, DEFAULT_SIZE_CLASS);
    const whale = creatureWorldY('whale', seabedY, DEFAULT_SIZE_CLASS);
    const deepsea = creatureWorldY('deepsea', seabedY, DEFAULT_SIZE_CLASS);
    expect(fish).toBeGreaterThan(whale);
    expect(whale).toBeGreaterThan(deepsea);
  });

  it('honours each species clearance when the water is deep enough, scaled by the creature size class', () => {
    const seabedY = -20;
    for (const species of ['fish', 'whale', 'deepsea'] as const) {
      const profile = SWIM_PROFILES[species];
      expect(profile).not.toBeNull();
      for (const sizeClass of WILDLIFE_SIZE_CLASSES) {
        const scale = WILDLIFE_SIZE_MODEL_SCALE[sizeClass];
        const y = creatureWorldY(species, seabedY, sizeClass);
        expect(y).toBeGreaterThanOrEqual(seabedY + profile!.minClearance * scale);
        expect(y).toBeLessThanOrEqual(SEA_SURFACE_WORLD_Y - profile!.minSubmergence * scale);
      }
    }
  });

  it('submerges a large creature deeper than a small one of the same species', () => {
    const seabedY = -2;
    const [small, , large] = WILDLIFE_SIZE_CLASSES;
    expect(creatureWorldY('fish', seabedY, large)).toBeLessThan(
      creatureWorldY('fish', seabedY, small),
    );
  });

  it('splits the difference when the water is too shallow for both clearances', () => {
    const seabedY = -1;
    expect(creatureWorldY('whale', seabedY, DEFAULT_SIZE_CLASS)).toBeCloseTo(-0.5, 6);
  });
});

describe('walkerGroundY — footprint sampling', () => {
  it('stands on the highest band the footprint overlaps, not the centre cell, and returns null only when every sample is null', () => {
    const sample = (cx: number) => (cx >= 10 ? 2 : 0);
    expect(walkerGroundY(sample, 9.8, 5.5, 'grazer')).toBe(2);
    expect(walkerGroundY(sample, 8.0, 5.5, 'grazer')).toBe(0);

    expect(walkerGroundY(() => null, 5, 5, 'grazer')).toBeNull();
    const halfNull = (cx: number) => (cx >= 5 ? 1 : null);
    expect(walkerGroundY(halfNull, 5.5, 5.5, 'grazer')).toBe(1);
  });

  it('probes the ground in CELLS, not in the world units the model is built in', () => {
    for (const species of WILDLIFE_SPECIES) {
      const worldUnits = WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES[species];
      const cells = WALKER_FOOTPRINT_HALF_EXTENT_CELLS_BY_SPECIES[species];
      expect(cells).toBe(worldUnits === null ? null : cellsAcross(worldUnits));
    }
    expect(WALKER_FOOTPRINT_HALF_EXTENT_CELLS_BY_SPECIES.grazer).toBeGreaterThan(0.5);
  });
});

describe('birds fly overhead', () => {
  it('clears the tallest terrain this game can contain, with named headroom, whatever the ground below it is doing', () => {
    expect(MAX_TERRAIN_WORLD_Y).toBe(16);
    expect(BIRD_FLIGHT_WORLD_Y).toBe(MAX_TERRAIN_WORLD_Y + BIRD_ALTITUDE_HEADROOM_WORLD_UNITS);
    expect(BIRD_ALTITUDE_HEADROOM_WORLD_UNITS).toBeGreaterThanOrEqual(MAX_TERRAIN_WORLD_Y / 2);

    for (const terrainY of [null, -20, 0, 4, MAX_TERRAIN_WORLD_Y]) {
      expect(creatureWorldY('bird', terrainY, DEFAULT_SIZE_CLASS)).toBe(BIRD_FLIGHT_WORLD_Y);
    }
  });

  it('classifies every species into exactly one placement kind', () => {
    expect(placementKindOf('bird')).toBe('flyer');
    for (const species of ['grazer', 'ibex', 'bison'] as const) {
      expect(placementKindOf(species)).toBe('walker');
    }
    for (const species of ['fish', 'whale', 'deepsea', 'ray', 'shark'] as const) {
      expect(placementKindOf(species)).toBe('swimmer');
    }
    for (const species of WILDLIFE_SPECIES) {
      const flies = FLIGHT_ALTITUDES[species] !== null;
      const swims = SWIM_PROFILES[species] !== null;
      expect(flies && swims).toBe(false);
    }
  });
});
