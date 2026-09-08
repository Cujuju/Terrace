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
import { SUPER_MESH_SPAN_CHUNKS } from './chunkTiling.ts';
import { DENIED_COLOR } from './denialCue.ts';
import type { LayerEdgeStyle } from '../state/layerEdgePrefs.ts';

export type { LayerEdgeStyle };

const DEBUG_COLOR = 0x35d6e8;

const DEBUG_OPACITY = 0.9;

const CREASE_COLOR = 0x000000;

const CREASE_OPACITY = 0.33;

const FLOATS_PER_SEGMENT = 6;

const FLOATS_PER_FLAT_SEGMENT = 4;

const POSITION_FLOATS_PER_VERTEX = 3;

const TILE_CAPACITY_GROWTH_FACTOR = 2;

const NO_LIP_POSITIONS = new Float32Array(0);

const RESTING_RENDER_ORDER = 500;

const GRABBED_RENDER_ORDER = RESTING_RENDER_ORDER + 1;

interface ChunkRun {
  offset: number;
  count: number;
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
  liveEnd: number;
  runs: Map<number, ChunkRun>;
}

const GRABBED_COLOR = 0xfff2c4;

const GRABBED_OPACITY = 1;

const GRAB_RADIUS_WORLD_UNITS = 1.5 * CELL_WORLD_SIZE;

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
  setRefused(refused: boolean): void;
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
  const restingVisible = (): boolean => style !== 'normal';
  const material = new LineBasicMaterial({
    color: DEBUG_COLOR,
    transparent: true,
    opacity: DEBUG_OPACITY,
    depthTest: true,
    depthWrite: false,
  });

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
    attribute.setUsage(DynamicDrawUsage);
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
        offset: tile.liveEnd,
        count: 0,
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

    if (!regrown) {
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

  const dropChunk = (idx: number): void => {
    segmentsByChunk.delete(idx);
    const tileIdx = tileIndexOfChunk(idx);
    const tile = tiles.get(tileIdx);
    if (tile === undefined || !tile.runs.has(idx)) return;
    writeRun(tileIdx, tile, idx, NO_LIP_POSITIONS);
  };

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
    if (chart === null) return;
    const { positions, flat, bands } = chart.lips;
    if (positions.length < FLOATS_PER_SEGMENT) return;

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

    const tileIdx = tileIndexOfChunk(idx);
    writeRun(tileIdx, tiles.get(tileIdx) ?? createTile(tileIdx), idx, positions);
  };

  const grabbedMaterial = new LineBasicMaterial({
    color: GRABBED_COLOR,
    transparent: true,
    opacity: GRABBED_OPACITY,
    depthTest: true,
    depthWrite: false,
  });
  let grabbed: LineSegments | null = null;
  let grabbedRefused = false;

  const clearGrabbed = (): void => {
    if (grabbed === null) return;
    group.remove(grabbed);
    grabbed.geometry.dispose();
    grabbed = null;
  };

  const distanceSqToSegment = (
    px: number, pz: number,
    ax: number, az: number, bx: number, bz: number,
  ): number => {
    const vx = bx - ax;
    const vz = bz - az;
    const lengthSq = vx * vx + vz * vz;
    let t = lengthSq === 0 ? 0 : ((px - ax) * vx + (pz - az) * vz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (ax + t * vx);
    const dz = pz - (az + t * vz);
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
      clearGrabbed();
    },

    lipNear,

    segmentsOf(chunkIdx, band) {
      return segmentsByChunk.get(chunkIdx)?.get(band);
    },

    lightBand(cell, band, atX, atZ, litSpanWorldUnits) {
      clearGrabbed();
      if (cell === null || band === null) return false;

      if (!lipNear(cell, band, atX, atZ)) return false;

      const spanSq = litSpanWorldUnits * litSpanWorldUnits;
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
      if (positions.length < FLOATS_PER_SEGMENT) return true;

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      grabbed = new LineSegments(geometry, grabbedMaterial);
      grabbed.renderOrder = GRABBED_RENDER_ORDER;
      group.add(grabbed);
      return true;
    },
    setRefused(refused) {
      if (refused === grabbedRefused) return;
      grabbedRefused = refused;
      grabbedMaterial.color.setHex(refused ? DENIED_COLOR : GRABBED_COLOR);
    },
    setStyle(next) {
      if (next === style) return;
      style = next;
      const visible = restingVisible();
      for (const tile of tiles.values()) tile.mesh.visible = visible;
      if (next === 'crease') {
        material.color.setHex(CREASE_COLOR);
        material.opacity = CREASE_OPACITY;
      } else if (next === 'debug') {
        material.color.setHex(DEBUG_COLOR);
        material.opacity = DEBUG_OPACITY;
      }
    },
    clear() {
      clearGrabbed();
      segmentsByChunk.clear();
      for (const [tileIdx, tile] of [...tiles]) disposeTile(tileIdx, tile);
    },
    drawCallCount(): number {
      return (restingVisible() ? tiles.size : 0) + (grabbed === null ? 0 : 1);
    },
    dispose() {
      this.clear();
      material.dispose();
      grabbedMaterial.dispose();
    },
  };
}
