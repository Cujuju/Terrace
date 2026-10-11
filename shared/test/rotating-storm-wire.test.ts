import { describe, expect, it } from 'vitest';
import { parseRotatingStormsPayload } from '../src/rotatingStormWire.ts';

function storm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, x: 10, y: 20, radius: 6, intensity: 0.5, vx: 1, vy: 2, ...overrides };
}

describe('parseRotatingStormsPayload', () => {
  it('reads a whole payload back as it was sent', () => {
    const payload = { storms: [storm(), storm({ id: 2, name: 'Hurricane Ada' })] };
    expect(parseRotatingStormsPayload(payload)).toEqual(payload);
  });

  it('refuses a payload that is not one at all', () => {
    expect(parseRotatingStormsPayload(null)).toBeNull();
    expect(parseRotatingStormsPayload({})).toBeNull();
    expect(parseRotatingStormsPayload({ storms: 'a sky' })).toBeNull();
  });

  it('drops the storm it cannot read rather than the whole sky', () => {
    const parsed = parseRotatingStormsPayload({
      storms: [
        storm({ id: 0 }),
        storm({ id: 1.5 }),
        storm({ id: 2, radius: 0 }),
        storm({ id: 3, x: Number.NaN }),
        'not a storm',
        storm({ id: 4 }),
      ],
    });
    expect(parsed?.storms.map((one) => one.id)).toEqual([4]);
  });

  it('keeps the first of a repeated id, so one storm cannot hold two slots', () => {
    const parsed = parseRotatingStormsPayload({
      storms: [storm({ id: 1, x: 10 }), storm({ id: 1, x: 99 })],
    });
    expect(parsed?.storms).toHaveLength(1);
    expect(parsed?.storms[0]?.x).toBe(10);
  });

  it('stops at the ceiling the caller can draw', () => {
    const CEILING = 2;
    const parsed = parseRotatingStormsPayload(
      { storms: [storm({ id: 1 }), storm({ id: 2 }), storm({ id: 3 })] },
      CEILING,
    );
    expect(parsed?.storms.map((one) => one.id)).toEqual([1, 2]);
  });

  it('clamps an intensity that arrived outside [0, 1]', () => {
    const parsed = parseRotatingStormsPayload({
      storms: [storm({ id: 1, intensity: 4 }), storm({ id: 2, intensity: -1 })],
    });
    expect(parsed?.storms.map((one) => one.intensity)).toEqual([1, 0]);
  });
});
