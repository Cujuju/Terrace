import { cellX, cellY, type Heightmap } from '../grid.ts';

export interface CellDiff {
  x: number;
  y: number;
  h: number;
  spans?: number[];
}

export function diffOf(map: Heightmap, changed: Set<number>): CellDiff[] {
  const indices = Array.from(changed).sort((a, b) => a - b);
  const diff: CellDiff[] = [];
  for (const i of indices) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const packed = map.columnSpans.get(i);
    const h = map.cells[i]!;
    diff.push(packed === undefined ? { x, y, h } : { x, y, h, spans: Array.from(packed) });
  }
  return diff;
}
