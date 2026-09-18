import type { SculptProfile, SculptTool } from '@terrace/shared';
import { cellGridSegments, clampIntoMark, markOutline, oneClickMark } from './footprintMark.ts';

export interface BrushFootprint {
  /** Draped outline in cell space, closed (first point repeated): x,z pairs. */
  readonly ringPoints: Float32Array;
  readonly ringCount: number;
  /** Per segment: ax,az,bx,bz in cell space. */
  readonly gridPoints: Float32Array;
  readonly gridCount: number;
  /** max(|dx|,|dz|) over mark cells — the footprint's half-extent in cells. */
  readonly reachCells: number;
  /** Mark occupancy over [-markExtent..markExtent] squared, row-major. */
  readonly markGrid: Uint8Array;
  readonly markExtent: number;
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
  // Melt the outline onto the mark: subdivide every run past one drape step
  // and clamp each sub-point inside, so no vertex leaves the edited cells.
  const draped: number[] = [];
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i]!;
    const b = closed[i + 1]!;
    const parts = drapeParts(a.x, a.z, b.x, b.z);
    for (let k = 0; k < parts; k++) {
      const t = k / parts;
      const [x, z] = clampIntoMark(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, mark);
      draped.push(x, z);
    }
  }
  const [ex, ez] = clampIntoMark(closed[closed.length - 1]!.x, closed[closed.length - 1]!.z, mark);
  draped.push(ex, ez);
  const ringCount = draped.length / 2;
  const ringPoints = new Float32Array(draped);
  let reachCells = 0;
  for (const [dx, dy] of mark.cells) {
    const reach = Math.max(Math.abs(dx), Math.abs(dy));
    if (reach > reachCells) reachCells = reach;
  }

  const markExtent = reachCells;
  const markWidth = 2 * markExtent + 1;
  const markGrid = new Uint8Array(markWidth * markWidth);
  for (const [dx, dy] of mark.cells) {
    markGrid[(dy + markExtent) * markWidth + (dx + markExtent)] = 1;
  }

  const segments = cellGridSegments(mark);
  const gridCount = segments.length;
  const gridPoints = new Float32Array(gridCount * 4);
  for (let s = 0; s < gridCount; s++) {
    const segment = segments[s]!;
    gridPoints[s * 4] = segment.ax;
    gridPoints[s * 4 + 1] = segment.az;
    gridPoints[s * 4 + 2] = segment.bx;
    gridPoints[s * 4 + 3] = segment.bz;
  }

  return {
    ringPoints,
    ringCount,
    gridPoints,
    gridCount,
    reachCells,
    markGrid,
    markExtent,
  };
}

/** Longest drape run in cells: the outline melts onto every step it crosses. */
export const DRAPE_STEP_CELLS = 0.25;

/** Runs covering ax,az-bx,bz with none longer than one drape step. */
function drapeParts(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / DRAPE_STEP_CELLS));
}
