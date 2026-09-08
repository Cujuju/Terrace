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

export const CYCLONE_SURGE_SETTING_KEY = 'cyclone-surge';

export const CYCLONE_SURGE_MODES = ['off', 'on'] as const;
export type CycloneSurgeMode = (typeof CYCLONE_SURGE_MODES)[number];

export const DEFAULT_CYCLONE_SURGE_MODE: CycloneSurgeMode = 'on';

export function parseFrequency(value: string | undefined): CycloneFrequency {
  return CYCLONE_FREQUENCIES.includes(value as CycloneFrequency)
    ? (value as CycloneFrequency)
    : DEFAULT_CYCLONE_FREQUENCY;
}

export function parseSurgeMode(value: string | undefined): CycloneSurgeMode {
  return CYCLONE_SURGE_MODES.includes(value as CycloneSurgeMode)
    ? (value as CycloneSurgeMode)
    : DEFAULT_CYCLONE_SURGE_MODE;
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

export { WORLD_UNITS_PER_BAND } from '@terrace/shared';

export const CYCLONE_RADIUS_CELLS = cellsAcross(30);

export const CYCLONE_MAX_RADIUS_WORLD_FRACTION = 0.3;

export function cycloneRadiusFor(worldSize: number): number {
  return Math.min(CYCLONE_RADIUS_CELLS, worldSize * CYCLONE_MAX_RADIUS_WORLD_FRACTION);
}

export const CYCLONE_EYE_RADIUS_FRACTION = 0.125;

export {
  BROADCAST_POSITION_DECIMALS,
  parseRotatingStormsPayload as parseAllPayload,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type RotatingStormState as CycloneState,
  type RotatingStormsPayload as CycloneAllPayload,
} from '@terrace/shared';
export { BROADCAST_INTENSITY_DECIMALS as CYCLONE_INTENSITY_DECIMALS } from '@terrace/shared';
