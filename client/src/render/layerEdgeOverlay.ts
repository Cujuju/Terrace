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
import { BAND_HEIGHT, CHUNK_SIZE, bandOf } from '@terrace/shared';
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

export interface LayerEdgeOverlay {
  /** Rebuilds the edges of the given chunks. Unreceived chunks are skipped. */
  update(dirty: Iterable<number>): void;
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
          positions.push(
            a.x * CELL_WORLD_SIZE, y, a.z * CELL_WORLD_SIZE,
            b.x * CELL_WORLD_SIZE, y, b.z * CELL_WORLD_SIZE,
          );
        }
      }
    }
    if (positions.length < FLOATS_PER_SEGMENT) return;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    const mesh = new LineSegments(geometry, material);
    // Above the terrain it traces, below the brush outline that must stay
    // readable over it.
    mesh.renderOrder = 500;
    group.add(mesh);
    meshes.set(idx, mesh);
  };

  return {
    update(dirty) {
      for (const idx of dirty) rebuild(idx);
    },
    clear() {
      for (const idx of [...meshes.keys()]) dropMesh(idx);
    },
    dispose() {
      this.clear();
      material.dispose();
    },
  };
}
