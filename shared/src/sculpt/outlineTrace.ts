// Band outlines as oriented polylines: marching squares over the folded field
// the renderer draws, saddles decided by the centre.

/** Fixed-point steps per cell for outline coordinates. */
export const OUTLINE_FIXED_POINT = 256;

export interface Point {
  readonly x: number;
  readonly y: number;
  readonly pinned: boolean;
}

export type Field = (x: number, y: number) => number;

function crossing(px: number, py: number, fp: number, qx: number, qy: number, fq: number, threshold: number): [number, number] {
  // From the outside node q toward the inside node p, where the field meets the threshold.
  let s = Math.floor(((threshold - fq) * OUTLINE_FIXED_POINT) / (fp - fq));
  if (s < 1) s = 1;
  if (s > OUTLINE_FIXED_POINT - 1) s = OUTLINE_FIXED_POINT - 1;
  return [qx * OUTLINE_FIXED_POINT + (px - qx) * s, qy * OUTLINE_FIXED_POINT + (py - qy) * s];
}

/** Marching squares over [x0, x1) × [y0, y1); every segment runs with the inside on its positive-cross side. */
export function traceLevel(field: Field, threshold: number, x0: number, y0: number, x1: number, y1: number): Point[][] {
  const width = x1 - x0 + 1;
  // Edge ids: 2 * node + 0 for the edge to the right, + 1 for the edge down.
  const next = new Map<number, number>();
  const at = new Map<number, [number, number]>();
  const edgePoint = (nx: number, ny: number, down: boolean): number => {
    const id = 2 * ((ny - y0) * width + (nx - x0)) + (down ? 1 : 0);
    if (!at.has(id)) {
      const ox = down ? nx : nx + 1;
      const oy = down ? ny + 1 : ny;
      const fa = field(nx, ny);
      const fb = field(ox, oy);
      at.set(id, fa >= threshold ? crossing(nx, ny, fa, ox, oy, fb, threshold) : crossing(ox, oy, fb, nx, ny, fa, threshold));
    }
    return id;
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const fa = field(x, y);
      const fb = field(x + 1, y);
      const fc = field(x + 1, y + 1);
      const fd = field(x, y + 1);
      const ia = fa >= threshold;
      const ib = fb >= threshold;
      const ic = fc >= threshold;
      const id = fd >= threshold;
      const top = (): number => edgePoint(x, y, false);
      const right = (): number => edgePoint(x + 1, y, true);
      const bottom = (): number => edgePoint(x, y + 1, false);
      const left = (): number => edgePoint(x, y, true);
      const link = (e1: number, e2: number, insideX: number, insideY: number): void => {
        const [ax, ay] = at.get(e1)!;
        const [bx, by] = at.get(e2)!;
        const cross = (bx - ax) * (insideY * OUTLINE_FIXED_POINT - ay) - (by - ay) * (insideX * OUTLINE_FIXED_POINT - ax);
        if (cross >= 0) next.set(e1, e2);
        else next.set(e2, e1);
      };
      const mask = (ia ? 1 : 0) | (ib ? 2 : 0) | (ic ? 4 : 0) | (id ? 8 : 0);
      if (mask === 0 || mask === 15) continue;
      const centreInside = fa + fb + fc + fd >= 4 * threshold;
      if (mask === 5 || mask === 10) {
        // Saddle: the centre decides whether the inside corners connect.
        const aInside = mask === 5;
        if (aInside === centreInside) {
          link(top(), right(), aInside ? x : x + 1, y);
          link(bottom(), left(), aInside ? x + 1 : x, y + 1);
        } else {
          link(left(), top(), aInside ? x : x + 1, y);
          link(right(), bottom(), aInside ? x + 1 : x, y + 1);
        }
        continue;
      }
      const edges: number[] = [];
      if (ia !== ib) edges.push(top());
      if (ib !== ic) edges.push(right());
      if (id !== ic) edges.push(bottom());
      if (ia !== id) edges.push(left());
      const [cornerX, cornerY] = ia ? [x, y] : ib ? [x + 1, y] : ic ? [x + 1, y + 1] : [x, y + 1];
      link(edges[0]!, edges[1]!, cornerX, cornerY);
    }
  }
  const hasPrevious = new Set(next.values());
  const used = new Set<number>();
  const lines: Point[][] = [];
  const walk = (start: number): void => {
    const line: Point[] = [];
    let edge: number | undefined = start;
    while (edge !== undefined && !used.has(edge)) {
      used.add(edge);
      const [px, py] = at.get(edge)!;
      line.push({ x: px, y: py, pinned: false });
      edge = next.get(edge);
    }
    if (edge === start && line.length > 0) line.push(line[0]!);
    if (line.length > 1) lines.push(line);
  };
  // Open lines first, from the ends with nothing before them, then closed loops; map order is insertion order.
  for (const edge of next.keys()) if (!hasPrevious.has(edge)) walk(edge);
  for (const edge of next.keys()) if (!used.has(edge)) walk(edge);
  return lines;
}

