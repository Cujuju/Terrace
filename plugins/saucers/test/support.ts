import { createSeededRng } from '@terrace/shared';
import { worldWithSibling } from '../../../server/test/support/harness.ts';
import { resetSaucersState } from '../server/index.ts';
import { type EncounterWorld } from '../server/encounter.ts';
import { loadFireBridge } from '../server/fire-bridge.ts';
import { loadStructuresBridge } from '../server/structures-bridge.ts';
import { setSaucerRandomSource } from '../server/rng.ts';

export const WORLD_SIZE = 512;
export const TICK_SECONDS = 0.1;
export const MAX_ENCOUNTER_TICKS = 400;
export const CENTRE = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
export const LAND_HEIGHT = 40;

export interface StandingBuilding {
  readonly x: number;
  readonly y: number;
  readonly footprintRadiusCells: number;
}

export function buildingsBridge(buildings: readonly StandingBuilding[]): void {
  loadStructuresBridge(worldWithSibling('structures', { standingStructures: () => buildings }));
}

export function encounterFixture() {
  const sculpts: number[][] = [];
  const ignitions: number[][] = [];
  let height = LAND_HEIGHT;
  const world: EncounterWorld = {
    worldSize: WORLD_SIZE,
    heightAt: () => height,
    isCellUnlocked: () => true,
    sculpt: (x, y, radius, amount) => { sculpts.push([x, y, radius, amount]); },
  };
  loadFireBridge(worldWithSibling('fire', {
    igniteAt: (x: number, y: number) => { ignitions.push([x, y]); return true; },
  }));
  return { world, sculpts, ignitions, setHeight: (next: number) => { height = next; } };
}

export function isolated(verify: () => void): void {
  const random = Math.random;
  resetSaucersState();
  Math.random = createSeededRng(12345).next;
  setSaucerRandomSource(() => 1);
  try {
    verify();
  } finally {
    Math.random = random;
    resetSaucersState();
    setSaucerRandomSource(null);
  }
}
