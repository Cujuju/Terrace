import type { Vec3 } from './picking.ts';

export function intersectRayWithWall(
  origin: Vec3,
  direction: Vec3,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  yLo: number,
  yHi: number,
): number | null {
  const t = crossRayWithWallPlan(origin, direction, ax, az, bx, bz);
  if (t === null) return null;
  const py = origin.y + t * direction.y;
  if (py < yLo || py > yHi) return null;
  return t;
}

export function crossRayWithWallPlan(
  origin: Vec3,
  direction: Vec3,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number | null {
  const ex = bx - ax;
  const ez = bz - az;
  const lengthSq = ex * ex + ez * ez;
  if (lengthSq === 0) return null;

  const nx = ez;
  const nz = -ex;
  const denom = nx * direction.x + nz * direction.z;
  if (denom === 0) return null;

  const t = (nx * (ax - origin.x) + nz * (az - origin.z)) / denom;
  if (!(t >= 0)) return null;

  const px = origin.x + t * direction.x;
  const pz = origin.z + t * direction.z;
  const s = ((px - ax) * ex + (pz - az) * ez) / lengthSq;
  if (s < 0 || s > 1) return null;

  return t;
}
