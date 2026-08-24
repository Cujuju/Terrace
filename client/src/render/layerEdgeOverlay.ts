// LAYER EDGES — every terrace lip in the world, drawn on the terrain itself
// (owner, 2026-08-23: "I wanted you to actually draw it on the map as to what
// the map knows in regards to what I could click to start dragging a layer").
//
// WHAT IT DRAWS, AND WHY THAT IS THE HONEST ANSWER. A "layer" is the region
// {height ≥ k·BAND_HEIGHT}; its edge is the marching-squares contour of that
// region, and that contour is ALREADY the thing the terrain mesh is built from
// (terrain/capEmission.ts's chunkContourLoops → the same loops that become cap
// outlines and skirt tops). So this overlay does not invent a grab model: it
// exposes the geometry the renderer already computes, at the exact height the
// lip is drawn at. If a line is here, the map genuinely knows about that edge.
//
// HOW IT DIFFERS FROM render/pickDebugOverlay.ts. That one answers "what did
// the PICKER name" — one cell, because a cell plus a riser/cap flag is all
// pickTerrainCellByRay returns. This one answers "what EDGES exist to be
// grabbed". The gap between the two pictures is the finding the two-method
// sculpt design turns on: the edges are all here in the geometry, and the pick
// path cannot currently name any of them. Closing that gap is the work.
//
// BORDER SEGMENTS ARE SKIPPED, and this is not cosmetic. assembleLoops closes
// every loop against the chunk's own border, so each chunk's contour includes
// straight runs along the seam that are an artefact of chunking rather than a
// terrace lip. terrain/capEmission.ts drops exactly these when it extrudes
// skirts (isBorderSegment), for the same reason: there is no riser there. Left
// in, the overlay would draw a chunk grid over the world and read as noise.
//
// COST. One rebuild per dirty chunk, over only the band levels that chunk
// actually spans (a flat chunk spans one and costs one march). It rides the
// same dirty-chunk set as the terrain meshes, so a stroke re-contours the
// chunks it touched and nothing else. It is a diagnostic, not a shipped
// feature: unlike terrainMeshes it rebuilds whole geometries rather than
// patching buffers, and it is not budgeted across frames.

import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from 'three';
import type { Object3D } from 'three';
import { BAND_HEIGHT, CHUNK_SIZE, DRAG_NORMAL_SCALE, bandOf } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { chunkContourLoops } from '../terrain/capEmission.ts';
import { hasChunk, sampleHeight, type TerrainMirror } from '../terrain/mirror.ts';

/**
 * Edge colour. Cyan because nothing else in the scene is: terrain is green and
 * brown, the brush ring is white, a riser pick is amber. An edge overlay whose
 * colour collides with any of those cannot be read at a glance over terrain.
 */
const EDGE_COLOR = 0x35d6e8;

/** Edge line opacity — present over bright treads, not so solid it flattens the terrain under it. */
const EDGE_OPACITY = 0.9;

/**
 * How far above its band's height the contour is drawn, in world units. The
 * lip is exactly at the band height, so without a lift the line z-fights the
 * cap it traces along its entire length.
 */
const EDGE_LIFT_WORLD_UNITS = 0.004;

/** Two endpoints per segment, three floats each. */
const FLOATS_PER_SEGMENT = 6;

/**
 * Colour of the lip currently under the cursor — the one a drag would grab.
 * Warm white against the resting cyan: a highlight has to win against the
 * colour it is picked out from, and lightening the same hue does not.
 */
const GRABBED_COLOR = 0xfff2c4;

/** The grabbed lip is drawn thicker in spirit — full opacity against the resting edges. */
const GRABBED_OPACITY = 1;

/**
 * How close the cursor must come to a lip to grab it, in world units.
 *
 * DERIVED, not chosen: a lip that BOUNDS the cell being pointed at, or any of
 * that cell's eight neighbours, is grabbable. A contour bounding a cell passes
 * within half a cell of its centre, and a neighbour's contour within one and a
 * half — so one and a half cells is exactly "the lip on or beside the cell I
 * am pointing at", and nothing further.
 *
 * IT WAS ONE CELL, MEASURED FROM THE CELL'S CORNER (owner report 2026-08-24:
 * "it is sometimes difficult to actually grab a band, like you can't reach
 * it"). The query point is a cell, so it carries up to half a cell of
 * quantisation on each axis before any tolerance is applied; measuring from
 * the corner added another half cell of bias, all of it in one direction. The
 * total error could equal the whole tolerance, which made grabbing a lip a
 * coin toss decided by which side of the cell the contour ran along. The
 * centre-of-cell fix below removes the bias; this covers the quantisation that
 * is left.
 */
const GRAB_RADIUS_WORLD_UNITS = 1.5 * CELL_WORLD_SIZE;

/**
 * How much of the grabbed lip lights up on either side of the cursor, in world
 * units. Long enough to read which way the lip runs (a couple of world units
 * of contour is unambiguous even at a shallow camera pitch), short enough that
 * grabbing a coastline does not set the whole coast alight and hide where the
 * cursor actually is.
 */
const HIGHLIGHT_SPAN_WORLD_UNITS = 2;

/**
 * How far either side of the grabbed lip the terrain is sampled to decide
 * WHICH WAY THE FACE LOOKS, in cells.
 *
 * Two rather than one: the contour runs between cells, so the cells
 * immediately either side of it can both read as the same band once the
 * marching-squares interpolation is accounted for, and a one-cell probe then
 * picks the outward direction by a coin toss. Two cells is clear of the lip
 * while still on the same terrace feature.
 *
 * DERIVED FROM THE CONTOUR, NOT TUNED FOR FEEL: nothing the player sees
 * changes with this number — it only decides a sign.
 */
const NORMAL_PROBE_CELLS = 2;

/**
 * A grabbed terrace lip: which band it belongs to, and which way its face
 * looks. Everything a `drag` stroke freezes on pointerdown.
 *
 * The normal is a unit vector scaled by DRAG_NORMAL_SCALE and rounded to
 * integers, because it goes on the wire and then into cell arithmetic that
 * server and client must agree on bit for bit — see shared/heightmap.ts's
 * DragPull.
 */
export interface LipGrab {
  readonly band: number;
  readonly normalX: number;
  readonly normalY: number;
}

export interface LayerEdgeOverlay {
  /** Rebuilds the edges of the given chunks. Unreceived chunks are skipped. */
  update(dirty: Iterable<number>): void;
  /**
   * Lights up the lip nearest the given cell and returns what a drag starting
   * there would grab — its band and the outward normal of its face. Null
   * clears the highlight and reports no grab, either because the pointer is
   * off the world or because the nearest lip is further than
   * GRAB_RADIUS_WORLD_UNITS away.
   */
  highlightAt(cell: { x: number; y: number } | null): LipGrab | null;
  /** Drops every edge mesh — for a fresh join replacing the world. */
  clear(): void;
  dispose(): void;
}

export function createLayerEdgeOverlay(
  group: Object3D,
  mirror: TerrainMirror,
  worldSize: number,
): LayerEdgeOverlay {
  const chunksPerEdge = Math.max(1, Math.floor(worldSize / CHUNK_SIZE));
  const meshes = new Map<number, LineSegments>();
  /**
   * The same segments the meshes draw, kept in world space and keyed by chunk
   * then band, so "which lip is under the cursor" is a lookup rather than a
   * re-march. Flat [ax, az, bx, bz, ...] per band — Y is implied by the band.
   *
   * Retained rather than recomputed because the overlay has already paid for
   * this contour: throwing it away and marching again on hover would run the
   * marching-squares pass every frame the pointer moves.
   */
  const segmentsByChunk = new Map<number, Map<number, number[]>>();
  const material = new LineBasicMaterial({
    color: EDGE_COLOR,
    transparent: true,
    opacity: EDGE_OPACITY,
    // Depth-tested, unlike the brush ring: an edge behind a hill is NOT
    // grabbable, and drawing it through the hill would promise otherwise.
    depthTest: true,
    depthWrite: false,
  });

  const dropMesh = (idx: number): void => {
    segmentsByChunk.delete(idx);
    const existing = meshes.get(idx);
    if (existing === undefined) return;
    group.remove(existing);
    existing.geometry.dispose();
    meshes.delete(idx);
  };

  /** The inclusive band range this chunk spans, or null if it has no cells. */
  const bandRange = (cx: number, cy: number): { lo: number; hi: number } | null => {
    const originX = cx * CHUNK_SIZE;
    const originZ = cy * CHUNK_SIZE;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const h = sampleHeight(mirror, originX + lx, originZ + ly);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return { lo: bandOf(lo), hi: bandOf(hi) };
  };

  /**
   * Whether every in-bounds neighbour of this chunk has been received.
   *
   * THE FRONTIER FICTION, and why it has to be excluded. A chunk's contour is
   * marched over a sample window that reaches one cell into its neighbours, and
   * terrain/mirror.ts holds cells of UNRECEIVED chunks at SEA_LEVEL as a
   * rendering fiction. At the edge of revealed territory that fiction meets
   * real ground as an enormous artificial step, and the marcher dutifully finds
   * a contour at EVERY band the step crosses — drawn, it is a bundle of long
   * straight lines along the frontier that look like grabbable lips and are
   * not. Nothing there is grabbable, because nothing there is known.
   *
   * Out-of-bounds neighbours are fine: the world's own border is not a fiction,
   * and a coastal chunk's lips are real.
   */
  const neighboursKnown = (cx: number, cy: number): boolean => {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= chunksPerEdge || ny >= chunksPerEdge) continue;
      if (!hasChunk(mirror, ny * chunksPerEdge + nx)) return false;
    }
    return true;
  };

  const rebuild = (idx: number): void => {
    dropMesh(idx);
    if (!hasChunk(mirror, idx)) return;
    const cx = idx % chunksPerEdge;
    const cy = Math.floor(idx / chunksPerEdge);
    if (!neighboursKnown(cx, cy)) return;
    const range = bandRange(cx, cy);
    if (range === null) return;

    const positions: number[] = [];
    const perBand = new Map<number, number[]>();
    // A contour exists at each band FLOOR above the chunk's lowest band: the
    // boundary of {h ≥ k·BAND_HEIGHT} is empty for k at or below the minimum
    // (everything is inside) and for k above the maximum (nothing is).
    for (let k = range.lo + 1; k <= range.hi; k++) {
      const threshold = k * BAND_HEIGHT;
      const y = threshold * HEIGHT_WORLD_SCALE + EDGE_LIFT_WORLD_UNITS;
      for (const loop of chunkContourLoops(mirror, cx, cy, threshold)) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i]!;
          const b = loop[(i + 1) % loop.length]!;
          // The chunk-seam artefact, not a lip — see the module header.
          if (a.onBorder && b.onBorder) continue;
          const ax = a.x * CELL_WORLD_SIZE;
          const az = a.z * CELL_WORLD_SIZE;
          const bx = b.x * CELL_WORLD_SIZE;
          const bz = b.z * CELL_WORLD_SIZE;
          positions.push(ax, y, az, bx, y, bz);
          let band = perBand.get(k);
          if (band === undefined) {
            band = [];
            perBand.set(k, band);
          }
          band.push(ax, az, bx, bz);
        }
      }
    }
    if (positions.length < FLOATS_PER_SEGMENT) return;
    segmentsByChunk.set(idx, perBand);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    const mesh = new LineSegments(geometry, material);
    // Above the terrain it traces, below the brush outline that must stay
    // readable over it.
    mesh.renderOrder = 500;
    group.add(mesh);
    meshes.set(idx, mesh);
  };

  // The grabbed lip, drawn as its own mesh so highlighting never rebuilds a
  // chunk's resting geometry.
  const grabbedMaterial = new LineBasicMaterial({
    color: GRABBED_COLOR,
    transparent: true,
    opacity: GRABBED_OPACITY,
    depthTest: true,
    depthWrite: false,
  });
  let grabbed: LineSegments | null = null;

  const clearGrabbed = (): void => {
    if (grabbed === null) return;
    group.remove(grabbed);
    grabbed.geometry.dispose();
    grabbed = null;
  };

  /** Squared distance from (px, pz) to segment (ax, az)-(bx, bz), in the XZ plane. */
  const distanceSqToSegment = (
    px: number, pz: number,
    ax: number, az: number, bx: number, bz: number,
  ): number => {
    const vx = bx - ax;
    const vz = bz - az;
    const lengthSq = vx * vx + vz * vz;
    // A degenerate segment is a point; the clamp below would divide by zero.
    let t = lengthSq === 0 ? 0 : ((px - ax) * vx + (pz - az) * vz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (ax + t * vx);
    const dz = pz - (az + t * vz);
    return dx * dx + dz * dz;
  };

  /** The chunks whose segments can reach a query point — its own and its neighbours. */
  const nearbyChunks = function* (cellX: number, cellY: number): Generator<number> {
    const ccx = Math.floor(cellX / CHUNK_SIZE);
    const ccy = Math.floor(cellY / CHUNK_SIZE);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = ccx + dx;
        const ny = ccy + dy;
        if (nx < 0 || ny < 0 || nx >= chunksPerEdge || ny >= chunksPerEdge) continue;
        yield ny * chunksPerEdge + nx;
      }
    }
  };

  return {
    update(dirty) {
      for (const idx of dirty) rebuild(idx);
      // A rebuilt chunk's retained segments are new objects, so any highlight
      // standing on the old ones is stale. Cheaper and more honest to drop it
      // than to try to re-find the same lip in freshly-marched geometry.
      clearGrabbed();
    },

    highlightAt(cell) {
      clearGrabbed();
      if (cell === null) return null;
      // THE CELL'S CENTRE, not its corner (owner report 2026-08-24). A cell's
      // representative point is its centre — it is where the height field is
      // sampled and what every contour is drawn relative to — so measuring a
      // distance from its corner biases every grab half a cell along both
      // axes, always in the same direction. See GRAB_RADIUS_WORLD_UNITS.
      const px = (cell.x + 0.5) * CELL_WORLD_SIZE;
      const pz = (cell.y + 0.5) * CELL_WORLD_SIZE;

      // PASS 1 — which band owns the nearest lip within grabbing range.
      const grabRadiusSq = GRAB_RADIUS_WORLD_UNITS * GRAB_RADIUS_WORLD_UNITS;
      let bestBand: number | null = null;
      let bestDistanceSq = grabRadiusSq;
      // The nearest segment itself, not just its band: its direction is what
      // gives a drag the frozen normal it pulls along.
      let bestAx = 0;
      let bestAz = 0;
      let bestBx = 0;
      let bestBz = 0;
      for (const idx of nearbyChunks(cell.x, cell.y)) {
        const perBand = segmentsByChunk.get(idx);
        if (perBand === undefined) continue;
        for (const [band, flat] of perBand) {
          for (let i = 0; i + 3 < flat.length; i += 4) {
            const d = distanceSqToSegment(px, pz, flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!);
            if (d < bestDistanceSq) {
              bestDistanceSq = d;
              bestBand = band;
              bestAx = flat[i]!;
              bestAz = flat[i + 1]!;
              bestBx = flat[i + 2]!;
              bestBz = flat[i + 3]!;
            }
          }
        }
      }
      if (bestBand === null) return null;

      // WHICH WAY THE FACE LOOKS. The normal is perpendicular to the lip, and
      // the two candidates differ only in sign; the outward one is the one
      // pointing at the LOWER ground, which is decided by sampling the terrain
      // either side rather than by trusting the contour's winding. Winding is
      // an implementation detail of chunkContourLoops and would silently
      // reverse every drag in the world if it ever changed; height is the
      // thing the player can actually see, and it cannot lie about which side
      // is the drop.
      const vx = bestBx - bestAx;
      const vz = bestBz - bestAz;
      const length = Math.sqrt(vx * vx + vz * vz);
      // A zero-length segment has no direction, so there is no pull to define.
      // Reporting no grab is the honest answer, and the case is not reachable
      // from marching squares — this is a guard, not a branch with a feel.
      if (length === 0) return null;
      let nx = -vz / length;
      let nz = vx / length;
      const forward = sampleHeight(
        mirror,
        Math.round(cell.x + nx * NORMAL_PROBE_CELLS),
        Math.round(cell.y + nz * NORMAL_PROBE_CELLS),
      );
      const backward = sampleHeight(
        mirror,
        Math.round(cell.x - nx * NORMAL_PROBE_CELLS),
        Math.round(cell.y - nz * NORMAL_PROBE_CELLS),
      );
      if (backward < forward) {
        nx = -nx;
        nz = -nz;
      }
      const grab: LipGrab = {
        band: bestBand,
        normalX: Math.round(nx * DRAG_NORMAL_SCALE),
        normalY: Math.round(nz * DRAG_NORMAL_SCALE),
      };

      // PASS 2 — light up that band's lip near the cursor. Scoped by distance
      // rather than by loop identity: a loop is CLIPPED AT THE CHUNK BORDER
      // (see chunkContourLoops), so "the whole loop" would stop dead at a seam
      // and read as the lip ending where it plainly does not.
      const spanSq = HIGHLIGHT_SPAN_WORLD_UNITS * HIGHLIGHT_SPAN_WORLD_UNITS;
      const y = bestBand * BAND_HEIGHT * HEIGHT_WORLD_SCALE + EDGE_LIFT_WORLD_UNITS;
      const positions: number[] = [];
      for (const idx of nearbyChunks(cell.x, cell.y)) {
        const flat = segmentsByChunk.get(idx)?.get(bestBand);
        if (flat === undefined) continue;
        for (let i = 0; i + 3 < flat.length; i += 4) {
          const ax = flat[i]!;
          const az = flat[i + 1]!;
          const bx = flat[i + 2]!;
          const bz = flat[i + 3]!;
          if (distanceSqToSegment(px, pz, ax, az, bx, bz) > spanSq) continue;
          positions.push(ax, y, az, bx, y, bz);
        }
      }
      if (positions.length < FLOATS_PER_SEGMENT) return grab;

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      grabbed = new LineSegments(geometry, grabbedMaterial);
      // Above the resting edges it is picked out from.
      grabbed.renderOrder = 501;
      group.add(grabbed);
      return grab;
    },
    clear() {
      clearGrabbed();
      for (const idx of [...meshes.keys()]) dropMesh(idx);
    },
    dispose() {
      this.clear();
      material.dispose();
      grabbedMaterial.dispose();
    },
  };
}
