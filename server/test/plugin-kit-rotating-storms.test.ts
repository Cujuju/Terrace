// Contract test for server/src/plugins/kit/rotatingStorms.ts — the rotating-
// storm sim engine, written BEFORE the module it covers.
//
// WHAT IS UNDER TEST is the mechanism only: that a storm tracks and veers on
// the profile it is handed, that the terrain a profile calls hostile decays it,
// that landfall is reported once and only when asked for, that damage arrives on
// its own cadence with the eye spared, and that a snapshot restores a storm, its
// generator and its name counter. The BEHAVIOUR each caller builds on top of it
// — where a funnel may touch down, what open water means, what a surge does —
// belongs to the plugins and is tested there.

import { describe, expect, it } from 'vitest';
import {
  createRotatingStorms,
  parseRotatingStormsSnapshot,
  ROTATING_STORM_DAMAGE_INTERVAL_SECONDS,
  type RotatingStormProfile,
  type RotatingStormWorld,
} from '../src/plugins/kit/rotatingStorms.ts';

/** The shipped tick period: TICK_HZ 10 (docs/DESIGN.md). */
const TICK_SECONDS = 0.1;

const WORLD_SIZE = 256;

/** Above SEA_LEVEL, so `land` reads land; below it, water. */
const LAND_HEIGHT = 400;
const WATER_HEIGHT = 0;

/** A world that is land everywhere, or water everywhere — the two pure cases. */
function uniformWorld(height: number): RotatingStormWorld {
  return { worldSize: WORLD_SIZE, heightAt: () => height };
}

/** Water in the western half, land in the eastern — one coast, at x = 128. */
function coastWorld(): RotatingStormWorld {
  const COAST_X = WORLD_SIZE / 2;
  return {
    worldSize: WORLD_SIZE,
    heightAt: (x: number) => (x < COAST_X ? WATER_HEIGHT : LAND_HEIGHT),
  };
}

/** A profile with no veer and no decay, so a track is exactly predictable. */
const STRAIGHT: RotatingStormProfile = {
  speedCellsPerSecond: 10,
  veerRadiansPerSecond: 0,
  meanLifetimeSeconds: 1000,
  spinUpSeconds: 1,
  fadeSeconds: 1,
  hostileTerrainDecayPerSecond: 0,
  minPeakIntensity: 1,
  maxPeakIntensity: 1,
  maxActive: 2,
  hostileTerrain: 'water',
  eyeRadiusFraction: 0,
  windFalloff: (r: number) => 1 - r * r,
};

const SEED = 0x1234_5678;

function engine(profile: RotatingStormProfile, extra: Record<string, unknown> = {}) {
  return createRotatingStorms({
    profile,
    seed: SEED,
    radiusFor: () => 6,
    ...extra,
  });
}

describe('rotatingStorms track', () => {
  it('moves the eye by speed × dt along its heading, and nothing else moves it', () => {
    const storms = engine(STRAIGHT);
    const world = uniformWorld(LAND_HEIGHT);
    const storm = storms.spawnAt(world, 100, 100);
    const heading = storm.heading;

    storms.advance(world, TICK_SECONDS);

    const step = STRAIGHT.speedCellsPerSecond * TICK_SECONDS;
    expect(storm.x).toBeCloseTo(100 + Math.cos(heading) * step, 10);
    expect(storm.y).toBeCloseTo(100 + Math.sin(heading) * step, 10);
    // Zero veer means the heading is untouched — the veer is a random walk
    // SCALED by the profile's own rate, not an unconditional wobble.
    expect(storm.heading).toBe(heading);
  });

  it('is deterministic from its seed: the same seed replays the same track', () => {
    const world = uniformWorld(LAND_HEIGHT);
    const veering: RotatingStormProfile = { ...STRAIGHT, veerRadiansPerSecond: 0.05 };
    const tracks = [0, 1].map(() => {
      const storms = engine(veering);
      const storm = storms.spawnAt(world, 100, 100);
      for (let tick = 0; tick < 50; tick++) storms.advance(world, TICK_SECONDS);
      return { x: storm.x, y: storm.y, heading: storm.heading };
    });
    expect(tracks[0]).toEqual(tracks[1]);
  });

  it('forgets a storm that has drifted clear of the world', () => {
    const storms = engine(STRAIGHT);
    const world = uniformWorld(LAND_HEIGHT);
    // Already past the despawn margin (1.5 radii) on the first tick it is aged.
    storms.spawnAt(world, -100, -100);
    storms.advance(world, TICK_SECONDS);
    expect(storms.count()).toBe(0);
  });
});

describe('rotatingStorms terrain', () => {
  it('decays a storm standing on the terrain its profile calls hostile', () => {
    // A long spin-up, so what is measured is the decay and not the clamp at 1.
    const SLOW_SPIN_UP_SECONDS = 1000;
    const DECAY_PER_SECOND = 0.25;
    const profile: RotatingStormProfile = {
      ...STRAIGHT,
      speedCellsPerSecond: 0,
      spinUpSeconds: SLOW_SPIN_UP_SECONDS,
      hostileTerrainDecayPerSecond: DECAY_PER_SECOND,
    };
    const storms = engine(profile);
    // hostileTerrain is 'water', so an all-water world is full exposure.
    const world = uniformWorld(WATER_HEIGHT);
    const storm = storms.spawnAt(world, 100, 100);
    storm.envelope = 1;

    storms.advance(world, 1);

    expect(storm.envelope).toBeCloseTo(1 + 1 / SLOW_SPIN_UP_SECONDS - DECAY_PER_SECOND, 10);
  });

  it('leaves a storm alone on terrain its profile does not call hostile', () => {
    const profile: RotatingStormProfile = {
      ...STRAIGHT,
      speedCellsPerSecond: 0,
      hostileTerrainDecayPerSecond: 0.25,
      hostileTerrain: 'land',
    };
    const storms = engine(profile);
    const world = uniformWorld(WATER_HEIGHT);
    const storm = storms.spawnAt(world, 100, 100);
    storm.envelope = 0.5;

    storms.advance(world, 1);

    expect(storm.envelope).toBeCloseTo(1, 10);
  });
});

describe('rotatingStorms landfall', () => {
  it('reports the eye crossing onto land exactly once, when asked to', () => {
    const profile: RotatingStormProfile = { ...STRAIGHT, speedCellsPerSecond: 0 };
    const storms = engine(profile, { reportsLandfall: true });
    const world = coastWorld();

    const storm = storms.spawnAt(world, 40, 100); // over water
    expect(storms.advance(world, TICK_SECONDS).landfalls).toHaveLength(0);

    storm.x = 200; // ashore
    const first = storms.advance(world, TICK_SECONDS);
    expect(first.landfalls).toHaveLength(1);
    expect(first.landfalls[0]?.stormId).toBe(storm.id);

    expect(storms.advance(world, TICK_SECONDS).landfalls).toHaveLength(0);
  });

  it('says nothing about landfall for a caller that did not ask', () => {
    const profile: RotatingStormProfile = { ...STRAIGHT, speedCellsPerSecond: 0 };
    const storms = engine(profile);
    const world = uniformWorld(LAND_HEIGHT);
    storms.spawnAt(world, 100, 100);
    expect(storms.advance(world, TICK_SECONDS).landfalls).toHaveLength(0);
  });
});

describe('rotatingStorms damage', () => {
  it('emits on its own cadence, not once per tick', () => {
    const storms = engine(STRAIGHT);
    const world = uniformWorld(LAND_HEIGHT);
    const storm = storms.spawnAt(world, 100, 100);
    storm.envelope = 1;

    // Half-interval steps, so the debt lands exactly on the interval rather
    // than a float's-breadth under it.
    const HALF_INTERVAL = ROTATING_STORM_DAMAGE_INTERVAL_SECONDS / 2;
    let events = 0;
    for (let step = 0; step < 4; step++) {
      events += storms.advance(world, HALF_INTERVAL).damage.length;
    }
    expect(events).toBe(2);
  });

  it('spares the eye and reports its radius, when the profile has one', () => {
    const EYE = 0.25;
    const profile: RotatingStormProfile = {
      ...STRAIGHT,
      speedCellsPerSecond: 0,
      eyeRadiusFraction: EYE,
      windFalloff: (r: number) => (r <= EYE ? 0 : (1 - r) / (1 - EYE)),
    };
    const storms = engine(profile);
    const world = uniformWorld(LAND_HEIGHT);
    const storm = storms.spawnAt(world, 100, 100);
    storm.envelope = 1;

    const event = storms.advance(world, ROTATING_STORM_DAMAGE_INTERVAL_SECONDS).damage[0];
    expect(event).toBeDefined();
    expect(event?.eyeRadius).toBeCloseTo(storm.radius * EYE, 6);
    // Every reported cell carries real wind: a cell in the calm middle scores
    // zero and is not worth a consumer's time.
    for (const cell of event?.cells ?? []) {
      expect(cell.severity).toBeGreaterThan(0);
      expect(Math.hypot(cell.x - storm.x, cell.y - storm.y)).toBeGreaterThan(storm.radius * EYE);
    }
  });
});

describe('rotatingStorms freeze', () => {
  it('stops movement, ageing and weakening but keeps the damage flowing', () => {
    const profile: RotatingStormProfile = { ...STRAIGHT, hostileTerrainDecayPerSecond: 0.25 };
    const storms = engine(profile);
    const world = uniformWorld(WATER_HEIGHT); // hostile
    const storm = storms.spawnAt(world, 100, 100);
    storm.envelope = 1;
    storms.freeze(true);

    const before = { x: storm.x, y: storm.y, life: storm.lifeSeconds, envelope: storm.envelope };
    const tick = storms.advance(world, ROTATING_STORM_DAMAGE_INTERVAL_SECONDS);

    expect({
      x: storm.x,
      y: storm.y,
      life: storm.lifeSeconds,
      envelope: storm.envelope,
    }).toEqual(before);
    expect(tick.damage).toHaveLength(1);
  });
});

describe('rotatingStorms snapshot', () => {
  it('restores the storms, the generator and the name counter', () => {
    const world = uniformWorld(LAND_HEIGHT);
    const named = { nameFor: (index: number) => `Storm ${index}` };

    const first = engine(STRAIGHT, named);
    first.spawnAt(world, 100, 100);
    first.spawnAt(world, 120, 100);
    for (let tick = 0; tick < 20; tick++) first.advance(world, TICK_SECONDS);

    // Through JSON, because that is what the host actually writes and reads.
    const parsed = parseRotatingStormsSnapshot(JSON.parse(JSON.stringify(first.snapshot())));
    expect(parsed).not.toBeNull();

    const second = engine(STRAIGHT, named);
    second.restore(parsed!);
    expect(second.states()).toEqual(first.states());
    expect(second.storms()[1]?.name).toBe('Storm 1');

    // The generator resumed where it left off: the next draw matches, and so
    // does the next name — a restarted world does not hand out Storm 0 again.
    expect(second.random()).toBe(first.random());
    expect(second.spawnAt(world, 10, 10).name).toBe('Storm 2');
  });

  it('rejects a snapshot that is not one, whole', () => {
    expect(parseRotatingStormsSnapshot(null)).toBeNull();
    expect(parseRotatingStormsSnapshot({ nextStormId: 1 })).toBeNull();
    expect(
      parseRotatingStormsSnapshot({
        nextStormId: 1,
        namedCount: 0,
        rngState: 7,
        storms: [{ id: 1, x: Number.NaN }],
      }),
    ).toBeNull();
  });
});
