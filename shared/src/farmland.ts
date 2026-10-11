import { bandOf, isWater } from './heightmap.ts';

export interface FarmlandWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

const ADJACENT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function isFarmlandCell(world: FarmlandWorld, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;

  const height = world.heightAt(x, y);
  if (isWater(height)) return false;
  const band = bandOf(height);

  let touchesWater = false;
  for (const [dx, dy] of ADJACENT_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;

    const neighborHeight = world.heightAt(nx, ny);
    if (isWater(neighborHeight)) {
      touchesWater = true;
      continue;
    }
    if (bandOf(neighborHeight) !== band) return false;
  }
  return touchesWater;
}

export function isFarmlandPlot(
  world: FarmlandWorld,
  x: number,
  y: number,
  treadCells: number,
): boolean {
  if (!Number.isInteger(treadCells) || treadCells < 0) return false;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;

  const height = world.heightAt(x, y);
  if (isWater(height)) return false;
  const band = bandOf(height);

  for (const [dx, dy] of ADJACENT_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    const neighborHeight = world.heightAt(nx, ny);
    if (isWater(neighborHeight)) {
      if (treadCells >= 1) return false;
      continue;
    }
    if (bandOf(neighborHeight) !== band) return false;
  }
  for (let dy = -treadCells; dy <= treadCells; dy++) {
    for (let dx = -treadCells; dx <= treadCells; dx++) {
      if (Math.abs(dx) + Math.abs(dy) <= 1) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
      const neighborHeight = world.heightAt(nx, ny);
      if (isWater(neighborHeight)) return false;
      if (bandOf(neighborHeight) !== band) return false;
    }
  }

  const shore = treadCells + 1;
  for (let dy = -shore; dy <= shore; dy++) {
    for (let dx = -shore; dx <= shore; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== shore) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
      if (isWater(world.heightAt(nx, ny))) return true;
    }
  }
  return false;
}
