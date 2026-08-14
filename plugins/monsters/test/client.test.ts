// The client half's PURE logic: payload validation, interpolation, and the
// placement/silhouette maths. Rendering is verified by eye per design §8 ("no
// headless GL rig"), so nothing here imports three — which is also what lets it
// run in the same node environment as the server tests.

import { describe, expect, it } from 'vitest';
import { SEA_LEVEL } from '@terrace/shared';
import { parseMonstersPayload, type MonsterState } from '../protocol.ts';
import {
  CTHULHU_FACE_TENTACLE_COUNT,
  CTHULHU_HEAD_BOTTOM,
  CTHULHU_HEAD_TOP,
  CTHULHU_LURK_DEPTH,
  CTHULHU_SHOULDER_HEIGHT,
  CTHULHU_SHOULDER_THICKNESS,
  CTHULHU_TORSO_HEIGHT,
  CTHULHU_TOTAL_HEIGHT,
  CTHULHU_WATERLINE_BITE,
  CTHULHU_WIDTH_CELLS,
} from '../client/anatomy.ts';
import {
  DEFAULT_INTERPOLATION_SECONDS,
  MAX_INTERPOLATION_SECONDS,
  MonsterInterpolator,
  lerpAngle,
} from '../client/interpolation.ts';
import { SEA_SURFACE_WORLD_Y, monsterOriginWorldY, submergedFraction } from '../client/placement.ts';
import { CTHULHU_FOOTPRINT_CELLS } from '../server/kinds.ts';

function monster(id: number, overrides: Partial<MonsterState> = {}): MonsterState {
  return { id, kind: 'cthulhu', x: 0, y: 0, heading: 0, ...overrides };
}

describe('state payload parsing', () => {
  it('accepts a well-formed payload', () => {
    const parsed = parseMonstersPayload({
      monsters: [{ id: 3, kind: 'cthulhu', x: 1.25, y: -2.5, heading: 1.5 }],
    });
    expect(parsed).toEqual([{ id: 3, kind: 'cthulhu', x: 1.25, y: -2.5, heading: 1.5 }]);
  });

  it('accepts an EMPTY list — that is the despawn, not a malformed message', () => {
    expect(parseMonstersPayload({ monsters: [] })).toEqual([]);
  });

  it('returns null when the payload is not a monster list at all', () => {
    for (const bad of [null, undefined, 7, 'x', {}, { monsters: 5 }]) {
      expect(parseMonstersPayload(bad)).toBeNull();
    }
  });

  it('drops malformed entries individually rather than failing the message', () => {
    const parsed = parseMonstersPayload({
      monsters: [
        { id: 1, kind: 'cthulhu', x: 0, y: 0, heading: 0 },
        null,
        { id: 'two', kind: 'cthulhu', x: 0, y: 0, heading: 0 },
        // A kind this client's bundle has never heard of — the version-skew case.
        { id: 3, kind: 'dagon', x: 0, y: 0, heading: 0 },
        { id: 4, kind: 'cthulhu', x: Number.NaN, y: 0, heading: 0 },
        { id: 5, kind: 'cthulhu', x: 0, y: 0, heading: Number.POSITIVE_INFINITY },
      ],
    });
    expect(parsed).toEqual([{ id: 1, kind: 'cthulhu', x: 0, y: 0, heading: 0 }]);
  });
});

describe('interpolation', () => {
  it('holds the first message exactly, with no history to blend from', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 10, y: 20, heading: 1 })]);
    const sampled = interpolator.sample().get(1);
    expect(sampled).toMatchObject({ x: 10, y: 20, heading: 1 });
  });

  it('walks halfway across the window in half the window', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 0, y: 0 })]);
    // Two messages one second apart: the measured window becomes 1 s.
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([monster(1, { x: 4, y: 0 })]);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.progress()).toBeCloseTo(0.5, 10);
    expect(interpolator.sample().get(1)!.x).toBeCloseTo(2, 10);
  });

  it('clamps at the target rather than extrapolating past it', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 0 })]);
    interpolator.advance(1);
    interpolator.receive([monster(1, { x: 4 })]);

    interpolator.advance(10);
    expect(interpolator.progress()).toBe(1);
    expect(interpolator.sample().get(1)!.x).toBe(4);
  });

  it('clamps a stalled gap to the ceiling, which is sized for one dropped message', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 0 })]);
    // A ten-second stall: the window must not become ten seconds.
    interpolator.advance(10);
    interpolator.receive([monster(1, { x: 4 })]);

    interpolator.advance(MAX_INTERPOLATION_SECONDS);
    expect(interpolator.progress()).toBe(1);
    // One dropped message at the 1 Hz cadence is a 2 s gap, and the ceiling has
    // to be able to span it without clamping.
    expect(MAX_INTERPOLATION_SECONDS).toBeGreaterThanOrEqual(DEFAULT_INTERPOLATION_SECONDS * 2);
  });

  it('drops a monster the moment it is absent from a message', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1)]);
    expect(interpolator.sample().size).toBe(1);

    interpolator.receive([]);
    expect(interpolator.sample().size).toBe(0);
  });

  it('does not blend a new arrival out of the departed one\'s position', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 100, y: 100 })]);
    interpolator.advance(1);
    // Banished, then a later arrival somewhere else — a NEW id, so no history.
    interpolator.receive([]);
    interpolator.advance(1);
    interpolator.receive([monster(2, { x: 0, y: 0 })]);

    const sampled = interpolator.sample().get(2)!;
    expect(sampled.x).toBe(0);
    expect(sampled.y).toBe(0);
  });

  it('turns the short way round through ±π', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(3 + (Math.PI * 2 - 6) / 2, 10);
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 10);
  });

  it('forgets everything on clear', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1)]);
    interpolator.clear();
    expect(interpolator.sample().size).toBe(0);
  });
});

describe('placement', () => {
  it('rides at its lurking depth when the water is deep enough', () => {
    const abyssY = -20;
    expect(monsterOriginWorldY(abyssY)).toBe(SEA_SURFACE_WORLD_Y - CTHULHU_LURK_DEPTH);
  });

  it('stands on the bottom rather than sinking through it', () => {
    // The shallowest water it can ever be in: exactly the deep threshold, three
    // bands = three world units below the surface.
    const shallowestLairY = -3;
    expect(monsterOriginWorldY(shallowestLairY)).toBe(shallowestLairY);
    expect(monsterOriginWorldY(shallowestLairY)).toBeGreaterThan(
      SEA_SURFACE_WORLD_Y - CTHULHU_LURK_DEPTH,
    );
  });

  it('assumes deep water, not band 0, when the chunk has not arrived', () => {
    // Band 0 is the sea SURFACE plane; clamping against it would beach the
    // model. Unknown must mean "no clamp".
    expect(monsterOriginWorldY(null)).toBe(SEA_SURFACE_WORLD_Y - CTHULHU_LURK_DEPTH);
    expect(monsterOriginWorldY(null)).toBeLessThan(SEA_LEVEL);
  });

  it('leaves the head clear of the water and the torso under it', () => {
    const originY = monsterOriginWorldY(-20);
    // Head bottom just under the surface by the waterline bite; head top well
    // clear of it.
    expect(originY + CTHULHU_HEAD_BOTTOM).toBeCloseTo(-CTHULHU_WATERLINE_BITE, 10);
    expect(originY + CTHULHU_HEAD_TOP).toBeGreaterThan(SEA_SURFACE_WORLD_Y);
    // Shoulder crowns break the surface; the whole torso does not.
    expect(originY + CTHULHU_SHOULDER_HEIGHT + CTHULHU_SHOULDER_THICKNESS / 2).toBeGreaterThan(
      SEA_SURFACE_WORLD_Y,
    );
    expect(originY + CTHULHU_TORSO_HEIGHT / 2).toBeLessThan(SEA_SURFACE_WORLD_Y);
  });

  it('is mostly submerged at its lurking depth', () => {
    const originY = monsterOriginWorldY(-20);
    const fraction = submergedFraction(originY, CTHULHU_TOTAL_HEIGHT);
    expect(fraction).toBeGreaterThan(0.5);
    expect(fraction).toBeLessThan(0.8);
  });
});

describe('silhouette', () => {
  it('is 10–14 cells tall, as briefed — several times a whale', () => {
    expect(CTHULHU_TOTAL_HEIGHT).toBeGreaterThanOrEqual(10);
    expect(CTHULHU_TOTAL_HEIGHT).toBeLessThanOrEqual(14);
  });

  it('has a fan of 6–8 face tentacles', () => {
    expect(CTHULHU_FACE_TENTACLE_COUNT).toBeGreaterThanOrEqual(6);
    expect(CTHULHU_FACE_TENTACLE_COUNT).toBeLessThanOrEqual(8);
    // Odd, so one tentacle hangs on the centre line and the fan is symmetric
    // about it rather than parted down the middle.
    expect(CTHULHU_FACE_TENTACLE_COUNT % 2).toBe(1);
  });

  it('agrees with the server about how wide it is', () => {
    // The server sizes its steering look-ahead off CTHULHU_FOOTPRINT_CELLS so
    // the body never swims into a cliff the centre point cleared. The server
    // half must not import the client half (it runs where three does not
    // exist), so the two numbers are pinned to each other HERE.
    expect(CTHULHU_WIDTH_CELLS).toBe(CTHULHU_FOOTPRINT_CELLS);
  });

  it('is taller than it is wide — the hunch, not a raft', () => {
    expect(CTHULHU_TOTAL_HEIGHT).toBeGreaterThan(CTHULHU_WIDTH_CELLS);
  });
});
