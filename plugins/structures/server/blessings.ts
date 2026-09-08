import { STRUCTURES_CAP } from '../protocol.ts';

let blessedKeys: ReadonlySet<number> = new Set();

export function setBlessedStructureCells(keys: readonly number[]): void {
  const next = new Set<number>();
  for (const key of keys) {
    if (!Number.isInteger(key) || key < 0) continue;
    if (next.size >= STRUCTURES_CAP) break;
    next.add(key);
  }
  blessedKeys = next;
}

export function isBlessedStructureCell(key: number): boolean {
  return blessedKeys.has(key);
}

export function blessedStructureCellCount(): number {
  return blessedKeys.size;
}

export function resetBlessings(): void {
  blessedKeys = new Set();
}
