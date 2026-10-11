export interface StructuresChangeCell {
  readonly x: number;
  readonly y: number;
}

const STRUCTURES_EVENT_LIST_CAP = 4096;

function parseCellList(value: unknown): StructuresChangeCell[] | null {
  if (!Array.isArray(value) || value.length > STRUCTURES_EVENT_LIST_CAP) return null;
  const cells: StructuresChangeCell[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { x, y } = item as { x?: unknown; y?: unknown };
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    cells.push({ x: x as number, y: y as number });
  }
  return cells;
}

export interface StructuresOccupationEvent {
  readonly seeded: readonly StructuresChangeCell[];
  readonly upgraded: readonly StructuresChangeCell[];
}

export function parseStructuresOccupation(payload: unknown): StructuresOccupationEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { seeded, upgraded } = payload as { seeded?: unknown; upgraded?: unknown };

  const seededCells = seeded === undefined ? [] : parseCellList(seeded);
  const upgradedCells = upgraded === undefined ? [] : parseCellList(upgraded);
  if (seededCells === null || upgradedCells === null) return null;

  return { seeded: seededCells, upgraded: upgradedCells };
}
