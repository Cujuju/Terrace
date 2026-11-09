import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import {
  ARENA_RADIUS_CELLS,
  BREATHE_RADIUS_FRACTION,
  HEIGHT_WORLD_SCALE,
  ORBIT_RADIUS_FRACTION_MAX,
} from '../protocol.ts';
import { FlightTerrain, type FlightWorld } from './flight-terrain.ts';
import { isClearOfSettlements } from './structures-bridge.ts';

export type SiteWorld = FlightWorld;

const ARENA_SITE_ATTEMPTS = 24;

const CRASH_SITE_ATTEMPTS_PER_CELL = 8;

const ARENA_CLEARANCE_CELLS = ARENA_RADIUS_CELLS;

const CLEARANCE_BEARINGS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const FLIGHT_ARENA_RADIUS_CELLS =
  ARENA_RADIUS_CELLS * (ORBIT_RADIUS_FRACTION_MAX + BREATHE_RADIUS_FRACTION);

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
  readonly terrain: FlightTerrain;
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

function arenaSite(world: SiteWorld, centreX: number, centreY: number, crashCells: CrashCell[]): ArenaSite {
  const terrain = new FlightTerrain();
  const centre = { x: centreX, y: centreY };
  terrain.includeCorridor(world, centre, centre, FLIGHT_ARENA_RADIUS_CELLS);
  return { centreX, centreY, crashCells, terrain, get altitude() { return terrain.altitude(); } };
}

export function crashCellAt(world: SiteWorld, x: number, y: number): CrashCell | null {
  if (!isRevealed(world, x, y)) return null;
  const height = world.heightAt(x, y);
  const water = height <= SEA_LEVEL;
  return {
    x, y,
    groundY: Math.max(height, SEA_LEVEL) * HEIGHT_WORLD_SCALE,
    water,
    depthBands: water ? (SEA_LEVEL - height) / BAND_HEIGHT : 0,
  };
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
    if (!isClearOfSettlements(x, y)) continue;
    const cell = crashCellAt(world, x, y);
    if (cell === null) continue;
    taken.add(key);
    cells.push(cell);
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

    return arenaSite(world, centreX, centreY, crashCells);
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

      return arenaSite(world, centreX, centreY, crashCells);
    }
  }
  return null;
}

export const ADMIN_SEARCH_RADIUS_CELLS = 160;

const ADMIN_SEARCH_STEP_CELLS = 8;

const ADMIN_SEARCH_SPOKES = 16;
