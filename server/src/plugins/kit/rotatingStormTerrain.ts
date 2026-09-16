import { SEA_LEVEL } from '@terrace/shared';
import type { RotatingStormWorld } from './rotatingStormTypes.ts';

const DISC_SAMPLE_SPOKES_PER_RING = 6;

const DISC_SAMPLE_INNER_RING_RADIUS_FRACTION = 0.55;

const DISC_SAMPLE_OUTER_RING_RADIUS_FRACTION = 1;

// Half a spoke gap, so the outer ring samples bearings the inner one misses.
const DISC_SAMPLE_OUTER_RING_PHASE_RADIANS = Math.PI / DISC_SAMPLE_SPOKES_PER_RING;

export const ROTATING_STORM_DISC_SAMPLE_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const offsets: Array<readonly [number, number]> = [[0, 0]];
  const rings: readonly (readonly [number, number])[] = [
    [DISC_SAMPLE_INNER_RING_RADIUS_FRACTION, 0],
    [DISC_SAMPLE_OUTER_RING_RADIUS_FRACTION, DISC_SAMPLE_OUTER_RING_PHASE_RADIANS],
  ];
  for (const [scale, phase] of rings) {
    for (let i = 0; i < DISC_SAMPLE_SPOKES_PER_RING; i++) {
      const angle = phase + (i * 2 * Math.PI) / DISC_SAMPLE_SPOKES_PER_RING;
      offsets.push([Math.cos(angle) * scale, Math.sin(angle) * scale]);
    }
  }
  return offsets;
})();

export function isWaterAt(world: RotatingStormWorld, x: number, y: number): boolean {
  return world.heightAt(x, y) <= SEA_LEVEL;
}

// Off-map samples count as water: the ocean is what lies beyond the edge.
export function waterFractionUnder(
  world: RotatingStormWorld,
  x: number,
  y: number,
  radius: number,
): number {
  let water = 0;
  for (const [dx, dy] of ROTATING_STORM_DISC_SAMPLE_OFFSETS) {
    const sx = Math.round(x + dx * radius);
    const sy = Math.round(y + dy * radius);
    const outside = sx < 0 || sy < 0 || sx >= world.worldSize || sy >= world.worldSize;
    if (outside || isWaterAt(world, sx, sy)) water++;
  }
  return water / ROTATING_STORM_DISC_SAMPLE_OFFSETS.length;
}
