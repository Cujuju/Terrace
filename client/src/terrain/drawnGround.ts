// DrawnGround — the single source of truth for "what does the terrain DRAW
// here" (plan water-painted-on-bands, work item W1; rebuilt as a READER on
// 2026-08-24, the contract fix).
//
// THE BUG THIS REPLACES, AND THE ONE THAT REPLACED IT. Asking
// `bandOf(sampleHeight(x, z))` answers "which band does the CELL LATTICE say
// this cell is in", but the terrain does not draw cell lattices: band k's cap
// is drawn over the region enclosed by the SMOOTHED marched contour at
// threshold k * BAND_HEIGHT. On the `fork` fixture (measured 2026-08-23) 430 of
// 6745 water vertices floated a full band because of it.
//
// This module's FIRST answer to that was to re-run the terrain's pipeline —
// loadSamples, marchLevel, assembleLoops, smoothLoop, groupLoops — here, and
// trust that two runs of the same five calls agree. They did not, and the file
// header used to claim "the two can never disagree again" while four ways to
// disagree sat in the code:
//
//   1. LAYERED CHUNKS. capEmission reloads the sample FIELD per band from
//      `sampleRenderBandHeight` when the chunk holds a buried floor. This file
//      always marched the plain height lattice — a different field entirely, so
//      a whole-band error by construction wherever a cave or overhang is.
//   2. CROSSING OVERRIDE. The waterline level marches with SHORE_EDGE_CROSSING
//      and ceilings with CEILING_EDGE_CROSSING; this file hardcoded `null`, so
//      its contour landed somewhere else.
//   3. THE SEABED SINK. Band 0's cap is drawn at -SEABED_CAP_SINK, and that
//      rule was RESTATED here (in the old `drawnBandWorldY`) rather than read.
//      Worse, whether a point took the seabed cap or the waterline cap above it
//      was left for the CALLER to guess — riverRig passed `seabed: false`
//      unconditionally.
//   4. THE BLOCKY FALLBACK. A chunk over budget is drawn as axis-aligned
//      per-cell quads at `blockyCellCapY(height)`. This file had no way to know
//      that had happened and answered with smoothed contours regardless —
//      describing a surface that is not on screen.
//
// So the pipeline no longer lives here. `planChunkCaps` in capEmission.ts is
// the one producer of "what will be drawn"; the vertex writer and this oracle
// are its two consumers, and they cannot drift because there is nothing left to
// drift from. What this file still owns is the QUERY: point-in-region
// containment against the polygons that were actually triangulated.
//
// HAZARD — `planChunkCaps` runs the shared march scratch (contours.ts's
// `samples` lattice and edge tables are ONE module-level set reused by every
// marcher in the client). A plan must therefore COMPLETE before another starts:
// no interleaving, no lazy generator, no async anywhere in this file. That
// holds naturally because every entry point plans synchronously to completion
// and caches the result before returning.
//
// LIFETIME. Every plan is memoised per chunk for the lifetime of the DrawnGround
// instance. One instance is created per water rebuild and discarded with it — it
// MUST NOT outlive a terrain edit, or its cache would answer later queries from
// pre-edit contours.

import { BAND_HEIGHT, CHUNK_SIZE, bandOf } from '@terrace/shared';
import { CLIFF_PALETTE, TERRAIN_PALETTE } from './bandColors.ts';
import {
  blockyCellCapY,
  planChunkCaps,
  type ChunkDrawnCaps,
  type ChunkPalettes,
} from './capEmission.ts';
import { type ContourLoop } from './contours.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';
import { type CapPolygon } from './triangulation.ts';

/**
 * The palettes the oracle plans with, and they are the ones the renderer draws
 * with (terrainMeshes.ts builds this same pair from these same two module
 * constants). Colour is almost irrelevant to a plan — but not entirely: an
 * underwater riser that takes a border colour counts 4 triangles per segment
 * instead of 2, which feeds CHUNK_TRIANGLE_BUDGET and can therefore flip the
 * blocky-fallback verdict. Planning with a stand-in palette would reintroduce a
 * way for the oracle and the renderer to disagree, so it does not.
 */
const DRAWN_PALETTES: ChunkPalettes = {
  top: TERRAIN_PALETTE,
  cliff: CLIFF_PALETTE,
};

/** The chunk holding a cell coordinate — contour chunks tile the cell lattice. */
function chunkOf(cell: number): number {
  return Math.floor(cell / CHUNK_SIZE);
}
/**
 * Even-odd point-in-loop test.
 *
 * EDGE CASES ARE NOT EXCLUDED BY CONSTRUCTION — this comment used to claim
 * "every probe in this module sits at a CELL CENTRE, which
 * CONTOUR_CELL_CENTRE_GUARD keeps at least an eighth of a cell clear of any
 * contour vertex or edge", and that stopped being true when waterCurtain
 * became the only caller: its probes are `midpoint + normal × reach` and land
 * anywhere. A probe exactly on an edge is therefore possible in principle, and
 * the even-odd rule may call it either way. It is left as is deliberately:
 * both answers name a band the terrain draws immediately either side of that
 * edge, the caller (`footBandOf`) is choosing where a sheet of water ends, and
 * a coin-flip between two adjacent bands at a boundary is not a defect worth
 * a tolerance parameter. What WOULD have been a defect — the guess that walk
 * starts from — is fixed in `bandAt` instead.
 *
 * This mirrors triangulation.ts's own pointInLoop; that one stays private to
 * the triangulator, and duplicating twelve lines of standard ray casting beats
 widening triangulation.ts's export surface for it.
 */
function pointInLoop(px: number, pz: number, loop: ContourLoop): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.z > pz !== b.z > pz) {
      const t = (pz - a.z) / (b.z - a.z);
      if (px < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

/**
 * Whether the point lies INSIDE the region a level's grouped loops draw —
 * inside some outer polygon AND inside none of its holes.
 *
 * The grouping is not optional. A basin dug into a plateau produces, at the
 * plateau's own threshold, an outer loop plus an inner loop winding the other
 * way; a naive "inside ANY loop" test reads the basin as part of the plateau
 * cap, which the terrain does not draw (groupLoops splices it out as a hole).
 */
function insideGrouped(pointX: number, pointZ: number, polygons: readonly CapPolygon[]): boolean {
  for (const polygon of polygons) {
    if (!pointInLoop(pointX, pointZ, polygon.outer)) continue;
    let inHole = false;
    for (const hole of polygon.holes) {
      if (pointInLoop(pointX, pointZ, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface DrawnGround {
  /**
   * The world Y of the cap the terrain DRAWS at this point, in CELL
   * coordinates — the number that was written into the vertex buffer.
   *
   * This, not `bandAt`, is what anything standing on the rock should ask for.
   * A band index has to be turned back into a height by re-applying the
   * terrain's rules (band 0 sinks to the seabed unless the waterline cap covers
   * it; a blocky chunk has no bands at all), and every caller that did so got
   * at least one of those rules wrong.
   */
  capYAt(cellX: number, cellZ: number): number;
  /**
   * The world Y of the cap the terrain draws for a GIVEN band, anchored at a
   * cell that band's region actually covers.
   *
   * Water needs this rather than `capYAt` because a water region's band is a
   * fact about the WATER (the river network computed it), while the height it
   * must be drawn at is a fact about the ROCK. The anchor resolves band 0's two
   * caps — seabed and the waterline above it — from the stack that cell's chunk
   * really drew, instead of the `seabed: boolean` the caller used to guess.
   * For every band above 0 the answer is chunk-independent.
   */
  capYOfBand(band: number, cellX: number, cellZ: number): number;
  /**
   * The band whose cap the terrain draws at this point.
   *
   * Still meaningful for callers that COMPARE ground levels rather than stand
   * on them — waterCurtain walks outward looking for the point where the
   * ground stops falling, which is a question about ordering, not height. Use
   * `capYAt` for anything that needs a Y.
   */
  bandAt(cellX: number, cellZ: number): number;
  /** Nearest contour VERTEX of `threshold`'s contour in the chunk holding the query. */
  nearestOnContour(
    threshold: number,
    cellX: number,
    cellZ: number,
  ): { x: number; z: number; loop: ContourLoop; index: number } | null;
  /** The smoothed loops of `threshold` for the chunk holding a cell. */
  loopsAt(threshold: number, cellX: number, cellZ: number): readonly ContourLoop[];
}

/** Plans are memoised per chunk; the pair has no cheap integer key. */
const cacheKey = (cx: number, cz: number): string => `${cx}:${cz}`;

export function createDrawnGround(mirror: TerrainMirror): DrawnGround {
  const cache = new Map<string, ChunkDrawnCaps>();

  /**
   * What the terrain drew for the chunk containing (cellX, cellZ), planned once.
   *
   * Calls the renderer's own planner, so this is not "the same computation" as
   * the mesh — it is the same CALL. A chunk the planner sends to the blocky
   * fallback is reported as such rather than being described with contours it
   * did not draw.
   */
  const capsAt = (cellX: number, cellZ: number): ChunkDrawnCaps => {
    const cx = chunkOf(cellX);
    const cz = chunkOf(cellZ);
    const key = cacheKey(cx, cz);
    const hit = cache.get(key);
    if (hit) return hit;
    const plan = planChunkCaps(mirror, cx, cz, DRAWN_PALETTES);
    const caps: ChunkDrawnCaps = plan.overBudget
      ? { blocky: true, levels: [] }
      : {
          blocky: false,
          levels: plan.levels.map((level, index) => ({
            threshold: level.threshold,
            sampleBand: level.sampleBand,
            capY: level.capY,
            polygons: plan.polygonsPerLevel[index],
          })),
        };
    cache.set(key, caps);
    return caps;
  };

  /**
   * The topmost published level whose drawn region contains the point, or null
   * on a blocky chunk (which publishes no levels).
   *
   * TOPMOST, walking the stack backwards, and that is the whole resolution
   * rule: the levels are drawn lowest-first, each over the one below, so the
   * last one that contains the point is the one you can see. It needs no guess
   * and no upper-bound argument — the four-sample-max reasoning the old
   * `bandAt` carried, and the off-by-one that reasoning was written to fix,
   * both exist only because the walk used to start from a lattice estimate
   * instead of from the drawn stack itself.
   *
   * It also settles band 0's two caps for free: the waterline level sits
   * directly above the seabed level in the stack, so a point on dry shore finds
   * the waterline cap first and a point on seabed falls through to the sunk
   * one. That question used to be pushed onto the caller as a boolean.
   */
  const topmostLevelAt = (cellX: number, cellZ: number) => {
    const caps = capsAt(cellX, cellZ);
    for (let i = caps.levels.length - 1; i >= 0; i--) {
      const level = caps.levels[i];
      if (insideGrouped(cellX, cellZ, level.polygons)) return level;
    }
    return null;
  };

  /**
   * The height the BLOCKY fallback drew at this point.
   *
   * A blocky chunk is one flat quad per lattice cell, so the answer is the
   * cell's own sampled height put through the fallback's own Y rule. The cell a
   * point lands in is the NEAREST sample, not the floor of the coordinate:
   * contour coordinates are cell-CENTRE units, and the fallback's quads are
   * centred on samples and half-open at the domain border.
   */
  const blockyHeightAt = (cellX: number, cellZ: number): number =>
    sampleHeight(mirror, Math.round(cellX), Math.round(cellZ));

  return {
    capYAt(cellX: number, cellZ: number): number {
      const caps = capsAt(cellX, cellZ);
      if (caps.blocky) return blockyCellCapY(blockyHeightAt(cellX, cellZ));
      const level = topmostLevelAt(cellX, cellZ);
      // Null means the point is outside every drawn region of its chunk, which
      // the lowest level makes impossible in practice (its region is the whole
      // domain, by makeLevels' construction). Answering with the lowest cap
      // that chunk drew keeps a malformed fixture from returning NaN.
      if (level !== null) return level.capY;
      return caps.levels.length > 0 ? caps.levels[0].capY : 0;
    },

    capYOfBand(band: number, cellX: number, cellZ: number): number {
      const caps = capsAt(cellX, cellZ);
      // Topmost first, so band 0 answers with the waterline cap where the chunk
      // drew one and the sunk seabed cap where it did not.
      for (let i = caps.levels.length - 1; i >= 0; i--) {
        if (caps.levels[i].sampleBand === band) return caps.levels[i].capY;
      }
      // A blocky chunk published no levels. Its Y rule takes a HEIGHT, and
      // makeLevels' own convention for "the representative raw height of band
      // k" is that band's threshold — the first height in it.
      return blockyCellCapY(band * BAND_HEIGHT);
    },

    bandAt(cellX: number, cellZ: number): number {
      const caps = capsAt(cellX, cellZ);
      if (caps.blocky) return bandOf(blockyHeightAt(cellX, cellZ));
      const level = topmostLevelAt(cellX, cellZ);
      if (level !== null) return level.sampleBand;
      return caps.levels.length > 0 ? caps.levels[0].sampleBand : 0;
    },

    nearestOnContour(threshold, cellX, cellZ) {
      // Nearest VERTEX, not nearest edge point: the caller re-seats onto the
      // loop and walks between endpoints (W3's contract), so a loop index —
      // which only a vertex has — is the useful answer.
      let best: { x: number; z: number; loop: ContourLoop; index: number } | null = null;
      let bestDistanceSquared = Infinity;
      for (const loop of polygonsOfThreshold(capsAt(cellX, cellZ), threshold).flatMap(
        (p) => [p.outer, ...p.holes],
      )) {
        for (let i = 0; i < loop.length; i++) {
          const dx = loop[i].x - cellX;
          const dz = loop[i].z - cellZ;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestDistanceSquared) {
            bestDistanceSquared = d2;
            best = { x: loop[i].x, z: loop[i].z, loop, index: i };
          }
        }
      }
      return best;
    },

    loopsAt(threshold, cellX, cellZ) {
      return polygonsOfThreshold(capsAt(cellX, cellZ), threshold).map((p) => p.outer);
    },
  };
}

/**
 * The published polygons of one threshold, or none when the chunk drew no such
 * level (including every blocky chunk, which drew no contours at all).
 */
function polygonsOfThreshold(
  caps: ChunkDrawnCaps,
  threshold: number,
): readonly CapPolygon[] {
  for (const level of caps.levels) {
    if (level.threshold === threshold) return level.polygons;
  }
  return [];
}
