import { hashStructureCell, type StructureTier } from '../protocol.ts';

export const SKIFF_MIN_TIER: StructureTier = 1;

export const SKIFF_MAX_PER_SETTLEMENT = 3;

export const SKIFF_ORBIT_PERIOD_SECONDS = 14;

export const SKIFF_ORBIT_RADIUS_MIN_WORLD_UNITS = 0.12;
export const SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS = 0.28;

export const SKIFF_HULL_AUTHORED_LENGTH_WORLD_UNITS = 0.36;
export const SKIFF_HULL_AUTHORED_BEAM_WORLD_UNITS = 0.14;

export const SKIFF_MODEL_SCALE = 1.6;

export const SKIFF_HULL_LENGTH_WORLD_UNITS =
  SKIFF_HULL_AUTHORED_LENGTH_WORLD_UNITS * SKIFF_MODEL_SCALE;
export const SKIFF_HULL_BEAM_WORLD_UNITS =
  SKIFF_HULL_AUTHORED_BEAM_WORLD_UNITS * SKIFF_MODEL_SCALE;

export const SKIFF_MOORING_CLEARANCE_WORLD_UNITS =
  SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS + SKIFF_HULL_LENGTH_WORLD_UNITS / 2;

export const SKIFF_MOORING_SPACING_WORLD_UNITS = 2 * SKIFF_MOORING_CLEARANCE_WORLD_UNITS;

export interface SkiffPlacement {
  readonly x: number;
  readonly z: number;
  readonly orbitRadius: number;
  readonly orbitClockwise: boolean;
  readonly phaseSeconds: number;
}

export function skiffsForSettlement(
  tier: StructureTier,
  moorings: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): SkiffPlacement[] {
  if (tier < SKIFF_MIN_TIER) return [];
  const count = Math.min(SKIFF_MAX_PER_SETTLEMENT, tier, moorings.length);

  const placements: SkiffPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const cell = moorings[i];
    const hash = hashStructureCell(cell.x, cell.y);
    const phaseRoll = hash & 0xffff;
    const radiusRoll = (hash >>> 16) & 0xff;
    const directionRoll = (hash >>> 24) & 1;
    placements.push({
      x: cell.x,
      z: cell.y,
      orbitRadius:
        SKIFF_ORBIT_RADIUS_MIN_WORLD_UNITS +
        (radiusRoll / 0xff) * (SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS - SKIFF_ORBIT_RADIUS_MIN_WORLD_UNITS),
      orbitClockwise: directionRoll === 0,
      phaseSeconds: (phaseRoll / 0x10000) * SKIFF_ORBIT_PERIOD_SECONDS,
    });
  }
  return placements;
}
