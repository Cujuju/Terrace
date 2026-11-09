import { describe, expect, it } from 'vitest';
import { drawnBandOfSample, MAX_HEIGHT, MIN_HEIGHT, BAND_HEIGHT } from '../src/index.ts';
import {
  createOutlineDistanceQuery, createNearestPointQuery, nearestPoint, signedDistance, traceBandOutlines,
} from '../src/sculpt/outlineField.ts';
import { OUTLINE_FIXED_POINT, type Point } from '../src/sculpt/outlineTrace.ts';

const point = (x: number, y: number): Point => ({ x, y, pinned: false });

describe('indexed outline queries', () => {
  it('preserves projections, integer distances, signs and original tie order', () => {
    const lines = [
      [point(-700, -200), point(900, 400)],
      [point(0, 1), point(0, 1)],
      [point(1000, -500), point(1000, 500)],
      [point(-1000, -500), point(-1000, 500)],
    ];
    const reach = 2 * OUTLINE_FIXED_POINT;
    const distance = createOutlineDistanceQuery(lines, reach);
    const nearest = createNearestPointQuery(lines);
    for (let y = -1024; y <= 1024; y += 127) for (let x = -1024; x <= 1024; x += 131) {
      const expected = signedDistance(lines, x, y);
      expect(distance(x, y)).toBe(expected !== null && Math.abs(expected) <= reach ? expected : null);
      expect(nearest(point(x, y))).toEqual(nearestPoint(lines, point(x, y)));
    }
  });

  it('keeps the floored distance at the reach boundary and handles empty outlines', () => {
    const reach = OUTLINE_FIXED_POINT;
    const lines = [[point(reach, 1), point(reach, 2)]];
    expect(Math.abs(signedDistance(lines, 0, 0)!)).toBe(reach);
    expect(createOutlineDistanceQuery(lines, reach)(0, 0)).toBe(signedDistance(lines, 0, 0));
    expect(createOutlineDistanceQuery([], reach)(0, 0)).toBeNull();
    expect(createNearestPointQuery([])(point(0, 0))).toBeNull();
  });

  it('reads fewer segments for a local query than an exhaustive scan', () => {
    let reads = 0;
    const measuredPoint = (x: number, y: number): Point => ({ get x() { reads++; return x; }, y, pinned: false });
    const lines = Array.from({ length: 100 }, (_, i) => [
      measuredPoint(i * OUTLINE_FIXED_POINT, 0), measuredPoint(i * OUTLINE_FIXED_POINT, OUTLINE_FIXED_POINT),
    ]);
    const query = createOutlineDistanceQuery(lines, OUTLINE_FIXED_POINT);
    reads = 0;
    query(1, 1);
    const indexedReads = reads;
    reads = 0;
    signedDistance(lines, 1, 1);
    expect(indexedReads).toBeLessThan(reads);
  });
});

describe('stacked wall tracing', () => {
  it('does not retrace unchanged folded fields for additional stacked bands', () => {
    const trace = (high: number) => {
      let reads = 0;
      const lines = traceBandOutlines((x) => { reads++; return x < 8 ? MIN_HEIGHT : high; },
        drawnBandOfSample(MIN_HEIGHT), drawnBandOfSample(high), 0, 0, 16, 16);
      return { lines, reads };
    };
    const single = trace(MIN_HEIGHT + BAND_HEIGHT);
    const stacked = trace(MAX_HEIGHT);
    expect(stacked.reads).toBe(single.reads);
    for (const line of stacked.lines.values()) expect(line).toEqual([...single.lines.values()][0]);
  });
});
