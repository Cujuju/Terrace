import { describe, expect, it } from 'vitest';
import {
  BEDROCK_BAND,
  CHUNK_SIZE,
  bandLevelHeight,
  setColumn,
  spanAt,
  spanCapBand,
  type ChunkPayload,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';
import { drawnBandAtY } from '../src/terrain/capEmission.ts';
import { pickTerrainCellByRay, type TerrainRayPick, type Vec3 } from '../src/terrain/picking.ts';
import { resolvePick } from '../src/terrain/pickBand.ts';
import { applySnapshot, createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

const WORLD = CHUNK_SIZE * 4;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

/** A hit sits on the ray to within this; only float error should separate them. */
const ON_RAY_EPSILON = 1e-6;

const HOLLOW_X = [30, 34] as const;
const HOLLOW_Z = [28, 32] as const;
const HOLLOW_FLOOR_BAND = 4;
const HOLLOW_ROOF_FLOOR_BAND = 10;
const HOLLOW_ROOF_CAP_BAND = 14;

const STEP_CELLS = 4;
const RAMP_TOP_BAND = 20;

function world(heightOf: (x: number, y: number) => number): TerrainMirror {
  const mirror = createTerrainMirror(WORLD);
  const perEdge = WORLD / CHUNK_SIZE;
  const chunks: ChunkPayload[] = [];
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      const heights = new Array<number>(CELLS_PER_CHUNK);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          heights[ly * CHUNK_SIZE + lx] = heightOf(cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly);
        }
      }
      chunks.push({ cx, cy, heights });
    }
  }
  applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks });
  return mirror;
}

/** A terraced ramp, with one carved block: solid, hollow, roof. Treads, risers and undersides. */
function rampWithHollow(): TerrainMirror {
  const mirror = world((x) =>
    bandLevelHeight(Math.max(0, Math.min(RAMP_TOP_BAND, Math.floor(x / STEP_CELLS)))),
  );
  for (let x = HOLLOW_X[0]; x <= HOLLOW_X[1]; x++) {
    for (let z = HOLLOW_Z[0]; z <= HOLLOW_Z[1]; z++) {
      setColumn(mirror.map, x, z, [
        { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(HOLLOW_FLOOR_BAND) },
        { floorBand: HOLLOW_ROOF_FLOOR_BAND, ceiling: bandLevelHeight(HOLLOW_ROOF_CAP_BAND) },
      ]);
    }
  }
  return mirror;
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

const AIM_ORIGIN: Vec3 = { x: 2 * CELL_WORLD_SIZE, y: 9, z: 30 * CELL_WORLD_SIZE };
const AIM_FIRST_CELL = 4;
const AIM_LAST_CELL = 50;
const AIM_STEPS = 600;

/** The aim swept across the ramp in even steps, as a pointer crossing the screen. */
function sweep(mirror: TerrainMirror): { pick: TerrainRayPick; direction: Vec3 }[] {
  const out: { pick: TerrainRayPick; direction: Vec3 }[] = [];
  for (let step = 0; step <= AIM_STEPS; step++) {
    const alongX = AIM_FIRST_CELL + ((AIM_LAST_CELL - AIM_FIRST_CELL) * step) / AIM_STEPS;
    const direction = normalize({
      x: alongX * CELL_WORLD_SIZE - AIM_ORIGIN.x,
      y: -AIM_ORIGIN.y,
      z: 0,
    });
    const pick = pickTerrainCellByRay(mirror, AIM_ORIGIN, direction);
    if (pick !== null) out.push({ pick, direction });
  }
  return out;
}

/** How far the hit strays from the ray, solving the ray parameter from its own X. */
function offRayDistance(pick: TerrainRayPick, direction: Vec3): number {
  const t = (pick.hitX - AIM_ORIGIN.x) / direction.x;
  return Math.max(
    Math.abs(AIM_ORIGIN.y + t * direction.y - pick.hitY),
    Math.abs(AIM_ORIGIN.z + t * direction.z - pick.hitZ),
  );
}

describe('the pick contract', () => {
  it('sweeps a ramp and a carved hollow, striking every face', () => {
    const picks = sweep(rampWithHollow());
    expect(picks.length).toBeGreaterThan(AIM_STEPS / 2);
    const faces = new Set(picks.map((p) => p.pick.face));
    expect(faces.has('tread')).toBe(true);
    expect(faces.has('riser')).toBe(true);
  });

  it('names the band at the hit point on every face', () => {
    for (const { pick } of sweep(rampWithHollow())) {
      const expected =
        pick.face === 'underside'
          ? spanAt(rampWithHollow().map, pick.x, pick.y, pick.spanIndex).floorBand
          : drawnBandAtY(pick.hitY);
      expect({ face: pick.face, band: pick.band }).toEqual({ face: pick.face, band: expected });
    }
  });

  it('keeps the hit point on the pointer ray, so the crosshair tracks the cursor', () => {
    for (const { pick, direction } of sweep(rampWithHollow())) {
      expect(offRayDistance(pick, direction)).toBeLessThan(ON_RAY_EPSILON);
    }
  });

  it('resolves a band inside the drawn range of the span it landed on', () => {
    const mirror = rampWithHollow();
    for (const { pick } of sweep(mirror)) {
      const resolved = resolvePick(mirror.map, pick);
      if (resolved === null) continue;
      const span = spanAt(mirror.map, pick.x, pick.y, pick.spanIndex);
      expect(resolved.band).toBeGreaterThanOrEqual(span.floorBand);
      expect(resolved.band).toBeLessThanOrEqual(spanCapBand(span));
    }
  });

  it('never moves the band more than one step while the aim stays in a cell', () => {
    const picks = sweep(rampWithHollow());
    for (let i = 1; i < picks.length; i++) {
      const before = picks[i - 1]!.pick;
      const after = picks[i]!.pick;
      if (before.x !== after.x || before.y !== after.y) continue;
      expect(Math.abs(after.band - before.band)).toBeLessThanOrEqual(1);
    }
  });

  it('clamps a shore skirt hit to the band the column draws, never to water', () => {
    // A tread at raw 5 draws its cap at y=0, so the march strikes the skirt below it.
    const mirror = world((x) => (x >= 32 ? 5 : 0));
    const skirt: TerrainRayPick = {
      x: 32,
      y: 20,
      surfaceY: 0,
      spanIndex: 0,
      face: 'riser',
      band: drawnBandAtY(-5 * HEIGHT_WORLD_SCALE),
      hitY: -5 * HEIGHT_WORLD_SCALE,
      hitX: 32 * CELL_WORLD_SIZE,
      hitZ: 20 * CELL_WORLD_SIZE,
    };
    expect(resolvePick(mirror.map, skirt)?.band).toBe(0);
  });
});
