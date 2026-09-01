// LAYER EDGES — every terrace lip in the world, drawn on the terrain itself
// (owner, 2026-08-23: "I wanted you to actually draw it on the map as to what
// the map knows in regards to what I could click to start dragging a layer").
//
// WHAT IT DRAWS, AND WHY THAT IS THE HONEST ANSWER. A "layer" at band k is the
// region {the column is SOLID at band k}; its edge is the marching-squares
// contour of that region, and that contour is ALREADY the thing the terrain
// mesh is built from. So this overlay does not invent a grab model: it exposes
// the geometry the renderer already computes, at the exact height the lip is
// drawn at. If a line is here, the map genuinely knows about that edge.
//
// IT IS NOW A READER, NOT A MARCHER (2026-08-27). It used to re-march every
// band of every dirty chunk with `chunkBandContourLoops` — the same field, the
// same marcher, the same smoother the chunk build had just run, a second time,
// for 4-9 ms per sculpt on a developed world. The chunk build publishes the
// loops it emitted from (terrain/drawnGroundStore.ts's chart →
// `caps.levels[i].polygons`), and that published set is a SUPERSET of the bands
// this overlay wants, so the overlay reads them. "Already the thing the mesh is
// built from" has stopped being an argument about two runs agreeing and become
// one object.
//
// WHICH MEANS IT IS DRIVEN BY BUILDS, NOT BY THE DIRTY SET. Charts are
// published when a chunk is BUILT, and builds are queued under a frame budget
// (render/terrainMeshes.ts) — `meshes.update(dirty)` does not build
// synchronously. An overlay refreshed from the dirty set would therefore read
// an absent or pre-edit chart for every deferred chunk and draw last edit's
// lips. `refreshChunk` is called per chunk by build completion instead
// (TerrainMeshes.onChunkDrawn), so the lips and the rock they lie on are
// replaced by the same event.
//
// A BLOCKY CHUNK GETS NO LIPS. `caps.blocky` means the chunk fell back to
// axis-aligned per-cell quads and drew no contours at all; the marcher would
// have happily produced lines for a surface that is not on screen, which is
// exactly the promise the module header makes and could not keep.
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
// COST. One arena write per chunk BUILT, over the levels that chunk published
// — no marching, no smoothing, no sampling. It is not budgeted across frames.
//
// IT DRAWS SUPER-MESHES, NOT CHUNKS (issue #246, 2026-09-01). It used to add
// one LineSegments per chunk, which made the CHUNK the drawing unit for the
// third time in this renderer and cost the same way it did in terrainMeshes:
// a fully revealed 2048-cell world is 128 x 128 = 16 384 chunks, and three
// walks every scene object with `updateMatrixWorld` and a frustum-sphere test
// BEFORE culling can discard any of it — measured at 0.187 us per object,
// 3.07 ms of a 7.1 ms frame. The overlay now packs SUPER_MESH_SPAN_CHUNKS^2
// chunks into one buffer per tile (the same span terrain and the frontier fog
// merge on, imported from render/terrainMeshes.ts so the three rigs cull at
// one granularity), which is 256 objects on that world instead of 16 384.
//
// PACKED, WITH NO HOLES. Terrain's arena keeps a free list because a chunk
// there is thousands of vertices and moving the tail is a real memmove; a
// chunk's LIPS are two orders smaller, so a run that changes size just shifts
// the runs after it (`copyWithin`, at most 63 offsets to fix up) and the tile
// stays a dense prefix. That is what lets the draw range be `[0, liveEnd)`
// with nothing dead inside it — no zeroed padding to keep out of the picture,
// and no compactor to schedule.

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
  Sphere,
  Vector3,
} from 'three';
import type { Object3D } from 'three';
import { BAND_HEIGHT, CHUNK_SIZE } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { LIP_LIFT_WORLD_UNITS } from '../terrain/capPlanFlat.ts';
import type { DrawnGroundStore } from '../terrain/drawnGroundStore.ts';
import { hasChunk, type TerrainMirror } from '../terrain/mirror.ts';
import { SUPER_MESH_SPAN_CHUNKS } from './terrainMeshes.ts';

/**
 * Edge colour. Cyan because nothing else in the scene is: terrain is green and
 * brown, the brush ring is white, a riser pick is amber. An edge overlay whose
 * colour collides with any of those cannot be read at a glance over terrain.
 */
const EDGE_COLOR = 0x35d6e8;

/** Edge line opacity — present over bright treads, not so solid it flattens the terrain under it. */
const EDGE_OPACITY = 0.9;

/** Two endpoints per segment, three floats each. */
const FLOATS_PER_SEGMENT = 6;

/** Two endpoints per segment, (x, z) each — the hover query's flat layout. */
const FLOATS_PER_FLAT_SEGMENT = 4;

/** Position components per vertex — the stride of a tile's packed buffer. */
const POSITION_FLOATS_PER_VERTEX = 3;

/**
 * How a tile's buffer grows when a chunk's lips no longer fit: geometric, for
 * the reason terrainMeshes' arena is (a world fills in chunk by chunk, and
 * growing by one chunk's worth each time would copy the whole tile on every
 * chunk of every tile). Doubling caps the reallocations any tile can ever see
 * at log2 of its final size.
 */
const TILE_CAPACITY_GROWTH_FACTOR = 2;

/** A chunk that draws no lips, as the arena writer wants it. */
const NO_LIP_POSITIONS = new Float32Array(0);

/**
 * Above the terrain the lips trace, below the brush outline that must stay
 * readable over them.
 */
const RESTING_RENDER_ORDER = 500;

/** Above the resting edges the grabbed lip is picked out from. */
const GRABBED_RENDER_ORDER = RESTING_RENDER_ORDER + 1;

/**
 * Where one chunk's lip vertices live inside its tile's packed buffer, plus
 * the run's own box.
 *
 * WHY A BOX PER RUN. The tile's bounding sphere has to be recomputed whenever
 * any of its chunks is rebuilt, and computing it from the buffer means
 * scanning every live vertex of the tile for an edit that touched one chunk's
 * worth. Kept per run, it is the union of at most SUPER_MESH_SPAN_CHUNKS^2
 * boxes. Meaningless while `count` is 0 (min > max); the union skips those.
 */
interface ChunkRun {
  /** First vertex of this chunk's run, as an index into the packed buffer. */
  offset: number;
  /** Live vertices in the run. */
  count: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** One drawn object: the packed lips of up to SUPER_MESH_SPAN_CHUNKS^2 chunks. */
interface EdgeTile {
  mesh: LineSegments;
  /** Capacity-sized; only `[0, liveEnd)` is live, and the draw range says so. */
  positions: Float32Array;
  attribute: BufferAttribute;
  /** Vertices in use — the packed prefix, holes being impossible here. */
  liveEnd: number;
  runs: Map<number, ChunkRun>;
}

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
  /**
   * Rebuilds ONE chunk's edges from the chart the terrain has published for
   * it. Called by build completion, never by the dirty set — see the module
   * header. A chunk that is unreceived, frontier-adjacent, blocky or not yet
   * drawn contributes nothing and loses whatever it had.
   */
  refreshChunk(chunkIdx: number): void;
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
  /**
   * Draw objects this overlay currently puts in the scene — its share of the
   * frame's draw budget (part B of
   * docs/plans/frame-budget-growth-and-draw-calls.md).
   *
   * A LIVE COUNT AND NOT A CONSTANT: one LineSegments per SUPER-MESH TILE
   * holding lips, plus the grabbed lip when one is lit. It still grows with
   * the revealed world — every merged rig does — but at one
   * SUPER_MESH_SPAN_CHUNKS^2-th of the rate it did while the chunk was the
   * drawing unit (issue #246); see B7 of the plan.
   */
  drawCallCount(): number;
  dispose(): void;
}

export function createLayerEdgeOverlay(
  group: Object3D,
  mirror: TerrainMirror,
  worldSize: number,
  drawnGround: DrawnGroundStore,
): LayerEdgeOverlay {
  const chunksPerEdge = Math.max(1, Math.floor(worldSize / CHUNK_SIZE));
  const tilesPerEdge = Math.max(1, Math.ceil(chunksPerEdge / SUPER_MESH_SPAN_CHUNKS));
  const tiles = new Map<number, EdgeTile>();
  /**
   * The same segments the meshes draw, kept in world space and keyed by chunk
   * then band, so "which lip is under the cursor" is a lookup rather than a
   * re-march. Flat [ax, az, bx, bz, ...] per band — Y is implied by the band.
   *
   * Retained rather than recomputed because the overlay has already paid for
   * this contour: throwing it away and marching again on hover would run the
   * marching-squares pass every frame the pointer moves.
   */
  const segmentsByChunk = new Map<number, Map<number, Float32Array>>();
  const material = new LineBasicMaterial({
    color: EDGE_COLOR,
    transparent: true,
    opacity: EDGE_OPACITY,
    // Depth-tested, unlike the brush ring: an edge behind a hill is NOT
    // grabbable, and drawing it through the hill would promise otherwise.
    depthTest: true,
    depthWrite: false,
  });

  /** Which tile a chunk's lips are packed into. */
  const tileIndexOfChunk = (chunkIdx: number): number => {
    const cx = chunkIdx % chunksPerEdge;
    const cy = Math.floor(chunkIdx / chunksPerEdge);
    return Math.floor(cy / SUPER_MESH_SPAN_CHUNKS) * tilesPerEdge
      + Math.floor(cx / SUPER_MESH_SPAN_CHUNKS);
  };

  /**
   * The bound the renderer culls the tile against: the union of its runs'
   * boxes, which is O(64) rather than O(live vertices).
   *
   * Hand-rolled rather than `geometry.computeBoundingSphere()` for the reason
   * terrainMeshes' is — that one reads the WHOLE position attribute, and the
   * tail past `liveEnd` is whatever a previous, longer occupant left there.
   */
  const updateTileBounds = (tile: EdgeTile): void => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const run of tile.runs.values()) {
      if (run.count === 0) continue; // a chunk that drew no lips has no box
      if (run.minX < minX) minX = run.minX;
      if (run.minY < minY) minY = run.minY;
      if (run.minZ < minZ) minZ = run.minZ;
      if (run.maxX > maxX) maxX = run.maxX;
      if (run.maxY > maxY) maxY = run.maxY;
      if (run.maxZ > maxZ) maxZ = run.maxZ;
    }
    const geometry = tile.mesh.geometry;
    if (minX > maxX) {
      geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 0);
      return;
    }
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centreZ = (minZ + maxZ) / 2;
    geometry.boundingSphere = new Sphere(
      new Vector3(centreX, centreY, centreZ),
      Math.hypot(maxX - centreX, maxY - centreY, maxZ - centreZ),
    );
  };

  /**
   * Installs a fresh attribute and geometry over the tile's current buffer —
   * a Float32Array cannot be resized, so growth means new arrays and therefore
   * a new attribute, and the old geometry is disposed rather than left holding
   * its GPU buffer.
   */
  const bindTile = (tile: EdgeTile): void => {
    const attribute = new BufferAttribute(tile.positions, POSITION_FLOATS_PER_VERTEX);
    attribute.setUsage(DynamicDrawUsage);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, tile.liveEnd);
    const previous = tile.mesh.geometry;
    tile.mesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();
    tile.attribute = attribute;
    // LAST, AND IT HAS TO BE HERE: the geometry above is brand new and its
    // `boundingSphere` is null, which three would otherwise compute over the
    // whole attribute, dead tail included.
    updateTileBounds(tile);
  };

  const createTile = (tileIdx: number): EdgeTile => {
    const positions = NO_LIP_POSITIONS;
    const geometry = new BufferGeometry();
    const attribute = new BufferAttribute(positions, POSITION_FLOATS_PER_VERTEX);
    geometry.setAttribute('position', attribute);
    const mesh = new LineSegments(geometry, material);
    mesh.renderOrder = RESTING_RENDER_ORDER;
    const tile: EdgeTile = { mesh, positions, attribute, liveEnd: 0, runs: new Map() };
    group.add(mesh);
    tiles.set(tileIdx, tile);
    return tile;
  };

  const disposeTile = (tileIdx: number, tile: EdgeTile): void => {
    group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tiles.delete(tileIdx);
  };

  /** Grows a tile's buffer to hold at least `vertices`. Returns true if it had to. */
  const ensureTileCapacity = (tile: EdgeTile, vertices: number): boolean => {
    const capacity = tile.positions.length / POSITION_FLOATS_PER_VERTEX;
    if (vertices <= capacity) return false;
    let grown = Math.max(capacity, 1);
    while (grown < vertices) grown *= TILE_CAPACITY_GROWTH_FACTOR;
    const positions = new Float32Array(grown * POSITION_FLOATS_PER_VERTEX);
    positions.set(tile.positions.subarray(0, tile.liveEnd * POSITION_FLOATS_PER_VERTEX));
    tile.positions = positions;
    bindTile(tile);
    return true;
  };

  /** The run's own box, measured over the vertices being written into it. */
  const measureRun = (run: ChunkRun, source: Float32Array): void => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i + 2 < source.length; i += POSITION_FLOATS_PER_VERTEX) {
      const x = source[i]!;
      const y = source[i + 1]!;
      const z = source[i + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    run.minX = minX;
    run.minY = minY;
    run.minZ = minZ;
    run.maxX = maxX;
    run.maxY = maxY;
    run.maxZ = maxZ;
  };

  /**
   * Replaces one chunk's run inside its tile, keeping the tile a dense prefix.
   *
   * A run that changes length shifts every run after it by the delta — the
   * memmove the packed layout trades the free list for, bounded by one tile's
   * lips. An emptied run is removed outright, and a tile whose last run goes
   * with it leaves the scene: an empty LineSegments is still an object three
   * walks every frame, which is the cost this whole arena exists to remove.
   */
  const writeRun = (
    tileIdx: number,
    tile: EdgeTile,
    chunkIdx: number,
    source: Float32Array,
  ): void => {
    const count = source.length / POSITION_FLOATS_PER_VERTEX;
    let run = tile.runs.get(chunkIdx);
    if (run === undefined) {
      if (count === 0) return;
      run = {
        // Appended: the tile is packed, so the only free space is past the end.
        offset: tile.liveEnd,
        count: 0,
        // An empty box (min > max), which `updateTileBounds` skips. Filled by
        // `measureRun` below, in this same call.
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
      };
      tile.runs.set(chunkIdx, run);
    }

    const delta = count - run.count;
    // BEFORE the tail moves and before the run is written: both index the
    // buffer this may replace.
    const regrown = delta > 0 && ensureTileCapacity(tile, tile.liveEnd + delta);

    const tailStart = run.offset + run.count;
    const tailCount = tile.liveEnd - tailStart;
    if (delta !== 0 && tailCount > 0) {
      tile.positions.copyWithin(
        (tailStart + delta) * POSITION_FLOATS_PER_VERTEX,
        tailStart * POSITION_FLOATS_PER_VERTEX,
        tile.liveEnd * POSITION_FLOATS_PER_VERTEX,
      );
      for (const other of tile.runs.values()) {
        if (other !== run && other.offset >= tailStart) other.offset += delta;
      }
    }
    tile.positions.set(source, run.offset * POSITION_FLOATS_PER_VERTEX);
    tile.liveEnd += delta;
    run.count = count;
    measureRun(run, source);

    const dirtyStart = run.offset;
    if (count === 0) tile.runs.delete(chunkIdx);
    if (tile.liveEnd === 0) {
      disposeTile(tileIdx, tile);
      return;
    }

    // A regrow installed a fresh attribute, which three uploads whole the
    // first time it sees it (WebGLAttributes' `createBuffer`) — an update
    // range on top of that is a second upload of data already sent. Residual,
    // named rather than hidden: ranges added by a LATER write to the same tile
    // in the same frame survive that first full upload, because three only
    // clears them in `updateBuffer`, so the next write re-sends those bytes
    // once. They are bounded by one tile and the data is current either way.
    if (!regrown) {
      // three's ranges are in ARRAY ELEMENTS, not vertices. A moved tail
      // dirties everything from this run's start to the live end; a rewrite
      // that kept its length dirties only the run.
      const dirtyCount = delta === 0 ? count : tile.liveEnd - dirtyStart;
      tile.attribute.addUpdateRange(
        dirtyStart * POSITION_FLOATS_PER_VERTEX,
        dirtyCount * POSITION_FLOATS_PER_VERTEX,
      );
      tile.attribute.needsUpdate = true;
    }
    tile.mesh.geometry.setDrawRange(0, tile.liveEnd);
    updateTileBounds(tile);
  };

  /** Drops a chunk's contribution: its retained segments and its tile run. */
  const dropChunk = (idx: number): void => {
    segmentsByChunk.delete(idx);
    const tileIdx = tileIndexOfChunk(idx);
    const tile = tiles.get(tileIdx);
    if (tile === undefined || !tile.runs.has(idx)) return;
    writeRun(tileIdx, tile, idx, NO_LIP_POSITIONS);
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
    dropChunk(idx);
    if (!hasChunk(mirror, idx)) return;
    const cx = idx % chunksPerEdge;
    const cy = Math.floor(idx / chunksPerEdge);
    if (!neighboursKnown(cx, cy)) return;
    const chart = drawnGround.chartOf(cx, cy);
    // No chart: the chunk has not been drawn yet, and there is nothing honest
    // to draw lips over. A blocky chunk publishes no lips at all — see header.
    if (chart === null) return;
    const { positions, flat, bands } = chart.lips;
    if (positions.length < FLOATS_PER_SEGMENT) return;

    // SUBARRAY VIEWS, not copies: the hover query indexes them and never
    // writes, and the chart owns the buffer for exactly as long as this mesh
    // stands — both are replaced by the next build of this chunk.
    const perBand = new Map<number, Float32Array>();
    for (let i = 0; i + 2 < bands.length; i += 3) {
      const band = bands[i]!;
      const firstSegment = bands[i + 1]!;
      const segmentCount = bands[i + 2]!;
      perBand.set(
        band,
        flat.subarray(firstSegment * FLOATS_PER_FLAT_SEGMENT, (firstSegment + segmentCount) * FLOATS_PER_FLAT_SEGMENT),
      );
    }
    segmentsByChunk.set(idx, perBand);

    // COPIED INTO THE TILE, where the published array used to BE the
    // attribute. One `set` of a chunk's lips is the price of the chunk no
    // longer being a draw object; the array is still emitted in the layout
    // three wants, so nothing is re-packed element by element.
    const tileIdx = tileIndexOfChunk(idx);
    writeRun(tileIdx, tiles.get(tileIdx) ?? createTile(tileIdx), idx, positions);
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
    refreshChunk(chunkIdx) {
      rebuild(chunkIdx);
      // A rebuilt chunk's retained segments are new objects, so any highlight
      // standing on the old ones is stale. Cheaper and more honest to drop it
      // than to try to re-find the same lip in freshly-published geometry.
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
      // The SAME lift the job emitted the resting segments at, so the
      // highlight sits exactly on the lip it picks out rather than under it.
      const y = band * BAND_HEIGHT * HEIGHT_WORLD_SCALE + LIP_LIFT_WORLD_UNITS;
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
      grabbed.renderOrder = GRABBED_RENDER_ORDER;
      group.add(grabbed);
      return true;
    },
    clear() {
      clearGrabbed();
      segmentsByChunk.clear();
      for (const [tileIdx, tile] of [...tiles]) disposeTile(tileIdx, tile);
    },
    drawCallCount(): number {
      return tiles.size + (grabbed === null ? 0 : 1);
    },
    dispose() {
      this.clear();
      material.dispose();
      grabbedMaterial.dispose();
    },
  };
}
