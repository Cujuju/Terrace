import { WORLD_UNIT_CELLS } from '../constants.ts';
import { isHeightInBand, spanAt, spanIndexCoveringBand } from '../columns.ts';
import { cellIndex, cellX, cellY, inBounds, type Heightmap } from '../grid.ts';

export const SOFT_DRAG_MIN_REACH = 0.45;

const SOFT_DRAG_LOBE_CELLS = WORLD_UNIT_CELLS;

const SOFT_DRAG_LOBE_SHARE = 0.65;

function hashCell(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function cellNoise(x: number, y: number): number {
  const lobe = hashCell(
    Math.floor(x / SOFT_DRAG_LOBE_CELLS),
    Math.floor(y / SOFT_DRAG_LOBE_CELLS),
  );
  return SOFT_DRAG_LOBE_SHARE * lobe + (1 - SOFT_DRAG_LOBE_SHARE) * hashCell(x, y);
}

export function admitRimEnclaves(
  map: Heightmap,
  targetBand: number,
  refused: Set<number>,
  inDisc: Set<number>,
  disc: number[],
): void {
  const alreadyAtBand = (x: number, y: number): boolean => {
    const k = spanIndexCoveringBand(map, x, y, targetBand);
    return k !== null && isHeightInBand(spanAt(map, x, y, k).ceiling, targetBand);
  };
  const passable = (x: number, y: number): boolean =>
    inBounds(map, x, y) && refused.has(cellIndex(map, x, y)) && !alreadyAtBand(x, y);

  const reached = new Set<number>();
  const stack: number[] = [];
  const seed = (x: number, y: number): void => {
    if (!passable(x, y)) return;
    const i = cellIndex(map, x, y);
    if (reached.has(i)) return;
    reached.add(i);
    stack.push(i);
  };
  const outside = (x: number, y: number): boolean => {
    if (!inBounds(map, x, y)) return true;
    const i = cellIndex(map, x, y);
    return !inDisc.has(i) && !refused.has(i);
  };
  for (const i of refused) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    if (outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1)) {
      seed(x, y);
    }
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    seed(x - 1, y);
    seed(x + 1, y);
    seed(x, y - 1);
    seed(x, y + 1);
  }
  for (const i of refused) {
    if (!reached.has(i)) disc.push(i);
  }
}
