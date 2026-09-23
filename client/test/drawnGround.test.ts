import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  bandLevelHeight,
  bandOf,
  chunkIndex,
  drawnBandOfSample,
  drawnLevelThreshold,
  BAND_HEIGHT,
  type ClimbPath,
} from '@terrace/shared';
import {
  createDrawnGround,
  drawnGroundYAt,
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
import { CLIFF_PALETTE, TERRAIN_PALETTE } from '../src/terrain/bandColors.ts';
import { planChunkCaps, drawnBandCapY } from '../src/terrain/capEmission.ts';
import {
  followClimbGroundY, interpolateClimbPose, newClimbGroundState, type ClimbPose,
} from '../src/plugins/kit/groundFollow.ts';
import { advanceClimbRiserShift, newClimbRiserShift } from '../src/plugins/kit/climbRiser.ts';

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
  it('fractional support agrees with CPU caps in both modes across asymmetric slopes and seams', () => {
    const mirror = terracedMirror();
    for (let z = 0; z < WORLD_SIZE; z++) for (let x = 0; x < WORLD_SIZE; x++) {
      mirror.map.cells[z * WORLD_SIZE + x] = bandLevelHeight(1) + BAND_HEIGHT * x + BAND_HEIGHT / 2 * z;
    }
    for (const mode of ['raw', 'binomial'] as const) {
      mirror.surfaceMode = mode;
      const ground = groundOf(mirror);
      for (const [x, z] of [[5.75, 6.75], [15.9, 10.2], [16.1, 10.2], [15.9, 16.1]]) {
        const plan = planChunkCaps(mirror, Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE), {
          top: TERRAIN_PALETTE, cliff: CLIFF_PALETTE,
        });
        let cap = -Infinity;
        for (let level = 0; level < plan.levels.length; level++) {
          if (plan.polygonsPerLevel[level].some(p => pointInLoop(x, z, p.outer) &&
              !p.holes.some(hole => pointInLoop(x, z, hole)))) cap = Math.max(cap, plan.levels[level].capY);
        }
        expect(Number.isFinite(cap)).toBe(true);
        expect(drawnGroundYAt(mirror, ground, x, z), `${mode} ${x},${z}`).toBe(cap);
      }
      expect(ground.capYAtFractional(5, 6)).toBe(ground.capYAt(5, 6));
      expect(ground.capYAtFractional(-1, -1)).toBe(ground.capYAt(0, 0));
      expect(ground.capYAtFractional(WORLD_SIZE, WORLD_SIZE)).toBe(ground.capYAt(WORLD_SIZE - 1, WORLD_SIZE - 1));
    }
  });

  it('availability and blocky fallback choose the rendered region on either side of a seam', () => {
    const mirror = terracedMirror();
    const store = createDrawnGroundStore(WORLD_SIZE);
    publishPlannedWorld(store, mirror);
    const ground = createDrawnGround(mirror, store);
    const rightChunk = chunkIndex(WORLD_SIZE, 1, 0);
    store.publish(rightChunk, { blocky: true, levels: [] });
    const z = 6;
    mirror.map.cells[z * WORLD_SIZE + CHUNK_SIZE] = bandLevelHeight(3);
    mirror.map.cells[z * WORLD_SIZE + CHUNK_SIZE + 1] = bandLevelHeight(8);
    expect(drawnGroundYAt(mirror, ground, CHUNK_SIZE + 0.1, z)).toBe(drawnBandCapY(3));
    expect(drawnGroundYAt(mirror, ground, CHUNK_SIZE + 0.75, z)).toBe(drawnBandCapY(8));
    store.clear();
    store.publish(rightChunk, { blocky: true, levels: [] });
    expect(drawnGroundYAt(mirror, ground, CHUNK_SIZE - 0.1, z)).toBeNull();
    expect(drawnGroundYAt(mirror, ground, CHUNK_SIZE + 0.1, z)).toBe(drawnBandCapY(3));
    mirror.received.delete(rightChunk);
    expect(drawnGroundYAt(mirror, ground, CHUNK_SIZE + 0.1, z)).toBeNull();
    expect(drawnGroundYAt(mirror, ground, NaN, z)).toBeNull();
  });
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

describe('continuous drawn climb support', () => {
  const path: ClimbPath = {
    id: 1, leg: 'face', fromX: 0, fromY: 0, toX: 1, toY: 0,
    footX: 0, footY: 0, fromHeight: 33, toHeight: 161, heading: 0,
  };
  const frameSeconds = 1 / 60;

  it('maps fractional progress in either direction and interpolates entry and arrival', () => {
    const ctx = { drawnGroundYAt: (x: number) => x === 0 ? 0.5 : 2.5, terrainRevisionAt: () => 0 };
    for (const climbing of [path, { ...path, fromX: 1, toX: 0, fromHeight: path.toHeight, toHeight: path.fromHeight }]) {
      const state = newClimbGroundState();
      let previous: number | null = null;
      for (let step = 0; step <= 32; step++) {
        const progress = step / 32;
        const height = climbing.fromHeight + (climbing.toHeight - climbing.fromHeight) * progress;
        const y = followClimbGroundY(state, ctx, { climbHeight: height, climbPath: climbing }, previous, 0, frameSeconds);
        expect(y).toBeCloseTo(climbing.fromX === 0 ? 0.5 + 2 * progress : 2.5 - 2 * progress);
        previous = y;
      }
    }
    const pose: ClimbPose = {};
    interpolateClimbPose(pose, { climbHeight: null }, { climbHeight: 65, climbPath: path }, 0.5);
    expect(pose.climbHeight).toBe(49);
    interpolateClimbPose(pose, { climbHeight: 129, climbPath: path }, { climbHeight: null }, 0.5);
    expect(pose.climbHeight).toBe(145);
    expect(pose.climbPath).toBe(path);
    const shift = newClimbRiserShift();
    shift.x = -0.5;
    const mover = { x: 1, y: 0, heading: 0, ...pose, climbHeight: pose.climbHeight! };
    advanceClimbRiserShift(shift, ctx, mover, 2.5, frameSeconds);
    expect(shift.x).toBe(-0.25);
    interpolateClimbPose(pose, { climbHeight: 129, climbPath: path }, { climbHeight: null }, 1);
    expect(pose.climbHeight).toBeNull();
    advanceClimbRiserShift(shift, ctx, { ...mover, ...pose, climbHeight: null }, 2.5, frameSeconds);
    expect(shift.x).toBeCloseTo(0);
  });

  it('caches supports, rebases revisions, and falls continuously to foot support', () => {
    let revision = 0, offset = 0, calls = 0, known = true;
    const ctx = {
      drawnGroundYAt: (x: number) => { calls++; return known ? (x === 0 ? 0.5 : 2.5) + offset : null; },
      terrainRevisionAt: () => revision,
    };
    const state = newClimbGroundState();
    const mover = { climbHeight: 97, climbPath: path, falling: false };
    let y = followClimbGroundY(state, ctx, mover, null, 0, frameSeconds)!;
    expect(y).toBe(1.5);
    expect(calls).toBe(3);
    followClimbGroundY(state, ctx, mover, y, 0, frameSeconds);
    expect(calls).toBe(3);
    offset = 1; revision++;
    const rebased = followClimbGroundY(state, ctx, mover, y, 0, 0)!;
    expect(rebased).toBe(y);
    known = false; revision++;
    expect(followClimbGroundY(state, ctx, mover, y, 0, frameSeconds)).toBeNull();
    known = true; offset = 0; revision++;
    mover.falling = true;
    y = followClimbGroundY(state, ctx, mover, y, 0, 0)!;
    expect(y).toBe(1.5);
    mover.climbHeight = 65;
    y = followClimbGroundY(state, ctx, mover, y, 0, frameSeconds)!;
    expect(y).toBe(1);
    mover.climbHeight = path.fromHeight;
    expect(followClimbGroundY(state, ctx, mover, y, 0, frameSeconds)).toBe(0.5);
  });
});
