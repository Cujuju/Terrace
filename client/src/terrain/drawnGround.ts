// DrawnGround — the single source of truth for "what does the terrain DRAW
// here" (plan water-painted-on-bands, work item W1).
//
// THE BUG THIS REPLACES. Asking `bandOf(sampleHeight(x, z))` answers "which
// band does the CELL LATTICE say this cell is in", but the terrain does not
// draw cell lattices: band k's cap is drawn over the region enclosed by the
// SMOOTHED marched contour at threshold k * BAND_HEIGHT, and Chaikin smoothing
// moves that boundary off the cell lattice by up to about half a cell. On the
// `fork` fixture (measured 2026-08-23) 430 of 6745 water vertices floated a
// full band above the ground because their cells sat just OUTSIDE a smoothed
// cap contour while their lattice heights still claimed membership. This module
// re-derives the answer from the very pipeline capEmission.ts draws with, so
// the two can never disagree again.
//
// HAZARD — the march scratch buffers are module-global and shared.
// contours.ts's `samples` lattice, edge tables and segment tables are ONE set
// of module-level arrays reused by every marcher in the client (see the
// per-write scratch note there). A loadSamples → marchLevel → assembleLoops run
// must therefore COMPLETE before another starts: no interleaving, no lazy
// generator that resumes mid-march, no async anywhere in this file. That holds
// naturally here because every entry point runs its marches synchronously to
// completion and caches the result before returning.
//
// LIFETIME. Every march is memoised on (chunkX, chunkZ, threshold) for the
// lifetime of the DrawnGround instance. One instance is created per terrain
// rebuild and discarded with it — it MUST NOT outlive a terrain edit, or its
// cache would answer later queries from pre-edit contours.

import { BAND_HEIGHT, CHUNK_SIZE, bandOf } from '@terrace/shared';
import { BAND_WORLD_HEIGHT } from '../config.ts';
import { SEABED_CAP_SINK } from './capEmission.ts';
import {
  assembleLoops,
  loadSamples,
  marchLevel,
  samples,
  type ContourLoop,
} from './contours.ts';
import { smoothLoop } from './contourSmoothing.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';
import { groupLoops, type CapPolygon } from './triangulation.ts';

/** The chunk holding a cell coordinate — contour chunks tile the cell lattice. */
function chunkOf(cell: number): number {
  return Math.floor(cell / CHUNK_SIZE);
}

/**
 * The smoothed loops of `{height ≥ threshold}` for one chunk — the exact loops
 * capEmission.ts draws band caps from (its chunkContourLoops, kept on
 * ContourPoint so the border mask survives for callers that need it).
 *
 * Runs the shared pipeline synchronously start to finish (see the HAZARD note
 * at the top of this file) and returns freshly allocated loops, so the caller
 * may hold them across other marches.
 */
function smoothedContourLoops(
  mirror: TerrainMirror,
  cx: number,
  cz: number,
  threshold: number,
): ContourLoop[] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  loadSamples(mirror, originX, originZ);
  const segmentCount = marchLevel(threshold, originX, originZ, null);
  const wholeInside = samples[0] >= threshold;
  return assembleLoops(segmentCount, originX, originZ, wholeInside)
    .map(smoothLoop)
    .filter((loop) => loop.length >= 3);
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/**
 * Even-odd point-in-loop test, edges excluded by construction of the query:
 * every probe in this module sits at a CELL CENTRE, which CONTOUR_CELL_CENTRE_GUARD
 * keeps at least an eighth of a cell clear of any contour vertex or edge.
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
  /** The band whose cap the terrain draws at this point, in CELL coordinates. */
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

/**
 * Marches are cached per (chunk, threshold) as GROUPED loops — groupLoops
 * output is what containment needs, and regrouping per query would defeat the
 * memo. Keyed by string because a chunk/threshold pair has no cheap integer
 * key and the map lives exactly one rebuild.
 */
const cacheKey = (cx: number, cz: number, threshold: number): string =>
  `${cx}:${cz}:${threshold}`;

export function createDrawnGround(mirror: TerrainMirror): DrawnGround {
  const cache = new Map<string, CapPolygon[]>();

  /** Grouped loops for the chunk containing (cellX, cellZ), marched once. */
  const groupedAt = (threshold: number, cellX: number, cellZ: number): CapPolygon[] => {
    const cx = chunkOf(cellX);
    const cz = chunkOf(cellZ);
    const key = cacheKey(cx, cz, threshold);
    const hit = cache.get(key);
    if (hit) return hit;
    const grouped = groupLoops(smoothedContourLoops(mirror, cx, cz, threshold));
    cache.set(key, grouped);
    return grouped;
  };

  return {
    /**
     * The band whose cap the terrain actually DRAWS over (cellX, cellZ).
     *
     * Starts from the lattice guess `bandOf(sampleHeight(...))` and walks DOWN
     * one threshold at a time, returning the first whose smoothed contour
     * contains the point. Smoothing can only ever SHRINK a region relative to
     * its lattice (Chaikin cut points are convex combinations, and the
     * clearance bias pulls a boundary a quarter-cell inside the higher cell),
     * so the true drawn band is the guess or LOWER — never higher — and within
     * a couple of levels. It is a correction of one or two bands, not a scan
     * from the summit.
     *
     * Termination: threshold 0's region is the whole domain (every height is
     * ≥ 0), so the walk always finds a container by band 0; MIN_PROBE_BAND is
     * belt-and-braces against a malformed fixture.
     */
    bandAt(cellX: number, cellZ: number): number {
      const guess = bandOf(sampleHeight(mirror, Math.floor(cellX), Math.floor(cellZ)));
      for (let band = guess; band >= MIN_PROBE_BAND; band--) {
        if (insideGrouped(cellX, cellZ, groupedAt(band * BAND_HEIGHT, cellX, cellZ))) {
          return band;
        }
      }
      return MIN_PROBE_BAND;
    },

    nearestOnContour(threshold, cellX, cellZ) {
      // Nearest VERTEX, not nearest edge point: the caller re-seats onto the
      // loop and walks between endpoints (W3's contract), so a loop index —
      // which only a vertex has — is the useful answer.
      let best: { x: number; z: number; loop: ContourLoop; index: number } | null = null;
      let bestDistanceSquared = Infinity;
      for (const loop of groupedAt(threshold, cellX, cellZ).flatMap((p) => [p.outer, ...p.holes])) {
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
      return groupedAt(threshold, cellX, cellZ).map((polygon) => polygon.outer);
    },
  };
}

/**
 * Bands below this are never probed. Heights are clamped non-negative by the
 * heightmap, so band 0's threshold-0 contour contains everything and the walk
 * stops here in practice; the constant only names the floor.
 */
const MIN_PROBE_BAND = 0;

/**
 * World Y of the terrain's drawn cap for a band — capEmission.ts makeLevels'
 * rule (its lines 606 and 642), restated HERE rather than duplicated THERE:
 *
 *   - band k > 0's cap sits at k * BAND_WORLD_HEIGHT;
 *   - band 0 is TWO levels. Where it is seabed its cap is SUNK to
 *     -SEABED_CAP_SINK (so dry land at the same heights has somewhere to be),
 *     and where it is dry shore it is the extra waterline level at y = 0.
 *   `seabed` picks between them.
 */
export function drawnBandWorldY(band: number, seabed: boolean): number {
  if (band === 0) return seabed ? -SEABED_CAP_SINK : 0;
  return band * BAND_WORLD_HEIGHT;
}
