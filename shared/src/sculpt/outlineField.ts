import { bandFloorHeight, drawnBandField } from '../bands.ts';
import { EDGE_UNITS_PER_CELL } from './edges.ts';
import { OUTLINE_FIXED_POINT, traceLevel, type Point } from './outlineTrace.ts';

// Distances from cells to band outlines, and the edge units a cell stores for them.

/** Outside every level: an excluded column is a hole in the grasped layer. */
export const HOLE_FIELD = -0x40000000;

/** Each level's drawn outline over the window, from the folded field the renderer draws. */
export function traceBandOutlines(
  heightAt: (x: number, y: number) => number | null,
  lowBand: number,
  highBand: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Map<number, Point[][]> {
  const outlines = new Map<number, Point[][]>();
  for (let band = lowBand + 1; band <= highBand; band++) {
    const field = (x: number, y: number): number => {
      const h = heightAt(x, y);
      return h === null ? HOLE_FIELD : drawnBandField(h, band);
    };
    outlines.set(band, traceLevel(field, bandFloorHeight(band), x0, y0, x1, y1));
  }
  return outlines;
}

/** Inward normal of the segment a→b: the inside is on its positive-cross side. */
function normalOf(a: Point, b: Point): [number, number] {
  return [a.y - b.y, b.x - a.x];
}

function isClosed(line: readonly Point[]): boolean {
  return line.length > 2 && line[0]!.x === line[line.length - 1]!.x && line[0]!.y === line[line.length - 1]!.y;
}

/** Which side of vertex v the point is on: positive inside, by its segments' summed unit normals. */
function vertexSide(line: readonly Point[], v: number, px: number, py: number): number {
  const closed = isClosed(line);
  const before = v > 0 ? v - 1 : closed ? line.length - 2 : -1;
  const after = v < line.length - 1 ? v + 1 : closed ? 1 : -1;
  let nx = 0;
  let ny = 0;
  if (before >= 0) {
    const [ux, uy] = normalOf(line[before]!, line[v]!);
    const length = Math.floor(Math.sqrt(ux * ux + uy * uy)) || 1;
    nx += Math.trunc((ux * OUTLINE_FIXED_POINT) / length);
    ny += Math.trunc((uy * OUTLINE_FIXED_POINT) / length);
  }
  if (after >= 0) {
    const [ux, uy] = normalOf(line[v]!, line[after]!);
    const length = Math.floor(Math.sqrt(ux * ux + uy * uy)) || 1;
    nx += Math.trunc((ux * OUTLINE_FIXED_POINT) / length);
    ny += Math.trunc((uy * OUTLINE_FIXED_POINT) / length);
  }
  return nx * (px - line[v]!.x) + ny * (py - line[v]!.y);
}

/** Signed fixed-point distance to the nearest outline point, positive inside. */
export function signedDistance(lines: readonly Point[][], px: number, py: number): number | null {
  let bestSquared = Infinity;
  let bestLine: readonly Point[] | null = null;
  // The nearest point's vertex, or -1 inside a segment, whose cross product then gives the side.
  let bestVertex = -1;
  let bestCross = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      const along = length === 0 ? 0 : Math.max(0, Math.min(length, (px - a.x) * dx + (py - a.y) * dy));
      const nx = length === 0 ? a.x : a.x + Math.trunc((dx * along) / length);
      const ny = length === 0 ? a.y : a.y + Math.trunc((dy * along) / length);
      const squared = (px - nx) * (px - nx) + (py - ny) * (py - ny);
      if (squared >= bestSquared) continue;
      bestSquared = squared;
      bestLine = line;
      bestVertex = along <= 0 ? i - 1 : along >= length ? i : -1;
      if (bestVertex < 0) bestCross = dx * (py - a.y) - dy * (px - a.x);
    }
  }
  if (bestLine === null) return null;
  const side = bestVertex >= 0 ? vertexSide(bestLine, bestVertex, px, py) : bestCross;
  const distance = Math.floor(Math.sqrt(bestSquared));
  return side >= 0 ? distance : -distance;
}

/** A fixed-point distance as the edge units a cell stores; no outline, or a cell or more away, stores none. */
export function edgeUnits(distanceFixed: number | null): number {
  if (distanceFixed === null) return EDGE_UNITS_PER_CELL;
  const u = Math.floor((Math.abs(distanceFixed) * EDGE_UNITS_PER_CELL + OUTLINE_FIXED_POINT / 2) / OUTLINE_FIXED_POINT);
  return u < EDGE_UNITS_PER_CELL ? u : EDGE_UNITS_PER_CELL;
}

/** Fixed-point coordinates stay under this, so x * span + y keys a vertex exactly. */
const VERTEX_KEY_SPAN = 1 << 20;

export function vertexKey(p: Point): number {
  return p.x * VERTEX_KEY_SPAN + p.y;
}

/** The point on the lines nearest p, or null when there are none. */
export function nearestPoint(lines: readonly Point[][], p: Point): Point | null {
  let best: Point | null = null;
  let bestSquared = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      const along = length === 0 ? 0 : Math.max(0, Math.min(length, (p.x - a.x) * dx + (p.y - a.y) * dy));
      const nx = length === 0 ? a.x : a.x + Math.trunc((dx * along) / length);
      const ny = length === 0 ? a.y : a.y + Math.trunc((dy * along) / length);
      const squared = (p.x - nx) * (p.x - nx) + (p.y - ny) * (p.y - ny);
      if (squared < bestSquared) {
        bestSquared = squared;
        best = { x: nx, y: ny, pinned: true };
      }
    }
  }
  return best;
}