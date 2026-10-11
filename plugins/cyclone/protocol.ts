import { cellsAcross } from '@terrace/shared';

export const CYCLONE_PLUGIN_NAME = 'cyclone';

export const CYCLONE_ALL_MESSAGE = 'all';

export const CYCLONE_DAMAGE_EVENT = 'damage';

export const CYCLONE_LANDFALL_EVENT = 'landfall';

export const CYCLONE_FREQUENCY_SETTING_KEY = 'cyclone-frequency';

export const CYCLONE_FREQUENCIES = ['off', 'rare', 'common'] as const;
export type CycloneFrequency = (typeof CYCLONE_FREQUENCIES)[number];

export const DEFAULT_CYCLONE_FREQUENCY: CycloneFrequency = 'rare';

export const FREQUENCY_INTERVAL_MULTIPLIERS: Readonly<Record<'rare' | 'common', number>> = {
  rare: 2,
  common: 0.5,
};

// One switch for everything a cyclone does to the ground: surge and wind scour.
export const CYCLONE_DAMAGE_SETTING_KEY = 'cyclone-damage';

export const CYCLONE_DAMAGE_FORMER_SETTING_KEYS = ['cyclone-surge'] as const;

export const CYCLONE_DAMAGE_MODES = ['off', 'on'] as const;
export type CycloneDamageMode = (typeof CYCLONE_DAMAGE_MODES)[number];

export const DEFAULT_CYCLONE_DAMAGE_MODE: CycloneDamageMode = 'on';

export function parseFrequency(value: string | undefined): CycloneFrequency {
  return CYCLONE_FREQUENCIES.includes(value as CycloneFrequency)
    ? (value as CycloneFrequency)
    : DEFAULT_CYCLONE_FREQUENCY;
}

export function parseDamageMode(value: string | undefined): CycloneDamageMode {
  return CYCLONE_DAMAGE_MODES.includes(value as CycloneDamageMode)
    ? (value as CycloneDamageMode)
    : DEFAULT_CYCLONE_DAMAGE_MODE;
}

export const CYCLONE_BASIN_NAMES = ['hurricane', 'typhoon', 'cyclone'] as const;
export type CycloneBasinName = (typeof CYCLONE_BASIN_NAMES)[number];

export function basinNameFor(x: number, y: number, worldSize: number): CycloneBasinName {
  const half = worldSize / 2;
  if (y >= half) return 'cyclone';
  return x < half ? 'hurricane' : 'typhoon';
}

export const CYCLONE_GIVEN_NAMES: readonly string[] = [
  'Ada',
  'Bramble',
  'Cinder',
  'Dagon',
  'Elgar',
  'Fenwick',
  'Grist',
  'Halloway',
  'Ivory',
  'Juniper',
  'Kestrel',
  'Lorne',
  'Marrow',
  'Nettle',
  'Osprey',
  'Pell',
  'Rowan',
  'Sable',
  'Thorne',
  'Vesper',
  'Wren',
];

export function givenNameFor(index: number): string {
  const names = CYCLONE_GIVEN_NAMES;
  return names[((index % names.length) + names.length) % names.length]!;
}

export function cycloneNameFor(index: number, x: number, y: number, worldSize: number): string {
  const basin = basinNameFor(x, y, worldSize);
  return `${basin.charAt(0).toUpperCase()}${basin.slice(1)} ${givenNameFor(index)}`;
}

export const CYCLONE_RADIUS_CELLS = cellsAcross(30);

export const CYCLONE_MAX_RADIUS_WORLD_FRACTION = 0.3;

export function cycloneRadiusFor(worldSize: number): number {
  return Math.min(CYCLONE_RADIUS_CELLS, worldSize * CYCLONE_MAX_RADIUS_WORLD_FRACTION);
}

export const CYCLONE_EYE_RADIUS_FRACTION = 0.125;

// The roster ceiling both halves size to: the server profile's cap and the
// client's spiral slots.
export const MAX_ACTIVE_CYCLONES = 1;

export interface CycloneDamagePayload {
  readonly stormId: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly eyeRadius: number;
  readonly intensity: number;
  readonly durationSeconds: number;
  readonly cells: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly severity: number;
  }>;
}

export interface CycloneLandfallPayload {
  readonly stormId: number;
  readonly x: number;
  readonly y: number;
  readonly intensity: number;
  readonly name?: string;
}

export {
  BROADCAST_POSITION_DECIMALS,
  parseRotatingStormsPayload as parseAllPayload,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type RotatingStormState as CycloneState,
} from '@terrace/shared';
