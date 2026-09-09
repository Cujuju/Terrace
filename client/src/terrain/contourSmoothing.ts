import { DRAWN_GROUND_SIMPLIFY_EPSILON } from '@terrace/shared';
import { RECT_NONE, type ContourLoop } from './contours.ts';

export const CONTOUR_SIMPLIFY_EPSILON = DRAWN_GROUND_SIMPLIFY_EPSILON;

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

export function simplifyLoop(loop: ContourLoop): ContourLoop {
  return dropCollinear(loop);
}
