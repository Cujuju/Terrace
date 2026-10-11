import { Vector4, type InstancedMesh } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { MAX_ACTIVE_TORNADOES, TORNADO_RADIUS_CELLS } from '../protocol.ts';

// A funnel keeps drawing while it disperses, so the ghost of a storm the
// server has already dropped needs a slot beside the live one that replaced it.
export const FUNNEL_SLOTS_PER_STORM = 2;

export const MAX_FUNNELS = MAX_ACTIVE_TORNADOES * FUNNEL_SLOTS_PER_STORM;

export const VISIBLE_VORTEX_FRACTION = 0.5;

export const FUNNEL_GROUND_RADIUS_WORLD_UNITS =
  TORNADO_RADIUS_CELLS * CELL_WORLD_SIZE * VISIBLE_VORTEX_FRACTION;

export const FUNNEL_SPIN_TURNS_PER_SECOND = 0.9;

export const TWO_PI = Math.PI * 2;

const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

// Seeds ride the slot, not the storm id: the layout attributes are written once
// at construction, so a funnel looks like the slot it stands in.
export function slotSeed(slot: number): number {
  return ((slot + 1) * GOLDEN_RATIO_CONJUGATE) % 1;
}

// What funnel.ts drives: a mesh whose layout never changes, whose only
// per-frame work is advancing phases the CPU has already wrapped.
export interface FunnelMesh {
  readonly mesh: InstancedMesh;
  advance(elapsed: number): void;
  dispose(): void;
}

export interface StormSlots {
  // What both shaders read per slot: (x, groundY, z, strength).
  readonly stand: Vector4[];
  claim(): number;
  place(slot: number, x: number, groundY: number, z: number, strength: number): void;
  release(slot: number): void;
  reset(): void;
  lit(): boolean;
}

// Per-slot ledger for the funnel meshes, in the shape createMassSlots gives the
// disc decks, plus a free list because funnels come and go within one world.
export function createStormSlots(maxFunnels: number): StormSlots {
  // Vector4 defaults w to 1; a slot starts parked, so strength starts at zero.
  const stand = Array.from({ length: maxFunnels }, () => new Vector4(0, 0, 0, 0));
  const free: number[] = [];
  let claimed = 0;
  let live = 0;

  function park(slot: number): void {
    const cell = stand[slot]!;
    if (cell.w !== 0) live--;
    cell.w = 0;
  }

  return {
    stand,

    claim(): number {
      const recycled = free.pop();
      if (recycled !== undefined) return recycled;
      if (claimed >= maxFunnels) return -1;
      return claimed++;
    },

    place(slot: number, x: number, groundY: number, z: number, strength: number): void {
      if (slot < 0) return;
      const cell = stand[slot]!;
      const wasDark = cell.w === 0;
      cell.set(x, groundY, z, Math.max(0, strength));
      if (wasDark && cell.w > 0) live++;
      else if (!wasDark && cell.w === 0) live--;
    },

    release(slot: number): void {
      if (slot < 0) return;
      park(slot);
      free.push(slot);
    },

    reset(): void {
      for (const cell of stand) cell.set(0, 0, 0, 0);
      free.length = 0;
      claimed = 0;
      live = 0;
    },

    lit(): boolean {
      return live > 0;
    },
  };
}
