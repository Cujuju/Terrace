// The CONTRACT of the vertical sheet a water region is poured over its lip
// with (client/src/render/water/waterRiser.ts). Replaces waterApron.test.ts,
// which tested the run-scan and the per-vertex normal the riser deletes.
//
// THE LOAD-BEARING ONE IS THE FIRST: across a band crossing, the drawn water
// surface has NO VERTICAL GAP. That is the defect this whole arc is about —
// "the river is a row of puddles" — stated as a contract and checked against
// the real pair (tread builder + riser builder) over a real heightmap, with no
// browser. Everything after it is a promise the rest of the pipeline leans on:
//
//   1. No vertical gap across a band crossing (the defect, as a contract).
//   2. Every riser's top edge is two CONSECUTIVE vertices of the region's own
//      loop, verbatim — the reason a top seam cannot exist.
//   3. Every riser's foot Y is the bandWorldY of a region that EXISTS.
//   4. The lower plate covers the foot point — the overlap the "no stitching
//      needed" argument rests on, asserted rather than assumed.
//   5. No riser where the outward side has no lower region (a rising bank gets
//      no waterfall), and none along a marching-tile closing edge.
//   6. A one-segment lip still emits. This is the `fork` defect: the apron
//      required a run of two and drew nothing at a channel's snout.
//   7. The two halves of a loop split by a marching-tile border put their feet
//      in the SAME place, so no slit runs down the centre of a fall.
//
// No WebGLRenderer and no DOM: both builders write plain triangle soups.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, cellIndex, cellX, cellY } from '@terrace/shared';
import {
  WATER_RISER_LEAN_CELLS,
  appendRiserSurfaces,
  waterPlateOf,
  type WaterPlate,
} from '../src/render/water/waterRiser.ts';
import { appendRegionSurface, type WaterRegion } from '../src/render/water/waterTread.ts';
import { RECT_NONE, type ContourLoop } from '../src/terrain/contours.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

/** World Y of a band, in the same shape the rig uses: a fixed step per band. */
const BAND_STEP_WORLD_Y = 0.25;
const bandWorldY = (band: number): number => band * BAND_STEP_WORLD_Y;

/** One triangle of the soup, as three (x, y, z) world-unit points. */
type Point3 = readonly [number, number, number];

function trianglesOf(soup: readonly number[]): Point3[][] {
  const out: Point3[][] = [];
  for (let i = 0; i < soup.length; i += 9) {
    out.push([
      [soup[i]!, soup[i + 1]!, soup[i + 2]!],
      [soup[i + 3]!, soup[i + 4]!, soup[i + 5]!],
      [soup[i + 6]!, soup[i + 7]!, soup[i + 8]!],
    ]);
  }
  return out;
}

/**
 * The HIGHEST water surface over a world XZ point, or null where there is
 * none — the headless twin of the preview's `__previewPickWaterY`, which is
 * what the in-browser measurements of this defect were taken with.
 *
 * Barycentric, so a point inside a triangle reads the interpolated surface
 * rather than a vertex. Degenerate triangles (zero projected area) are skipped:
 * they cover nothing, and dividing by their area would produce a NaN that
 * silently wins a `>` comparison.
 */
function topWaterY(soup: readonly number[], px: number, pz: number): number | null {
  let best: number | null = null;
  for (const [a, b, c] of trianglesOf(soup)) {
    const area = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (area === 0) continue;
    const wa = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / area;
    const wb = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / area;
    const wc = 1 - wa - wb;
    if (wa < 0 || wb < 0 || wc < 0) continue;
    const y = wa * a[1] + wb * b[1] + wc * c[1];
    if (best === null || y > best) best = y;
  }
  return best;
}

// ---------------------------------------------------------------------------
// A real two-region fixture: a one-cell channel running along z, crossing one
// band step. The shape every fixture in the preview harness is made of.
// ---------------------------------------------------------------------------

const WORLD_SIZE = CHUNK_SIZE * 4;
/** The band the upstream half of the channel is drawn at. */
const UPPER_BAND = 6;
const LOWER_BAND = UPPER_BAND - 1;
/** Where the channel steps down, in cells along z. */
const STEP_AT_Z = 20;
/** The channel's x, chosen NOT to sit on a marching-tile border (16, 32, 48). */
const CHANNEL_X = 20;
/** First and last cell of the channel along z. */
const CHANNEL_FROM_Z = 14;
const CHANNEL_TO_Z = 26;
/** The bank: two bands over the upper channel floor, unambiguously dry. */
const BANK_BANDS_ABOVE = 2;

interface Fixture {
  readonly soup: number[];
  readonly upperLoops: readonly ContourLoop[];
  readonly lowerPlate: WaterPlate;
  readonly riserFrom: number;
}

/** Tiles a region reaches — the four-tile rule TILE_LATTICE_OFFSETS encodes. */
function tilesFor(cells: Iterable<number>): Set<number> {
  const tiles = new Set<number>();
  const tilesPerEdge = WORLD_SIZE / CHUNK_SIZE;
  for (const cell of cells) {
    const x = cellX(WORLD_SIZE, cell);
    const y = cellY(WORLD_SIZE, cell);
    for (const [dx, dy] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0) continue;
      tiles.add(Math.floor(ny / CHUNK_SIZE) * tilesPerEdge + Math.floor(nx / CHUNK_SIZE));
    }
  }
  return tiles;
}

/**
 * Builds the fixture: terrain, both treads, and the upper region's risers,
 * exactly as render/riverRig.ts's rebuild does — treads for every band first,
 * then the falls, because a fall is classified against a lower PLATE.
 */
function buildFall(): Fixture {
  const mirror: TerrainMirror = createTerrainMirror(WORLD_SIZE);
  mirror.map.cells.fill((UPPER_BAND + BANK_BANDS_ABOVE) * BAND_HEIGHT);
  const upperCells = new Set<number>();
  const lowerCells = new Set<number>();
  for (let z = CHANNEL_FROM_Z; z <= CHANNEL_TO_Z; z++) {
    const cell = cellIndex(mirror.map, CHANNEL_X, z);
    const band = z < STEP_AT_Z ? UPPER_BAND : LOWER_BAND;
    mirror.map.cells[cell] = band * BAND_HEIGHT;
    (band === UPPER_BAND ? upperCells : lowerCells).add(cell);
  }

  const soup: number[] = [];
  const lowerRegion: WaterRegion = {
    cells: lowerCells,
    surfaceBand: LOWER_BAND,
    tiles: tilesFor(lowerCells),
  };
  const upperRegion: WaterRegion = {
    cells: upperCells,
    surfaceBand: UPPER_BAND,
    tiles: tilesFor(upperCells),
  };
  // Highest band first, as the rig does.
  const upperLoops = appendRegionSurface(mirror, upperRegion, bandWorldY(UPPER_BAND), soup);
  const lowerLoops = appendRegionSurface(mirror, lowerRegion, bandWorldY(LOWER_BAND), soup);
  const lowerPlate = waterPlateOf(LOWER_BAND, lowerLoops);

  const riserFrom = soup.length;
  appendRiserSurfaces(upperLoops, bandWorldY(UPPER_BAND), bandWorldY, [lowerPlate], soup);
  return { soup, upperLoops, lowerPlate, riserFrom };
}

const world = (cells: number): number => cells * CELL_WORLD_SIZE;

describe('water riser', () => {
  it('leaves NO VERTICAL GAP in the water surface across a band crossing', () => {
    // THE DEFECT, AS A CONTRACT. Walk the channel's centre-line through the
    // step at 1/20 of a cell and read the highest water over each point. The
    // surface must start at the upper band, end at the lower one, and never
    // fall by a whole band between two neighbouring samples — a river drawn as
    // separate plates does exactly that, and it is what "the water is a row of
    // puddles" looks like in numbers.
    const { soup } = buildFall();
    const STEP_CELLS = 0.05;
    const upperY = bandWorldY(UPPER_BAND);
    const lowerY = bandWorldY(LOWER_BAND);
    /** A whole band's fall between two samples a twentieth of a cell apart. */
    const GAP_TOLERANCE = (upperY - lowerY) * 0.9;

    let previous: number | null = null;
    let sawUpper = false;
    let sawLower = false;
    let sawBetween = false;
    for (let z = CHANNEL_FROM_Z + 1; z <= CHANNEL_TO_Z - 1; z += STEP_CELLS) {
      const y = topWaterY(soup, world(CHANNEL_X), world(z));
      expect(y, `the channel is dry at z = ${z.toFixed(2)}`).not.toBeNull();
      if (Math.abs(y! - upperY) < 1e-9) sawUpper = true;
      else if (Math.abs(y! - lowerY) < 1e-9) sawLower = true;
      else if (y! < upperY && y! > lowerY) sawBetween = true;
      if (previous !== null) {
        expect(
          previous - y!,
          `the water drops a whole band in a twentieth of a cell at z = ${z.toFixed(2)}`,
        ).toBeLessThan(GAP_TOLERANCE);
      }
      previous = y;
    }
    expect(sawUpper, 'never saw the upper tread').toBe(true);
    expect(sawLower, 'never saw the lower tread').toBe(true);
    expect(sawBetween, 'the surface jumped between treads with nothing between').toBe(true);
  });

  it('hangs every sheet from two consecutive vertices of the loop, verbatim', () => {
    const { soup, upperLoops, riserFrom } = buildFall();
    const risers = trianglesOf(soup.slice(riserFrom));
    expect(risers.length).toBeGreaterThan(0);

    // Every ORDERED pair of crest vertices in a riser triangle must be a ring
    // neighbour pair of one of the region's own loops, bit-identical.
    const neighbours = new Set<string>();
    for (const loop of upperLoops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        neighbours.add(`${world(a.x)},${world(a.z)}|${world(b.x)},${world(b.z)}`);
      }
    }
    const crestY = bandWorldY(UPPER_BAND);
    let checked = 0;
    for (const triangle of risers) {
      const crest = triangle.filter(([, y]) => y === crestY);
      if (crest.length !== 2) continue;
      const key = `${crest[0]![0]},${crest[0]![2]}|${crest[1]![0]},${crest[1]![2]}`;
      expect(neighbours.has(key), `top edge ${key} is not an edge of the loop`).toBe(true);
      checked++;
    }
    expect(checked, 'no riser had a two-vertex top edge to check').toBeGreaterThan(0);
  });

  it("lands every foot at a band a region is actually drawn at, inside its plate", () => {
    const { soup, lowerPlate, riserFrom } = buildFall();
    const footY = bandWorldY(lowerPlate.band);
    const feet: Point3[] = [];
    for (const triangle of trianglesOf(soup.slice(riserFrom))) {
      for (const point of triangle) {
        if (point[1] === bandWorldY(UPPER_BAND)) continue;
        expect(point[1], 'a foot is at a height no region is drawn at').toBe(footY);
        feet.push(point);
      }
    }
    expect(feet.length).toBeGreaterThan(0);
    // AND the lower plate really is under them. This is the overlap the "no
    // stitching needed" argument rests on, so it is asserted, not assumed.
    for (const [x, , z] of feet) {
      const covered = topWaterY(soup.slice(0, riserFrom), x, z);
      expect(
        covered,
        `nothing is drawn under the foot at (${x}, ${z}) — the fall ends in mid-air`,
      ).not.toBeNull();
    }
  });

  it('draws nothing where the outward side has no lower region', () => {
    // The same channel with NO lower region offered: a rising bank on every
    // side, so not one segment may pour.
    const { upperLoops } = buildFall();
    const soup: number[] = [];
    appendRiserSurfaces(upperLoops, bandWorldY(UPPER_BAND), bandWorldY, [], soup);
    expect(soup.length).toBe(0);
  });

  it('draws no fall along a marching-tile closing edge', () => {
    // Both endpoints on a tile border AND sharing that border's axis: the
    // straight segment assembleLoops closes a clipped outline with. Across it
    // lies the same region's other half, so it is interior water.
    const loop: ContourLoop = [
      { x: 8, z: 7, rect: 1 },
      { x: 8, z: 9, rect: 1 },
      { x: 9, z: 9, rect: RECT_NONE },
      { x: 9, z: 7, rect: RECT_NONE },
    ];
    // A plate covering everything, so only the closing-edge rule can exclude.
    const everywhere = waterPlateOf(UPPER_BAND - 1, [
      [
        { x: 0, z: 0, rect: RECT_NONE },
        { x: 64, z: 0, rect: RECT_NONE },
        { x: 64, z: 64, rect: RECT_NONE },
        { x: 0, z: 64, rect: RECT_NONE },
      ],
    ]);
    const soup: number[] = [];
    appendRiserSurfaces([loop], bandWorldY(UPPER_BAND), bandWorldY, [everywhere], soup);
    // Three real segments pour; the border-closing one does not.
    expect(trianglesOf(soup).length).toBe(3 * 2);
    for (const triangle of trianglesOf(soup)) {
      const footOffTheBorder = triangle.some(
        ([x, y]) => y !== bandWorldY(UPPER_BAND) && x < world(8) - 1e-9,
      );
      expect(footOffTheBorder, 'a fall was drawn off the tile-border closing edge').toBe(false);
    }
  });

  it('emits from a lip one segment long — the snout the apron could not see', () => {
    // The `fork` regression, as a contract: ONE qualifying segment is a fall.
    // The apron required MIN_LIP_RUN_VERTICES = 2 consecutive lip VERTICES and
    // drew nothing here. The plate is a narrow strip that only the east face's
    // probe can reach.
    const loop: ContourLoop = [
      { x: 7.5, z: 7.5, rect: RECT_NONE },
      { x: 8.5, z: 7.5, rect: RECT_NONE },
      { x: 8.5, z: 8.5, rect: RECT_NONE },
      { x: 7.5, z: 8.5, rect: RECT_NONE },
    ];
    const strip = waterPlateOf(UPPER_BAND - 1, [
      [
        { x: 8.5, z: 7.5, rect: RECT_NONE },
        { x: 9.5, z: 7.5, rect: RECT_NONE },
        { x: 9.5, z: 8.5, rect: RECT_NONE },
        { x: 8.5, z: 8.5, rect: RECT_NONE },
      ],
    ]);
    const soup: number[] = [];
    appendRiserSurfaces([loop], bandWorldY(UPPER_BAND), bandWorldY, [strip], soup);
    expect(trianglesOf(soup).length, 'a one-segment lip drew nothing').toBe(2);
  });

  it('puts the two halves of a border-split loop on the same foot', () => {
    // The `fork` slit: a course running ALONG a tile border arrives as two
    // half-loops that share their border points exactly. Mirror-image normals
    // would separate their feet and leave a gap down the centre of the fall.
    const west: ContourLoop = [
      { x: 8, z: 7, rect: 1 },
      { x: 7, z: 8, rect: RECT_NONE },
      { x: 8, z: 9, rect: 1 },
    ];
    const east: ContourLoop = [
      { x: 8, z: 9, rect: 1 },
      { x: 9, z: 8, rect: RECT_NONE },
      { x: 8, z: 7, rect: 1 },
    ];
    const everywhere = waterPlateOf(UPPER_BAND - 1, [
      [
        { x: 0, z: 0, rect: RECT_NONE },
        { x: 64, z: 0, rect: RECT_NONE },
        { x: 64, z: 64, rect: RECT_NONE },
        { x: 0, z: 64, rect: RECT_NONE },
      ],
    ]);
    const soup: number[] = [];
    appendRiserSurfaces([west, east], bandWorldY(UPPER_BAND), bandWorldY, [everywhere], soup);

    // The foot hanging from the shared border point (8, 9) is the one within a
    // lean of it; the other corner of the same quad hangs a whole cell away.
    const footY = bandWorldY(UPPER_BAND - 1);
    const reach = world(WATER_RISER_LEAN_CELLS) * 1.01;
    const feet = new Set<string>();
    for (const [x, y, z] of trianglesOf(soup).flat()) {
      if (y !== footY) continue;
      if (Math.hypot(x - world(8), z - world(9)) > reach) continue;
      feet.add(`${x},${z}`);
    }
    expect(feet.size, 'the two halves put their feet in different places').toBe(1);
  });

  it('is deterministic: the same input writes the same soup', () => {
    expect(buildFall().soup).toEqual(buildFall().soup);
  });
});
