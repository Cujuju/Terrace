import { drawnBandField, drawnBandOfSample, drawnLevelThreshold } from './bands.ts';
import {
  DRAWN_GROUND_BAND_BIAS,
  DRAWN_GROUND_CENTRE_CLEARANCE,
  DRAWN_GROUND_COORD_DENOM,
  ISOLINE_SAMPLES_PER_CELL,
  drawnCrossingFraction,
  drawnIsolineAt,
} from './drawnGround.ts';

// One lattice square's drawn outline for one band, the geometry the meshers emit
// and the ground and pick queries read (docs/plans/edge-aware-brushes.md, step 7).

/** A tall step fans its bands this far apart around its wall. */
export const DRAWN_FAN_SPACING_CELLS = 1 / 4;

/** Four bands a quarter cell apart fill a cell; a taller step stacks as one wall. */
export const DRAWN_FAN_MAX_BANDS = 1 / DRAWN_FAN_SPACING_CELLS;

/** A fanned band keeps one edge-encoding step, an eighth of a cell, clear of both cells. */
export const DRAWN_FAN_CLEARANCE_CELLS = 1 / 8;

/**
 * Where band `band` crosses an edge, as a fraction from its outside end: at the
 * wall for one band; a taller step fans its bands evenly around the wall.
 */
export function drawnEdgeCrossing(outsideRaw: number, insideRaw: number, band: number): number {
  const wall = drawnCrossingFraction(
    drawnBandField(outsideRaw, band),
    drawnBandField(insideRaw, band),
    drawnLevelThreshold(band),
  );
  const low = drawnBandOfSample(outsideRaw);
  const bands = drawnBandOfSample(insideRaw) - low;
  if (bands <= 1 || bands > DRAWN_FAN_MAX_BANDS) return wall;
  // Centred on the wall, never wider than the room on its nearer side.
  const halfSteps = (bands - 1) / 2;
  const room = (wall < 1 - wall ? wall : 1 - wall) - DRAWN_FAN_CLEARANCE_CELLS;
  const fit = room / halfSteps;
  // A fan narrower than the crossing clearance would only draw slivers: it stacks.
  if (fit < DRAWN_GROUND_CENTRE_CLEARANCE) return wall;
  const spacing = fit < DRAWN_FAN_SPACING_CELLS ? fit : DRAWN_FAN_SPACING_CELLS;
  // Higher bands sit nearer the inside end, where their own ground is.
  return wall + (band - low - 1 - halfSteps) * spacing;
}

function clampUnits(units: number): number {
  if (!(units > 0)) return 0;
  return units > DRAWN_GROUND_COORD_DENOM ? DRAWN_GROUND_COORD_DENOM : units;
}

/**
 * Interior points, in square coordinates, of the bilinear isoline between edge
 * points (ax, az) and (bx, bz). Writes `outU`/`outV`; returns how many.
 */
export function drawnIsolinePoints(
  northWest: number,
  northEast: number,
  southWest: number,
  southEast: number,
  threshold: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  outU: Float64Array,
  outV: Float64Array,
): number {
  const spanU = Math.abs(bx - ax);
  const spanV = Math.abs(bz - az);
  if (spanU + spanV < ISOLINE_SAMPLES_PER_CELL / DRAWN_GROUND_COORD_DENOM) return 0;
  const alongX = spanU >= spanV;
  const chordLengthSquared = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
  let written = 0;
  let advanced = 0;
  for (let k = 1; k < ISOLINE_SAMPLES_PER_CELL; k++) {
    const t = k / ISOLINE_SAMPLES_PER_CELL;
    const fixedUnits = clampUnits(
      Math.round((alongX ? ax + (bx - ax) * t : az + (bz - az) * t) * DRAWN_GROUND_COORD_DENOM),
    );
    const solved = drawnIsolineAt(
      northWest, northEast, southWest, southEast, threshold, fixedUnits, alongX,
    );
    if (solved === null || solved <= 0 || solved >= 1) continue;
    const fixed = fixedUnits / DRAWN_GROUND_COORD_DENOM;
    const u = alongX ? fixed : solved;
    const v = alongX ? solved : fixed;
    const along = ((u - ax) * (bx - ax) + (v - az) * (bz - az)) / chordLengthSquared;
    if (!(along > advanced) || !(along < 1)) continue;
    advanced = along;
    outU[written] = u;
    outV[written] = v;
    written++;
  }
  return written;
}

/**
 * The isoline's interior points between two fanned crossings: solved on the
 * wall chord, each shifted by its ends' fan shifts blended along the chord.
 */
export function drawnFannedIsolinePoints(
  northWest: number,
  northEast: number,
  southWest: number,
  southEast: number,
  threshold: number,
  wallFrom: readonly [number, number],
  wallTo: readonly [number, number],
  fanFrom: readonly [number, number],
  fanTo: readonly [number, number],
  outU: Float64Array,
  outV: Float64Array,
): number {
  const [ax, az] = wallFrom;
  const [bx, bz] = wallTo;
  const count = drawnIsolinePoints(
    northWest, northEast, southWest, southEast, threshold, ax, az, bx, bz, outU, outV,
  );
  const chordLengthSquared = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
  // Kept clear of the square's edges, a shifted point can never carry the outline round a corner.
  const least = DRAWN_GROUND_CENTRE_CLEARANCE;
  const most = 1 - DRAWN_GROUND_CENTRE_CLEARANCE;
  for (let k = 0; k < count; k++) {
    const along = ((outU[k]! - ax) * (bx - ax) + (outV[k]! - az) * (bz - az)) / chordLengthSquared;
    const u = outU[k]! + (fanFrom[0] - ax) * (1 - along) + (fanTo[0] - bx) * along;
    const v = outV[k]! + (fanFrom[1] - az) * (1 - along) + (fanTo[1] - bz) * along;
    outU[k] = u < least ? least : u > most ? most : u;
    outV[k] = v < least ? least : v > most ? most : v;
  }
  return count;
}

/** Square edges, as marching squares names them: north, east, south, west. */
export const SQUARE_EDGE_NORTH = 0;
export const SQUARE_EDGE_EAST = 1;
export const SQUARE_EDGE_SOUTH = 2;
export const SQUARE_EDGE_WEST = 3;

const N = SQUARE_EDGE_NORTH;
const E = SQUARE_EDGE_EAST;
const S = SQUARE_EDGE_SOUTH;
const W = SQUARE_EDGE_WEST;

/** Contour segments per corner mask (NW 1, NE 2, SE 4, SW 8), from edge to edge. */
export const MARCHING_CASES: readonly (readonly number[])[] = [
  [], [N, W], [E, N], [E, W], [S, E], [], [S, N], [S, W],
  [W, S], [N, S], [], [E, S], [W, E], [N, E], [W, N], [],
];
export const MARCHING_SADDLE_5_JOINED: readonly number[] = [N, E, S, W];
export const MARCHING_SADDLE_5_SPLIT: readonly number[] = [N, W, S, E];
export const MARCHING_SADDLE_10_JOINED: readonly number[] = [W, N, E, S];
export const MARCHING_SADDLE_10_SPLIT: readonly number[] = [E, N, W, S];

/** The saddle reads joined when the corners' mean clears the threshold. */
export function marchingSegments(
  mask: number,
  northWest: number,
  northEast: number,
  southEast: number,
  southWest: number,
  bias: number,
  threshold: number,
): readonly number[] {
  if (mask !== 5 && mask !== 10) return MARCHING_CASES[mask]!;
  const joined = (northWest + northEast + southEast + southWest) / 4 + bias >= threshold;
  return mask === 5
    ? joined ? MARCHING_SADDLE_5_JOINED : MARCHING_SADDLE_5_SPLIT
    : joined ? MARCHING_SADDLE_10_JOINED : MARCHING_SADDLE_10_SPLIT;
}

/** Corners of a square's edge, from its low end: north and south run west to east. */
const EDGE_ENDS: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [3, 2], [0, 3]];
const CORNER_U: readonly number[] = [0, 1, 1, 0];
const CORNER_V: readonly number[] = [0, 0, 1, 1];

// drawnGround imports this module, so its constants are read at call time, not load time.
let scratchU: Float64Array | null = null;
let scratchV: Float64Array | null = null;

function crossesSegment(
  px: number, pz: number, qx: number, qz: number,
  ax: number, az: number, bx: number, bz: number,
): boolean {
  const d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
  const d2 = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
  const d3 = (qx - px) * (az - pz) - (qz - pz) * (ax - px);
  const d4 = (qx - px) * (bz - pz) - (qz - pz) * (bx - px);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

/**
 * Whether band `band` is drawn at (u, v) of a square whose raw corner samples
 * are `raw` (NW, NE, SE, SW), read from the same fanned outline the meshers draw.
 */
export function drawnSquareHoldsBand(raw: readonly number[], band: number, u: number, v: number): boolean {
  const threshold = drawnLevelThreshold(band);
  const field = raw.map((h) => drawnBandField(h, band));
  let mask = 0;
  for (let c = 0; c < 4; c++) {
    if (field[c]! + DRAWN_GROUND_BAND_BIAS >= threshold) mask |= 1 << c;
  }
  if (mask === 0) return false;
  if (mask === 15) return true;

  const wallU = [0, 0, 0, 0];
  const wallV = [0, 0, 0, 0];
  const fanU = [0, 0, 0, 0];
  const fanV = [0, 0, 0, 0];
  for (let edge = 0; edge < 4; edge++) {
    const [lo, hi] = EDGE_ENDS[edge]!;
    const hiInside = (mask & (1 << hi)) !== 0;
    if (((mask & (1 << lo)) !== 0) === hiInside) continue;
    const outside = hiInside ? lo : hi;
    const inside = hiInside ? hi : lo;
    const wall = drawnCrossingFraction(field[outside]!, field[inside]!, threshold);
    const fan = drawnEdgeCrossing(raw[outside]!, raw[inside]!, band);
    const wallT = hiInside ? wall : 1 - wall;
    const fanT = hiInside ? fan : 1 - fan;
    wallU[edge] = CORNER_U[lo]! + (CORNER_U[hi]! - CORNER_U[lo]!) * wallT;
    wallV[edge] = CORNER_V[lo]! + (CORNER_V[hi]! - CORNER_V[lo]!) * wallT;
    fanU[edge] = CORNER_U[lo]! + (CORNER_U[hi]! - CORNER_U[lo]!) * fanT;
    fanV[edge] = CORNER_V[lo]! + (CORNER_V[hi]! - CORNER_V[lo]!) * fanT;
  }

  // A point just inside the square: every contour meets the edges clear of the corners.
  const inset = 1 / (DRAWN_GROUND_COORD_DENOM * DRAWN_GROUND_COORD_DENOM);
  const px = u < inset ? inset : u > 1 - inset ? 1 - inset : u;
  const pz = v < inset ? inset : v > 1 - inset ? 1 - inset : v;
  scratchU ??= new Float64Array(ISOLINE_SAMPLES_PER_CELL);
  scratchV ??= new Float64Array(ISOLINE_SAMPLES_PER_CELL);
  const pointsU = scratchU;
  const pointsV = scratchV;
  // Parity of contour crossings on the way to the north-west corner.
  let crossings = 0;
  const segments = marchingSegments(mask, field[0]!, field[1]!, field[2]!, field[3]!, DRAWN_GROUND_BAND_BIAS, threshold);
  for (let s = 0; s < segments.length; s += 2) {
    const from = segments[s]!;
    const to = segments[s + 1]!;
    const count = drawnFannedIsolinePoints(
      field[0]!, field[1]!, field[3]!, field[2]!, threshold,
      [wallU[from]!, wallV[from]!], [wallU[to]!, wallV[to]!],
      [fanU[from]!, fanV[from]!], [fanU[to]!, fanV[to]!],
      pointsU, pointsV,
    );
    let lastU = fanU[from]!;
    let lastV = fanV[from]!;
    for (let k = 0; k <= count; k++) {
      const nextU = k < count ? pointsU[k]! : fanU[to]!;
      const nextV = k < count ? pointsV[k]! : fanV[to]!;
      if (crossesSegment(px, pz, 0, 0, lastU, lastV, nextU, nextV)) crossings++;
      lastU = nextU;
      lastV = nextV;
    }
  }
  return ((mask & 1) !== 0) !== (crossings % 2 === 1);
}
