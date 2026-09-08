import { cellsAcross } from '@terrace/shared';

export const TORNADO_PLUGIN_NAME = 'tornado';

export const TORNADO_ALL_MESSAGE = 'all';

export const TORNADO_DAMAGE_EVENT = 'damage';

export const TORNADO_FREQUENCY_SETTING_KEY = 'tornado-frequency';

export const TORNADO_FREQUENCIES = ['off', 'rare', 'common'] as const;
export type TornadoFrequency = (typeof TORNADO_FREQUENCIES)[number];

export const DEFAULT_TORNADO_FREQUENCY: TornadoFrequency = 'rare';

export const FREQUENCY_INTERVAL_MULTIPLIERS: Readonly<Record<'rare' | 'common', number>> = {
  rare: 2,
  common: 0.5,
};

export function parseFrequency(value: string | undefined): TornadoFrequency {
  return TORNADO_FREQUENCIES.includes(value as TornadoFrequency)
    ? (value as TornadoFrequency)
    : DEFAULT_TORNADO_FREQUENCY;
}

export { WORLD_UNITS_PER_BAND } from '@terrace/shared';

export const TORNADO_RADIUS_CELLS = cellsAcross(1.5);

export const TORNADO_HEIGHT_WORLD_UNITS = 6;

export {
  BROADCAST_POSITION_DECIMALS,
  parseRotatingStormsPayload as parseAllPayload,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type RotatingStormState as TornadoState,
  type RotatingStormsPayload as TornadoAllPayload,
} from '@terrace/shared';
export { BROADCAST_INTENSITY_DECIMALS as TORNADO_INTENSITY_DECIMALS } from '@terrace/shared';
