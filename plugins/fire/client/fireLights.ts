import { Group, PointLight } from 'three';
import type { FireInstance } from './flames/types.ts';

export const FIRE_LIGHT_POOL_SIZE = 4;

export const FIRE_LIGHT_RANGE_WORLD_UNITS = 6;

export const FIRE_LIGHT_MIN_SEPARATION_WORLD_UNITS = FIRE_LIGHT_RANGE_WORLD_UNITS / 2;

const CANDIDATES_PER_FREE_SLOT = 4;

export const FIRE_LIGHT_PEAK_INTENSITY = 2.5;

export const FIRE_LIGHT_HEIGHT_FRACTION_OF_FUEL = 0.5;

export const FIRE_LIGHT_MIN_HEIGHT_WORLD_UNITS = 0.5;

export const FIRE_LIGHT_COLOR = 0xff7a33;

export const FIRE_LIGHT_REASSIGN_SECONDS = 0.25;

export const FIRE_LIGHT_HOLD_MIN_INTENSITY = 0.35;

export const FIRE_LIGHT_HANDOVER_SECONDS = 0.3;

const HANDOVER_RAMP_SECONDS = FIRE_LIGHT_HANDOVER_SECONDS / 2;

export interface FireLights {
  readonly root: Group;
  update(fires: readonly FireInstance[], dt: number): void;
  darken(): void;
}

type SlotPhase = 'steady' | 'fadingOut' | 'fadingIn';

interface LightSlot {
  readonly light: PointLight;
  heldKey: number;
  pendingKey: number;
  phase: SlotPhase;
  envelope: number;
}

export function createFireLights(): FireLights {
  const root = new Group();
  root.name = 'fire:lights';

  const slots: LightSlot[] = [];
  for (let index = 0; index < FIRE_LIGHT_POOL_SIZE; index++) {
    const light = new PointLight(FIRE_LIGHT_COLOR, 0, FIRE_LIGHT_RANGE_WORLD_UNITS);
    light.visible = true;
    root.add(light);
    slots.push({ light, heldKey: 0, pendingKey: 0, phase: 'steady', envelope: 0 });
  }

  let sinceReassignSeconds = FIRE_LIGHT_REASSIGN_SECONDS;

  const heldFires: (FireInstance | null)[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(null);

  const candidates: (FireInstance | null)[] = new Array(
    FIRE_LIGHT_POOL_SIZE * CANDIDATES_PER_FREE_SLOT,
  ).fill(null);
  let candidateCount = 0;

  const litX: number[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(0);
  const litZ: number[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(0);
  let litCount = 0;

  const MIN_SEPARATION_SQUARED =
    FIRE_LIGHT_MIN_SEPARATION_WORLD_UNITS * FIRE_LIGHT_MIN_SEPARATION_WORLD_UNITS;

  function isSeparated(fire: FireInstance): boolean {
    for (let index = 0; index < litCount; index++) {
      const dx = fire.x - litX[index]!;
      const dz = fire.z - litZ[index]!;
      if (dx * dx + dz * dz < MIN_SEPARATION_SQUARED) return false;
    }
    return true;
  }

  const slotIsFree: boolean[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(false);

  function resolveHeld(fires: readonly FireInstance[]): void {
    let unresolved = 0;
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      heldFires[slot] = null;
      if (slots[slot]!.heldKey !== 0) unresolved++;
    }

    if (unresolved > 0) {
      for (const fire of fires) {
        for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
          if (heldFires[slot] === null && slots[slot]!.heldKey === fire.key) {
            heldFires[slot] = fire;
            unresolved--;
            break;
          }
        }
        if (unresolved === 0) break;
      }
    }

    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      const state = slots[slot]!;
      if (state.heldKey === 0 || heldFires[slot] !== null) continue;
      state.heldKey = state.pendingKey;
      state.pendingKey = 0;
      state.envelope = 0;
      state.phase = state.heldKey === 0 ? 'steady' : 'fadingIn';
    }
  }

  function isSpokenFor(key: number): boolean {
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      const state = slots[slot]!;
      if (state.heldKey === key || state.pendingKey === key) return true;
    }
    return false;
  }

  function offerCandidate(fire: FireInstance, wanted: number): void {
    let position = candidateCount;
    while (position > 0) {
      const above = candidates[position - 1]!;
      const better =
        fire.intensity > above.intensity ||
        (fire.intensity === above.intensity && fire.key < above.key);
      if (!better) break;
      if (position < wanted) candidates[position] = above;
      position--;
    }
    if (position >= wanted) return;
    candidates[position] = fire;
    if (candidateCount < wanted) candidateCount++;
  }

  function reassign(fires: readonly FireInstance[]): void {
    let freeCount = 0;
    litCount = 0;
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      const state = slots[slot]!;
      const held = heldFires[slot];
      const keeps =
        state.phase !== 'fadingOut' &&
        held !== null &&
        held.intensity >= FIRE_LIGHT_HOLD_MIN_INTENSITY;
      slotIsFree[slot] = !keeps;
      if (!keeps) freeCount++;
      else {
        litX[litCount] = held.x;
        litZ[litCount] = held.z;
        litCount++;
      }
    }
    if (freeCount === 0) return;

    candidateCount = 0;
    const wanted = freeCount * CANDIDATES_PER_FREE_SLOT;
    for (const fire of fires) {
      if (fire.intensity <= 0) continue;
      if (isSpokenFor(fire.key)) continue;
      if (!isSeparated(fire)) continue;
      offerCandidate(fire, wanted);
    }
    if (candidateCount === 0) return;

    let next = 0;
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE && next < candidateCount; slot++) {
      if (!slotIsFree[slot]) continue;
      let fire: FireInstance | null = null;
      while (next < candidateCount) {
        const candidate = candidates[next]!;
        next++;
        if (isSeparated(candidate)) {
          fire = candidate;
          break;
        }
      }
      if (fire === null) break;
      litX[litCount] = fire.x;
      litZ[litCount] = fire.z;
      litCount++;
      const state = slots[slot]!;
      if (state.envelope <= 0) {
        state.heldKey = fire.key;
        state.pendingKey = 0;
        state.phase = 'fadingIn';
        heldFires[slot] = fire;
      } else {
        state.pendingKey = fire.key;
        state.phase = 'fadingOut';
      }
    }
  }

  function advance(state: LightSlot, slot: number, dt: number): void {
    if (state.phase === 'fadingIn') {
      state.envelope = Math.min(1, state.envelope + dt / HANDOVER_RAMP_SECONDS);
      if (state.envelope >= 1) state.phase = 'steady';
      return;
    }
    if (state.phase === 'fadingOut') {
      state.envelope = Math.max(0, state.envelope - dt / HANDOVER_RAMP_SECONDS);
      if (state.envelope > 0) return;
      state.heldKey = state.pendingKey;
      state.pendingKey = 0;
      state.phase = state.heldKey === 0 ? 'steady' : 'fadingIn';
      heldFires[slot] = null;
      return;
    }
    state.envelope = state.heldKey === 0 ? 0 : 1;
  }

  return {
    root,

    update(fires: readonly FireInstance[], dt: number): void {
      sinceReassignSeconds += dt;

      resolveHeld(fires);

      if (sinceReassignSeconds >= FIRE_LIGHT_REASSIGN_SECONDS) {
        sinceReassignSeconds = 0;
        reassign(fires);
      }

      for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
        const state = slots[slot]!;
        advance(state, slot, dt);

        const fire = heldFires[slot];
        if (fire === null) {
          state.light.intensity = 0;
          continue;
        }
        state.light.position.set(
          fire.x,
          fire.groundY +
            Math.max(
              fire.fuelHeight * FIRE_LIGHT_HEIGHT_FRACTION_OF_FUEL,
              FIRE_LIGHT_MIN_HEIGHT_WORLD_UNITS,
            ),
          fire.z,
        );
        state.light.intensity = fire.intensity * FIRE_LIGHT_PEAK_INTENSITY * state.envelope;
      }
    },

    darken(): void {
      for (const state of slots) {
        state.heldKey = 0;
        state.pendingKey = 0;
        state.phase = 'steady';
        state.envelope = 0;
        state.light.intensity = 0;
      }
    },
  };
}
