import {
  BAND_HEIGHT,
  DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS,
  sculptSweepRadius,
  applySculpt,
  createHeightmap,
  forEachFootprintOffset,
  sculptOptionsOf,
  type SculptIntent,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';
import {
  MAX_LATTICE_SPAN,
  assembleLoops,
  loadSampleField,
  marchLevel,
  type ContourLoop,
} from '../../terrain/contours.ts';
import { simplifyLoop } from '../../terrain/contourSmoothing.ts';

export type SculptDir = SculptIntent['dir'];

const FOOTPRINT_OUTSIDE = 0;
const FOOTPRINT_INSIDE = 1;

const SCULPT_DIRECTIONS: readonly SculptDir[] = [1, -1];

const FOOTPRINT_EDGE_CROSSING = 0.5;

export const CELL_TOUCH_EPSILON = 1e-6;

const FOOTPRINT_LATTICE_MARGIN_CELLS = 1;

const FOOTPRINT_LATTICE_SPAN = 2 * (MAX_BRUSH_RADIUS + FOOTPRINT_LATTICE_MARGIN_CELLS);

const FOOTPRINT_LATTICE_CENTRE = FOOTPRINT_LATTICE_SPAN / 2;

const MAX_FOOTPRINT_REACH_CELLS = MAX_BRUSH_RADIUS - 1;

if (
  MAX_FOOTPRINT_REACH_CELLS + FOOTPRINT_LATTICE_MARGIN_CELLS > FOOTPRINT_LATTICE_CENTRE ||
  FOOTPRINT_LATTICE_CENTRE + MAX_FOOTPRINT_REACH_CELLS + FOOTPRINT_LATTICE_MARGIN_CELLS >
    FOOTPRINT_LATTICE_SPAN ||
  FOOTPRINT_LATTICE_SPAN > MAX_LATTICE_SPAN
) {
  throw new RangeError(
    `brush radius ${MAX_BRUSH_RADIUS} does not fit a ${FOOTPRINT_LATTICE_SPAN}-cell contour lattice`,
  );
}

export interface Mark {
  readonly has: (dx: number, dy: number) => boolean;
  readonly cells: readonly (readonly [number, number])[];
}

const SIMULATION_SPAN_CELLS =
  2 * (sculptSweepRadius(MAX_BRUSH_RADIUS, 'soft', 'stamp', 'clicked') + FOOTPRINT_LATTICE_MARGIN_CELLS + 1);

// Dry band-aligned simulation ground: at sea level, raise and lower
// simulate different footprints, so the outline used to change size with
// sculpt direction. Mid-terrain ground behaves the same both ways.
const SIMULATION_GROUND_HEIGHT = 8 * BAND_HEIGHT;

export function oneClickMark(radius: number, tool: SculptTool, profile: SculptProfile): Mark {
  const keys = new Set<string>();
  const cells: (readonly [number, number])[] = [];
  // The outline is direction-independent: a raise and a lower stamp the
  // same cells on typical terrain, so the mark unions both directions and
  // never changes size with the sculpt mode.
  for (const dir of SCULPT_DIRECTIONS) {
    const map = createHeightmap(SIMULATION_SPAN_CELLS);
    const centre = SIMULATION_SPAN_CELLS >> 1;
    map.cells.fill(SIMULATION_GROUND_HEIGHT);

    applySculpt(
      map,
      centre,
      centre,
      radius,
      DEFAULT_SCULPT_AMOUNT * dir,
      sculptOptionsOf({ type: 'sculpt', x: centre, y: centre, radius, dir, tool, profile }),
    );

    for (let j = 0; j < SIMULATION_SPAN_CELLS; j++) {
      for (let i = 0; i < SIMULATION_SPAN_CELLS; i++) {
        // Edited cells are detected by height change, not band change: a
        // soft edge can move heights within one drawn band.
        if (map.cells[j * SIMULATION_SPAN_CELLS + i]! === SIMULATION_GROUND_HEIGHT) continue;
        const dx = i - centre;
        const dy = j - centre;
        const key = `${dx},${dy}`;
        if (keys.has(key)) continue;
        keys.add(key);
        cells.push([dx, dy]);
      }
    }
  }
  if (cells.length === 0) {
    // A pure-melt stroke edits nothing on flat ground, but the brush
    // still reaches its footprint on rough terrain: outline that area.
    forEachFootprintOffset(radius, (dx, dy) => {
      const key = `${dx},${dy}`;
      if (keys.has(key)) return;
      keys.add(key);
      cells.push([dx, dy]);
    });
  }
  return { has: (dx, dy) => keys.has(`${dx},${dy}`), cells };
}

/** A mark over the exact cells given, as offsets from the aim. */
export function markFromOffsets(cells: readonly (readonly [number, number])[]): Mark {
  const keys = new Set<string>();
  for (const [dx, dy] of cells) keys.add(`${dx},${dy}`);
  return { has: (dx, dy) => keys.has(`${dx},${dy}`), cells };
}

export function clampIntoMark(x: number, z: number, mark: Mark): [number, number] {
  if (mark.has(Math.round(x), Math.round(z))) return [x, z];
  let bestX = x;
  let bestZ = z;
  let bestDistance = Infinity;
  for (const [cx, cz] of mark.cells) {
    const nx = x < cx - 0.5 ? cx - 0.5 : x > cx + 0.5 ? cx + 0.5 : x;
    const nz = z < cz - 0.5 ? cz - 0.5 : z > cz + 0.5 ? cz + 0.5 : z;
    const dx = x - nx;
    const dz = z - nz;
    const distance = dx * dx + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestX = nx;
      bestZ = nz;
    }
  }
  return [bestX, bestZ];
}

/**
 * Every closed loop the mark marches to, largest first. A carve's admitted
 * cells are often disconnected, so more than one loop is ordinary there.
 */
export function markOutlineLoops(mark: Mark): ContourLoop[] {
  loadSampleField(
    (i, j) =>
      mark.has(i - FOOTPRINT_LATTICE_CENTRE, j - FOOTPRINT_LATTICE_CENTRE)
        ? FOOTPRINT_INSIDE
        : FOOTPRINT_OUTSIDE,
    FOOTPRINT_LATTICE_SPAN,
  );
  const origin = -FOOTPRINT_LATTICE_CENTRE;
  const segmentCount = marchLevel(FOOTPRINT_INSIDE, origin, origin, FOOTPRINT_EDGE_CROSSING);
  const loops = assembleLoops(segmentCount, origin, origin, false).map(simplifyLoop);
  for (const loop of loops) {
    for (const point of loop) {
      const [x, z] = clampIntoMark(point.x, point.z, mark);
      point.x = x;
      point.z = z;
    }
  }
  // Largest first so the ring strip always carries the dominant loop, and the
  // order never depends on march order.
  return loops.sort((a, b) => b.length - a.length);
}

export function markOutline(radius: number, mark: Mark): ContourLoop {
  loadSampleField(
    (i, j) =>
      mark.has(i - FOOTPRINT_LATTICE_CENTRE, j - FOOTPRINT_LATTICE_CENTRE)
        ? FOOTPRINT_INSIDE
        : FOOTPRINT_OUTSIDE,
    FOOTPRINT_LATTICE_SPAN,
  );

  const origin = -FOOTPRINT_LATTICE_CENTRE;
  const segmentCount = marchLevel(
    FOOTPRINT_INSIDE,
    origin,
    origin,
    FOOTPRINT_EDGE_CROSSING,
  );
  const loops = assembleLoops(segmentCount, origin, origin, false).map(simplifyLoop);

  if (loops.length !== 1) {
    throw new RangeError(
      `brush radius ${radius} marched to ${loops.length} contour loops, expected 1`,
    );
  }

  for (const point of loops[0]) {
    const [x, z] = clampIntoMark(point.x, point.z, mark);
    point.x = x;
    point.z = z;
  }
  return loops[0];
}

export interface GridSegment {
  readonly ax: number; readonly az: number;
  readonly bx: number; readonly bz: number;
}

export function cellGridSegments(mark: Mark): GridSegment[] {
  const segments: GridSegment[] = [];
  for (const [dx, dy] of mark.cells) {
    if (mark.has(dx + 1, dy)) {
      segments.push({ ax: dx + 0.5, az: dy - 0.5, bx: dx + 0.5, bz: dy + 0.5 });
    }
    if (mark.has(dx, dy + 1)) {
      segments.push({ ax: dx - 0.5, az: dy + 0.5, bx: dx + 0.5, bz: dy + 0.5 });
    }
  }
  return segments;
}
