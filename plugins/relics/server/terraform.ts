import { BAND_HEIGHT, MAX_BRUSH_RADIUS } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import type { SkillId } from '../protocol.ts';

export interface TerraformStep {
  readonly dx: number;
  readonly dy: number;
  readonly radius: number;
  readonly amount: number;
}

export const TERRAFORM_RING_OFFSET = MAX_BRUSH_RADIUS;

const RING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-TERRAFORM_RING_OFFSET, 0],
  [TERRAFORM_RING_OFFSET, 0],
  [0, -TERRAFORM_RING_OFFSET],
  [0, TERRAFORM_RING_OFFSET],
];

export const QUAKE_CORE_DEPTH_BANDS = 6;

export const QUAKE_RIM_DEPTH_BANDS = QUAKE_CORE_DEPTH_BANDS / 2;

export const GENESIS_PEAK_BANDS = QUAKE_CORE_DEPTH_BANDS;

export const GENESIS_SHORE_BANDS = 2;

function ring(bands: number): TerraformStep[] {
  return RING_OFFSETS.map(([dx, dy]) => ({
    dx,
    dy,
    radius: MAX_BRUSH_RADIUS,
    amount: bands * BAND_HEIGHT,
  }));
}

export const QUAKE_STEPS: readonly TerraformStep[] = [
  { dx: 0, dy: 0, radius: MAX_BRUSH_RADIUS, amount: -QUAKE_CORE_DEPTH_BANDS * BAND_HEIGHT },
  ...ring(-QUAKE_RIM_DEPTH_BANDS),
];

export const GENESIS_STEPS: readonly TerraformStep[] = [
  { dx: 0, dy: 0, radius: MAX_BRUSH_RADIUS, amount: GENESIS_PEAK_BANDS * BAND_HEIGHT },
  ...ring(GENESIS_SHORE_BANDS),
];

export interface TerraformSpec {
  readonly peakBands: number;

  plan(world: WorldApi, x: number, y: number): readonly TerraformStep[];
}

function peakBandsOf(steps: readonly TerraformStep[]): number {
  return Math.max(...steps.map((step) => Math.abs(step.amount))) / BAND_HEIGHT;
}

export function fixedTerraform(steps: readonly TerraformStep[]): TerraformSpec {
  return { peakBands: peakBandsOf(steps), plan: () => steps };
}

export const BULWARK_WALL_BANDS = QUAKE_CORE_DEPTH_BANDS / 2;

export const BULWARK_RING_RADIUS = 2 * TERRAFORM_RING_OFFSET;

export const BULWARK_SEGMENTS = 8;

const FULL_TURN = Math.PI * 2;

export const BULWARK_STEPS: readonly TerraformStep[] = Array.from(
  { length: BULWARK_SEGMENTS },
  (_unused, index) => {
    const bearing = (index / BULWARK_SEGMENTS) * FULL_TURN;
    return {
      dx: Math.round(Math.cos(bearing) * BULWARK_RING_RADIUS),
      dy: Math.round(Math.sin(bearing) * BULWARK_RING_RADIUS),
      radius: MAX_BRUSH_RADIUS,
      amount: BULWARK_WALL_BANDS * BAND_HEIGHT,
    };
  },
);

export const LANDSLIDE_HALVING = 2;

export const LANDSLIDE_MIN_FACE_BANDS = LANDSLIDE_HALVING * LANDSLIDE_HALVING;

export const LANDSLIDE_MAX_TOPPLE_BANDS = 4;

export function planLandslide(
  world: WorldApi,
  x: number,
  y: number,
): readonly TerraformStep[] {
  const size = world.worldSize;
  const top = world.heightAt(x, y);

  let face: { readonly dx: number; readonly dy: number; readonly drop: number } | null = null;
  for (const [dx, dy] of RING_OFFSETS) {
    const px = x + dx;
    const py = y + dy;
    if (px < 0 || py < 0 || px >= size || py >= size) continue;
    const drop = top - world.heightAt(px, py);
    if (face === null || drop > face.drop) face = { dx, dy, drop };
  }
  if (face === null) return [];

  const faceBands = Math.floor(face.drop / BAND_HEIGHT);
  if (faceBands < LANDSLIDE_MIN_FACE_BANDS) return [];

  const toppleBands = Math.min(
    Math.floor(faceBands / LANDSLIDE_HALVING),
    LANDSLIDE_MAX_TOPPLE_BANDS,
  );

  const steps: TerraformStep[] = [
    { dx: 0, dy: 0, radius: MAX_BRUSH_RADIUS, amount: -toppleBands * BAND_HEIGHT },
  ];
  let bands = Math.floor(toppleBands / LANDSLIDE_HALVING);
  for (let stride = 1; bands >= 1; stride++) {
    steps.push({
      dx: face.dx * stride,
      dy: face.dy * stride,
      radius: MAX_BRUSH_RADIUS,
      amount: bands * BAND_HEIGHT,
    });
    bands = Math.floor(bands / LANDSLIDE_HALVING);
  }
  return steps;
}

export const TERRAFORM_BY_SKILL: ReadonlyMap<SkillId, TerraformSpec> = new Map<
  SkillId,
  TerraformSpec
>([
  ['quake', fixedTerraform(QUAKE_STEPS)],
  ['genesis', fixedTerraform(GENESIS_STEPS)],
  ['bulwark', fixedTerraform(BULWARK_STEPS)],
  ['landslide', { peakBands: LANDSLIDE_MAX_TOPPLE_BANDS, plan: planLandslide }],
]);

export function applyTerraform(
  world: WorldApi,
  x: number,
  y: number,
  steps: readonly TerraformStep[],
): number {
  const size = world.worldSize;
  let changed = 0;

  for (const step of steps) {
    const cx = x + step.dx;
    const cy = y + step.dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
    changed += world.sculpt(cx, cy, step.radius, step.amount).length;
  }

  return changed;
}
