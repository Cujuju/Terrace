// DrawnGround — the single source of truth for "what does the terrain DRAW
// here" (plan water-painted-on-bands, work item W1; rebuilt as a READER on
// 2026-08-24, the contract fix; rebuilt again on 2026-08-26 as a reader over a
// store the EMITTER fills — see terrain/drawnGroundStore.ts).
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
// THE SECOND FIX (2026-08-26): THE PLAN IS HANDED OVER, NOT RE-DERIVED. The
// version above still CALLED `planChunkCaps` — once per chunk per oracle, and
// one oracle was built per water rebuild, so a held stroke re-marched every
// chunk the water reached twice a second while `writeChunkVertexData` had
// already planned those same chunks and discarded the result. This file is now
// a pure reader over `DrawnGroundStore`, which the emitter fills as it draws.
// Three things follow, and all three are the point:
//
//   * NO SECOND COMPUTATION. `capsAt` is a Map read, and `bandAt` /
//     `topmostLevelAt` are an array read into the store's precomputed band grid
//     instead of a point-in-polygon walk down the level stack.
//   * NO INVALIDATION. The old memo was private to an instance and "MUST NOT
//     outlive a terrain edit", which four call sites in world.ts had to
//     remember. An entry is now replaced by the very act that redraws its
//     chunk, so an oracle may live as long as its mirror does.
//   * A CHUNK MAY HAVE NO ENTRY, and the answer for one is defined below rather
//     than left to chance. See `MISSING CHUNKS`.
//
// MISSING CHUNKS. A chunk has no entry until it has been drawn, and the mesh
// builder drains its queue under a frame budget (terrainMeshes.ts), so during a
// held stroke a just-dirtied chunk can be a frame or two behind the mirror.
// This reader answers for such a chunk exactly as it answers for a BLOCKY one:
// from the cell's own sampled height through the blocky fallback's Y rule. That
// is the conservative answer — it names a height the terrain really has, never
// a contour nobody has drawn — and it is on the correct side of the race for
// every caller: water welded to the rock that is on screen is right, and water
// welded to rock that has not been emitted yet is not.
//
// HAZARD (retired, kept as the record). While this file planned chunks itself
// it shared contours.ts's module-level march scratch, which forced "a plan must
// COMPLETE before another starts: no interleaving, no lazy generator, no async
// anywhere in this file". Nothing here marches any more, so the constraint has
// moved to the store's `publish` — and to `publishPlannedChunk`, the harness-
// only entry point.

import { BAND_HEIGHT, CHUNK_SIZE, bandOf } from '@terrace/shared';
import { blockyCellCapY } from './capEmission.ts';
import { type ContourLoop } from './contours.ts';
import {
  polygonsOfLevel,
  topLevelIndexAt,
  type ChunkChart,
  type DrawnGroundStore,
} from './drawnGroundStore.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';
import { type CapPolygon } from './triangulation.ts';

/** The chunk holding a cell coordinate — contour chunks tile the cell lattice. */
function chunkOf(cell: number): number {
  return Math.floor(cell / CHUNK_SIZE);
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

/**
 * A reader over what the terrain published. Cheap to construct and safe to keep
 * for the mirror's whole lifetime — it holds no cache of its own, which is the
 * difference from every earlier version of this function.
 */
export function createDrawnGround(mirror: TerrainMirror, store: DrawnGroundStore): DrawnGround {
  /** What the chunk containing (cellX, cellZ) drew, or null if it has not been drawn. */
  const chartAt = (cellX: number, cellZ: number): ChunkChart | null =>
    store.chartOf(chunkOf(cellX), chunkOf(cellZ));

  /**
   * The topmost published level whose drawn region contains the point, or null
   * on a blocky chunk (which publishes no levels) and on one not yet drawn.
   *
   * TOPMOST, and that is the whole resolution rule: the levels are drawn
   * lowest-first, each over the one below, so the last one that contains the
   * point is the one you can see. It needs no guess and no upper-bound argument
   * — the four-sample-max reasoning the old `bandAt` carried, and the off-by-one
   * that reasoning was written to fix, both exist only because the walk used to
   * start from a lattice estimate instead of from the drawn stack itself.
   *
   * It also settles band 0's two caps for free: the waterline level sits
   * directly above the seabed level in the stack, so a point on dry shore finds
   * the waterline cap first and a point on seabed falls through to the sunk
   * one. That question used to be pushed onto the caller as a boolean.
   *
   * The walk itself now happens once per chunk BUILD, in the store's rasteriser
   * — this is the array read that replaced it.
   */
  const topmostLevelAt = (chart: ChunkChart, cellX: number, cellZ: number): number | null => {
    const index = topLevelIndexAt(chart, cellX, cellZ);
    if (index === null || index >= chart.plan.levelThreshold.length) return null;
    return index;
  };

  /**
   * The height the BLOCKY fallback drew at this point — also the answer for a
   * chunk with no entry yet (see the header's MISSING CHUNKS note).
   *
   * A blocky chunk is one flat quad per lattice cell, so the answer is the
   * cell's own sampled height put through the fallback's own Y rule. The cell a
   * point lands in is the NEAREST sample, not the floor of the coordinate:
   * contour coordinates are cell-CENTRE units, and the fallback's quads are
   * centred on samples and half-open at the domain border.
   */
  const blockyHeightAt = (cellX: number, cellZ: number): number =>
    sampleHeight(mirror, Math.round(cellX), Math.round(cellZ));

  /** True when the chunk drew no contours to read — blocky, or not drawn at all. */
  const hasNoContours = (chart: ChunkChart | null): chart is null =>
    chart === null || chart.plan.blocky;

  return {
    capYAt(cellX: number, cellZ: number): number {
      const chart = chartAt(cellX, cellZ);
      if (hasNoContours(chart)) return blockyCellCapY(blockyHeightAt(cellX, cellZ));
      const level = topmostLevelAt(chart, cellX, cellZ);
      // Null means the point is outside every drawn region of its chunk, which
      // the lowest level makes impossible in practice (its region is the whole
      // domain, by makeLevels' construction). Answering with the lowest cap
      // that chunk drew keeps a malformed fixture from returning NaN.
      if (level !== null) return chart.plan.levelCapY[level]!;
      return chart.plan.levelCapY.length > 0 ? chart.plan.levelCapY[0]! : 0;
    },

    capYOfBand(band: number, cellX: number, cellZ: number): number {
      const chart = chartAt(cellX, cellZ);
      if (!hasNoContours(chart)) {
        // Topmost first, so band 0 answers with the waterline cap where the
        // chunk drew one and the sunk seabed cap where it did not.
        const { levelSampleBand, levelCapY } = chart.plan;
        for (let i = levelSampleBand.length - 1; i >= 0; i--) {
          if (levelSampleBand[i] === band) return levelCapY[i]!;
        }
      }
      // A blocky chunk published no levels, and an undrawn one published
      // nothing at all. The blocky Y rule takes a HEIGHT, and makeLevels' own
      // convention for "the representative raw height of band k" is that band's
      // threshold — the first height in it.
      return blockyCellCapY(band * BAND_HEIGHT);
    },

    bandAt(cellX: number, cellZ: number): number {
      const chart = chartAt(cellX, cellZ);
      if (hasNoContours(chart)) return bandOf(blockyHeightAt(cellX, cellZ));
      const level = topmostLevelAt(chart, cellX, cellZ);
      if (level !== null) return chart.plan.levelSampleBand[level]!;
      return chart.plan.levelSampleBand.length > 0 ? chart.plan.levelSampleBand[0]! : 0;
    },

    nearestOnContour(threshold, cellX, cellZ) {
      // Nearest VERTEX, not nearest edge point: the caller re-seats onto the
      // loop and walks between endpoints (W3's contract), so a loop index —
      // which only a vertex has — is the useful answer.
      let best: { x: number; z: number; loop: ContourLoop; index: number } | null = null;
      let bestDistanceSquared = Infinity;
      for (const loop of polygonsOfThreshold(chartAt(cellX, cellZ), threshold).flatMap(
        (p) => [p.outer, ...p.holes],
      )) {
        for (let i = 0; i < loop.length; i++) {
          const dx = loop[i]!.x - cellX;
          const dz = loop[i]!.z - cellZ;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestDistanceSquared) {
            bestDistanceSquared = d2;
            best = { x: loop[i]!.x, z: loop[i]!.z, loop, index: i };
          }
        }
      }
      return best;
    },

    loopsAt(threshold, cellX, cellZ) {
      return polygonsOfThreshold(chartAt(cellX, cellZ), threshold).map((p) => p.outer);
    },
  };
}

/**
 * The published polygons of one threshold, or none when the chunk drew no such
 * level (including every blocky chunk, which drew no contours at all, and every
 * chunk that has not been drawn yet).
 */
function polygonsOfThreshold(
  chart: ChunkChart | null,
  threshold: number,
): readonly CapPolygon[] {
  if (chart === null) return [];
  const thresholds = chart.plan.levelThreshold;
  for (let i = 0; i < thresholds.length; i++) {
    // THE ONE PLACE point objects are rebuilt from the flat published plan —
    // lazily, per chunk and level, and kept. See drawnGroundStore's
    // `polygonsOfLevel`.
    if (thresholds[i] === threshold) return polygonsOfLevel(chart, i);
  }
  return [];
}
