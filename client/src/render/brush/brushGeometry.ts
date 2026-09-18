import type { SculptProfile, SculptTool } from '@terrace/shared';
import {
  cellGridSegments,
  markCellsTouching,
  markOutline,
  oneClickMark,
} from './footprintMark.ts';

export interface BrushFootprint {
  /** Outline in cell space, closed (first point repeated): x,z pairs. */
  readonly ringPoints: Float32Array;
  readonly ringCount: number;
  /** ringCellIndex[i]..ringCellIndex[i+1] slices ringCells for point i. */
  readonly ringCellIndex: Int32Array;
  /** dx,dz pairs. */
  readonly ringCells: Int32Array;
  /** Per segment: ax,az,bx,bz in cell space. */
  readonly gridPoints: Float32Array;
  /** Per segment: cellAx,cellAz,cellBx,cellBz. */
  readonly gridCells: Int32Array;
  readonly gridCount: number;
  /** max(|dx|,|dz|) over mark cells — the footprint's half-extent in cells. */
  readonly reachCells: number;
}

export function brushFootprint(
  radius: number,
  tool: SculptTool,
  profile: SculptProfile,
): BrushFootprint {
  const mark = oneClickMark(radius, tool, profile);
  const outline = markOutline(radius, mark);

  // Closed by repeating the first point: WebGPURenderer draws Line, not LineLoop.
  const closed = [...outline, outline[0]!];
  const ringCount = closed.length;
  const ringPoints = new Float32Array(ringCount * 2);
  const perPoint: [number, number][][] = [];
  let cellTotal = 0;
  let reachCells = 0;
  for (const [dx, dy] of mark.cells) {
    const reach = Math.max(Math.abs(dx), Math.abs(dy));
    if (reach > reachCells) reachCells = reach;
  }
  for (let i = 0; i < ringCount; i++) {
    const point = closed[i]!;
    ringPoints[i * 2] = point.x;
    ringPoints[i * 2 + 1] = point.z;
    const touched = markCellsTouching(mark, point.x, point.z);
    perPoint.push(touched);
    cellTotal += touched.length;
  }
  const ringCellIndex = new Int32Array(ringCount + 1);
  const ringCells = new Int32Array(cellTotal * 2);
  let cursor = 0;
  for (let i = 0; i < ringCount; i++) {
    ringCellIndex[i] = cursor;
    for (const [cx, cz] of perPoint[i]!) {
      ringCells[cursor * 2] = cx;
      ringCells[cursor * 2 + 1] = cz;
      cursor++;
    }
  }
  ringCellIndex[ringCount] = cursor;

  const segments = cellGridSegments(mark);
  const gridCount = segments.length;
  const gridPoints = new Float32Array(gridCount * 4);
  const gridCells = new Int32Array(gridCount * 4);
  for (let s = 0; s < gridCount; s++) {
    const segment = segments[s]!;
    gridPoints[s * 4] = segment.ax;
    gridPoints[s * 4 + 1] = segment.az;
    gridPoints[s * 4 + 2] = segment.bx;
    gridPoints[s * 4 + 3] = segment.bz;
    gridCells[s * 4] = segment.cellAx;
    gridCells[s * 4 + 1] = segment.cellAz;
    gridCells[s * 4 + 2] = segment.cellBx;
    gridCells[s * 4 + 3] = segment.cellBz;
  }

  return {
    ringPoints,
    ringCount,
    ringCellIndex,
    ringCells,
    gridPoints,
    gridCells,
    gridCount,
    reachCells,
  };
}
