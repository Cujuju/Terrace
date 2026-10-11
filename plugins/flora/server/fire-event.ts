export const FIRE_CELLS_BURNED_OUT_EVENT_NAME = 'fire:cellsBurnedOut';

const MAX_BURNED_OUT_PER_EVENT = 2048;

const BURNED_OUT_STRIDE = 2;

export interface BurnedOutCell {
  readonly x: number;
  readonly y: number;
}

function isCellCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parseBurnedOutCells(payload: unknown): BurnedOutCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const cells = (payload as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return null;

  const parsed: BurnedOutCell[] = [];
  for (let i = 0; i + BURNED_OUT_STRIDE - 1 < cells.length; i += BURNED_OUT_STRIDE) {
    if (parsed.length >= MAX_BURNED_OUT_PER_EVENT) break;
    const x = cells[i];
    const y = cells[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    parsed.push({ x, y });
  }
  return parsed;
}
