import {
  BAND_HEIGHT,
  BEDROCK_BAND,
  BEDROCK_FLOOR,
  drawnBandOfSample,
  quantizeToBand,
  SEA_LEVEL,
  setColumn,
  type Heightmap,
  type Span,
} from '@terrace/shared';

const MOUND_RADIUS_X_CELLS = 30;
const MOUND_RADIUS_Z_CELLS = 14;

const MOUND_CREST_BANDS = 9;
const MOUND_SHOULDER_BANDS = 8;
const MOUND_RIM_BANDS = 7;

const MOUND_CREST_EDGE_SQUARED = 0.5 * 0.5;
const MOUND_SHOULDER_EDGE_SQUARED = 0.8 * 0.8;

const MOUND_BASE_BANDS_ABOVE_SEA = 1;

const TUNNEL_OPENING_BANDS = 5;

/** A roof one band up rests on the floor; seeing under it needs a band of air as well. */
const MIN_TUNNEL_OPENING_BANDS = 2;

const TUNNEL_HALF_WIDTH_CELLS = 6;

const ARCH_TUNNEL_OFFSET_CELLS = -14;
const CAVE_TUNNEL_OFFSET_CELLS = 14;

const CAVE_DEPTH_FRACTION = 2 / 3;

const ARCH_FIXTURE_ENV_KEY = 'ARCH_FIXTURE';
const ARCH_FIXTURE_ENV_ON = '1';

export function archFixtureRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARCH_FIXTURE_ENV_KEY] === ARCH_FIXTURE_ENV_ON;
}

function moundBandsAt(dx: number, dz: number): number {
  const nx = dx / MOUND_RADIUS_X_CELLS;
  const nz = dz / MOUND_RADIUS_Z_CELLS;
  const rSquared = nx * nx + nz * nz;
  if (rSquared > 1) return 0;
  if (rSquared <= MOUND_CREST_EDGE_SQUARED) return MOUND_CREST_BANDS;
  if (rSquared <= MOUND_SHOULDER_EDGE_SQUARED) return MOUND_SHOULDER_BANDS;
  return MOUND_RIM_BANDS;
}

function insideTunnel(dx: number, dz: number): boolean {
  if (Math.abs(dx - ARCH_TUNNEL_OFFSET_CELLS) <= TUNNEL_HALF_WIDTH_CELLS) return true;
  if (Math.abs(dx - CAVE_TUNNEL_OFFSET_CELLS) > TUNNEL_HALF_WIDTH_CELLS) return false;
  const caveEnd = -MOUND_RADIUS_Z_CELLS + 2 * MOUND_RADIUS_Z_CELLS * CAVE_DEPTH_FRACTION;
  return dz <= caveEnd;
}

export function carveArchFixture(map: Heightmap): number {
  const centreX = Math.floor(map.size / 2);
  const centreZ = Math.floor(map.size / 2);

  const base = quantizeToBand(SEA_LEVEL + MOUND_BASE_BANDS_ABOVE_SEA * BAND_HEIGHT);
  if (base <= BEDROCK_FLOOR || TUNNEL_OPENING_BANDS < MIN_TUNNEL_OPENING_BANDS) {
    throw new Error(
      `arch fixture: a base of ${base} cannot carry an opening of ` +
        `${TUNNEL_OPENING_BANDS} band(s) above bedrock (${BEDROCK_FLOOR})`,
    );
  }
  const baseBand = drawnBandOfSample(base);
  let layered = 0;

  for (let dz = -MOUND_RADIUS_Z_CELLS; dz <= MOUND_RADIUS_Z_CELLS; dz++) {
    for (let dx = -MOUND_RADIUS_X_CELLS; dx <= MOUND_RADIUS_X_CELLS; dx++) {
      const bands = moundBandsAt(dx, dz);
      if (bands === 0) continue;

      const x = centreX + dx;
      const z = centreZ + dz;
      if (x < 0 || z < 0 || x >= map.size || z >= map.size) continue;

      const moundTop = base + bands * BAND_HEIGHT;
      const roofFloorBand = baseBand + TUNNEL_OPENING_BANDS;

      let spans: readonly Span[];
      if (insideTunnel(dx, dz) && TUNNEL_OPENING_BANDS < bands) {
        spans = [
          { floorBand: BEDROCK_BAND, ceiling: base },
          { floorBand: roofFloorBand, ceiling: moundTop },
        ];
        layered++;
      } else {
        spans = [{ floorBand: BEDROCK_BAND, ceiling: moundTop }];
      }

      setColumn(map, x, z, spans);
    }
  }

  return layered;
}
