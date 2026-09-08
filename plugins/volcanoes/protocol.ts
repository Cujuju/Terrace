import { BAND_HEIGHT, MAX_HEIGHT, WORLD_UNITS_PER_BAND } from '@terrace/shared';

export { WORLD_UNITS_PER_BAND } from '@terrace/shared';

export const VENT_MIN_BANDS_ABOVE_SEA = 6;

export const GENESIS_CONE_BANDS = 4;

export const VENT_SUMMIT_WORLD_UNITS =
  (VENT_MIN_BANDS_ABOVE_SEA + GENESIS_CONE_BANDS) * WORLD_UNITS_PER_BAND;

export const FLOW_RADIUS_WORLD_UNITS = 1;

export const VOLCANOES_PLUGIN_NAME = 'volcanoes';

export const VOLCANOES_ALL_MESSAGE = 'all';

export const VOLCANOES_CHANGES_MESSAGE = 'changes';

export const VOLCANOES_ACTIVITY_SETTING_KEY = 'activity';

export type VolcanicActivity = 'none' | 'dormant' | 'active';

export const VOLCANIC_ACTIVITIES: readonly VolcanicActivity[] = [
  'none',
  'dormant',
  'active',
];

export const DEFAULT_VOLCANIC_ACTIVITY: VolcanicActivity = 'dormant';

export function parseActivity(value: string | undefined): VolcanicActivity {
  const found = VOLCANIC_ACTIVITIES.find((activity) => activity === value);
  return found ?? DEFAULT_VOLCANIC_ACTIVITY;
}

export interface VentState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly erupting: boolean;
}

export interface LavaCellState {
  readonly x: number;
  readonly y: number;
  readonly ageSeconds: number;
}

export interface VolcanoesAllPayload {
  readonly vents: readonly VentState[];
  readonly lava: readonly LavaCellState[];
}

export interface VolcanoesChangesPayload {
  readonly vents: readonly VentState[];
  readonly molten: readonly LavaCellState[];
  readonly forgotten: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

export const LAVA_COOL_SECONDS = 90;

export function heatFromAge(ageSeconds: number): number {
  if (!(ageSeconds > 0)) return 1;
  if (ageSeconds >= LAVA_COOL_SECONDS) return 0;
  return 1 - ageSeconds / LAVA_COOL_SECONDS;
}

export function lavaKey(x: number, y: number): number {
  return y * 0x10000 + x;
}

function isCell(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y } = value as Record<string, unknown>;
  return Number.isInteger(x) && Number.isInteger(y);
}

function parseVent(value: unknown): VentState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, x, y, erupting } = value as Record<string, unknown>;
  if (!Number.isInteger(id) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (typeof erupting !== 'boolean') return null;
  return { id: id as number, x: x as number, y: y as number, erupting };
}

function parseLavaCell(value: unknown): LavaCellState | null {
  if (!isCell(value)) return null;
  const { ageSeconds } = value as unknown as Record<string, unknown>;
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds)) return null;
  if (ageSeconds < 0) return null;
  return { x: value.x, y: value.y, ageSeconds: ageSeconds as number };
}

function parseList<T>(value: unknown, parseOne: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: T[] = [];
  for (const item of value) {
    const one = parseOne(item);
    if (one === null) return null;
    parsed.push(one);
  }
  return parsed;
}

export function parseAllPayload(payload: unknown): VolcanoesAllPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { vents, lava } = payload as Record<string, unknown>;
  const parsedVents = parseList(vents, parseVent);
  const parsedLava = parseList(lava, parseLavaCell);
  if (parsedVents === null || parsedLava === null) return null;
  return { vents: parsedVents, lava: parsedLava };
}

export function parseChangesPayload(payload: unknown): VolcanoesChangesPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { vents, molten, forgotten } = payload as Record<string, unknown>;
  const parsedVents = parseList(vents, parseVent);
  const parsedMolten = parseList(molten, parseLavaCell);
  const parsedForgotten = parseList(forgotten, (item) => (isCell(item) ? item : null));
  if (parsedVents === null || parsedMolten === null || parsedForgotten === null) {
    return null;
  }
  return { vents: parsedVents, molten: parsedMolten, forgotten: parsedForgotten };
}
