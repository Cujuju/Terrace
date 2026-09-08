import {
  WORLD_UNIT_CELLS,
  cellsAcross,
} from '@terrace/shared';

export const SETTLER_RACES = ['rudy', 'uno'] as const;

export type SettlerRace = (typeof SETTLER_RACES)[number];

export const SETTLER_DISTRICT_CELLS = cellsAcross(16);

function hashDistrict(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function settlementRace(x: number, y: number): SettlerRace {
  const districtX = Math.floor(x / SETTLER_DISTRICT_CELLS);
  const districtY = Math.floor(y / SETTLER_DISTRICT_CELLS);
  return SETTLER_RACES[(hashDistrict(districtX, districtY) >>> 24) & 1];
}

export const RACE_SINGULAR: Record<SettlerRace, string> = {
  rudy: 'Rudy',
  uno: 'Uno',
};

export const RACE_PLURAL: Record<SettlerRace, string> = {
  rudy: 'Rudys',
  uno: 'Unos',
};
