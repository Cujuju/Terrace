export const TEMPLES_PLUGIN_NAME = 'temples';

export const TEMPLE_STATE_MESSAGE = 'state';

export const TEMPLE_PLACE_MESSAGE = 'place';

export const TEMPLE_REMOVE_MESSAGE = 'remove';

export const TEMPLE_REFUSED_MESSAGE = 'refused';

export const TEMPLE_REFUSED_STANDING = 0;
export const TEMPLE_REFUSED_GROUND = 1;
export const TEMPLE_REFUSED_NO_SETTLERS = 2;

export interface TempleRefusal {
  readonly x: number;
  readonly y: number;
  readonly reason: number;
}

export const TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS = 2;

import { CELL_WORLD_SIZE, cellsAcross } from '@terrace/shared';

export const TEMPLE_FRONT_APRON_WORLD_UNITS = TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 4;

export const TEMPLE_SURVEY_RADIUS_CELLS = Math.ceil(
  cellsAcross(TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 2 + TEMPLE_FRONT_APRON_WORLD_UNITS),
);

export const TEMPLE_SURVEYED_GROUND_RADIUS =
  (TEMPLE_SURVEY_RADIUS_CELLS + 0.5) * CELL_WORLD_SIZE;

export interface TempleCell {
  readonly x: number;
  readonly y: number;
}

export const TEMPLE_DOOR_OFFSET_CELLS = cellsAcross(
  TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS / 2 + TEMPLE_FRONT_APRON_WORLD_UNITS,
);

export function templeDoorCell(temple: TempleCell): { x: number; y: number } {
  return { x: temple.x + TEMPLE_DOOR_OFFSET_CELLS, y: temple.y };
}

export function packTempleRefusal(refusal: TempleRefusal): number[] {
  return [refusal.x, refusal.y, refusal.reason];
}

export function parseTempleRefusalPayload(payload: unknown): TempleRefusal | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const refused = (payload as { refused?: unknown }).refused;
  if (!Array.isArray(refused) || refused.length < 3) return null;
  const x = refused[0];
  const y = refused[1];
  const reason = refused[2];
  if (!isCellCoordinate(x) || !isCellCoordinate(y)) return null;
  if (typeof reason !== 'number' || !Number.isInteger(reason)) return null;
  return { x, y, reason };
}

export function templeFootprintCells(temple: TempleCell): number[] {
  const cells: number[] = [];
  for (let dy = -TEMPLE_SURVEY_RADIUS_CELLS; dy <= TEMPLE_SURVEY_RADIUS_CELLS; dy++) {
    for (let dx = -TEMPLE_SURVEY_RADIUS_CELLS; dx <= TEMPLE_SURVEY_RADIUS_CELLS; dx++) {
      cells.push(temple.x + dx, temple.y + dy);
    }
  }
  return cells;
}

export interface TempleStatePayload {
  readonly temple: readonly number[];
}

const MAX_CELL_COORDINATE = 65536;

function isCellCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_CELL_COORDINATE
  );
}

export function packTemple(temple: TempleCell | null): number[] {
  return temple === null ? [] : [temple.x, temple.y];
}

export function parseTempleStatePayload(payload: unknown): TempleCell | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const temple = (payload as { temple?: unknown }).temple;
  if (!Array.isArray(temple) || temple.length < 2) return null;
  const x = temple[0];
  const y = temple[1];
  if (!isCellCoordinate(x) || !isCellCoordinate(y)) return null;
  return { x, y };
}

export interface TemplePlacePayload {
  readonly x: number;
  readonly y: number;
}

export function parseTemplePlacePayload(payload: unknown): TempleCell | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { x?: unknown; y?: unknown };
  if (!isCellCoordinate(message.x) || !isCellCoordinate(message.y)) return null;
  return { x: message.x, y: message.y };
}
