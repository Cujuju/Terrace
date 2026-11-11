import { bandFloorHeight, drawnBandField, drawnBandOfSample } from '../bands.ts';
import { EDGE_UNITS_PER_CELL } from './edges.ts';
import { OUTLINE_FIXED_POINT, isClosedOutline as isClosed, traceLevel, type Point } from './outlineTrace.ts';

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
  const presentBands = new Set<number>();
  let hasHoles = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const h = heightAt(x, y);
      if (h === null) hasHoles = true;
      else presentBands.add(drawnBandOfSample(h));
    }
  }
  for (let band = lowBand + 1; band <= highBand; band++) {
    // With no sample crossing membership, the folded field and threshold translate together.
    if (!hasHoles && band > lowBand + 1 && !presentBands.has(band - 1)) {
      outlines.set(band, outlines.get(band - 1)!);
      continue;
    }
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
  const nearest = new NearestOutlinePoint(px, py);
  let order = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) nearest.consider(line, i, order++);
  }
  return nearest.distance();
}

class NearestOutlinePoint {
  readonly px: number;
  readonly py: number;
  readonly limitSquared: number;
  squared = Infinity;
  private line: readonly Point[] | null = null;
  private vertex = -1;
  private cross = 0;
  private order = Infinity;
  private x = 0;
  private y = 0;

  constructor(px: number, py: number, limitSquared = Infinity) {
    this.px = px;
    this.py = py;
    this.limitSquared = limitSquared;
  }

  consider(line: readonly Point[], i: number, order: number): void {
    const { px, py } = this;
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const along = length === 0 ? 0 : Math.max(0, Math.min(length, (px - a.x) * dx + (py - a.y) * dy));
    const nx = length === 0 ? a.x : a.x + Math.trunc((dx * along) / length);
    const ny = length === 0 ? a.y : a.y + Math.trunc((dy * along) / length);
    const squared = (px - nx) * (px - nx) + (py - ny) * (py - ny);
    if (squared >= this.limitSquared || squared > this.squared || (squared === this.squared && order >= this.order)) return;
    this.squared = squared;
    this.line = line;
    this.order = order;
    this.x = nx;
    this.y = ny;
    this.vertex = along <= 0 ? i - 1 : along >= length ? i : -1;
    if (this.vertex < 0) this.cross = dx * (py - a.y) - dy * (px - a.x);
  }

  distance(): number | null {
    if (this.line === null) return null;
    const side = this.vertex >= 0 ? vertexSide(this.line, this.vertex, this.px, this.py) : this.cross;
    const distance = Math.floor(Math.sqrt(this.squared));
    return side >= 0 ? distance : -distance;
  }

  point(): Point | null {
    return this.line === null ? null : { x: this.x, y: this.y, pinned: true };
  }
}

interface OutlineSegment {
  readonly line: readonly Point[];
  readonly end: number;
  readonly order: number;
}

/** One grid cell per bucket; queries expand until every unvisited bucket lies farther than the nearest candidate. */
const DISTANCE_BUCKET_FIXED = OUTLINE_FIXED_POINT;

/** Exact signed distance within the requested integer distance; farther outlines return null. Original segment order breaks equal-distance ties. */
export function createOutlineDistanceQuery(lines: readonly Point[][], maxDistanceFixed: number): (px: number, py: number) => number | null {
  const query = createOutlineQuery(lines, maxDistanceFixed);
  return (px, py) => query(px, py).distance();
}

export function createNearestPointQuery(lines: readonly Point[][]): (p: Point) => Point | null {
  const query = createOutlineQuery(lines, Infinity);
  return (p) => query(p.x, p.y).point();
}

function createOutlineQuery(lines: readonly Point[][], maxDistanceFixed: number): (px: number, py: number) => NearestOutlinePoint {
  const buckets: (OutlineSegment[] | undefined)[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of lines) for (const p of line) {
    const x = Math.floor(p.x / DISTANCE_BUCKET_FIXED);
    const y = Math.floor(p.y / DISTANCE_BUCKET_FIXED);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const width = maxX - minX + 1;
  let order = 0;
  for (const line of lines) {
    for (let end = 1; end < line.length; end++) {
      const a = line[end - 1]!;
      const b = line[end]!;
      const segment = { line, end, order: order++ };
      for (let y = Math.floor(Math.min(a.y, b.y) / DISTANCE_BUCKET_FIXED); y <= Math.floor(Math.max(a.y, b.y) / DISTANCE_BUCKET_FIXED); y++) {
        for (let x = Math.floor(Math.min(a.x, b.x) / DISTANCE_BUCKET_FIXED); x <= Math.floor(Math.max(a.x, b.x) / DISTANCE_BUCKET_FIXED); x++) {
          const key = (y - minY) * width + x - minX;
          let bucket = buckets[key];
          if (bucket === undefined) buckets[key] = bucket = [];
          bucket.push(segment);
        }
      }
    }
  }
  // Distances are floored: include candidates strictly below the next fixed-point unit.
  const limitSquared = (maxDistanceFixed + 1) ** 2;
  const queryReach = Math.ceil((maxDistanceFixed + 1) / DISTANCE_BUCKET_FIXED);
  const seen = new Uint32Array(order);
  let stamp = 0;
  return (px, py) => {
    const cx = Math.floor(px / DISTANCE_BUCKET_FIXED);
    const cy = Math.floor(py / DISTANCE_BUCKET_FIXED);
    const nearest = new NearestOutlinePoint(px, py, limitSquared);
    if (order === 0) return nearest;
    const dx = Math.max(minX * DISTANCE_BUCKET_FIXED - px, 0, px - (maxX + 1) * DISTANCE_BUCKET_FIXED);
    const dy = Math.max(minY * DISTANCE_BUCKET_FIXED - py, 0, py - (maxY + 1) * DISTANCE_BUCKET_FIXED);
    if (dx * dx + dy * dy >= limitSquared) return nearest;
    const reach = Math.min(queryReach, Math.max(Math.abs(cx - minX), Math.abs(cx - maxX), Math.abs(cy - minY), Math.abs(cy - maxY)));
    stamp = (stamp + 1) >>> 0;
    if (stamp === 0) { seen.fill(0); stamp = 1; }
    for (let ring = 0; ring <= reach; ring++) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        if (y < minY || y > maxY) continue;
        const row = (y - minY) * width;
        const step = ring > 0 && y > cy - ring && y < cy + ring ? 2 * ring : 1;
        for (let x = cx - ring; x <= cx + ring; x += step) {
          if (x < minX || x > maxX) continue;
          const bucket = buckets[row + x - minX];
          if (bucket !== undefined) for (const s of bucket) {
            if (seen[s.order] === stamp) continue;
            seen[s.order] = stamp;
            nearest.consider(s.line, s.end, s.order);
          }
        }
      }
      const outside = Math.min(px - (cx - ring) * DISTANCE_BUCKET_FIXED, (cx + ring + 1) * DISTANCE_BUCKET_FIXED - px,
        py - (cy - ring) * DISTANCE_BUCKET_FIXED, (cy + ring + 1) * DISTANCE_BUCKET_FIXED - py);
      if (outside * outside > Math.min(nearest.squared, limitSquared)) break;
    }
    return nearest;
  };
}

/** First containing dropped ring's replacement side, preserving ring order. Bounds exclude rings that cannot contain a brush cell. */
export function createDroppedRingQuery(rings: readonly Point[][]): (px: number, py: number) => boolean | null {
  const buckets = new Map<number, { ring: readonly Point[]; inside: boolean }[]>();
  for (const ring of rings) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const entry = { ring, inside: ringArea(ring) < 0 };
    for (let y = Math.floor(minY / OUTLINE_FIXED_POINT); y <= Math.floor(maxY / OUTLINE_FIXED_POINT); y++) {
      for (let x = Math.floor(minX / OUTLINE_FIXED_POINT); x <= Math.floor(maxX / OUTLINE_FIXED_POINT); x++) {
        const key = x * VERTEX_KEY_SPAN + y;
        let bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, bucket = []);
        bucket.push(entry);
      }
    }
  }
  return (px, py) => {
    const key = Math.floor(px / OUTLINE_FIXED_POINT) * VERTEX_KEY_SPAN + Math.floor(py / OUTLINE_FIXED_POINT);
    const bucket = buckets.get(key);
    if (bucket !== undefined) for (const { ring, inside } of bucket) if (ringContains(ring, px, py)) return inside;
    return null;
  };
}

/** Twice a closed ring's signed area: positive when what it encloses is inside its level. */
export function ringArea(ring: readonly Point[]): number {
  let twice = 0;
  for (let i = 1; i < ring.length; i++) twice += ring[i - 1]!.x * ring[i]!.y - ring[i]!.x * ring[i - 1]!.y;
  return twice;
}

/** Whether a closed ring encloses the point: crossings of a ray toward +x, exact in integers. */
export function ringContains(ring: readonly Point[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!;
    const b = ring[i]!;
    if (a.y > py === b.y > py) continue;
    const t = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y);
    if (b.y > a.y ? t > 0 : t < 0) inside = !inside;
  }
  return inside;
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
  const nearest = new NearestOutlinePoint(p.x, p.y);
  let order = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) nearest.consider(line, i, order++);
  }
  return nearest.point();
}
