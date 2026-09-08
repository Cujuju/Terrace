import { CELL_WORLD_SIZE } from '../../config.ts';
import {
  RECT_NONE,
  type ContourLoop,
  type ContourPoint,
} from '../../terrain/contours.ts';
import { type DrawnGround } from '../../terrain/drawnGround.ts';
import { BAND_GRID_CELLS } from '../../terrain/drawnGroundStore.ts';

export const CURTAIN_PROBE_CELLS = BAND_GRID_CELLS;

const CURTAIN_FOOT_SEARCH_MAX_CELLS = 1;

function isTileClosingSegment(a: ContourPoint, b: ContourPoint): boolean {
  return (a.rect & b.rect) !== RECT_NONE;
}

function outwardNormal(a: ContourPoint, b: ContourPoint): { x: number; z: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return { x: 0, z: 0 };
  return { x: dz / length, z: -dx / length };
}

function footBandOf(
  ground: DrawnGround,
  waterBandAt: (cellX: number, cellZ: number) => number | null,
  a: ContourPoint,
  b: ContourPoint,
  normal: { x: number; z: number },
  surfaceBand: number,
): { band: number; inWater: boolean } {
  const midX = (a.x + b.x) / 2;
  const midZ = (a.z + b.z) / 2;
  const steps = Math.round(CURTAIN_FOOT_SEARCH_MAX_CELLS / CURTAIN_PROBE_CELLS);
  let lowestGround = surfaceBand;
  let groundFalling = false;
  let groundSettled = false;
  let lowestWater: number | null = null;

  for (let step = 1; step <= steps; step++) {
    const reach = step * CURTAIN_PROBE_CELLS;
    const probeX = midX + normal.x * reach;
    const probeZ = midZ + normal.z * reach;

    const water = waterBandAt(Math.round(probeX), Math.round(probeZ));
    if (water !== null && water < surfaceBand && (lowestWater === null || water < lowestWater)) {
      lowestWater = water;
    }

    if (groundSettled) continue;
    const band = ground.bandAt(probeX, probeZ);
    if (band < lowestGround) {
      lowestGround = band;
      groundFalling = true;
      continue;
    }
    if (groundFalling || band > lowestGround) groundSettled = true;
  }

  return lowestWater !== null
    ? { band: lowestWater, inWater: true }
    : { band: lowestGround, inWater: false };
}

export function appendCurtains(
  ground: DrawnGround,
  loops: readonly ContourLoop[],
  surfaceBand: number,
  surfaceY: number,
  bandSurfaceY: (band: number, cellX: number, cellZ: number) => number,
  waterBandAt: (cellX: number, cellZ: number) => number | null,
  seaWorldY: number,
  out: number[],
): void {
  const topY = surfaceY;

  for (const loop of loops) {
    if (loop.length < 3) continue;
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % n]!;
      if (isTileClosingSegment(a, b)) continue;

      const normal = outwardNormal(a, b);
      const foot = footBandOf(ground, waterBandAt, a, b, normal, surfaceBand);
      if (foot.band >= surfaceBand) continue;

      const midCellX = (a.x + b.x) / 2;
      const midCellZ = (a.z + b.z) / 2;
      const footY = bandSurfaceY(foot.band, midCellX, midCellZ);
      const bottomY = foot.inWater ? footY : Math.max(footY, seaWorldY);
      if (bottomY >= topY) continue;

      const ax = a.x * CELL_WORLD_SIZE;
      const az = a.z * CELL_WORLD_SIZE;
      const bx = b.x * CELL_WORLD_SIZE;
      const bz = b.z * CELL_WORLD_SIZE;

      out.push(ax, topY, az, bx, topY, bz, bx, bottomY, bz);
      out.push(ax, topY, az, bx, bottomY, bz, ax, bottomY, az);
    }
  }
}
