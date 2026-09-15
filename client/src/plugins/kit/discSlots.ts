import { Vector2 } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { InterpolatedDisc } from './discInterpolator.ts';

export interface MassSlots {
  readonly massXZ: Vector2[];
  readonly massSize: Vector2[];
  readonly massVelocity: Vector2[];
  claim(): number;
  update(slot: number, disc: InterpolatedDisc): boolean;
  updateWorld(
    slot: number,
    x: number,
    z: number,
    radius: number,
    intensity: number,
    vx: number,
    vz: number,
  ): boolean;
  park(slot: number): boolean;
  reset(): void;
}

// Per-kind slot ledger shared by every instanced deck: world-unit centre,
// (radius, intensity) and velocity per slot, plus whether any slot is lit.
export function createMassSlots(maxMasses: number): MassSlots {
  const massXZ = Array.from({ length: maxMasses }, () => new Vector2());
  const massSize = Array.from({ length: maxMasses }, () => new Vector2());
  const massVelocity = Array.from({ length: maxMasses }, () => new Vector2());
  let claimed = 0;
  let live = 0;

  function updateWorld(
    slot: number,
    x: number,
    z: number,
    radius: number,
    rawIntensity: number,
    vx: number,
    vz: number,
  ): boolean {
    if (slot < 0) return live > 0;
    const intensity = Math.max(0, rawIntensity);
    const wasDark = massSize[slot]!.y === 0;
    massXZ[slot]!.set(x, z);
    massSize[slot]!.set(radius, intensity);
    massVelocity[slot]!.set(vx, vz);
    if (wasDark && intensity > 0) live++;
    if (!wasDark && intensity === 0) live--;
    return live > 0;
  }

  return {
    massXZ,
    massSize,
    massVelocity,

    claim(): number {
      if (claimed >= maxMasses) return -1;
      return claimed++;
    },

    update(slot: number, disc: InterpolatedDisc): boolean {
      return updateWorld(
        slot,
        disc.x * CELL_WORLD_SIZE,
        disc.y * CELL_WORLD_SIZE,
        disc.radius * CELL_WORLD_SIZE,
        disc.intensity,
        disc.vx * CELL_WORLD_SIZE,
        disc.vy * CELL_WORLD_SIZE,
      );
    },

    updateWorld,

    park(slot: number): boolean {
      if (slot < 0) return live > 0;
      if (massSize[slot]!.y !== 0) live--;
      massSize[slot]!.y = 0;
      return live > 0;
    },

    reset(): void {
      claimed = 0;
      live = 0;
      for (const size of massSize) size.set(0, 0);
    },
  };
}
