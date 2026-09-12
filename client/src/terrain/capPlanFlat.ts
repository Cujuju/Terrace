import { BAND_HEIGHT } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { type ChunkDrawnCaps } from './capEmission.ts';
import { isSeamSegment, type ContourLoop } from './contours.ts';

export interface FlatCapPlan {
  readonly blocky: boolean;
  readonly levelThreshold: Float64Array;
  readonly levelSampleBand: Int32Array;
  readonly levelCapY: Float64Array;
  readonly levelPolygonStart: Int32Array;
  readonly polygonLoopStart: Int32Array;
  readonly loopPointStart: Int32Array;
  readonly points: Float64Array;
  readonly rects: Uint8Array;
}

export interface ChunkLipSegments {
  readonly positions: Float32Array;
  readonly flat: Float32Array;
  readonly bands: Int32Array;
}

export function flattenCapPlan(caps: ChunkDrawnCaps): FlatCapPlan {
  const levelCount = caps.levels.length;
  const levelThreshold = new Float64Array(levelCount);
  const levelSampleBand = new Int32Array(levelCount);
  const levelCapY = new Float64Array(levelCount);
  const levelPolygonStart = new Int32Array(levelCount + 1);
  const polygonLoopStart: number[] = [0];
  const loopPointStart: number[] = [0];
  const points: number[] = [];
  const rects: number[] = [];

  let polygonCount = 0;
  for (let i = 0; i < levelCount; i++) {
    const level = caps.levels[i]!;
    levelThreshold[i] = level.threshold;
    levelSampleBand[i] = level.sampleBand;
    levelCapY[i] = level.capY;
    levelPolygonStart[i] = polygonCount;
    for (const polygon of level.polygons) {
      let loopCount = 0;
      const pushLoop = (loop: ContourLoop): void => {
        for (const p of loop) {
          points.push(p.x, p.z);
          rects.push(p.rect);
        }
        loopPointStart.push(points.length / 2);
        loopCount++;
      };
      pushLoop(polygon.outer);
      for (const hole of polygon.holes) pushLoop(hole);
      polygonLoopStart.push(polygonLoopStart[polygonLoopStart.length - 1]! + loopCount);
      polygonCount++;
    }
  }
  levelPolygonStart[levelCount] = polygonCount;

  return {
    blocky: caps.blocky,
    levelThreshold,
    levelSampleBand,
    levelCapY,
    levelPolygonStart,
    polygonLoopStart: Int32Array.from(polygonLoopStart),
    loopPointStart: Int32Array.from(loopPointStart),
    points: Float64Array.from(points),
    rects: Uint8Array.from(rects),
  };
}

export function rehydrateLevelPolygons(
  plan: FlatCapPlan,
  levelIndex: number,
): { outer: ContourLoop; holes: ContourLoop[] }[] {
  const out: { outer: ContourLoop; holes: ContourLoop[] }[] = [];
  const firstPolygon = plan.levelPolygonStart[levelIndex]!;
  const lastPolygon = plan.levelPolygonStart[levelIndex + 1]!;
  for (let p = firstPolygon; p < lastPolygon; p++) {
    const firstLoop = plan.polygonLoopStart[p]!;
    const lastLoop = plan.polygonLoopStart[p + 1]!;
    const loops: ContourLoop[] = [];
    for (let l = firstLoop; l < lastLoop; l++) {
      const loop: ContourLoop = [];
      for (let k = plan.loopPointStart[l]!; k < plan.loopPointStart[l + 1]!; k++) {
        loop.push({ x: plan.points[k * 2]!, z: plan.points[k * 2 + 1]!, rect: plan.rects[k]! });
      }
      loops.push(loop);
    }
    out.push({ outer: loops[0] ?? [], holes: loops.slice(1) });
  }
  return out;
}

export function emitLipSegments(caps: ChunkDrawnCaps): ChunkLipSegments {
  const positions: number[] = [];
  const flat: number[] = [];
  const bands: number[] = [];
  if (!caps.blocky) {
    for (const level of caps.levels) {
      const firstSegment = flat.length / 4;
      const y = level.sampleBand * BAND_HEIGHT * HEIGHT_WORLD_SCALE + LIP_LIFT_WORLD_UNITS;
      for (const polygon of level.polygons) {
        emitLoopSegments(polygon.outer, y, positions, flat);
        for (const hole of polygon.holes) emitLoopSegments(hole, y, positions, flat);
      }
      const segmentCount = flat.length / 4 - firstSegment;
      if (segmentCount > 0) bands.push(level.sampleBand, firstSegment, segmentCount);
    }
  }
  return {
    positions: Float32Array.from(positions),
    flat: Float32Array.from(flat),
    bands: Int32Array.from(bands),
  };
}

export const LIP_LIFT_WORLD_UNITS = 0.004;

function emitLoopSegments(
  loop: ContourLoop,
  y: number,
  positions: number[],
  flat: number[],
): void {
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    if (isSeamSegment(a, b)) continue;
    const ax = a.x * CELL_WORLD_SIZE;
    const az = a.z * CELL_WORLD_SIZE;
    const bx = b.x * CELL_WORLD_SIZE;
    const bz = b.z * CELL_WORLD_SIZE;
    positions.push(ax, y, az, bx, y, bz);
    flat.push(ax, az, bx, bz);
  }
}
