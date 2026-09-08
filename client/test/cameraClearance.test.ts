import { describe, expect, it } from 'vitest';

import {
  applyGroundClearance,
  clearedCameraY,
  type GroundHeightSampler,
} from '../src/render/cameraClearance.ts';
import {
  CAMERA_GROUND_CLEARANCE_WORLD_UNITS,
  CAMERA_MIN_DISTANCE,
  CAMERA_NEAR,
  HEIGHT_WORLD_SCALE,
  MAX_RELIEF_WORLD_UNITS,
} from '../src/config.ts';
import { BAND_HEIGHT } from '@terrace/shared';

const CLEARANCE = CAMERA_GROUND_CLEARANCE_WORLD_UNITS;

describe('clearedCameraY', () => {
  it('lifts a camera that is under the ground', () => {
    expect(clearedCameraY(2, 16)).toBe(16 + CLEARANCE);
  });

  it('lifts a camera that is above the ground but inside the clearance', () => {
    expect(clearedCameraY(16 + CLEARANCE / 2, 16)).toBe(16 + CLEARANCE);
  });

  it('leaves a camera that already clears the ground exactly where it is', () => {
    const high = 16 + CLEARANCE * 10;
    expect(clearedCameraY(high, 16)).toBe(high);
  });

  it('is idempotent — clamping an already-clamped height changes nothing', () => {
    const once = clearedCameraY(0, 7);
    expect(clearedCameraY(once, 7)).toBe(once);
  });

  it('holds the floor exactly at the boundary rather than nudging it', () => {
    const exactly = 16 + CLEARANCE;
    expect(clearedCameraY(exactly, 16)).toBe(exactly);
  });

  it('clears the ground at sea level too, where the ground is y = 0', () => {
    expect(clearedCameraY(0, 0)).toBe(CLEARANCE);
  });
});

describe('applyGroundClearance', () => {
  const groundAt = (y: number): GroundHeightSampler => () => y;

  it('raises the position in place and reports the move', () => {
    const position = { x: 5, y: 1, z: 5 };
    expect(applyGroundClearance(position, groundAt(16))).toBe(true);
    expect(position.y).toBe(16 + CLEARANCE);
    expect(position.x).toBe(5);
    expect(position.z).toBe(5);
  });

  it('leaves a clear camera untouched and reports no move', () => {
    const position = { x: 0, y: 100, z: 0 };
    expect(applyGroundClearance(position, groundAt(16))).toBe(false);
    expect(position.y).toBe(100);
  });

  it('does not clamp where the ground is unknown', () => {
    const position = { x: 0, y: -50, z: 0 };
    expect(applyGroundClearance(position, () => null)).toBe(false);
    expect(position.y).toBe(-50);
  });

  it('samples the ground at the camera XZ, not the origin', () => {
    const seen: Array<[number, number]> = [];
    const position = { x: 12.5, y: 0, z: -3.25 };
    applyGroundClearance(position, (x, z) => {
      seen.push([x, z]);
      return 0;
    });
    expect(seen).toEqual([[12.5, -3.25]]);
  });
});

describe('the clearance value itself', () => {
  it('clears the near plane, so the ground cannot cross it', () => {
    expect(CLEARANCE).toBeGreaterThan(CAMERA_NEAR);
  });

  it('clears one band step, so a single sculpt cannot swallow the camera', () => {
    expect(CLEARANCE).toBeGreaterThan(BAND_HEIGHT * HEIGHT_WORLD_SCALE);
  });

  it('is what actually bounds approach to the landscape, not the orbit clamp', () => {
    const maxSummitY = MAX_RELIEF_WORLD_UNITS;
    expect(CAMERA_MIN_DISTANCE).toBeLessThan(maxSummitY);
    expect(clearedCameraY(CAMERA_MIN_DISTANCE, maxSummitY)).toBeGreaterThan(
      maxSummitY,
    );
  });
});
