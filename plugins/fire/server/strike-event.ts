const MAX_STRIKES_PER_EVENT = 8;

const STRIKE_STRIDE = 3;

export interface StruckCell {
  readonly x: number;
  readonly y: number;
}

function isCellCoordinate(value: unknown, worldSize: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < worldSize;
}

export function parseStruckCells(payload: unknown, worldSize: number): StruckCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const strikes = (payload as { strikes?: unknown }).strikes;
  if (!Array.isArray(strikes)) return null;

  const cells: StruckCell[] = [];
  for (let i = 0; i + STRIKE_STRIDE - 1 < strikes.length; i += STRIKE_STRIDE) {
    if (cells.length >= MAX_STRIKES_PER_EVENT) break;
    const x = strikes[i + 1];
    const y = strikes[i + 2];
    if (!isCellCoordinate(x, worldSize) || !isCellCoordinate(y, worldSize)) continue;
    cells.push({ x, y });
  }
  return cells;
}
