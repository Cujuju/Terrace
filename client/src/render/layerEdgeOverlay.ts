// LAYER EDGES — every terrace lip in the world, drawn on the terrain itself
// (owner, 2026-08-23: "I wanted you to actually draw it on the map as to what
// the map knows in regards to what I could click to start dragging a layer").
//
// WHAT IT DRAWS, AND WHY THAT IS THE HONEST ANSWER. A "layer" at band k is the
// region {the column is SOLID at band k}; its edge is the marching-squares
// contour of that region, and that contour is ALREADY the thing the terrain
// mesh is built from (terrain/capEmission.ts's chunkBandContourLoops marches
// the very field planChunkCaps marches → the same loops that become cap
// outlines and skirt tops). So this overlay does not invent a grab model: it
// exposes the geometry the renderer already computes, at the exact height the
// lip is drawn at. If a line is here, the map genuinely knows about that edge.
//
// IT USED TO BE {height ≥ k·BAND_HEIGHT} — the top surface only — and that was
// the same statement while every column held one solid span. Once a column
// became a LIST of spans (shared/src/columns.ts) and the carve tool opened a
// gap under a roof, the two parted: the top height still says "solid" over a
// tunnel mouth, so the overlay drew its cyan line straight across an opening
// the mesh had left open. Per band solidity is the field that cannot say that.
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
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  bandOf,
  isSpanDrawn,
  spanAt,
  spanCapHeight,
  spanCount,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { chunkBandContourLoops } from '../terrain/capEmission.ts';
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
 * How close a lip must lie to the aimed point to COUNT AS BOUNDING ITS CELL, in
 * world units. A membership guard, not a search: it answers yes or no about the
 * one band the pick named (see `lightBand`), and never chooses between bands.
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

export interface LayerEdgeOverlay {
  /** Rebuilds the edges of the given chunks. Unreceived chunks are skipped. */
  update(dirty: Iterable<number>): void;
  /**
   * Lights up ONE NAMED BAND's lip beside `(atX, atZ)` and reports whether that
   * band has a lip there at all — a segment bounding `cell` or one of its eight
   * neighbours (GRAB_RADIUS_WORLD_UNITS).
   *
   * A GUARD, NOT A SEARCH, and that is the whole of the 2026-08-27 change. The
   * caller has already decided which band the player is aiming at, from the
   * height the ray struck on the riser face (world.ts's `bandOfPick`), because
   * only the pick knows that; a nearest-lip-in-plan ranking here was a second,
   * disagreeing answer to the same question — a terrace face is VERTICAL, so
   * every lip stacked on it sits at the same place on the ground and the
   * ranking picked between them almost arbitrarily (owner report, 2026-08-24:
   * "it only snaps to the edge of the topmost layer").
   *
   * The guard survives the search because a grab NAMES a band on the wire and
   * `applyDragRegion` refuses a band `canSpreadBandTo` cannot reach; an
   * emitted-then-refused intent still spends a seq and a mana gate.
   *
   * `cell` selects the chunks to look in. `(atX, atZ)` is the world-space point
   * distances are measured from — the caller's, so there is one convention for
   * it rather than one here and one there. A null `cell` or `band` clears the
   * highlight and reports false: the pointer is off the world, or it is on a
   * face with no lip to grab.
   *
   * `litSpanWorldUnits` is HOW MUCH of that band's contour lights up either
   * side of `(atX, atZ)`, and it is the CALLER'S, for the same reason the
   * aimed point is (owner, 2026-08-27: "I want that mouse pointer to be
   * pointing to those cells on the band lip"). It was a fixed 2 world units
   * here, which is a length with no relationship to the edit a press would
   * make; the caller passes the BRUSH RADIUS instead, so the lit stretch is
   * exactly the run of lip the press moves. Scoped by distance rather than by
   * loop identity either way: a loop is CLIPPED AT THE CHUNK BORDER (see
   * chunkContourLoops), so "the whole loop" would stop dead at a seam and read
   * as the lip ending where it plainly does not.
   */
  lightBand(
    cell: { x: number; y: number } | null,
    band: number | null,
    atX: number,
    atZ: number,
    litSpanWorldUnits: number,
  ): boolean;
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

  /**
   * The inclusive band range whose contours can be non-empty here, or null if
   * the chunk has no cells.
   *
   * `hi` is the highest band any column reaches: nothing is solid above it, so
   * every higher contour is empty.
   *
   * `lo` IS NOT THE LOWEST TOP SURFACE, and that distinction is the whole
   * carve fix. The old rule was "every column is solid at every band up to the
   * lowest top, so contours below that are empty" — true only while a column
   * was one unbroken span. A carved column is open at the bands of its gap,
   * which can sit BELOW every top surface in the chunk (a flat plateau with a
   * tunnel through it has one top band and a hole several bands under it), and
   * a range starting at the lowest top would skip exactly the bands where the
   * opening lives. So `lo` is the lowest band a column is solid up to WITHOUT
   * a break: the cap of its lowest drawn span, which for an unlayered column
   * is its top surface — the old rule, restated so it survives a gap.
   */
  const bandRange = (cx: number, cy: number): { lo: number; hi: number } | null => {
    const originX = cx * CHUNK_SIZE;
    const originZ = cy * CHUNK_SIZE;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = originX + lx;
        const y = originZ + ly;
        const h = sampleHeight(mirror, x, y);
        if (h > hi) hi = h;
        // The unbroken-solid ceiling of this column: its lowest DRAWN span's
        // cap. A column with no drawn span at all (fully buried by the
        // seabed's own rules) contributes its top height, as before.
        let unbrokenTo = h;
        const count = spanCount(mirror.map, x, y);
        for (let k = 0; k < count; k++) {
          const span = spanAt(mirror.map, x, y, k);
          if (!isSpanDrawn(span)) continue;
          unbrokenTo = spanCapHeight(span);
          break;
        }
        if (unbrokenTo < lo) lo = unbrokenTo;
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
    // boundary of {solid at band k} is empty for k at or below the minimum
    // (every column is solid there, unbroken — see bandRange) and for k above
    // the maximum (nothing is solid that high).
    for (let k = range.lo + 1; k <= range.hi; k++) {
      const y = k * BAND_HEIGHT * HEIGHT_WORLD_SCALE + EDGE_LIFT_WORLD_UNITS;
      for (const loop of chunkBandContourLoops(mirror, cx, cy, k)) {
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

    lightBand(cell, band, atX, atZ, litSpanWorldUnits) {
      clearGrabbed();
      if (cell === null || band === null) return false;

      // PASS 1 — THE GUARD. Does this band's contour bound the aimed cell or
      // one of its neighbours? One band, one yes/no; nothing is ranked and
      // nothing else can win.
      const grabRadiusSq = GRAB_RADIUS_WORLD_UNITS * GRAB_RADIUS_WORLD_UNITS;
      let bounded = false;
      for (const idx of nearbyChunks(cell.x, cell.y)) {
        const flat = segmentsByChunk.get(idx)?.get(band);
        if (flat === undefined) continue;
        for (let i = 0; i + 3 < flat.length; i += 4) {
          if (distanceSqToSegment(atX, atZ, flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!) >= grabRadiusSq) {
            continue;
          }
          bounded = true;
          break;
        }
        if (bounded) break;
      }
      if (!bounded) return false;

      // PASS 2 — light up the caller's stretch of that band's lip around the
      // aimed point. See `litSpanWorldUnits` on the interface for why the
      // length is the caller's and why it is a distance rather than a loop.
      const spanSq = litSpanWorldUnits * litSpanWorldUnits;
      const y = band * BAND_HEIGHT * HEIGHT_WORLD_SCALE + EDGE_LIFT_WORLD_UNITS;
      const positions: number[] = [];
      for (const idx of nearbyChunks(cell.x, cell.y)) {
        const flat = segmentsByChunk.get(idx)?.get(band);
        if (flat === undefined) continue;
        for (let i = 0; i + 3 < flat.length; i += 4) {
          const ax = flat[i]!;
          const az = flat[i + 1]!;
          const bx = flat[i + 2]!;
          const bz = flat[i + 3]!;
          if (distanceSqToSegment(atX, atZ, ax, az, bx, bz) > spanSq) continue;
          positions.push(ax, y, az, bx, y, bz);
        }
      }
      // The band IS grabbable — the guard said so — even when no segment came
      // within the highlight span to draw.
      if (positions.length < FLOATS_PER_SEGMENT) return true;

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      grabbed = new LineSegments(geometry, grabbedMaterial);
      // Above the resting edges it is picked out from.
      grabbed.renderOrder = 501;
      group.add(grabbed);
      return true;
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
