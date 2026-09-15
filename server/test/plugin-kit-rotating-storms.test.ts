import { describe, expect, it } from 'vitest';
import { DEFAULT_TICK_HZ } from '../src/config.ts';
import {
  createRotatingStorms,
  parseRotatingStormsSnapshot,
  ROTATING_STORM_DAMAGE_INTERVAL_SECONDS,
  waterFractionUnder,
  type RotatingStormProfile,
  type RotatingStormWorld,
} from '../src/plugins/kit/rotatingStorms.ts';

const TICK_SECONDS = 0.1;

const WORLD_SIZE = 256;

const LAND_HEIGHT = 400;
const WATER_HEIGHT = 0;

function uniformWorld(height: number): RotatingStormWorld {
  return { worldSize: WORLD_SIZE, heightAt: () => height };
}

function coastWorld(): RotatingStormWorld {
  const COAST_X = WORLD_SIZE / 2;
  return {
    worldSize: WORLD_SIZE,
    heightAt: (x: number) => (x < COAST_X ? WATER_HEIGHT : LAND_HEIGHT),
  };
}

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

// Long enough that nothing in a test ages, spins up or fades on its own.
const UNENDING_SECONDS = 1e9;

const OVER_FULL_ENVELOPE = 5;

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
    storms.spawnAt(world, -100, -100);
    storms.advance(world, TICK_SECONDS);
    expect(storms.count()).toBe(0);
  });
});

describe('rotatingStorms terrain', () => {
  it('decays a storm standing on the terrain its profile calls hostile', () => {
    const SLOW_SPIN_UP_SECONDS = 1000;
    const DECAY_PER_SECOND = 0.25;
    const profile: RotatingStormProfile = {
      ...STRAIGHT,
      speedCellsPerSecond: 0,
      spinUpSeconds: SLOW_SPIN_UP_SECONDS,
      hostileTerrainDecayPerSecond: DECAY_PER_SECOND,
    };
    const storms = engine(profile);
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

    const storm = storms.spawnAt(world, 40, 100);
    expect(storms.advance(world, TICK_SECONDS).landfalls).toHaveLength(0);

    storm.x = 200;
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
    const world = uniformWorld(WATER_HEIGHT);
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

    const parsed = parseRotatingStormsSnapshot(JSON.parse(JSON.stringify(first.snapshot())));
    expect(parsed).not.toBeNull();

    const second = engine(STRAIGHT, named);
    second.restore(parsed!);
    expect(second.states()).toEqual(first.states());
    expect(second.storms()[1]?.name).toBe('Storm 1');

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

describe('rotatingStorms veer', () => {
  const VEERING: RotatingStormProfile = {
    ...STRAIGHT,
    speedCellsPerSecond: 0,
    veerRadiansPerSecond: 0.05,
    spinUpSeconds: UNENDING_SECONDS,
  };

  const WINDOW_SECONDS = 600;
  const SPREAD_SAMPLES = 8;

  function rmsDriftAt(dt: number): number {
    const world = uniformWorld(LAND_HEIGHT);
    let sumSquares = 0;
    for (let sample = 0; sample < SPREAD_SAMPLES; sample++) {
      const storms = createRotatingStorms({
        profile: VEERING,
        seed: SEED + sample,
        radiusFor: () => 6,
      });
      const storm = storms.spawnAt(world, 100, 100);
      storm.lifeSeconds = UNENDING_SECONDS;
      const start = storm.heading;
      for (let step = 0; step < Math.round(WINDOW_SECONDS / dt); step++) storms.advance(world, dt);
      const drift = storm.heading - start;
      sumSquares += drift * drift;
    }
    return Math.sqrt(sumSquares / SPREAD_SAMPLES);
  }

  it('spreads the same over a window whatever the tick rate', () => {
    const FAST_TICK_SECONDS = 1 / 20;
    const ratio = rmsDriftAt(1) / rmsDriftAt(FAST_TICK_SECONDS);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it('draws the profile veer as written at the default tick rate', () => {
    const REFERENCE_TICK_SECONDS = 1 / DEFAULT_TICK_HZ;
    const storms = engine(VEERING);
    const world = uniformWorld(LAND_HEIGHT);
    const storm = storms.spawnAt(world, 100, 100);
    storm.lifeSeconds = UNENDING_SECONDS;

    const maxStep = VEERING.veerRadiansPerSecond * REFERENCE_TICK_SECONDS;
    let previous = storm.heading;
    let widest = 0;
    for (let tick = 0; tick < 200; tick++) {
      storms.advance(world, REFERENCE_TICK_SECONDS);
      widest = Math.max(widest, Math.abs(storm.heading - previous));
      previous = storm.heading;
    }
    expect(widest).toBeLessThanOrEqual(maxStep + 1e-12);
    expect(widest).toBeGreaterThan(maxStep / 2);
  });
});

describe('rotatingStorms freeze and reset', () => {
  it('spawns nothing while frozen: a parked sky rolls no dice and sites nobody', () => {
    const storms = engine(STRAIGHT);
    const world = uniformWorld(LAND_HEIGHT);
    storms.freeze(true);

    expect(storms.rollSpawn(Number.POSITIVE_INFINITY, 1)).toBe(false);
    expect(storms.trySpawn(world, () => ({ x: 100, y: 100 }))).toBeNull();
    expect(storms.count()).toBe(0);
  });

  it('reset() thaws the sky as well as emptying it', () => {
    const storms = engine(STRAIGHT);
    storms.freeze(true);
    storms.reset();
    expect(storms.isFrozen()).toBe(false);
  });
});

describe('rotatingStorms envelope', () => {
  it('holds the envelope inside [0, 1] whichever way it is moving', () => {
    const world = uniformWorld(WATER_HEIGHT);
    const spinning = engine({ ...STRAIGHT, speedCellsPerSecond: 0 });
    const rising = spinning.spawnAt(world, 100, 100);
    rising.envelope = 0.9;
    spinning.advance(world, STRAIGHT.spinUpSeconds);
    expect(rising.envelope).toBe(1);

    const fading = engine({ ...STRAIGHT, speedCellsPerSecond: 0 });
    const retiring = fading.spawnAt(world, 100, 100);
    retiring.retiring = true;
    retiring.envelope = OVER_FULL_ENVELOPE;
    fading.advance(world, 0);
    expect(retiring.envelope).toBe(1);
  });
});

describe('rotatingStorms restore', () => {
  it('never hands out an id a restored storm already holds', () => {
    const RESTORED_ID = 7;
    const world = uniformWorld(LAND_HEIGHT);
    const storms = engine(STRAIGHT);
    const source = engine(STRAIGHT);
    source.spawnAt(world, 100, 100);
    const snapshot = source.snapshot();

    storms.restore({
      ...snapshot,
      nextStormId: 1,
      storms: [{ ...snapshot.storms[0]!, id: RESTORED_ID }],
    });

    expect(storms.spawnAt(world, 10, 10).id).toBe(RESTORED_ID + 1);
  });
});

describe('rotatingStorms snapshot bounds', () => {
  function snapshotWith(storm: Record<string, unknown>): unknown {
    return { nextStormId: 2, namedCount: 0, rngState: 7, storms: [storm] };
  }

  const WHOLE_STORM = {
    id: 1,
    x: 10,
    y: 20,
    radius: 6,
    heading: 0,
    peakIntensity: 1,
    envelope: 1,
    retiring: false,
    lifeSeconds: 30,
    landfallReported: false,
    damageDebtSeconds: 0,
    ownerDebtSeconds: 0,
  };

  it('clamps a fraction that came back out of range', () => {
    const parsed = parseRotatingStormsSnapshot(
      snapshotWith({ ...WHOLE_STORM, peakIntensity: 4, envelope: -2 }),
    );
    expect(parsed?.storms[0]?.peakIntensity).toBe(1);
    expect(parsed?.storms[0]?.envelope).toBe(0);
  });

  it('refuses a storm with no width at all', () => {
    expect(parseRotatingStormsSnapshot(snapshotWith({ ...WHOLE_STORM, radius: 0 }))).toBeNull();
  });
});

describe('waterFractionUnder', () => {
  it('counts what lies off the map as water — the ocean is what is out there', () => {
    const world = uniformWorld(LAND_HEIGHT);
    expect(waterFractionUnder(world, -100, -100, 6)).toBe(1);
    expect(waterFractionUnder(world, WORLD_SIZE / 2, WORLD_SIZE / 2, 6)).toBe(0);
  });
});
