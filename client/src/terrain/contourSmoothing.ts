import {
  CONTOUR_CELL_CENTRE_GUARD,
  RECT_NONE,
  samePoint,
  type ContourLoop,
  type ContourPoint,
} from './contours.ts';

export const CHAIKIN_ITERATIONS = 2;

export const CHAIKIN_CUT = 1 / 4;

export const CONTOUR_SIMPLIFY_EPSILON = 1 / 4096;

function chaikinPass(loop: ContourLoop): ContourLoop {
  const n = loop.length;
  if (n < 3) return loop;
  const out: ContourLoop = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    const aPinned = a.rect !== RECT_NONE;
    const bPinned = b.rect !== RECT_NONE;
    const first = aPinned
      ? a
      : {
          x: a.x + (b.x - a.x) * CHAIKIN_CUT,
          z: a.z + (b.z - a.z) * CHAIKIN_CUT,
          rect: RECT_NONE,
        };
    const second = bPinned
      ? b
      : {
          x: a.x + (b.x - a.x) * (1 - CHAIKIN_CUT),
          z: a.z + (b.z - a.z) * (1 - CHAIKIN_CUT),
          rect: RECT_NONE,
        };
    pushDistinct(out, first);
    pushDistinct(out, second);
  }
  if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out;
}

function pushDistinct(out: ContourLoop, p: ContourPoint): void {
  if (out.length > 0 && samePoint(out[out.length - 1], p)) return;
  out.push(p);
}

function enforceCentreGuard(loop: ContourLoop): void {
  for (const p of loop) {
    if (p.rect !== RECT_NONE) continue;
    const cx = Math.round(p.x);
    const cz = Math.round(p.z);
    const dx = p.x - cx;
    const dz = p.z - cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= CONTOUR_CELL_CENTRE_GUARD) continue;
    if (d === 0) {
      p.x = cx + CONTOUR_CELL_CENTRE_GUARD;
      continue;
    }
    const scale = CONTOUR_CELL_CENTRE_GUARD / d;
    p.x = cx + dx * scale;
    p.z = cz + dz * scale;
  }
}

function dropCollinear(loop: ContourLoop): ContourLoop {
  const n = loop.length;
  if (n < 4) return loop;
  const out: ContourLoop = [];
  for (let i = 0; i < n; i++) {
    const prev = out.length > 0 ? out[out.length - 1] : loop[(i + n - 1) % n];
    const here = loop[i];
    const next = loop[(i + 1) % n];
    if (here.rect !== RECT_NONE) {
      out.push(here);
      continue;
    }
    const area = Math.abs(
      (here.x - prev.x) * (next.z - prev.z) - (here.z - prev.z) * (next.x - prev.x),
    );
    const base = Math.hypot(next.x - prev.x, next.z - prev.z);
    if (base > 0 && area / base < CONTOUR_SIMPLIFY_EPSILON) continue;
    out.push(here);
  }
  return out.length >= 3 ? out : loop;
}

export function smoothLoop(loop: ContourLoop): ContourLoop {
  let current = loop;
  for (let pass = 0; pass < CHAIKIN_ITERATIONS; pass++) {
    current = chaikinPass(current);
  }
  enforceCentreGuard(current);
  return dropCollinear(current);
}
