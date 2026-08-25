// The client half's PURE logic: payload validation, interpolation, and vertical
// placement. Rendering is verified by eye per design §8 ("no headless GL rig"),
// so nothing here imports three — which is also what lets this run in the same
// node environment as the server tests.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, MAX_HEIGHT, SEA_LEVEL, cellsAcross } from '@terrace/shared';
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
  WALKER_FOOTPRINT_HALF_EXTENT,
  WALKER_FOOTPRINT_HALF_EXTENT_CELLS,
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
    ...overrides,
  };
}

describe('entities payload parsing', () => {
  it('accepts a well-formed payload', () => {
    const parsed = parseEntitiesPayload({
      entities: [{ id: 3, species: 'whale', x: 1.25, y: -2.5, heading: 1.5, size: 0 }],
    });
    expect(parsed).toEqual([
      { id: 3, species: 'whale', x: 1.25, y: -2.5, heading: 1.5, size: 0 },
    ]);
  });

  it('reads a payload from a server that predates size classes as medium', () => {
    // Version skew is ordinary for a self-hoster: an old server omits the field
    // entirely, and the right answer is "ordinary medium creatures", never
    // "drop the whole population".
    const parsed = parseEntitiesPayload({
      entities: [{ id: 3, species: 'fish', x: 0, y: 0, heading: 0 }],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].size).toBe(DEFAULT_SIZE_CLASS_INDEX);
    expect(sizeClassAt(parsed![0].size)).toBe(DEFAULT_SIZE_CLASS);
  });

  it('falls back to the default class for a size index it does not know', () => {
    const parsed = parseEntitiesPayload({
      entities: [
        { id: 1, species: 'fish', x: 0, y: 0, heading: 0, size: 99 },
        { id: 2, species: 'fish', x: 0, y: 0, heading: 0, size: -1 },
        { id: 3, species: 'fish', x: 0, y: 0, heading: 0, size: 'big' },
      ],
    });
    expect(parsed?.map((entity) => entity.size)).toEqual([
      DEFAULT_SIZE_CLASS_INDEX,
      DEFAULT_SIZE_CLASS_INDEX,
      DEFAULT_SIZE_CLASS_INDEX,
    ]);
  });

  it('never carries a school on the wire', () => {
    // Schools are a server-side steering concept; the client draws creatures
    // where it is told they are and needs no knowledge of them.
    const parsed = parseEntitiesPayload({
      entities: [{ id: 1, species: 'fish', x: 0, y: 0, heading: 0, size: 0, schoolId: 7 }],
    });
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed![0]).sort()).toEqual(['heading', 'id', 'size', 'species', 'x', 'y']);
  });

  it('returns null when the payload is not an entity list at all', () => {
    for (const bad of [null, undefined, 7, 'x', {}, { entities: 5 }]) {
      expect(parseEntitiesPayload(bad)).toBeNull();
    }
  });

  it('drops individual malformed entries rather than the whole message', () => {
    const parsed = parseEntitiesPayload({
      entities: [
        null,
        { id: 1, species: 'dragon', x: 0, y: 0, heading: 0 },
        { id: 2, species: 'fish', x: NaN, y: 0, heading: 0 },
        { id: 3, species: 'fish', x: 0, y: 0 },
        { id: 4, species: 'grazer', x: 1, y: 2, heading: 0.5, size: 1 },
      ],
    });
    expect(parsed).toEqual([{ id: 4, species: 'grazer', x: 1, y: 2, heading: 0.5, size: 1 }]);
  });
});

describe('size classes', () => {
  it('round-trips every class through its wire index', () => {
    for (const sizeClass of WILDLIFE_SIZE_CLASSES) {
      expect(sizeClassAt(sizeClassIndex(sizeClass))).toBe(sizeClass);
    }
  });

  it('draws the default class at exactly the scale the models are authored at', () => {
    // The models in client/models.ts are authored at medium, and every clearance
    // in client/placement.ts was sized against those dimensions. If this stops
    // being 1, both files quietly start meaning something else.
    expect(WILDLIFE_SIZE_MODEL_SCALE[DEFAULT_SIZE_CLASS]).toBe(1);
  });

  it('orders the model scales smallest to largest', () => {
    const scales = WILDLIFE_SIZE_CLASSES.map((sizeClass) => WILDLIFE_SIZE_MODEL_SCALE[sizeClass]);
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThan(scales[i - 1]);
  });

  it('keeps the largest fish inside its own swim clearance', () => {
    // A large fish is 1.4 × the authored 0.26-unit body height, so its half
    // height is 0.182 — the fish profile insists on 0.3 of submergence, so no
    // clearance in placement.ts has to become size-aware. This is that argument,
    // pinned: it is what makes "size is a scale on the root" safe.
    const FISH_AUTHORED_BODY_HEIGHT = 0.26;
    const largestHalfHeight = (FISH_AUTHORED_BODY_HEIGHT * WILDLIFE_SIZE_MODEL_SCALE.large) / 2;
    expect(largestHalfHeight).toBeLessThan(SWIM_PROFILES.fish!.minSubmergence);
    expect(largestHalfHeight).toBeLessThan(SWIM_PROFILES.fish!.minClearance);
  });
});

describe('lerpAngle', () => {
  it('takes the short way round the circle', () => {
    // 170° → -170° is a 20° step forward, not a 340° step back.
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    const half = lerpAngle(from, to, 0.5);
    expect(Math.abs(half - from)).toBeCloseTo((10 * Math.PI) / 180, 6);
  });

  it('is exact at both ends', () => {
    expect(lerpAngle(0.3, 1.2, 0)).toBeCloseTo(0.3, 10);
    expect(lerpAngle(0.3, 1.2, 1)).toBeCloseTo(1.2, 10);
  });
});

describe('WildlifeInterpolator', () => {
  it('places a newly seen creature exactly where the server put it', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 10, y: 20, heading: 0.5 })]);

    const sampled = interpolator.sample().get(1);
    expect(sampled).toMatchObject({ x: 10, y: 20, heading: 0.5 });
  });

  it('walks between the last two states as frames advance', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 0, y: 0 })]);

    // A full window of frames, so the measured gap becomes the next window.
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([entity(1, { x: 10, y: 0 })]);

    expect(interpolator.sample().get(1)?.x).toBeCloseTo(0, 6);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(5, 6);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(10, 6);
  });

  it('clamps at the target instead of extrapolating past it', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([entity(1, { x: 10 })]);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS * 5);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(10, 6);
    expect(interpolator.progress()).toBe(1);
  });

  it('starts each segment from the pose it was actually rendering', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([entity(1, { x: 10 })]);

    // Halfway there, a new message arrives early.
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(5, 6);
    interpolator.receive([entity(1, { x: 20 })]);

    // No snap backwards: the new segment begins at 5, not at 0 or 10.
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(5, 6);
  });

  it('never adopts a stalled gap as the interpolation window', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 0 })]);
    interpolator.advance(30); // a 30-second stall
    interpolator.receive([entity(1, { x: 10 })]);

    interpolator.advance(MAX_INTERPOLATION_SECONDS);
    expect(interpolator.sample().get(1)?.x).toBeCloseTo(10, 6);
  });

  it('carries the size class through interpolation untouched', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1, { x: 0, size: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([entity(1, { x: 10, size: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);

    // Position is halfway; size is a class, not a quantity, so it does not lerp.
    const sampled = interpolator.sample().get(1);
    expect(sampled?.x).toBeCloseTo(5, 6);
    expect(sampled?.size).toBe(0);
  });

  it('drops creatures the server has stopped reporting', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1), entity(2)]);
    expect(interpolator.sample().size).toBe(2);

    interpolator.receive([entity(2)]);
    const sampled = interpolator.sample();
    expect(sampled.has(1)).toBe(false);
    expect(sampled.has(2)).toBe(true);
  });

  it('forgets everything on clear', () => {
    const interpolator = new WildlifeInterpolator();
    interpolator.receive([entity(1)]);
    interpolator.clear();
    expect(interpolator.sample().size).toBe(0);
  });
});

describe('vertical placement', () => {
  /** The sea surface is world Y 0 because SEA_LEVEL is 0 (see placement.ts). */
  it('anchors the water surface at the shared sea level', () => {
    expect(SEA_SURFACE_WORLD_Y).toBe(SEA_LEVEL);
    expect(SEA_SURFACE_WORLD_Y).toBe(0);
  });

  it('stands land species on the rendered ground', () => {
    expect(creatureWorldY('grazer', 4, DEFAULT_SIZE_CLASS)).toBe(4);
    expect(creatureWorldY('grazer', -1.5, DEFAULT_SIZE_CLASS)).toBe(-1.5);
  });

  it('falls back to band 0 before the first snapshot arrives', () => {
    expect(creatureWorldY('grazer', null, DEFAULT_SIZE_CLASS)).toBe(UNKNOWN_TERRAIN_WORLD_Y);
  });

  it('stacks the three swimmers surface → mid → seabed', () => {
    const seabedY = -8;
    const fish = creatureWorldY('fish', seabedY, DEFAULT_SIZE_CLASS);
    const whale = creatureWorldY('whale', seabedY, DEFAULT_SIZE_CLASS);
    const deepsea = creatureWorldY('deepsea', seabedY, DEFAULT_SIZE_CLASS);

    expect(fish).toBeGreaterThan(whale);
    expect(whale).toBeGreaterThan(deepsea);
  });

  it('keeps every swimmer inside the water column', () => {
    for (const seabedY of [-20, -8, -3, -1.5, -0.9]) {
      for (const species of ['fish', 'whale', 'deepsea'] as const) {
        const y = creatureWorldY(species, seabedY, DEFAULT_SIZE_CLASS);
        expect(y).toBeGreaterThanOrEqual(seabedY);
        expect(y).toBeLessThanOrEqual(SEA_SURFACE_WORLD_Y);
      }
    }
  });

  it('honours each species clearance when the water is deep enough', () => {
    const seabedY = -20;
    for (const species of ['fish', 'whale', 'deepsea'] as const) {
      const profile = SWIM_PROFILES[species];
      expect(profile).not.toBeNull();
      const y = creatureWorldY(species, seabedY, DEFAULT_SIZE_CLASS);
      expect(y).toBeGreaterThanOrEqual(seabedY + profile!.minClearance);
      expect(y).toBeLessThanOrEqual(SEA_SURFACE_WORLD_Y - profile!.minSubmergence);
    }
  });

  it('scales both clearances with the creature size class', () => {
    // The bug this pins (2026-08-21): a clearance is the MODEL'S half-height
    // plus a little water, and the model is uniformly scaled by its size class,
    // so a clearance that ignored the class placed a large creature as if it
    // were an adult — belly in the seabed, dorsal through the surface. Deep
    // water so neither clamp is the one that binds by accident.
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
    // The visible consequence, stated as the relation rather than as three
    // numbers: a bigger body sits further from the surface it must not breach.
    // Shallow enough that the submergence clamp is the binding one for the
    // large class but not for the small, which is exactly where the old code
    // returned the same Y for both.
    const seabedY = -2;
    const [small, , large] = WILDLIFE_SIZE_CLASSES;
    expect(creatureWorldY('fish', seabedY, large)).toBeLessThan(
      creatureWorldY('fish', seabedY, small),
    );
  });

  it('splits the difference when the water is too shallow for both clearances', () => {
    // A whale insists on 0.7 above the seabed AND 0.7 below the surface; one
    // world unit of water cannot give it both.
    const seabedY = -1;
    expect(creatureWorldY('whale', seabedY, DEFAULT_SIZE_CLASS)).toBeCloseTo(-0.5, 6);
  });
});

describe('walkerGroundY — footprint sampling', () => {
  const flatAt = (h: number) => () => h;

  it('stands on the highest band the footprint overlaps, not the centre cell', () => {
    // Centre cell is band 0; the cell one to the +x is band 2 (world Y 2). A
    // walker at x = 9.8 overhangs the boundary at x = 10, so it must stand at 2.
    const sample = (cx: number) => (cx >= 10 ? 2 : 0);
    expect(walkerGroundY(sample, 9.8, 5.5)).toBe(2);
    // Well clear of the boundary the centre cell rules. THE FIXTURE MOVED on
    // 2026-08-22, from x = 9.0 to x = 8.0, and the move is the bug: a grazer
    // then reached 1.8 CELLS either side of itself (0.45 world units), so at
    // x = 9.0 its body genuinely did overhang cell 10 and standing at band 0
    // there was the clipping this function exists to prevent. The old fixture
    // passed only because the half-extent was being read as 0.45 cells — a
    // quarter of the creature. The grazer has since shrunk to 0.18 world units
    // (0.72 cells, GRAZER_SCALE), so x = 8.0 is clear by an even wider margin
    // and the fixture stays where it is. See WALKER_FOOTPRINT_HALF_EXTENT.
    expect(walkerGroundY(sample, 8.0, 5.5)).toBe(0);
  });

  it('probes the ground in CELLS, not in the world units the model is built in', () => {
    // THE BUG THIS PINS, and its twin lives in the monsters plugin. Model
    // dimensions have been world units since the 2026-08-21 re-sample cut a
    // cell to a quarter of one; walkerGroundY adds its half-extent straight to
    // a CELL coordinate. A raw 0.45 therefore probed a quarter of the ground
    // the creature covers, which is a plausible-looking number and an invisible
    // failure — exactly why the conversion is pinned here rather than trusted.
    expect(WALKER_FOOTPRINT_HALF_EXTENT_CELLS).toBe(
      cellsAcross(WALKER_FOOTPRINT_HALF_EXTENT),
    );
    // A grazer still overhangs most of its own cell: a body ~0.44 world units
    // long is ~1.76 cells, so the probe must reach a good part of a cell either
    // side of centre — far more than the raw world-unit number would give.
    expect(WALKER_FOOTPRINT_HALF_EXTENT_CELLS).toBeGreaterThan(0.5);
  });

  it('matches the single-cell sample on flat ground', () => {
    expect(walkerGroundY(flatAt(3), 20.5, 20.5)).toBe(3);
  });

  it('returns null only when every sample is null', () => {
    expect(walkerGroundY(() => null, 5, 5)).toBeNull();
    const halfNull = (cx: number) => (cx >= 5 ? 1 : null);
    expect(walkerGroundY(halfNull, 5.5, 5.5)).toBe(1);
  });
});

describe('birds fly overhead', () => {
  it('clears the tallest terrain this game can contain, with named headroom', () => {
    // MAX_HEIGHT is the sculpt ceiling; MAX_TERRAIN_WORLD_Y is that in world
    // units. The requirement is "well above", not "above", so the headroom is
    // asserted as a share of the mountain rather than as a bare inequality.
    // RESTATED, not derived: MAX_HEIGHT / BAND_HEIGHT is the ceiling in BANDS,
    // which equalled world units only while a band drew one of them. Since
    // 2026-08-20 the client derives its vertical scale from the world's relief
    // instead, so this pins that relief — 16 cells — and a change to the
    // client's MAX_RELIEF_WORLD_UNITS must be followed here deliberately.
    expect(MAX_TERRAIN_WORLD_Y).toBe(16);
    expect(BIRD_FLIGHT_WORLD_Y).toBe(MAX_TERRAIN_WORLD_Y + BIRD_ALTITUDE_HEADROOM_WORLD_UNITS);
    expect(BIRD_ALTITUDE_HEADROOM_WORLD_UNITS).toBeGreaterThanOrEqual(MAX_TERRAIN_WORLD_Y / 2);
  });

  it('places a bird at its altitude whatever the ground below it is doing', () => {
    // Including "there is no ground": a bird over a chunk this client has never
    // been sent must not sag to the unknown-terrain default the way a walker
    // does — its Y does not come from the terrain at all.
    for (const terrainY of [null, -20, 0, 4, MAX_TERRAIN_WORLD_Y]) {
      expect(creatureWorldY('bird', terrainY, DEFAULT_SIZE_CLASS)).toBe(BIRD_FLIGHT_WORLD_Y);
    }
  });

  it('classifies every species into exactly one placement kind', () => {
    expect(placementKindOf('bird')).toBe('flyer');
    expect(placementKindOf('grazer')).toBe('walker');
    for (const species of ['fish', 'whale', 'deepsea'] as const) {
      expect(placementKindOf(species)).toBe('swimmer');
    }
    // A flyer has no swim profile and a swimmer no altitude: the two tables are
    // disjoint, which is what makes the kind well-defined rather than a
    // precedence rule that happens to work today.
    for (const species of WILDLIFE_SPECIES) {
      const flies = FLIGHT_ALTITUDES[species] !== null;
      const swims = SWIM_PROFILES[species] !== null;
      expect(flies && swims).toBe(false);
    }
  });
});
