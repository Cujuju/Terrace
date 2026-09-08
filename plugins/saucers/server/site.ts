import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { ARENA_RADIUS_CELLS, CRUISE_ALTITUDE_WORLD_UNITS, HEIGHT_WORLD_SCALE } from '../protocol.ts';
import { isClearOfSettlements } from './structures-bridge.ts';

export interface SiteWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

const ARENA_SITE_ATTEMPTS = 24;

const CRASH_SITE_ATTEMPTS_PER_CELL = 8;

const ARENA_CLEARANCE_CELLS = ARENA_RADIUS_CELLS;

const CLEARANCE_BEARINGS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const ALTITUDE_SAMPLE_SPOKES = 16;

const ALTITUDE_SAMPLE_RADII: readonly number[] = [0.5, 1];

export interface CrashCell {
  readonly x: number;
  readonly y: number;
  readonly groundY: number;
  readonly water: boolean;
  readonly depthBands: number;
}

export interface ArenaSite {
  readonly centreX: number;
  readonly centreY: number;
  readonly crashCells: readonly CrashCell[];
  readonly altitude: number;
}

function isRevealed(world: SiteWorld, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  return world.isCellUnlocked(x, y);
}

function isOpenLand(world: SiteWorld, x: number, y: number): boolean {
  return isRevealed(world, x, y) && world.heightAt(x, y) > SEA_LEVEL;
}

function hasArenaClearance(world: SiteWorld, x: number, y: number): boolean {
  for (const [dx, dy] of CLEARANCE_BEARINGS) {
    const sx = Math.round(x + dx * ARENA_CLEARANCE_CELLS);
    const sy = Math.round(y + dy * ARENA_CLEARANCE_CELLS);
    if (!isRevealed(world, sx, sy)) return false;
  }
  return true;
}

function arenaAltitude(world: SiteWorld, x: number, y: number): number {
  let peak = world.heightAt(x, y);
  for (let spoke = 0; spoke < ALTITUDE_SAMPLE_SPOKES; spoke++) {
    const angle = (spoke * 2 * Math.PI) / ALTITUDE_SAMPLE_SPOKES;
    for (const fraction of ALTITUDE_SAMPLE_RADII) {
      const sx = Math.round(x + Math.cos(angle) * ARENA_RADIUS_CELLS * fraction);
      const sy = Math.round(y + Math.sin(angle) * ARENA_RADIUS_CELLS * fraction);
      if (sx < 0 || sy < 0 || sx >= world.worldSize || sy >= world.worldSize) continue;
      const height = world.heightAt(sx, sy);
      if (height > peak) peak = height;
    }
  }
  return peak * HEIGHT_WORLD_SCALE + CRUISE_ALTITUDE_WORLD_UNITS;
}

function findCrashCells(
  world: SiteWorld,
  centreX: number,
  centreY: number,
  random: () => number,
  wanted: number,
): CrashCell[] | null {
  const cells: CrashCell[] = [];
  const taken = new Set<number>();
  const attempts = CRASH_SITE_ATTEMPTS_PER_CELL * wanted;
  for (let attempt = 0; attempt < attempts && cells.length < wanted; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * ARENA_RADIUS_CELLS;
    const x = Math.round(centreX + Math.cos(angle) * distance);
    const y = Math.round(centreY + Math.sin(angle) * distance);
    const key = y * world.worldSize + x;
    if (taken.has(key)) continue;
    if (!isRevealed(world, x, y)) continue;
    if (!isClearOfSettlements(x, y)) continue;
    taken.add(key);
    const height = world.heightAt(x, y);
    const water = height <= SEA_LEVEL;
    cells.push({
      x,
      y,
      groundY: Math.max(height, SEA_LEVEL) * HEIGHT_WORLD_SCALE,
      water,
      depthBands: water ? (SEA_LEVEL - height) / BAND_HEIGHT : 0,
    });
  }
  return cells.length === wanted ? cells : null;
}

export function findArenaSite(
  world: SiteWorld,
  random: () => number,
  crashCellsWanted: number,
): ArenaSite | null {
  for (let attempt = 0; attempt < ARENA_SITE_ATTEMPTS; attempt++) {
    const centreX = Math.floor(random() * world.worldSize);
    const centreY = Math.floor(random() * world.worldSize);
    if (!isOpenLand(world, centreX, centreY)) continue;
    if (!hasArenaClearance(world, centreX, centreY)) continue;

    const crashCells = findCrashCells(world, centreX, centreY, random, crashCellsWanted);
    if (crashCells === null) continue;

    return { centreX, centreY, crashCells, altitude: arenaAltitude(world, centreX, centreY) };
  }
  return null;
}

export function findArenaSiteNear(
  world: SiteWorld,
  near: { readonly x: number; readonly y: number },
  random: () => number,
  crashCellsWanted: number,
): ArenaSite | null {
  for (let radius = 0; radius <= ADMIN_SEARCH_RADIUS_CELLS; radius += ADMIN_SEARCH_STEP_CELLS) {
    const spokes = radius === 0 ? 1 : ADMIN_SEARCH_SPOKES;
    for (let spoke = 0; spoke < spokes; spoke++) {
      const angle = (spoke * 2 * Math.PI) / spokes;
      const centreX = Math.round(near.x + Math.cos(angle) * radius);
      const centreY = Math.round(near.y + Math.sin(angle) * radius);
      if (!isOpenLand(world, centreX, centreY)) continue;
      if (!hasArenaClearance(world, centreX, centreY)) continue;

      const crashCells = findCrashCells(world, centreX, centreY, random, crashCellsWanted);
      if (crashCells === null) continue;

      return { centreX, centreY, crashCells, altitude: arenaAltitude(world, centreX, centreY) };
    }
  }
  return null;
}

export const ADMIN_SEARCH_RADIUS_CELLS = 160;

const ADMIN_SEARCH_STEP_CELLS = 8;

const ADMIN_SEARCH_SPOKES = 16;
