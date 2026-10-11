import {
  BufferAttribute,
  BufferGeometry,
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
import { hasChunk, sampleRenderHeight, type TerrainMirror } from '../terrain/mirror.ts';
import { smoothLipSegments } from '../terrain/contourSmoothing.ts';
import { SUPER_MESH_SPAN_CHUNKS } from './terrainMeshes.ts';
import { DENIED_COLOR } from './denialCue.ts';
import { hideRiserDecal, setRiserDecalTint, showRiserDecal } from './riserDecal.ts';

export type LayerEdgeStyle = 'normal' | 'crease' | 'debug';

const DEBUG_COLOR = 0x35d6e8;

const DEBUG_OPACITY = 0.9;

export interface CreaseLook {
  readonly color: number;
  readonly opacity: number;
}

export const DEFAULT_CREASE_LOOK: CreaseLook = { color: 0x000000, opacity: 0.33 };

export interface CellLook {
  readonly color: number;
  readonly opacity: number;
}

export const DEFAULT_CELL_LOOK: CellLook = { color: 0xffffff, opacity: 0.15 };

const FLOATS_PER_SEGMENT = 6;

const FLOATS_PER_FLAT_SEGMENT = 4;

const POSITION_FLOATS_PER_VERTEX = 3;

const TILE_CAPACITY_GROWTH_FACTOR = 2;

const VERTICES_PER_SEGMENT = 2;

/** Abandoned slots are packed away once they hold this share of a tile. */
const TILE_COMPACT_HOLE_SHARE = 1 / 2;

/** A run's slot: a power of two of segments, so a resize rarely outgrows it. */
function slotCapacityOf(vertices: number): number {
  const segments = Math.ceil(vertices / VERTICES_PER_SEGMENT);
  let slot = 1;
  while (slot < segments) slot *= 2;
  return slot * VERTICES_PER_SEGMENT;
}

const NO_LIP_POSITIONS = new Float32Array(0);

const RESTING_RENDER_ORDER = 500;

const GRABBED_RENDER_ORDER = RESTING_RENDER_ORDER + 1;

/** Vertices past `count` up to `capacity` are zero: zero-length segments that draw nothing. */
interface ChunkRun {
  offset: number;
  count: number;
  capacity: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface EdgeTile {
  mesh: LineSegments;
  positions: Float32Array;
  attribute: BufferAttribute;
  /** End of the last slot; everything past it is zero. */
  liveEnd: number;
  /** Capacity of slots no run holds any more. */
  holeVertices: number;
  runs: Map<number, ChunkRun>;
}

const GRABBED_COLOR = 0xfff2c4;

const GRABBED_OPACITY = 1;

const GRAB_RADIUS_WORLD_UNITS = 1.5 * CELL_WORLD_SIZE;

const RISER_OPACITY = 0.35;

export interface LayerEdgeOverlay {
  refreshChunk(chunkIdx: number): void;
  lipNear(cell: { x: number; y: number } | null, band: number | null, atX: number, atZ: number): boolean;
  segmentsOf(chunkIdx: number, band: number): Float32Array | undefined;
  lightBand(
    cell: { x: number; y: number } | null,
    band: number | null,
    atX: number,
    atZ: number,
    litSpanWorldUnits: number,
  ): boolean;
  setStyle(style: LayerEdgeStyle): void;
  setCreaseLook(look: CreaseLook): void;
  setRefused(refused: boolean): void;
  /** The lip line over the lit riser. The riser face itself always shows. */
  setLipHighlight(visible: boolean): void;
  setCellLook(look: CellLook): void;
  setCellLinesVisible(visible: boolean): void;
  setBandGridVisible(visible: boolean): void;
  setLipSmoothing(enabled: boolean): void;
  clear(): void;
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
  const segmentsByChunk = new Map<number, Map<number, Float32Array>>();
  let style: LayerEdgeStyle = 'debug';
  let creaseLook: CreaseLook = DEFAULT_CREASE_LOOK;
  let cellLook: CellLook = DEFAULT_CELL_LOOK;
  let cellLinesVisible = false;
  let bandGridVisible = false;
  let lipSmoothing = false;
  const restingVisible = (): boolean => style !== 'normal';
  const material = new LineBasicMaterial({
    color: DEBUG_COLOR,
    transparent: true,
    opacity: DEBUG_OPACITY,
    depthTest: true,
    depthWrite: false,
  });
  const cellMaterial = new LineBasicMaterial({
    color: DEFAULT_CELL_LOOK.color,
    transparent: true,
    opacity: DEFAULT_CELL_LOOK.opacity,
    depthTest: true,
    depthWrite: false,
  });
  const cellMeshes = new Map<number, LineSegments>();
  const bandMeshes = new Map<number, LineSegments>();
  const knownChunks = new Set<number>();

  const tileIndexOfChunk = (chunkIdx: number): number => {
    const cx = chunkIdx % chunksPerEdge;
    const cy = Math.floor(chunkIdx / chunksPerEdge);
    return Math.floor(cy / SUPER_MESH_SPAN_CHUNKS) * tilesPerEdge
      + Math.floor(cx / SUPER_MESH_SPAN_CHUNKS);
  };

  const updateTileBounds = (tile: EdgeTile): void => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const run of tile.runs.values()) {
      if (run.count === 0) continue;
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

  const bindTile = (tile: EdgeTile): void => {
    const attribute = new BufferAttribute(tile.positions, POSITION_FLOATS_PER_VERTEX);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, tile.liveEnd);
    const previous = tile.mesh.geometry;
    tile.mesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();
    tile.attribute = attribute;
    updateTileBounds(tile);
  };

  const createTile = (tileIdx: number): EdgeTile => {
    const positions = NO_LIP_POSITIONS;
    const geometry = new BufferGeometry();
    const attribute = new BufferAttribute(positions, POSITION_FLOATS_PER_VERTEX);
    geometry.setAttribute('position', attribute);
    const mesh = new LineSegments(geometry, material);
    mesh.visible = restingVisible();
    mesh.renderOrder = RESTING_RENDER_ORDER;
    const tile: EdgeTile = { mesh, positions, attribute, liveEnd: 0, holeVertices: 0, runs: new Map() };
    group.add(mesh);
    tiles.set(tileIdx, tile);
    return tile;
  };

  const disposeTile = (tileIdx: number, tile: EdgeTile): void => {
    group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tiles.delete(tileIdx);
  };

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

  /** Packs every slot to the front, shrunk to fit: one whole-tile upload, rarely. */
  const compactTile = (tile: EdgeTile): void => {
    const runs = [...tile.runs.values()].sort((a, b) => a.offset - b.offset);
    let packed = 0;
    for (const run of runs) {
      const capacity = slotCapacityOf(run.count);
      tile.positions.copyWithin(
        packed * POSITION_FLOATS_PER_VERTEX,
        run.offset * POSITION_FLOATS_PER_VERTEX,
        (run.offset + run.count) * POSITION_FLOATS_PER_VERTEX,
      );
      tile.positions.fill(
        0,
        (packed + run.count) * POSITION_FLOATS_PER_VERTEX,
        (packed + capacity) * POSITION_FLOATS_PER_VERTEX,
      );
      run.offset = packed;
      run.capacity = capacity;
      packed += capacity;
    }
    tile.positions.fill(0, packed * POSITION_FLOATS_PER_VERTEX, tile.liveEnd * POSITION_FLOATS_PER_VERTEX);
    tile.liveEnd = packed;
    tile.holeVertices = 0;
  };

  const sameRun = (tile: EdgeTile, run: ChunkRun, source: Float32Array): boolean => {
    const base = run.offset * POSITION_FLOATS_PER_VERTEX;
    for (let i = 0; i < source.length; i++) if (tile.positions[base + i] !== source[i]) return false;
    return true;
  };

  const writeRun = (
    tileIdx: number,
    tile: EdgeTile,
    chunkIdx: number,
    source: Float32Array,
  ): void => {
    const count = source.length / POSITION_FLOATS_PER_VERTEX;
    let run = tile.runs.get(chunkIdx);
    if (run !== undefined && count === run.count && sameRun(tile, run, source)) return;
    if (run === undefined) {
      if (count === 0) return;
      run = {
        offset: tile.liveEnd,
        count: 0,
        capacity: 0,
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
      };
      tile.runs.set(chunkIdx, run);
    }

    const floats = POSITION_FLOATS_PER_VERTEX;
    const dirty: [number, number][] = [];
    let regrown = false;
    if (count > run.capacity) {
      // Outgrown: the run moves to a new slot at the end; the old one becomes a hole.
      if (run.capacity > 0) {
        tile.positions.fill(0, run.offset * floats, (run.offset + run.count) * floats);
        dirty.push([run.offset, run.offset + run.count]);
        tile.holeVertices += run.capacity;
      }
      const capacity = slotCapacityOf(count);
      regrown = ensureTileCapacity(tile, tile.liveEnd + capacity);
      run.offset = tile.liveEnd;
      run.count = 0;
      run.capacity = capacity;
      tile.liveEnd += capacity;
    }
    tile.positions.set(source, run.offset * floats);
    if (run.count > count) tile.positions.fill(0, (run.offset + count) * floats, (run.offset + run.count) * floats);
    dirty.push([run.offset, run.offset + Math.max(count, run.count)]);
    run.count = count;
    measureRun(run, source);

    if (count === 0) {
      tile.runs.delete(chunkIdx);
      tile.holeVertices += run.capacity;
    }
    if (tile.runs.size === 0) {
      disposeTile(tileIdx, tile);
      return;
    }

    if (tile.holeVertices > tile.liveEnd * TILE_COMPACT_HOLE_SHARE) {
      compactTile(tile);
      tile.attribute.clearUpdateRanges();
      tile.attribute.needsUpdate = true;
    } else if (!regrown) {
      for (const [from, to] of dirty) {
        if (to > from) tile.attribute.addUpdateRange(from * floats, (to - from) * floats);
      }
      tile.attribute.needsUpdate = true;
    }
    tile.mesh.geometry.setDrawRange(0, tile.liveEnd);
    updateTileBounds(tile);
  };

  /** Forgets everything the chunk drew except its lip run, which `rebuild` rewrites in place. */
  const forgetChunk = (idx: number): void => {
    knownChunks.delete(idx);
    dropCellGrid(idx);
    dropBandGrid(idx);
    segmentsByChunk.delete(idx);
  };

  const NEIGHBOUR_OFFSETS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

  const dropGridLines = (meshes: Map<number, LineSegments>, idx: number): void => {
    const mesh = meshes.get(idx);
    if (mesh === undefined) return;
    group.remove(mesh);
    mesh.geometry.dispose();
    meshes.delete(idx);
  };

  const dropCellGrid = (idx: number): void => {
    dropGridLines(cellMeshes, idx);
  };

  const dropBandGrid = (idx: number): void => {
    dropGridLines(bandMeshes, idx);
  };

  const gridPositions = (idx: number, subdiv: number): Float32Array => {
    const cx = idx % chunksPerEdge;
    const cy = Math.floor(idx / chunksPerEdge);
    const ox = cx * CHUNK_SIZE;
    const oz = cy * CHUNK_SIZE;
    const size = worldSize;
    const n = CHUNK_SIZE;
    const m = n * subdiv;
    const hAt = (fx: number, fz: number): number => {
      const x0 = Math.max(0, Math.min(size - 2, Math.floor(fx)));
      const z0 = Math.max(0, Math.min(size - 2, Math.floor(fz)));
      const tx = Math.max(0, Math.min(1, fx - x0));
      const tz = Math.max(0, Math.min(1, fz - z0));
      const a = sampleRenderHeight(mirror, x0, z0);
      const b = sampleRenderHeight(mirror, x0 + 1, z0);
      const c = sampleRenderHeight(mirror, x0, z0 + 1);
      const d = sampleRenderHeight(mirror, x0 + 1, z0 + 1);
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    };
    const corners = new Float32Array((m + 1) * (m + 1));
    for (let j = 0; j <= m; j++) {
      for (let i = 0; i <= m; i++) {
        corners[j * (m + 1) + i] = hAt(ox + i / subdiv, oz + j / subdiv);
      }
    }
    const positions = new Float32Array(2 * m * (m + 1) * FLOATS_PER_SEGMENT);
    let w = 0;
    const xOf = (i: number): number => (ox + i / subdiv - 0.5) * CELL_WORLD_SIZE;
    const zOf = (j: number): number => (oz + j / subdiv - 0.5) * CELL_WORLD_SIZE;
    const yOf = (h: number): number => h * HEIGHT_WORLD_SCALE + LIP_LIFT_WORLD_UNITS;
    for (let j = 0; j <= m; j++) {
      for (let i = 0; i < m; i++) {
        positions[w++] = xOf(i);
        positions[w++] = yOf(corners[j * (m + 1) + i]!);
        positions[w++] = zOf(j);
        positions[w++] = xOf(i + 1);
        positions[w++] = yOf(corners[j * (m + 1) + i + 1]!);
        positions[w++] = zOf(j);
      }
    }
    for (let i = 0; i <= m; i++) {
      for (let j = 0; j < m; j++) {
        positions[w++] = xOf(i);
        positions[w++] = yOf(corners[j * (m + 1) + i]!);
        positions[w++] = zOf(j);
        positions[w++] = xOf(i);
        positions[w++] = yOf(corners[(j + 1) * (m + 1) + i]!);
        positions[w++] = zOf(j + 1);
      }
    }
    return positions;
  };

  const makeGridMesh = (positions: Float32Array): LineSegments => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, POSITION_FLOATS_PER_VERTEX));
    geometry.computeBoundingSphere();
    const mesh = new LineSegments(geometry, cellMaterial);
    mesh.renderOrder = RESTING_RENDER_ORDER;
    group.add(mesh);
    return mesh;
  };

  const buildCellGrid = (idx: number): void => {
    dropCellGrid(idx);
    if (!cellLinesVisible) return;
    cellMeshes.set(idx, makeGridMesh(gridPositions(idx, 1)));
  };

  const buildBandGrid = (idx: number): void => {
    dropBandGrid(idx);
    if (!bandGridVisible) return;
    bandMeshes.set(idx, makeGridMesh(gridPositions(idx, 4)));
  };

  const neighboursKnown = (cx: number, cy: number): boolean => {
    for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= chunksPerEdge || ny >= chunksPerEdge) continue;
      if (!hasChunk(mirror, ny * chunksPerEdge + nx)) return false;
    }
    return true;
  };

  // A chunk's lips gate on its neighbours being received, but a west or north arrival
  // never remeshes it; re-evaluate the gate for every neighbour on each draw.
  const rebuildNeighbours = (idx: number): void => {
    const cx = idx % chunksPerEdge;
    const cy = Math.floor(idx / chunksPerEdge);
    for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= chunksPerEdge || ny >= chunksPerEdge) continue;
      const neighbour = ny * chunksPerEdge + nx;
      if (!segmentsByChunk.has(neighbour)) rebuild(neighbour);
    }
  };

  const rebuild = (idx: number): void => {
    const lips = rebuildChunk(idx);
    const tileIdx = tileIndexOfChunk(idx);
    const tile = tiles.get(tileIdx);
    if (lips.length === 0) {
      if (tile !== undefined && tile.runs.has(idx)) writeRun(tileIdx, tile, idx, NO_LIP_POSITIONS);
      return;
    }
    writeRun(tileIdx, tile ?? createTile(tileIdx), idx, lips);
  };

  /** The chunk's grids and segments, rebuilt; returns its lip line positions. */
  const rebuildChunk = (idx: number): Float32Array => {
    forgetChunk(idx);
    if (!hasChunk(mirror, idx)) return NO_LIP_POSITIONS;
    const cx = idx % chunksPerEdge;
    const cy = Math.floor(idx / chunksPerEdge);
    if (!neighboursKnown(cx, cy)) return NO_LIP_POSITIONS;
    knownChunks.add(idx);
    buildCellGrid(idx);
    buildBandGrid(idx);
    const chart = drawnGround.chartOf(cx, cy);
    if (chart === null) return NO_LIP_POSITIONS;
    const { positions, flat, bands } = chart.lips;
    if (positions.length < FLOATS_PER_SEGMENT) return NO_LIP_POSITIONS;

    const smoothedPositions = lipSmoothing
      ? smoothLipSegments(positions, 6, bands)
      : null;
    // Picking follows filled geometry, regardless of decorative line smoothing.
    const lipPositions = smoothedPositions?.coords ?? positions;
    const lipFlat = flat;
    const lipBands = bands;

    const perBand = new Map<number, Float32Array>();
    for (let i = 0; i + 2 < lipBands.length; i += 3) {
      const band = lipBands[i]!;
      const firstSegment = lipBands[i + 1]!;
      const segmentCount = lipBands[i + 2]!;
      perBand.set(
        band,
        lipFlat.subarray(firstSegment * FLOATS_PER_FLAT_SEGMENT, (firstSegment + segmentCount) * FLOATS_PER_FLAT_SEGMENT),
      );
    }
    segmentsByChunk.set(idx, perBand);
    return lipPositions;
  };

  const grabbedMaterial = new LineBasicMaterial({
    color: GRABBED_COLOR,
    transparent: true,
    opacity: GRABBED_OPACITY,
    depthTest: true,
    depthWrite: false,
  });
  // One persistent mesh; a new one per hover costs a render object and GPU buffers.
  // Starts one segment long so warmup never uploads a zero-sized buffer.
  let grabbedPositions = new Float32Array(FLOATS_PER_SEGMENT);
  let grabbedAttribute = new BufferAttribute(grabbedPositions, POSITION_FLOATS_PER_VERTEX);
  const grabbedBounds = new Sphere();
  const grabbed = new LineSegments(new BufferGeometry(), grabbedMaterial);
  grabbed.geometry.setAttribute('position', grabbedAttribute);
  grabbed.geometry.boundingSphere = grabbedBounds;
  grabbed.renderOrder = GRABBED_RENDER_ORDER;
  grabbed.visible = false;
  group.add(grabbed);
  let grabbedRefused = false;

  setRiserDecalTint(GRABBED_COLOR, RISER_OPACITY);
  let lipHighlight = true;

  // The aim the lit lip was last painted for: lightBand repaints only when the
  // aim, its band, the span or the terrain beneath them changes.
  let litValid = false;
  let litCellX = 0;
  let litCellY = 0;
  let litBand = 0;
  let litAtX = 0;
  let litAtZ = 0;
  let litSpan = 0;

  const clearGrabbed = (): void => {
    grabbed.visible = false;
    hideRiserDecal();
    litValid = false;
  };

  const ensureGrabbedCapacity = (floats: number): void => {
    if (floats <= grabbedPositions.length) return;
    let grown = Math.max(grabbedPositions.length, FLOATS_PER_SEGMENT);
    while (grown < floats) grown *= TILE_CAPACITY_GROWTH_FACTOR;
    const positions = new Float32Array(grown);
    positions.set(grabbedPositions);
    grabbedPositions = positions;
    grabbedAttribute = new BufferAttribute(positions, POSITION_FLOATS_PER_VERTEX);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', grabbedAttribute);
    geometry.boundingSphere = grabbedBounds;
    grabbed.geometry.dispose();
    grabbed.geometry = geometry;
  };

  /** The segment point nearest the last distanceSqToSegment query. */
  const nearest = { x: 0, z: 0 };

  const distanceSqToSegment = (
    px: number, pz: number,
    ax: number, az: number, bx: number, bz: number,
  ): number => {
    const vx = bx - ax;
    const vz = bz - az;
    const lengthSq = vx * vx + vz * vz;
    let t = lengthSq === 0 ? 0 : ((px - ax) * vx + (pz - az) * vz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    nearest.x = ax + t * vx;
    nearest.z = az + t * vz;
    const dx = px - nearest.x;
    const dz = pz - nearest.z;
    return dx * dx + dz * dz;
  };

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

  const lipNear = (
    cell: { x: number; y: number } | null,
    band: number | null,
    atX: number,
    atZ: number,
  ): boolean => {
    if (cell === null || band === null) return false;
    const grabRadiusSq = GRAB_RADIUS_WORLD_UNITS * GRAB_RADIUS_WORLD_UNITS;
    for (const idx of nearbyChunks(cell.x, cell.y)) {
      const flat = segmentsByChunk.get(idx)?.get(band);
      if (flat === undefined) continue;
      for (let i = 0; i + 3 < flat.length; i += 4) {
        if (distanceSqToSegment(atX, atZ, flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!) < grabRadiusSq) {
          return true;
        }
      }
    }
    return false;
  };

  return {
    refreshChunk(chunkIdx) {
      rebuild(chunkIdx);
      rebuildNeighbours(chunkIdx);
      clearGrabbed();
    },

    lipNear,

    segmentsOf(chunkIdx, band) {
      // Canonical published contours are also available at the reveal edge,
      // where decorative lines wait for neighbouring chunks.
      const chart = drawnGround.chartOf(chunkIdx % chunksPerEdge, Math.floor(chunkIdx / chunksPerEdge));
      if (!chart) return undefined;
      const { bands, flat } = chart.lips;
      for (let at = 0; at + 2 < bands.length; at += 3) {
        if (bands[at] !== band) continue;
        return flat.subarray(bands[at + 1]! * FLOATS_PER_FLAT_SEGMENT,
          (bands[at + 1]! + bands[at + 2]!) * FLOATS_PER_FLAT_SEGMENT);
      }
      return undefined;
    },

    lightBand(cell, band, atX, atZ, litSpanWorldUnits) {
      // Same aim as the painted state: the buffers already hold this lip.
      if (
        litValid
        && cell !== null
        && band !== null
        && cell.x === litCellX
        && cell.y === litCellY
        && band === litBand
        && atX === litAtX
        && atZ === litAtZ
        && litSpanWorldUnits === litSpan
      ) {
        return true;
      }
      clearGrabbed();
      if (cell === null || band === null) return false;

      const aimCellX = cell.x;
      const aimCellY = cell.y;
      const aimBand = band;
      const remember = (): void => {
        litValid = true;
        litCellX = aimCellX;
        litCellY = aimCellY;
        litBand = aimBand;
        litAtX = atX;
        litAtZ = atZ;
        litSpan = litSpanWorldUnits;
      };

      if (!lipNear(cell, band, atX, atZ)) {
        remember();
        return false;
      }

      const spanSq = litSpanWorldUnits * litSpanWorldUnits;
      const capY = band * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
      const y = capY + LIP_LIFT_WORLD_UNITS;
      // The riser is the wall under that cap: one band down, the face the aim names.
      const footY = (band - 1) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
      let written = 0;
      let anchorX = atX;
      let anchorZ = atZ;
      let anchorDistanceSq = Infinity;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (const idx of nearbyChunks(cell.x, cell.y)) {
        const flat = segmentsByChunk.get(idx)?.get(band);
        if (flat === undefined) continue;
        for (let i = 0; i + 3 < flat.length; i += 4) {
          const ax = flat[i]!;
          const az = flat[i + 1]!;
          const bx = flat[i + 2]!;
          const bz = flat[i + 3]!;
          const distanceSq = distanceSqToSegment(atX, atZ, ax, az, bx, bz);
          if (distanceSq > spanSq) continue;
          if (distanceSq < anchorDistanceSq) {
            anchorDistanceSq = distanceSq;
            anchorX = nearest.x;
            anchorZ = nearest.z;
          }
          ensureGrabbedCapacity(written + FLOATS_PER_SEGMENT);
          const ay = y;
          const by = y;
          grabbedPositions[written++] = ax;
          grabbedPositions[written++] = ay;
          grabbedPositions[written++] = az;
          grabbedPositions[written++] = bx;
          grabbedPositions[written++] = by;
          grabbedPositions[written++] = bz;
          minX = Math.min(minX, ax, bx);
          minZ = Math.min(minZ, az, bz);
          maxX = Math.max(maxX, ax, bx);
          maxZ = Math.max(maxZ, az, bz);
        }
      }
      if (written < FLOATS_PER_SEGMENT) {
        remember();
        return true;
      }

      // The wall under the lit lip: centred where the lip passes nearest the aim,
      // reaching every lit segment end, so wall and lip line light the same run.
      let reachSq = 0;
      for (let i = 0; i < written; i += POSITION_FLOATS_PER_VERTEX) {
        const dx = grabbedPositions[i]! - anchorX;
        const dz = grabbedPositions[i + 2]! - anchorZ;
        reachSq = Math.max(reachSq, dx * dx + dz * dz);
      }
      showRiserDecal({ aimX: anchorX, aimZ: anchorZ, reach: Math.sqrt(reachSq), footY, capY });

      grabbedAttribute.clearUpdateRanges();
      grabbedAttribute.addUpdateRange(0, written);
      grabbedAttribute.needsUpdate = true;
      grabbed.geometry.setDrawRange(0, written / POSITION_FLOATS_PER_VERTEX);
      grabbed.visible = lipHighlight;
      const centreX = (minX + maxX) / 2;
      const centreZ = (minZ + maxZ) / 2;
      grabbedBounds.center.set(centreX, y, centreZ);
      grabbedBounds.radius = Math.hypot(maxX - centreX, maxZ - centreZ);
      remember();
      return true;
    },
    setRefused(refused) {
      if (refused === grabbedRefused) return;
      grabbedRefused = refused;
      grabbedMaterial.color.setHex(refused ? DENIED_COLOR : GRABBED_COLOR);
      setRiserDecalTint(refused ? DENIED_COLOR : GRABBED_COLOR, RISER_OPACITY);
    },
    setLipHighlight(visible) {
      lipHighlight = visible;
      litValid = false;
      if (!visible) grabbed.visible = false;
    },
    setCellLook(look) {
      cellLook = look;
      cellMaterial.color.setHex(look.color);
      cellMaterial.opacity = look.opacity;
    },
    setCellLinesVisible(visible) {
      if (visible === cellLinesVisible) return;
      cellLinesVisible = visible;
      if (!visible) {
        for (const idx of [...cellMeshes.keys()]) dropCellGrid(idx);
        return;
      }
      for (const idx of [...knownChunks]) rebuild(idx);
    },
    setBandGridVisible(visible) {
      if (visible === bandGridVisible) return;
      bandGridVisible = visible;
      if (!visible) {
        for (const idx of [...bandMeshes.keys()]) dropBandGrid(idx);
        return;
      }
      for (const idx of [...knownChunks]) rebuild(idx);
    },
    setLipSmoothing(enabled) {
      if (enabled === lipSmoothing) return;
      lipSmoothing = enabled;
      for (const idx of [...knownChunks]) rebuild(idx);
    },
    setStyle(next) {
      if (next === style) return;
      style = next;
      const visible = restingVisible();
      for (const tile of tiles.values()) tile.mesh.visible = visible;
      if (next === 'crease') {
        material.color.setHex(creaseLook.color);
        material.opacity = creaseLook.opacity;
      } else if (next === 'debug') {
        material.color.setHex(DEBUG_COLOR);
        material.opacity = DEBUG_OPACITY;
      }
    },
    setCreaseLook(look) {
      creaseLook = look;
      if (style !== 'crease') return;
      material.color.setHex(look.color);
      material.opacity = look.opacity;
    },
    clear() {
      clearGrabbed();
      segmentsByChunk.clear();
      knownChunks.clear();
      for (const idx of [...cellMeshes.keys()]) dropCellGrid(idx);
      for (const idx of [...bandMeshes.keys()]) dropBandGrid(idx);
      for (const [tileIdx, tile] of [...tiles]) disposeTile(tileIdx, tile);
    },
    drawCallCount(): number {
      return (restingVisible() ? tiles.size : 0) + (grabbed.visible ? 1 : 0) + cellMeshes.size + bandMeshes.size;
    },
    dispose() {
      this.clear();
      for (const idx of [...cellMeshes.keys()]) dropCellGrid(idx);
      group.remove(grabbed);
      grabbed.geometry.dispose();
      material.dispose();
      cellMaterial.dispose();
      grabbedMaterial.dispose();
    },
  };
}
