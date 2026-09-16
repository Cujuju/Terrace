import { describe, expect, it } from 'vitest';
import { cellsAcross, createSeededRng } from '@terrace/shared';
import {
  DISC_MIN_ACTIVE_SYSTEMS,
  DISC_SYSTEM_MAX_RADIUS_CELLS,
  DISC_SYSTEM_MIN_RADIUS_CELLS,
  createDiscSystems,
} from '../src/plugins/kit/discSystems.ts';

const TICK_SECONDS = 0.1;

const WORLD_SIZE = cellsAcross(512);

const WIND = { vx: 1.25, vy: -0.5 };

function seeded(seed: number): () => number {
  return createSeededRng(seed).next;
}

describe('discSystems cap derivation', () => {
  it('scales the population with the coverage fraction it is given', () => {
    const NO_CEILING = 100;
    const whole = createDiscSystems({
      coverageFraction: 0.18,
      maxActiveSystems: NO_CEILING,
      random: seeded(1),
    });
    const half = createDiscSystems({
      coverageFraction: 0.09,
      maxActiveSystems: NO_CEILING,
      random: seeded(1),
    });
    expect(whole.capFor(WORLD_SIZE)).toBe(14);
    expect(half.capFor(WORLD_SIZE)).toBe(7);
  });

  it('never falls below one system, and never exceeds the ceiling it is given', () => {
    const tiny = createDiscSystems({
      coverageFraction: 0.0001,
      maxActiveSystems: 14,
      random: seeded(2),
    });
    expect(tiny.capFor(WORLD_SIZE)).toBe(DISC_MIN_ACTIVE_SYSTEMS);

    const greedy = createDiscSystems({
      coverageFraction: 0.9,
      maxActiveSystems: 3,
      random: seeded(3),
    });
    expect(greedy.capFor(WORLD_SIZE)).toBe(3);
  });
});

describe('discSystems drift', () => {
  it('moves every living disc by exactly the supplied wind vector', () => {
    const engine = createDiscSystems({
      coverageFraction: 0.18,
      maxActiveSystems: 14,
      random: seeded(4),
    });
    for (let n = 0; n < 5; n++) engine.spawnOne(WORLD_SIZE);
    const before = engine.systems().map((disc) => ({ x: disc.x, y: disc.y }));
    expect(before.length).toBe(5);

    engine.advance(WORLD_SIZE, TICK_SECONDS, WIND);

    const after = engine.systems();
    expect(after).toHaveLength(before.length);
    for (let index = 0; index < after.length; index++) {
      expect(after[index]!.x - before[index]!.x).toBeCloseTo(WIND.vx * TICK_SECONDS, 12);
      expect(after[index]!.y - before[index]!.y).toBeCloseTo(WIND.vy * TICK_SECONDS, 12);
    }
  });

  it('keeps every radius inside the band the world allows', () => {
    const engine = createDiscSystems({
      coverageFraction: 0.18,
      maxActiveSystems: 14,
      random: seeded(5),
    });
    for (let n = 0; n < 20; n++) engine.spawnOne(WORLD_SIZE);
    for (const disc of engine.systems()) {
      expect(disc.radius).toBeGreaterThanOrEqual(DISC_SYSTEM_MIN_RADIUS_CELLS);
      expect(disc.radius).toBeLessThanOrEqual(DISC_SYSTEM_MAX_RADIUS_CELLS);
    }
  });
});

describe('discSystems siting', () => {
  it('retries a refused centre and reports the give-up through onUnsited', () => {
    let attempts = 0;
    let unsited = 0;
    const engine = createDiscSystems({
      coverageFraction: 0.18,
      maxActiveSystems: 14,
      random: seeded(6),
      siting: () => {
        attempts++;
        return false;
      },
      onUnsited: () => {
        unsited++;
      },
    });

    expect(engine.spawnOne(WORLD_SIZE)).toBeNull();
    expect(attempts).toBe(engine.sitingAttempts);
    expect(unsited).toBe(1);
    expect(engine.systems()).toHaveLength(0);
  });

  it('births the disc on the first centre a predicate accepts', () => {
    let attempts = 0;
    let unsited = 0;
    const engine = createDiscSystems({
      coverageFraction: 0.18,
      maxActiveSystems: 14,
      random: seeded(7),
      siting: () => ++attempts >= 2,
      onUnsited: () => {
        unsited++;
      },
    });

    expect(engine.spawnOne(WORLD_SIZE)).not.toBeNull();
    expect(attempts).toBe(2);
    expect(unsited).toBe(0);
    expect(engine.systems()).toHaveLength(1);
  });
});

describe('discSystems dev override', () => {
  it('parks exactly one disc over the middle of the world and holds it there', () => {
    const engine = createDiscSystems({
      coverageFraction: 0.18,
      maxActiveSystems: 14,
      random: seeded(8),
    });
    engine.force(true);

    for (let tick = 0; tick < 50; tick++) engine.advance(WORLD_SIZE, TICK_SECONDS, WIND);

    const parked = engine.systems();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.x).toBe(WORLD_SIZE / 2);
    expect(parked[0]!.y).toBe(WORLD_SIZE / 2);
    expect(parked[0]!.envelope).toBeGreaterThan(0);
    expect(parked[0]!.envelope).toBeLessThanOrEqual(1);
  });
});

describe('discSystems admission', () => {
  const SMALL_WORLD = cellsAcross(128);
  const CEILING = 7;
  const COVERAGE_FRACTION = 0.09;

  function engineOn(seed: number): ReturnType<typeof createDiscSystems> {
    return createDiscSystems({
      coverageFraction: COVERAGE_FRACTION,
      maxActiveSystems: CEILING,
      random: seeded(seed),
    });
  }

  it('refuses a natural spawn once the coverage cap is full', () => {
    const engine = engineOn(9);
    const cap = engine.capFor(SMALL_WORLD);
    expect(cap).toBeLessThan(CEILING);
    for (let n = 0; n < cap; n++) expect(engine.spawnOne(SMALL_WORLD)).not.toBeNull();
    expect(engine.spawnOne(SMALL_WORLD)).toBeNull();
    expect(engine.systems()).toHaveLength(cap);
  });

  it('lets a summoned system pass the coverage cap, but never the draw ceiling', () => {
    const engine = engineOn(10);
    expect(engine.capFor(SMALL_WORLD)).toBeLessThan(CEILING);
    for (let n = 0; n < CEILING; n++) {
      expect(engine.spawnAt(SMALL_WORLD, n, n)).not.toBeNull();
    }
    expect(engine.spawnAt(SMALL_WORLD, 0, 0)).toBeNull();
    expect(engine.systems()).toHaveLength(CEILING);
  });

  it('refuses both spawns while the sky is parked, and admits again after a reset', () => {
    const engine = engineOn(11);
    engine.force(true);
    expect(engine.spawnOne(SMALL_WORLD)).toBeNull();
    expect(engine.spawnAt(SMALL_WORLD, 0, 0)).toBeNull();

    engine.reset();
    expect(engine.isForced()).toBe(false);
    expect(engine.spawnAt(SMALL_WORLD, 0, 0)).not.toBeNull();
  });

  it('refuses a centre that is not a number, and stays dry there', () => {
    const engine = engineOn(12);
    expect(engine.spawnAt(SMALL_WORLD, Number.NaN, 0)).toBeNull();
    expect(engine.spawnAt(SMALL_WORLD, 0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(engine.systems()).toHaveLength(0);
    expect(engine.intensityAt(0, 0)).toBe(0);
    expect(engine.intensityAt(Number.NaN, Number.NaN)).toBe(0);
  });
});

describe('discSystems determinism', () => {
  const TRACE_TICKS = 2000;

  it('replays the same sky from the same seed', () => {
    const trace = (seed: number): string[] => {
      const engine = createDiscSystems({
        coverageFraction: 0.09,
        footprintAreaScale: 3,
        maxActiveSystems: 7,
        random: seeded(seed),
      });
      const frames: string[] = [];
      for (let tick = 0; tick < TRACE_TICKS; tick++) {
        engine.advance(WORLD_SIZE, TICK_SECONDS, WIND);
        frames.push(JSON.stringify(engine.states(WIND)));
      }
      return frames;
    };
    expect(trace(20260814)).toEqual(trace(20260814));
  });
});

describe('discSystems intensity', () => {
  const NUDGE_CELLS = 1;

  it('is full just inside the rim and nothing just outside it', () => {
    const engine = createDiscSystems({
      coverageFraction: 0.09,
      maxActiveSystems: 7,
      random: seeded(13),
    });
    const centre = WORLD_SIZE / 2;
    const system = engine.spawnAt(WORLD_SIZE, centre, centre)!;
    system.envelope = 1;

    expect(engine.intensityAt(centre + system.radius - NUDGE_CELLS, centre)).toBe(
      system.peakIntensity,
    );
    expect(engine.intensityAt(centre + system.radius + NUDGE_CELLS, centre)).toBe(0);
  });
});
