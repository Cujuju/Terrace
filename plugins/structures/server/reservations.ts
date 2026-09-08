import { structureKey } from '../protocol.ts';

let reservedKeys: ReadonlySet<number> = new Set();

export const RESERVED_CELLS_CAP = 4096;

export function setReservedStructureCells(cells: readonly number[]): void {
  const next = new Set<number>();
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const x = cells[i];
    const y = cells[i + 1];
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) continue;
    if (next.size >= RESERVED_CELLS_CAP) break;
    next.add(structureKey(x, y));
  }
  reservedKeys = next;
}

export function hasReservedStructureCells(): boolean {
  return reservedKeys.size > 0;
}

export function isReservedStructureCell(key: number): boolean {
  return reservedKeys.has(key);
}

export function resetReservations(): void {
  reservedKeys = new Set();
}
