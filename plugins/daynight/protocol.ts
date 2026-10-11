export const DAYNIGHT_PLUGIN_NAME = 'daynight';

export const DAYNIGHT_CLOCK_MESSAGE = 'clock';

export { DAY_LENGTH_SECONDS } from '@terrace/shared';

export const DAYNIGHT_PHASE_DECIMALS = 4;

const PHASE_QUANTUM = 10 ** DAYNIGHT_PHASE_DECIMALS;

export function wrapPhase(value: number): number {
  const remainder = value % 1;
  if (remainder < 0) return remainder + 1;
  return remainder === 0 ? 0 : remainder;
}

export function roundBroadcastPhase(value: number): number {
  return Math.round(wrapPhase(value) * PHASE_QUANTUM) / PHASE_QUANTUM;
}

export interface DayNightClockState {
  readonly phase: number;
  readonly day: number | null;
  readonly genesisDay: number | null;
}

export function parseClockPayload(payload: unknown): DayNightClockState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const phase = (payload as { phase?: unknown }).phase;
  if (typeof phase !== 'number' || !Number.isFinite(phase)) return null;

  const day = (payload as { day?: unknown }).day;
  const genesisDay = (payload as { genesisDay?: unknown }).genesisDay;
  const calendarKnown =
    Number.isInteger(day) && (day as number) >= 0 && Number.isInteger(genesisDay);

  return {
    phase: wrapPhase(phase),
    day: calendarKnown ? (day as number) : null,
    genesisDay: calendarKnown ? (genesisDay as number) : null,
  };
}
