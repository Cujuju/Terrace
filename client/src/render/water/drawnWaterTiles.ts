import {
  BAND_HEIGHT,
  CELL_CENTRE_OFFSET_CELLS,
  CHUNK_SIZE,
  TERRAIN_LOD_NEAR_N,
  cellCoordToWorld,
  cellIndex,
  chunksPerEdge,
  drawnGroundHeight,
  drawnGroundSubcell,
  drawnGroundSubcellIsLayered,
  quantizeToBand,
  type DrawnGroundPoint,
  type Heightmap,
} from '@terrace/shared';
import { HEIGHT_WORLD_SCALE } from '../../config.ts';

export interface WaterRegion {
  readonly anchorCell: number;
  readonly surfaceBand: number;
  readonly tiles: Set<number>;
}

export const RIVER_SURFACE_LIFT_WORLD_UNITS = 1 / 64;

const SUBCELLS_PER_CELL = TERRAIN_LOD_NEAR_N;

const SUBCELL_SIZE_CELLS = 1 / SUBCELLS_PER_CELL;

const SUBCELL_CENTRE_CELLS = SUBCELL_SIZE_CELLS / 2;

const CURTAIN_FOOT_REACH_SUBCELLS = SUBCELLS_PER_CELL;

const COVER_MARGIN_SUBCELLS = 1;

const TILE_LATTICE_SPAN = CHUNK_SIZE * SUBCELLS_PER_CELL;

const COVER_SPAN = TILE_LATTICE_SPAN + 2 * COVER_MARGIN_SUBCELLS;

const NOT_COVERED = 0;

/** The sub-cell carries water over only the tread pieces below the surface band. */
const PARTLY_COVERED = 1;

/** Every tread of the sub-cell is below the surface band, so the whole square is water. */
const FULLY_COVERED = 2;

const CARDINAL_SUBCELL_DX: readonly number[] = [0, 1, 0, -1];

const CARDINAL_SUBCELL_DZ: readonly number[] = [-1, 0, 1, 0];

const BLEND_STENCIL_SPAN = 2;

const TRIANGLE_POINTS = 3;

/** Half-sub-cells: the coarsest unit in which sub-cell and cell centres are both integral. */
const HALF_SUBCELLS_PER_SUBCELL = 2;

const HALF_SUBCELLS_PER_CELL = HALF_SUBCELLS_PER_SUBCELL * SUBCELLS_PER_CELL;

/** Scratch for one tile's coverage. One tile is meshed at a time, never interleaved. */
const coverage = new Uint8Array(COVER_SPAN * COVER_SPAN);

interface CoveredRun {
  readonly startX: number;
  readonly endX: number;
  readonly startZ: number;
}

export function waterSurfaceWorldY(heightUnits: number): number {
  return heightUnits * HEIGHT_WORLD_SCALE + RIVER_SURFACE_LIFT_WORLD_UNITS;
}

export function waterBandWorldY(band: number): number {
  return waterSurfaceWorldY(band * BAND_HEIGHT);
}

function subcellCentreCells(lattice: number): number {
  return lattice * SUBCELL_SIZE_CELLS + SUBCELL_CENTRE_CELLS;
}

function subcellCentreHalfSubcells(lattice: number): number {
  return lattice * HALF_SUBCELLS_PER_SUBCELL + HALF_SUBCELLS_PER_SUBCELL / 2;
}

function cellCentreHalfSubcells(cell: number): number {
  return cell * HALF_SUBCELLS_PER_CELL + HALF_SUBCELLS_PER_CELL / 2;
}

function subcellWorldEdge(lattice: number): number {
  return cellCoordToWorld(lattice * SUBCELL_SIZE_CELLS);
}

function pushQuad(
  out: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
): void {
  out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  out.push(ax, ay, az, cx, cy, cz, dx, dy, dz);
}

export function appendDrawnWaterTile(
  map: Heightmap,
  region: WaterRegion,
  tile: number,
  surfaceY: number,
  waterBandAt: (cellX: number, cellZ: number) => number | null,
  seaWorldY: number,
  out: number[],
): void {
  const band = region.surfaceBand;
  const surfaceHeight = band * BAND_HEIGHT;
  const lastCell = map.size - 1;

  const groundAt = (sx: number, sz: number): number =>
    drawnGroundHeight(map, subcellCentreCells(sx), subcellCentreCells(sz));

  const cellOfLattice = (s: number): number => Math.floor(s * SUBCELL_SIZE_CELLS);

  const clampCell = (i: number): number => (i < 0 ? 0 : i > lastCell ? lastCell : i);

  /** Lower cell of the pair whose centres bracket this lattice line, as the blend reads it. */
  const blendCellOfLattice = (s: number): number =>
    Math.floor(subcellCentreCells(s) - CELL_CENTRE_OFFSET_CELLS);

  const sheetReachesSurface = (x: number, z: number, water: number, drawn: number): boolean => {
    const sheetHeight = water * BAND_HEIGHT;
    const bankBuriesIt = drawn > sheetHeight;
    if (bankBuriesIt) return false;
    const sitsOnItsOwnCap = drawn === sheetHeight;
    if (sitsOnItsOwnCap) return true;
    return quantizeToBand(map.cells[cellIndex(map, x, z)]!) < sheetHeight;
  };

  /** Nearest stencil cell whose sheet reaches the drawn surface owns the sub-cell, so sheets abut. */
  const owningBandAt = (sx: number, sz: number): number | null => {
    const insideX = clampCell(cellOfLattice(sx));
    const insideZ = clampCell(cellOfLattice(sz));
    const insideBand = waterBandAt(insideX, insideZ);
    let drawn = 0;
    let drawnKnown = false;
    if (insideBand !== null) {
      drawn = groundAt(sx, sz);
      drawnKnown = true;
      // The cell the sub-cell sits in is always the nearest of the stencil.
      if (sheetReachesSurface(insideX, insideZ, insideBand, drawn)) return insideBand;
    }
    const baseX = blendCellOfLattice(sx);
    const baseZ = blendCellOfLattice(sz);
    const centreX = subcellCentreHalfSubcells(sx);
    const centreZ = subcellCentreHalfSubcells(sz);
    let owner: number | null = null;
    let nearest = 0;
    for (let dz = 0; dz < BLEND_STENCIL_SPAN; dz++) {
      const z = clampCell(baseZ + dz);
      const offZ = centreZ - cellCentreHalfSubcells(z);
      for (let dx = 0; dx < BLEND_STENCIL_SPAN; dx++) {
        const x = clampCell(baseX + dx);
        if (x === insideX && z === insideZ) continue;
        const offX = centreX - cellCentreHalfSubcells(x);
        const distance = offX * offX + offZ * offZ;
        if (owner !== null && distance >= nearest) continue;
        const water = waterBandAt(x, z);
        if (water === null) continue;
        if (!drawnKnown) {
          drawn = groundAt(sx, sz);
          drawnKnown = true;
        }
        if (!sheetReachesSurface(x, z, water, drawn)) continue;
        owner = water;
        nearest = distance;
      }
    }
    return owner;
  };

  const carriesWater = (sx: number, sz: number): boolean => owningBandAt(sx, sz) === band;

  /** A layered sub-cell keeps the centre rule, so its whole square carries the sheet. */
  const coverKindAt = (sx: number, sz: number): number => {
    if (!carriesWater(sx, sz)) return NOT_COVERED;
    if (drawnGroundSubcellIsLayered(map, sx, sz)) return FULLY_COVERED;
    return drawnGroundSubcell(map, sx, sz).highBand < band ? FULLY_COVERED : PARTLY_COVERED;
  };

  const footYBeyond = (sx: number, sz: number, dx: number, dz: number): number | null => {
    let lowestWater: number | null = null;
    let lowestGround = surfaceHeight;
    let groundFalling = false;
    let groundSettled = false;

    for (let step = 1; step <= CURTAIN_FOOT_REACH_SUBCELLS; step++) {
      const px = sx + dx * step;
      const pz = sz + dz * step;

      const water = waterBandAt(cellOfLattice(px), cellOfLattice(pz));
      if (water !== null && water < band && (lowestWater === null || water < lowestWater)) {
        lowestWater = water;
      }

      if (groundSettled) continue;
      const height = groundAt(px, pz);
      if (height < lowestGround) {
        lowestGround = height;
        groundFalling = true;
        continue;
      }
      if (groundFalling || height > lowestGround) groundSettled = true;
    }

    if (lowestWater !== null) return waterBandWorldY(lowestWater);
    if (lowestGround >= surfaceHeight) return null;
    return Math.max(waterSurfaceWorldY(lowestGround), seaWorldY);
  };

  const tilesPerEdge = chunksPerEdge(map.size);
  const originX = (tile % tilesPerEdge) * CHUNK_SIZE * SUBCELLS_PER_CELL;
  const originZ = Math.floor(tile / tilesPerEdge) * CHUNK_SIZE * SUBCELLS_PER_CELL;
  const latticeSize = map.size * SUBCELLS_PER_CELL;
  const endX = Math.min(originX + TILE_LATTICE_SPAN, latticeSize);
  const endZ = Math.min(originZ + TILE_LATTICE_SPAN, latticeSize);
  if (originX >= endX || originZ >= endZ) return;

  const coverageAt = (sx: number, sz: number): number =>
    coverage[
      (sz - originZ + COVER_MARGIN_SUBCELLS) * COVER_SPAN +
        (sx - originX + COVER_MARGIN_SUBCELLS)
    ]!;

  coverage.fill(NOT_COVERED);
  for (let sz = originZ - COVER_MARGIN_SUBCELLS; sz < endZ + COVER_MARGIN_SUBCELLS; sz++) {
    if (sz < 0 || sz >= latticeSize) continue;
    for (let sx = originX - COVER_MARGIN_SUBCELLS; sx < endX + COVER_MARGIN_SUBCELLS; sx++) {
      if (sx < 0 || sx >= latticeSize) continue;
      coverage[
        (sz - originZ + COVER_MARGIN_SUBCELLS) * COVER_SPAN +
          (sx - originX + COVER_MARGIN_SUBCELLS)
      ] = coverKindAt(sx, sz);
    }
  }

  /** The sheet's share of a partly covered sub-cell: its treads below the surface band. */
  const emitSheetPieces = (sx: number, sz: number): void => {
    const push = (p: DrawnGroundPoint): void => {
      out.push(cellCoordToWorld(p.x), surfaceY, cellCoordToWorld(p.y));
    };
    for (const tread of drawnGroundSubcell(map, sx, sz).treads) {
      if (tread.band >= band) continue;
      for (const piece of tread.pieces) {
        if (piece.length < TRIANGLE_POINTS) continue;
        // Reversed: the contract walks a tread the other way round from a water quad.
        const fan = piece[piece.length - 1]!;
        for (let k = piece.length - 2; k >= 1; k--) {
          push(fan);
          push(piece[k]!);
          push(piece[k - 1]!);
        }
      }
    }
  };

  const emitTread = (run: CoveredRun, endZLattice: number): void => {
    const loX = subcellWorldEdge(run.startX);
    const hiX = subcellWorldEdge(run.endX);
    const loZ = subcellWorldEdge(run.startZ);
    const hiZ = subcellWorldEdge(endZLattice);
    pushQuad(out, loX, surfaceY, loZ, hiX, surfaceY, loZ, hiX, surfaceY, hiZ, loX, surfaceY, hiZ);
  };

  let open: CoveredRun[] = [];
  for (let sz = originZ; sz < endZ; sz++) {
    const row: CoveredRun[] = [];
    let runStart = -1;
    for (let sx = originX; sx <= endX; sx++) {
      const cover = sx < endX ? coverageAt(sx, sz) : NOT_COVERED;
      const whole = cover === FULLY_COVERED;
      if (whole && runStart < 0) runStart = sx;
      if (!whole && runStart >= 0) {
        row.push({ startX: runStart, endX: sx, startZ: sz });
        runStart = -1;
      }
      if (cover === NOT_COVERED) continue;
      if (cover === PARTLY_COVERED) emitSheetPieces(sx, sz);

      for (let step = 0; step < CARDINAL_SUBCELL_DX.length; step++) {
        const dx = CARDINAL_SUBCELL_DX[step]!;
        const dz = CARDINAL_SUBCELL_DZ[step]!;
        if (coverageAt(sx + dx, sz + dz) !== NOT_COVERED) continue;
        const bottomY = footYBeyond(sx, sz, dx, dz);
        if (bottomY === null || bottomY >= surfaceY) continue;
        const loX = subcellWorldEdge(sx);
        const hiX = subcellWorldEdge(sx + 1);
        const loZ = subcellWorldEdge(sz);
        const hiZ = subcellWorldEdge(sz + 1);
        const edgeX0 = dx > 0 ? hiX : loX;
        const edgeZ0 = dz > 0 ? hiZ : loZ;
        const edgeX1 = dx === 0 ? hiX : edgeX0;
        const edgeZ1 = dz === 0 ? hiZ : edgeZ0;
        pushQuad(
          out,
          edgeX0, surfaceY, edgeZ0,
          edgeX1, surfaceY, edgeZ1,
          edgeX1, bottomY, edgeZ1,
          edgeX0, bottomY, edgeZ0,
        );
      }
    }

    const next: CoveredRun[] = [];
    let oi = 0;
    let ri = 0;
    while (oi < open.length || ri < row.length) {
      const held = open[oi];
      const fresh = row[ri];
      if (held !== undefined && (fresh === undefined || held.startX < fresh.startX)) {
        emitTread(held, sz);
        oi++;
      } else if (fresh !== undefined && (held === undefined || fresh.startX < held.startX)) {
        next.push(fresh);
        ri++;
      } else if (held !== undefined && fresh !== undefined) {
        if (held.endX === fresh.endX) {
          next.push(held);
        } else {
          emitTread(held, sz);
          next.push(fresh);
        }
        oi++;
        ri++;
      }
    }
    open = next;
  }
  for (const held of open) emitTread(held, endZ);
}
