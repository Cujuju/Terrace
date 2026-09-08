import { BAND_HEIGHT, MAX_HEIGHT, MAX_STEP, RELAX_SLACK, WORLD_UNIT_CELLS } from '@terrace/shared';
import { isFiniteNumber } from '@terrace/shared';

export const MUDSLIDES_PLUGIN_NAME = 'mudslides';

export const MUDSLIDES_ACTIVE_MESSAGE = 'active';

export const MUDSLIDES_DEBRIS_MESSAGE = 'debris';

export const MUDSLIDES_FLOW_EVENT = 'flow';

export const MUDSLIDES_FREQUENCY_SETTING_KEY = 'mudslide-frequency';

export const MUDSLIDE_FREQUENCIES = ['off', 'rare', 'uncommon', 'common'] as const;
export type MudslideFrequency = (typeof MUDSLIDE_FREQUENCIES)[number];

export const DEFAULT_MUDSLIDE_FREQUENCY: MudslideFrequency = 'uncommon';

export function parseFrequency(value: string | undefined): MudslideFrequency {
  return MUDSLIDE_FREQUENCIES.includes(value as MudslideFrequency)
    ? (value as MudslideFrequency)
    : DEFAULT_MUDSLIDE_FREQUENCY;
}

export { WORLD_UNITS_PER_BAND } from '@terrace/shared';

export function cellsAcross(worldUnits: number): number {
  return Math.max(1, Math.round(worldUnits * WORLD_UNIT_CELLS));
}

export const MUDSLIDE_SLOPE_SPAN_WORLD_UNITS = 2;
export const MUDSLIDE_SLOPE_SPAN_CELLS = cellsAcross(MUDSLIDE_SLOPE_SPAN_WORLD_UNITS);

export const MUDSLIDE_MAX_DROP_PER_CELL = MAX_STEP + RELAX_SLACK;

export const MUDSLIDE_MAX_DROP_OVER_SPAN = MUDSLIDE_MAX_DROP_PER_CELL * MUDSLIDE_SLOPE_SPAN_CELLS;

export const MUDSLIDE_TRIGGER_STEEPNESS = 0.5;

export const MUDSLIDE_TRIGGER_DROP = Math.ceil(
  MUDSLIDE_MAX_DROP_OVER_SPAN * MUDSLIDE_TRIGGER_STEEPNESS,
);

export const MUDSLIDE_RIM_STEEPNESS = 0.6;

export const MUDSLIDE_RIM_DROP = Math.ceil(MUDSLIDE_MAX_DROP_PER_CELL * MUDSLIDE_RIM_STEEPNESS);

export const MUDSLIDE_MAX_PATH_WORLD_UNITS = 24;
export const MUDSLIDE_MAX_PATH_CELLS = cellsAcross(MUDSLIDE_MAX_PATH_WORLD_UNITS);

export { BROADCAST_POSITION_DECIMALS, roundBroadcastPosition } from '@terrace/shared';

export const MUDSLIDE_LOAD_DECIMALS = 2;
const LOAD_QUANTUM = 10 ** MUDSLIDE_LOAD_DECIMALS;

export function roundBroadcastLoad(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * LOAD_QUANTUM) / LOAD_QUANTUM;
}

export const MAX_ACTIVE_SLIDES = 3;

export interface SlideState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly load: number;
}

export interface MudslidesActivePayload {
  readonly slides: readonly SlideState[];
}

export interface DebrisCell {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
}

export interface MudslidesDebrisPayload {
  readonly cells: readonly DebrisCell[];
}

export interface MudslideFlowEvent {
  readonly slideId: number;
  readonly headX: number;
  readonly headY: number;
  readonly toeX: number;
  readonly toeY: number;
  readonly cells: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly delta: number;
  }>;
  readonly volumeMoved: number;
  readonly stop: MudslideStop;
}

export const MUDSLIDE_STOPS = ['water', 'sea', 'basin', 'locked', 'length', 'spent'] as const;
export type MudslideStop = (typeof MUDSLIDE_STOPS)[number];

function parseSlide(value: unknown): SlideState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, x, y, vx, vy, load } = value as Record<string, unknown>;
  if (!Number.isInteger(id)) return null;
  for (const number of [x, y, vx, vy, load]) if (!isFiniteNumber(number)) return null;
  return {
    id: id as number,
    x: x as number,
    y: y as number,
    vx: vx as number,
    vy: vy as number,
    load: load as number,
  };
}

export function parseActivePayload(payload: unknown): MudslidesActivePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { slides } = payload as Record<string, unknown>;
  if (!Array.isArray(slides)) return null;
  const parsed: SlideState[] = [];
  for (const value of slides) {
    const slide = parseSlide(value);
    if (slide === null) return null;
    parsed.push(slide);
  }
  return { slides: parsed };
}

function parseDebrisCell(value: unknown): DebrisCell | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, depth } = value as Record<string, unknown>;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (!isFiniteNumber(depth) || depth <= 0) return null;
  return { x: x as number, y: y as number, depth: depth as number };
}

export function parseDebrisPayload(payload: unknown): MudslidesDebrisPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { cells } = payload as Record<string, unknown>;
  if (!Array.isArray(cells)) return null;
  const parsed: DebrisCell[] = [];
  for (const value of cells) {
    const cell = parseDebrisCell(value);
    if (cell === null) return null;
    parsed.push(cell);
  }
  return { cells: parsed };
}
