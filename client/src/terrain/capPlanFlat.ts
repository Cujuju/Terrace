// THE PUBLISHED CAP PLAN, FLAT — one chunk's drawn contours as typed arrays.
//
// WHY FLAT. The plan a chunk publishes (capEmission's `ChunkDrawnCaps`) is a
// tree of levels, polygons, loops and point objects. Since 2026-08-27 the chunk
// build runs in a worker, and posting that tree across the boundary would move
// its whole cost into the receiving thread's deserialiser — which is the thread
// the move exists to unload. It travels as typed arrays instead, and the main
// thread keeps it in that form: the band grid, the lips and the cap heights are
// all answered from flat arrays, and point objects are rebuilt lazily for the
// one query that genuinely needs them (`rehydrateLevelPolygons`).
//
// POINTS ARE DOUBLE PRECISION and that is a correctness requirement, not
// caution. `ContourPoint.x/z` are the marching interpolants, and the published
// contract (capEmission.ts's DrawnCapLevel) is "the very polygons handed to the
// ear clipper". A Float32 round trip would make the published polygon a
// different polygon from the drawn one — reintroducing exactly the
// producer/consumer disagreement four water rewrites died on.

import { BAND_HEIGHT } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { type ChunkDrawnCaps } from './capEmission.ts';
import { RECT_NONE, type ContourLoop } from './contours.ts';

/**
 * A cap plan, flat. Level i owns polygons
 * `[levelPolygonStart[i], levelPolygonStart[i + 1])`; polygon p owns loops
 * `[polygonLoopStart[p], polygonLoopStart[p + 1])`, of which the FIRST is the
 * outer and the rest are its holes; loop l owns points
 * `[loopPointStart[l], loopPointStart[l + 1])`, each a pair in `points`.
 */
export interface FlatCapPlan {
  readonly blocky: boolean;
  readonly levelThreshold: Float64Array;
  readonly levelSampleBand: Int32Array;
  readonly levelCapY: Float64Array;
  readonly levelPolygonStart: Int32Array;
  readonly polygonLoopStart: Int32Array;
  readonly loopPointStart: Int32Array;
  /** x, z interleaved — DOUBLE precision, see the module header. */
  readonly points: Float64Array;
  readonly rects: Uint8Array;
}

/**
 * The terrace lips of one chunk, as the overlay draws and queries them.
 *
 * `positions` is the line geometry (two endpoints, three floats each, per
 * segment). `flat` is the same segments as (ax, az, bx, bz) for the hover
 * query, and `bands` names which run of segments belongs to which band as
 * triples (band, firstSegment, segmentCount). Emitting them here rather than on
 * the main thread means no lip point object is ever created there.
 */
export interface ChunkLipSegments {
  readonly positions: Float32Array;
  readonly flat: Float32Array;
  readonly bands: Int32Array;
}

/** The published plan, flattened for the wire. */
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
      // OUTER FIRST, then holes — the order the rehydrator relies on.
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

/**
 * The loops of one level, as point objects again.
 *
 * ONLY WHERE A QUERY GENUINELY NEEDS THEM: `terrain/drawnGround.ts`'s
 * `nearestOnContour` and `loopsAt`, which walk vertices and hand a loop back to
 * the waterfall curtain. Everything else on the main thread — the band grid,
 * the lips, the cap heights — is answered from flat arrays and never
 * rehydrates. Doing it eagerly on splice would put the clone cost this whole
 * job exists to remove straight back.
 */
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

/**
 * The terrace lips of a chunk, from the plan it drew — see
 * render/layerEdgeOverlay.ts for what they are and why the border segments go.
 */
export function emitLipSegments(caps: ChunkDrawnCaps): ChunkLipSegments {
  const positions: number[] = [];
  const flat: number[] = [];
  const bands: number[] = [];
  if (!caps.blocky) {
    for (const level of caps.levels) {
      // The waterline level is a colour boundary on flat ground with no riser
      // under it; a band level is one whose threshold IS its band's floor.
      if (level.threshold !== level.sampleBand * BAND_HEIGHT) continue;
      const firstSegment = flat.length / 4;
      // The BAND's height, not the level's capY: band 0's cap is sunk under the
      // dry-land cap that shares its height, and the lip is at the band.
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

/**
 * How far above its band's height a lip is drawn, in world units — without it
 * the line z-fights the cap it traces along its whole length.
 *
 * Lives here rather than in the overlay because the segments are emitted here
 * now; the overlay draws exactly what it is handed.
 */
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
    // Both ends on the chunk's own domain rectangle: a seam artefact, not a
    // lip. capEmission drops exactly these when it extrudes skirts.
    if (a.rect !== RECT_NONE && b.rect !== RECT_NONE) continue;
    const ax = a.x * CELL_WORLD_SIZE;
    const az = a.z * CELL_WORLD_SIZE;
    const bx = b.x * CELL_WORLD_SIZE;
    const bz = b.z * CELL_WORLD_SIZE;
    positions.push(ax, y, az, bx, y, bz);
    flat.push(ax, az, bx, bz);
  }
}

