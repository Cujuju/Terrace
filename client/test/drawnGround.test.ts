import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  bandLevelHeight,
  bandOf,
  chunkIndex,
  drawnBandOfSample,
  drawnLevelThreshold,
} from '@terrace/shared';
import {
  createDrawnGround,
  type DrawnGround,
} from '../src/terrain/drawnGround.ts';
import {
  createDrawnGroundStore,
  publishPlannedWorld,
} from '../src/terrain/drawnGroundStore.ts';
import { createTerrainMirror, sampleHeight, type TerrainMirror } from '../src/terrain/mirror.ts';
import {
  assembleLoops,
  domainInside,
  loadSamples,
  marchLevel,
} from '../src/terrain/contours.ts';
import { simplifyLoop } from '../src/terrain/contourSmoothing.ts';
import { groupLoops, type CapPolygon } from '../src/terrain/triangulation.ts';

function groundOf(mirror: TerrainMirror): DrawnGround {
  const store = createDrawnGroundStore(mirror.map.size);
  publishPlannedWorld(store, mirror);
  return createDrawnGround(mirror, store);
}

const WORLD_SIZE = CHUNK_SIZE * 2;

/** Off every isoline the fixture has: level-to-level crossings sit at uv = 1/2
 * and the shore sliver hugs the sea corner, so fifths clear them all. */
const OFF_CONTOUR = 1 / 5;

function ringOf(x: number, z: number): number {
  const centre = WORLD_SIZE / 2 - 0.5;
  return Math.max(Math.abs(x - centre), Math.abs(z - centre));
}

function terracedMirror(): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  for (let z = 0; z < WORLD_SIZE; z++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      mirror.map.cells[z * WORLD_SIZE + x] =
        ringOf(x, z) <= 4
          ? bandLevelHeight(3)
          : ringOf(x, z) <= 8
            ? bandLevelHeight(2)
            : ringOf(x, z) <= 12
              ? bandLevelHeight(1)
              : 0;
    }
  }
  const tilesPerEdge = WORLD_SIZE / CHUNK_SIZE;
  for (let i = 0; i < tilesPerEdge * tilesPerEdge; i++) mirror.received.add(i);
  return mirror;
}

function pointInLoop(px: number, pz: number, loop: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.z > pz !== b.z > pz) {
      if (px < a.x + ((pz - a.z) / (b.z - a.z)) * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

function drawnBandIndependent(mirror: TerrainMirror, px: number, pz: number): number {
  const cx = Math.floor(px / CHUNK_SIZE);
  const cz = Math.floor(pz / CHUNK_SIZE);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  let highest = -Infinity;
  let lowest = Infinity;
  for (let i = 0; i < mirror.map.cells.length; i++) {
    highest = Math.max(highest, drawnBandOfSample(mirror.map.cells[i]));
    lowest = Math.min(lowest, drawnBandOfSample(mirror.map.cells[i]));
  }
  for (let band = highest; band >= lowest; band--) {
    loadSamples(mirror, originX, originZ);
    const segmentCount = marchLevel(drawnLevelThreshold(band), originX, originZ, null);
    const wholeInside = domainInside(drawnLevelThreshold(band), null);
    const polygons: CapPolygon[] = groupLoops(
      assembleLoops(segmentCount, originX, originZ, wholeInside)
        .map(simplifyLoop)
        .filter((loop) => loop.length >= 3),
    );
    for (const polygon of polygons) {
      if (!pointInLoop(px, pz, polygon.outer)) continue;
      if (polygon.holes.some((hole) => pointInLoop(px, pz, hole))) continue;
      return band;
    }
  }
  return lowest;
}

describe('drawnGround', () => {
  it('bandAt agrees with the drawn surface everywhere on a fine grid, including within half a cell of boundaries', () => {
    const mirror = terracedMirror();
    const ground = groundOf(mirror);

    const disagreements: string[] = [];
    for (let z = OFF_CONTOUR; z < WORLD_SIZE; z += 0.5) {
      for (let x = OFF_CONTOUR; x < WORLD_SIZE; x += 0.5) {
        const expected = drawnBandIndependent(mirror, x, z);
        expect(ground.bandAt(x, z), `${x},${z} h=${sampleHeight(mirror, Math.floor(x), Math.floor(z))}`).toBe(expected);
        const naive = bandOf(sampleHeight(mirror, Math.floor(x), Math.floor(z)));
        if (naive !== expected) disagreements.push(`${x},${z}`);
      }
    }
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it('a basin enclosed inside a higher band reports its own lower band (the hole rule)', () => {
    const mirror = terracedMirror();
    for (let z = 14; z <= 17; z++) {
      for (let x = 14; x <= 17; x++) mirror.map.cells[z * WORLD_SIZE + x] = bandLevelHeight(1);
    }

    const ground = groundOf(mirror);
    const basinCentre = ground.bandAt(15.5, 15.5);
    expect(basinCentre).toBe(1);
    expect(basinCentre).not.toBe(3);

    expect(ground.bandAt(12.5, 15.5)).toBe(3);
  });
});
