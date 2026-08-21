// The camera's ground floor. These test the CONTRACT — "the camera is never
// below its clearance over the ground under it" — not the render loop's
// wiring, because the contract is the thing that can be wrong in a way a
// player would see.

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
    // The case this whole module exists for: inside a mountain.
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
    // Only Y is the floor's business.
    expect(position.x).toBe(5);
    expect(position.z).toBe(5);
  });

  it('leaves a clear camera untouched and reports no move', () => {
    const position = { x: 0, y: 100, z: 0 };
    expect(applyGroundClearance(position, groundAt(16))).toBe(false);
    expect(position.y).toBe(100);
  });

  it('does not clamp where the ground is unknown', () => {
    // Off-world or pre-snapshot. Guessing sea level here would yank the camera
    // up out of a world that has not loaded yet.
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
    // The bug this fixes, stated as a test: the orbit clamp is measured to a
    // target on the base plane, so at maximum relief it permits a camera
    // BELOW the summit. The floor is what stops that, and it is the reason
    // CAMERA_MIN_DISTANCE is free to be smaller than the world's relief.
    // MAX_RELIEF_WORLD_UNITS is already a world-space height — the multiply by
    // CELL_WORLD_SIZE that stood here was correct only while relief was stated
    // in CELLS and a cell was a world unit, and on the re-sampled grid it
    // shrank the world's tallest possible summit to a quarter of itself, which
    // is below CAMERA_MIN_DISTANCE and so made the first assertion below fail
    // for the opposite of the reason it is testing.
    const maxSummitY = MAX_RELIEF_WORLD_UNITS;
    expect(CAMERA_MIN_DISTANCE).toBeLessThan(maxSummitY);
    expect(clearedCameraY(CAMERA_MIN_DISTANCE, maxSummitY)).toBeGreaterThan(
      maxSummitY,
    );
  });
});
