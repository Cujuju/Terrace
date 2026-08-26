// Client-half tests: the wire validator and the interpolator. Both are pure
// logic (no three, no DOM, no clock), which is the half of a render feature
// this project tests — design §8 ships no headless GL rig.

import { describe, expect, it } from 'vitest';
import {
  BOATS_PAYLOAD_CAP,
  BROADCAST_POSITION_DECIMALS,
  parseBoatsPayload,
  roundBroadcastPosition,
  type BoatState,
} from '../protocol.ts';
import {
  BoatInterpolator,
  DEFAULT_INTERPOLATION_SECONDS,
  MAX_INTERPOLATION_SECONDS,
  lerpAngle,
} from '../client/interpolation.ts';

function boat(id: number, x: number, y: number, heading = 0, fighting = false): BoatState {
  return { id, x, y, heading, fighting };
}

describe('the boats:state wire contract', () => {
  it('reads a well-formed payload', () => {
    expect(parseBoatsPayload({ boats: [boat(1, 2.5, 3.5, 0.25, true)] })).toEqual([
      { id: 1, x: 2.5, y: 3.5, heading: 0.25, fighting: true },
    ]);
  });

  it('treats an empty list as the despawn, not as malformed', () => {
    expect(parseBoatsPayload({ boats: [] })).toEqual([]);
  });

  it('rejects malformed payloads whole', () => {
    expect(parseBoatsPayload(null)).toBeNull();
    expect(parseBoatsPayload({})).toBeNull();
    expect(parseBoatsPayload({ boats: [{ id: 1, x: 1, y: 2, heading: 0 }] })).toBeNull();
    expect(parseBoatsPayload({ boats: [{ id: -1, x: 1, y: 2, heading: 0, fighting: false }] })).toBeNull();
    expect(parseBoatsPayload({ boats: [{ id: 1, x: Number.NaN, y: 2, heading: 0, fighting: false }] })).toBeNull();
    expect(parseBoatsPayload({ boats: [{ id: 1.5, x: 1, y: 2, heading: 0, fighting: false }] })).toBeNull();
  });

  it('refuses a payload past the defensive cap', () => {
    const boats = Array.from({ length: BOATS_PAYLOAD_CAP + 1 }, (_unused, i) => boat(i, 0, 0));
    expect(parseBoatsPayload({ boats })).toBeNull();
  });

  it('rounds broadcast positions to the documented precision', () => {
    expect(roundBroadcastPosition(1.23456)).toBe(1.23);
    expect(BROADCAST_POSITION_DECIMALS).toBe(2);
  });
});

describe('BoatInterpolator', () => {
  it('starts a first-seen boat exactly where the server says it is', () => {
    const interpolator = new BoatInterpolator();
    interpolator.receive([boat(1, 10, 20)]);
    const pose = interpolator.sample().get(1);
    expect(pose?.x).toBe(10);
    expect(pose?.y).toBe(20);
  });

  it('glides between two messages', () => {
    const interpolator = new BoatInterpolator();
    interpolator.receive([boat(1, 0, 0)]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([boat(1, 10, 0)]);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    const midway = interpolator.sample().get(1);
    expect(midway?.x).toBeGreaterThan(0);
    expect(midway?.x).toBeLessThan(10);
  });

  it('clamps at the destination rather than extrapolating past it', () => {
    // A boat holding station at the edge of a fight is stationary for long
    // stretches; overshooting a thing that has stopped is worse than briefly
    // holding still.
    const interpolator = new BoatInterpolator();
    interpolator.receive([boat(1, 0, 0)]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([boat(1, 10, 0)]);

    interpolator.advance(MAX_INTERPOLATION_SECONDS * 10);
    expect(interpolator.sample().get(1)?.x).toBe(10);
  });

  it('drops a boat the moment it leaves the list', () => {
    // It sank, or it left this player's view. Easing it onward would read as
    // sailing away, which is the opposite of what happened.
    const interpolator = new BoatInterpolator();
    interpolator.receive([boat(1, 0, 0), boat(2, 5, 5)]);
    interpolator.receive([boat(2, 5, 5)]);
    expect(interpolator.sample().has(1)).toBe(false);
    expect(interpolator.sample().has(2)).toBe(true);
  });

  it('takes `fighting` from the message rather than interpolating it', () => {
    const interpolator = new BoatInterpolator();
    interpolator.receive([boat(1, 0, 0, 0, false)]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([boat(1, 1, 0, 0, true)]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 4);
    // A quarter of the way through the glide, and already fully engaged:
    // half-fighting is not a state.
    expect(interpolator.sample().get(1)?.fighting).toBe(true);
  });

  it('continues from the pose being rendered, not from the last message', () => {
    // A late message must not make the boat jump back to re-run ground it has
    // already covered.
    const interpolator = new BoatInterpolator();
    interpolator.receive([boat(1, 0, 0)]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([boat(1, 10, 0)]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS * 0.75);
    const beforeNext = interpolator.sample().get(1)!.x;

    interpolator.receive([boat(1, 20, 0)]);
    const afterNext = interpolator.sample().get(1)!.x;
    expect(afterNext).toBeCloseTo(beforeNext, 6);
  });

  it('turns the short way round', () => {
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI, 6);
  });

  it('forgets everything on clear', () => {
    const interpolator = new BoatInterpolator();
    interpolator.receive([boat(1, 1, 1)]);
    interpolator.clear();
    expect(interpolator.sample().size).toBe(0);
  });
});
