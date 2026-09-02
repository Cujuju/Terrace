// Contract test for server/src/plugins/kit/discSystems.ts — the drifting-disc
// sim engine, written BEFORE the module it covers.
//
// WHAT IS UNDER TEST is the mechanism only: how a population cap is derived
// from a coverage fraction, that every living disc is displaced by exactly the
// wind vector it is handed, that a siting predicate is retried and then
// reported, and that the dev override parks one disc over the middle of the
// world. The BEHAVIOUR each caller builds on top of it — which kinds wet the
// ground, where snow may sit, what a broadcast looks like — belongs to the
// plugins and is tested there.

import { describe, expect, it } from 'vitest';
import { cellsAcross, createSeededRng } from '@terrace/shared';
import {
  DISC_MIN_ACTIVE_SYSTEMS,
  DISC_SYSTEM_MAX_RADIUS_CELLS,
  DISC_SYSTEM_MIN_RADIUS_CELLS,
  createDiscSystems,
} from '../src/plugins/kit/discSystems.ts';

/** The shipped tick period: TICK_HZ 10 (docs/DESIGN.md). */
const TICK_SECONDS = 0.1;

/** The nominal world — 512 world units square, in cells. */
const WORLD_SIZE = cellsAcross(512);

/** A wind that blows hard enough for one tick's displacement to be measurable. */
const WIND = { vx: 1.25, vy: -0.5 };

function seeded(seed: number): () => number {
  return createSeededRng(seed).next;
}

describe('discSystems cap derivation', () => {
  it('scales the population with the coverage fraction it is given', () => {
    // Two instances differing ONLY in coverage: half the coverage, half the
    // population. That proportionality is the whole reason a kind plugin can
    // carry its own share of one sky.
    // A ceiling high enough not to bind, so what is measured is the derivation
    // and not the clamp.
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
    // Every attempt the engine allows itself was spent before it gave up, and
    // the caller was told exactly once.
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
    // It still GATHERS rather than snapping to full strength — a photograph of
    // weather that arrived by teleport is not a photograph of the sim.
    expect(parked[0]!.envelope).toBeGreaterThan(0);
    expect(parked[0]!.envelope).toBeLessThanOrEqual(1);
  });
});
