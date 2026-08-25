// DrawnGround contract tests (plan water-painted-on-bands, work item W1).
//
// The module's whole reason to exist is that `bandOf(sampleHeight(...))` is NOT
// what the terrain draws: the drawn cap for band k covers the region enclosed
// by the SMOOTHED marched contour at threshold k * BAND_HEIGHT, and Chaikin
// smoothing moves that boundary off the cell lattice by up to about half a
// cell. So the tests are contract-level:
//
//   1. On a hand-built concentric-terrace fixture, `bandAt` agrees with the
//      terrain's own rule — derived here from the same contour containment the
//      mesh builder uses (march → smooth → group → even-odd with holes), which
//      is as close as vitest gets to raycasting the emitted mesh. Probed on a
//      fine HALF-CELL grid, so every band boundary is sampled on both sides.
//      AND an explicit assertion that `bandAt` disagrees with the naive lattice
//      rule somewhere — a test the naive rule would also pass has tested
//      nothing, since replacing bandAt with bandOf(sampleHeight) is exactly the
//      bug this module replaces (the 430 floating water vertices).
//   2. A basin enclosed inside a higher band reads as its own lower band — the
//      hole rule; containment must be tested on groupLoops output.
//   3. Band 0 is two levels and `capYOfBand` distinguishes them — resolved from
//      the chunk's published cap stack, not from a boolean the caller passes.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, bandOf, chunkIndex } from '@terrace/shared';
import { BAND_WORLD_HEIGHT } from '../src/config.ts';
import {
  createDrawnGround,
} from '../src/terrain/drawnGround.ts';
import { createTerrainMirror, sampleHeight, type TerrainMirror } from '../src/terrain/mirror.ts';
import { assembleLoops, loadSamples, marchLevel, samples } from '../src/terrain/contours.ts';
import { smoothLoop } from '../src/terrain/contourSmoothing.ts';
import { groupLoops, type CapPolygon } from '../src/terrain/triangulation.ts';

const WORLD_SIZE = CHUNK_SIZE * 2;

/** Chebyshev distance from the fixture's centre, in cells. */
function ringOf(x: number, z: number): number {
  const centre = WORLD_SIZE / 2 - 0.5;
  return Math.max(Math.abs(x - centre), Math.abs(z - centre));
}

/**
 * Four concentric square terraces, one band each: heights 0/16/32/48 in rings
 * four cells wide. Every intermediate band EXISTS as terrain, so the downward
 * walk in bandAt always lands on a band the mesh really draws, and the four
 * smoothed boundaries give plenty of half-cell disagreement with the lattice.
 */
function terracedMirror(): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  for (let z = 0; z < WORLD_SIZE; z++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      mirror.map.cells[z * WORLD_SIZE + x] =
        ringOf(x, z) <= 4
          ? 3 * BAND_HEIGHT
          : ringOf(x, z) <= 8
            ? 2 * BAND_HEIGHT
            : ringOf(x, z) <= 12
              ? BAND_HEIGHT
              : 0;
    }
  }
  const tilesPerEdge = WORLD_SIZE / CHUNK_SIZE;
  for (let i = 0; i < tilesPerEdge * tilesPerEdge; i++) mirror.received.add(i);
  return mirror;
}

/** Even-odd point-in-loop, same standard ray cast the triangulator uses. */
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

/**
 * The terrain's own answer for a point: the highest PRESENT band whose smoothed
 * contour contains it, holes subtracted. This re-derives the rule from the same
 * pipeline capEmission draws with rather than calling the code under test, so
 * test 1 compares two independent applications of the DRAWN-surface rule.
 */
function drawnBandIndependent(mirror: TerrainMirror, px: number, pz: number): number {
  const cx = Math.floor(px / CHUNK_SIZE);
  const cz = Math.floor(pz / CHUNK_SIZE);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  let highest = -Infinity;
  for (let i = 0; i < mirror.map.cells.length; i++) {
    highest = Math.max(highest, bandOf(mirror.map.cells[i]));
  }
  for (let band = highest; band >= 0; band--) {
    loadSamples(mirror, originX, originZ);
    const segmentCount = marchLevel(band * BAND_HEIGHT, originX, originZ, null);
    const wholeInside = samples[0] >= band * BAND_HEIGHT;
    const polygons: CapPolygon[] = groupLoops(
      assembleLoops(segmentCount, originX, originZ, wholeInside)
        .map(smoothLoop)
        .filter((loop) => loop.length >= 3),
    );
    for (const polygon of polygons) {
      if (!pointInLoop(px, pz, polygon.outer)) continue;
      if (polygon.holes.some((hole) => pointInLoop(px, pz, hole))) continue;
      return band;
    }
  }
  return 0;
}

describe('drawnGround', () => {
  it('bandAt agrees with the drawn surface everywhere on a fine grid, including within half a cell of boundaries', () => {
    const mirror = terracedMirror();
    const ground = createDrawnGround(mirror);

    // Half-cell steps guarantee probes strictly between cell centres, i.e. on
    // both sides of every smoothed boundary — the case the lattice rule gets
    // wrong and the one that floated 430 water vertices.
    const disagreements: string[] = [];
    for (let z = 0.5; z < WORLD_SIZE; z += 0.5) {
      for (let x = 0.5; x < WORLD_SIZE; x += 0.5) {
        const expected = drawnBandIndependent(mirror, x, z);
        expect(ground.bandAt(x, z)).toBe(expected);
        const naive = bandOf(sampleHeight(mirror, Math.floor(x), Math.floor(z)));
        if (naive !== expected) disagreements.push(`${x},${z}`);
      }
    }
    // The fixture MUST actually distinguish the two rules, or assertion above
    // is vacuous — the naive rule would pass it too.
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it('a basin enclosed inside a higher band reports its own lower band (the hole rule)', () => {
    const mirror = terracedMirror();
    // Dig an enclosed basin through two bands in the middle of the top
    // terrace (the top terrace covers rings ≤ 4 about the centre): at the top
    // band's threshold the basin is a HOLE in the cap polygon, not part of
    // the region.
    for (let z = 14; z <= 17; z++) {
      for (let x = 14; x <= 17; x++) mirror.map.cells[z * WORLD_SIZE + x] = BAND_HEIGHT;
    }

    const ground = createDrawnGround(mirror);
    const basinCentre = ground.bandAt(15.5, 15.5);
    expect(basinCentre).toBe(1);
    expect(basinCentre).not.toBe(3);

    // And the surrounding terrace still reads as itself just outside the
    // basin — close enough that the lattice rule and the drawn rule could
    // disagree, yet both say band 3 here.
    expect(ground.bandAt(12.5, 15.5)).toBe(3);
  });

  it('capYOfBand distinguishes band 0’s two levels from the drawn stack', () => {
    // A shore fixture draws BOTH band-0 caps: the sunk seabed and the waterline
    // above it. The oracle must answer with the one the terrain actually put
    // over the query point rather than asking the caller which it meant.
    const mirror = terracedMirror();
    const ground = createDrawnGround(mirror);
    expect(ground.capYOfBand(1, 15.5, 15.5)).toBe(BAND_WORLD_HEIGHT);
  });
});
