export const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_ALL_MESSAGE = 'all';

export const STRUCTURES_CHANGES_MESSAGE = 'changes';

export const STRUCTURES_CAP = 512;

export const STRUCTURE_TIERS = [
  'camp',
  'hut',
  'timber-house',
  'longhouse',
  'stone-cottage',
  'watchtower',
] as const;

export type StructureTier = number;

export const STRUCTURE_TIER_COUNT = STRUCTURE_TIERS.length;

export const MAX_STRUCTURE_TIER = STRUCTURE_TIER_COUNT - 1;

export function isStructureTier(value: unknown): value is StructureTier {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < STRUCTURE_TIER_COUNT;
}

export interface StructureCell {
  readonly x: number;
  readonly y: number;
  readonly tier: StructureTier;
}

export const STRUCTURES_CELL_KEY_STRIDE = 65536;

export function structureKey(x: number, y: number): number {
  return y * STRUCTURES_CELL_KEY_STRIDE + x;
}

export function cellOfKey(key: number): { x: number; y: number } {
  return { x: key % STRUCTURES_CELL_KEY_STRIDE, y: Math.floor(key / STRUCTURES_CELL_KEY_STRIDE) };
}

export function packStructureCells(cells: Iterable<StructureCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y, cell.tier);
  return packed;
}

function isCellCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < STRUCTURES_CELL_KEY_STRIDE
  );
}

export function parseStructureCells(value: unknown): StructureCell[] | null {
  if (!Array.isArray(value)) return null;

  const cells: StructureCell[] = [];
  for (let i = 0; i + 2 < value.length; i += 3) {
    if (cells.length >= STRUCTURES_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    const tier = value[i + 2];
    if (!isCellCoordinate(x) || !isCellCoordinate(y) || !isStructureTier(tier)) continue;
    cells.push({ x, y, tier });
  }
  return cells;
}

export function packCells(cells: Iterable<{ readonly x: number; readonly y: number }>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseCells(value: unknown): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(value)) return null;

  const cells: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= STRUCTURES_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

export interface StructuresAllPayload {
  readonly structures: readonly number[];
}

export interface StructuresChangesPayload {
  readonly founded: readonly number[];
  readonly upgraded: readonly number[];
  readonly demolished: readonly number[];
}

export function parseAllPayload(payload: unknown): StructureCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseStructureCells((payload as { structures?: unknown }).structures);
}

export function parseChangesPayload(
  payload: unknown,
): { founded: StructureCell[]; upgraded: StructureCell[]; demolished: Array<{ x: number; y: number }> } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { founded?: unknown; upgraded?: unknown; demolished?: unknown };
  const founded = parseStructureCells(message.founded ?? []);
  const upgraded = parseStructureCells(message.upgraded ?? []);
  const demolished = parseCells(message.demolished ?? []);
  if (founded === null || upgraded === null || demolished === null) return null;
  return { founded, upgraded, demolished };
}

const TWO_PI = Math.PI * 2;

export const STRUCTURE_SCALE_MIN = 0.9;
export const STRUCTURE_SCALE_MAX = 1.1;

export const STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS = 1;

export interface StructureVariation {
  readonly yaw: number;
  readonly scale: number;
}

export function hashStructureCell(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function structureVariation(x: number, y: number): StructureVariation {
  const hash = hashStructureCell(x, y);
  const yawRoll = hash & 0xffff;
  const scaleRoll = (hash >>> 16) & 0xff;
  return {
    yaw: (yawRoll / 0x10000) * TWO_PI,
    scale: STRUCTURE_SCALE_MIN + (scaleRoll / 0xff) * (STRUCTURE_SCALE_MAX - STRUCTURE_SCALE_MIN),
  };
}

import {
  CELL_WORLD_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
} from '@terrace/shared';

export const STRUCTURE_SURVEY_RADIUS_CELLS = Math.ceil(
  cellsAcross(STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS / 2),
);

export const STRUCTURE_SURVEYED_GROUND_RADIUS =
  (STRUCTURE_SURVEY_RADIUS_CELLS + 0.5) * CELL_WORLD_SIZE;

export const STRUCTURE_SEPARATION_WORLD_UNITS = STRUCTURE_SURVEYED_GROUND_RADIUS * 2;

export const STRUCTURE_SEPARATION_CELLS_SQUARED =
  cellsAcross(STRUCTURE_SEPARATION_WORLD_UNITS) ** 2;

export const STRUCTURE_SEPARATION_CELLS = Math.ceil(
  cellsAcross(STRUCTURE_SEPARATION_WORLD_UNITS),
);

export const SETTLER_RACES = ['rudy', 'uno'] as const;

export type SettlerRace = (typeof SETTLER_RACES)[number];

export const SETTLER_DISTRICT_CELLS = cellsAcross(16);

export function settlementRace(x: number, y: number): SettlerRace {
  const districtX = Math.floor(x / SETTLER_DISTRICT_CELLS);
  const districtY = Math.floor(y / SETTLER_DISTRICT_CELLS);
  return SETTLER_RACES[(hashStructureCell(districtX, districtY) >>> 24) & 1];
}

export const HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.75;
