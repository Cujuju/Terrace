import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
  type Object3D,
} from 'three';
import {
  cellCentreCoord,
  cellX,
  cellY,
  chunkIndexOfCell,
  chunksPerEdge,
  CHUNK_SIZE,
  drawnGroundHeight,
  SEA_LEVEL,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE, WATER_SURFACE_LIFT } from '../config.ts';
import { type TerrainMirror } from '../terrain/mirror.ts';
import { WATER_COLOR } from './water.ts';
import { installWaterBandClock, makeBanded } from './water/waterBands.ts';
import {
  RIVER_SURFACE_LIFT_WORLD_UNITS,
  appendDrawnWaterTile,
  waterBandWorldY,
  type WaterRegion,
} from './water/drawnWaterTiles.ts';
import {
  directRiverNetworkSource,
  type RiverNetworkSource,
} from './water/riverNetworkSource.ts';
import { EMPTY_RIVER_SURFACE, type RiverSurface } from './water/riverSurface.ts';
import { watchReducedMotion } from '../plugins/kit/reducedMotion.ts';

const RIVER_RECOMPUTE_INTERVAL_MS = 500;

const DRAWN_BLEND_REACH_CELLS = 1;

const SEA_SURFACE_WORLD_Y = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;

const WATER_DEPTH_BIAS_FACTOR = -1;
const WATER_DEPTH_BIAS_UNITS = -1;

const WATER_OPACITY = 0.8;

const RIVER_ROUGHNESS = 0.85;
const RIVER_METALNESS = 0;

function plotRadiusCells(mirror: TerrainMirror, x: number, y: number): number {
  const drawnAt = (cx: number, cy: number): number =>
    drawnGroundHeight(mirror.renderMap, cellCentreCoord(cx), cellCentreCoord(cy));
  const height = drawnAt(x, y);
  for (let reach = 1; reach <= SPRING_PLOT_PROBE_CELLS; reach++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== reach) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= mirror.map.size || ny >= mirror.map.size) {
          return reach - 0.5;
        }
        if (drawnAt(nx, ny) !== height) return reach - 0.5;
      }
    }
  }
  return SPRING_PLOT_PROBE_CELLS;
}

function geometryFromTriangles(positions: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  const vertexCount = positions.length / 3;
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  const normals = new Float32Array(positions.length);
  for (let v = 0; v < vertexCount; v++) normals[v * 3 + 1] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  return geometry;
}

const MIST_PARTICLES_PER_WATERFALL = 8;
const MIST_SPREAD_CELLS = 0.4;
const MIST_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.6;
const MIST_COLOR = 0xf4fbff;
const MIST_OPACITY = 0.55;
const MIST_SPRITE_SIZE = CELL_WORLD_SIZE * 0.5;

const MIST_BOB_PERIOD_SECONDS = 6;
const MIST_BOB_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.15;

const TWO_PI = Math.PI * 2;

const SPRING_RING_COUNT = 3;

const SPRING_RING_SEGMENTS = 12;

const SPRING_RING_MIN_RADIUS_CELLS = 0.18;

const SPRING_RING_MAX_RADIUS_CELLS = 0.45;

const SPRING_PLOT_PROBE_CELLS = 3;

const SPRING_RING_PLOT_FILL_FRACTION = 0.6;

const SPRING_RING_MAX_WIDTH_CELLS = 0.1;

const SPRING_RIPPLE_PERIOD_SECONDS = 4.5;

const SPRING_FOAM_COLOR = 0xf4fbff;

const SPRING_RING_OPACITY = 0.5;

const SPRING_DOME_RADIUS_CELLS = 0.16;

const SPRING_DOME_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.12;

const SPRING_DOME_SEGMENTS = 8;

const SPRING_DOME_MID_PROFILE = Math.SQRT1_2;

const SPRING_DOME_OPACITY = 0.85;

const SPRING_DOME_SWELL_FRACTION = 0.15;
const SPRING_DOME_SWELL_PERIOD_SECONDS = 6;

const SPRING_EFFECT_LIFT_WORLD_UNITS = RIVER_SURFACE_LIFT_WORLD_UNITS * 2;

interface SpringState {
  readonly ringMesh: Mesh;
  readonly ringGeometry: BufferGeometry;
  readonly ringCentreX: Float32Array;
  readonly ringCentreZ: Float32Array;
  readonly ringDirX: Float32Array;
  readonly ringDirZ: Float32Array;
  readonly ringEdge: Float32Array;
  readonly ringCycleOffset: Float32Array;
  readonly ringPlotScale: Float32Array;

  readonly domeMesh: Mesh;
  readonly domeGeometry: BufferGeometry;
  readonly domeRestOffsetY: Float32Array;
  readonly domeSurfaceY: Float32Array;
  readonly domePhase: Float32Array;
}

export interface RiverRig {
  refresh(mirror: TerrainMirror, dirty: ReadonlySet<number>): void;
  forceRefresh(mirror: TerrainMirror): void;
  dispose(): void;
}

export interface RiverRigOptions {
  readonly networkSource?: RiverNetworkSource;
  readonly now?: () => number;
}

export const WATER_TILE_FRAME_BUDGET_MS = 1.0;

export const RIVER_RIG_DRAW_OBJECTS = 3;

export function createRiverRig(
  parent: Object3D,
  onFrame: (handler: (dt: number) => void) => () => void,
  options?: RiverRigOptions,
): RiverRig {
  const networkSource = options?.networkSource ?? directRiverNetworkSource;
  const now = options?.now ?? ((): number => performance.now());
  const waterMaterial = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: WATER_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: WATER_DEPTH_BIAS_FACTOR,
    polygonOffsetUnits: WATER_DEPTH_BIAS_UNITS,
  });

  makeBanded(waterMaterial);
  installWaterBandClock(onFrame);

  const waterMesh = new Mesh(new BufferGeometry(), waterMaterial);
  parent.add(waterMesh);

  interface RegionRun {
    offset: number;
    count: number;
  }

  const INITIAL_WATER_VERTEX_CAPACITY = 3072;

  let waterPositions = new Float32Array(INITIAL_WATER_VERTEX_CAPACITY * 3);
  let waterNormals = new Float32Array(INITIAL_WATER_VERTEX_CAPACITY * 3);
  let waterPositionAttribute = new BufferAttribute(waterPositions, 3);
  let waterNormalAttribute = new BufferAttribute(waterNormals, 3);
  let liveWaterVertices = 0;
  const waterRunOrder: number[] = [];
  const waterRuns = new Map<number, RegionRun>();

  const runKeyOf = (band: number, tile: number, tileCount: number): number =>
    band * tileCount + tile;

  const fillWaterNormals = (from: number, to: number): void => {
    for (let v = from; v < to; v++) waterNormals[v * 3 + 1] = 1;
  };
  fillWaterNormals(0, INITIAL_WATER_VERTEX_CAPACITY);

  const bindWaterGeometry = (): void => {
    waterPositionAttribute = new BufferAttribute(waterPositions, 3);
    waterNormalAttribute = new BufferAttribute(waterNormals, 3);
    waterPositionAttribute.setUsage(DynamicDrawUsage);
    waterNormalAttribute.setUsage(DynamicDrawUsage);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', waterPositionAttribute);
    geometry.setAttribute('normal', waterNormalAttribute);
    geometry.setDrawRange(0, liveWaterVertices);
    const previous = waterMesh.geometry;
    waterMesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();
  };
  bindWaterGeometry();

  const ensureWaterCapacity = (vertices: number): void => {
    const capacity = waterPositions.length / 3;
    if (vertices <= capacity) return;
    let grown = Math.max(capacity, 1);
    while (grown < vertices) grown *= 2;
    const positions = new Float32Array(grown * 3);
    positions.set(waterPositions.subarray(0, liveWaterVertices * 3));
    waterPositions = positions;
    waterNormals = new Float32Array(grown * 3);
    fillWaterNormals(0, grown);
    bindWaterGeometry();
  };

  const spliceRun = (key: number, source: readonly number[], count: number): void => {
    let run = waterRuns.get(key);
    if (run === undefined) {
      if (count === 0) return;
      let at = waterRunOrder.length;
      for (let i = 0; i < waterRunOrder.length; i++) {
        if (waterRunOrder[i]! > key) {
          at = i;
          break;
        }
      }
      const previous = at === 0 ? null : waterRuns.get(waterRunOrder[at - 1]!)!;
      run = { offset: previous === null ? 0 : previous.offset + previous.count, count: 0 };
      waterRunOrder.splice(at, 0, key);
      waterRuns.set(key, run);
    }

    const delta = count - run.count;
    if (delta > 0) ensureWaterCapacity(liveWaterVertices + delta);

    const tailStart = run.offset + run.count;
    const tailLength = liveWaterVertices - tailStart;
    if (delta !== 0 && tailLength > 0) {
      waterPositions.copyWithin(
        (tailStart + delta) * 3,
        tailStart * 3,
        (tailStart + tailLength) * 3,
      );
    }
    if (delta !== 0) {
      const from = waterRunOrder.indexOf(key) + 1;
      for (let i = from; i < waterRunOrder.length; i++) {
        waterRuns.get(waterRunOrder[i]!)!.offset += delta;
      }
      liveWaterVertices += delta;
      run.count = count;
    }

    const base = run.offset * 3;
    for (let i = 0; i < count * 3; i++) waterPositions[base + i] = source[i]!;

    if (count === 0) {
      waterRuns.delete(key);
      waterRunOrder.splice(waterRunOrder.indexOf(key), 1);
    }
  };

  const recomputeWaterBounds = (): void => {
    const geometry = waterMesh.geometry;
    if (liveWaterVertices === 0) {
      geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 0);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let v = 0; v < liveWaterVertices; v++) {
      const x = waterPositions[v * 3]!;
      const y = waterPositions[v * 3 + 1]!;
      const z = waterPositions[v * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centreZ = (minZ + maxZ) / 2;
    let maxSquared = 0;
    for (let v = 0; v < liveWaterVertices; v++) {
      const dx = waterPositions[v * 3]! - centreX;
      const dy = waterPositions[v * 3 + 1]! - centreY;
      const dz = waterPositions[v * 3 + 2]! - centreZ;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared > maxSquared) maxSquared = squared;
    }
    geometry.boundingSphere = new Sphere(
      new Vector3(centreX, centreY, centreZ),
      Math.sqrt(maxSquared),
    );
  };

  interface WetCells {
    band: Int16Array;
    stamp: Int32Array;
    list: Int32Array;
    generation: number;
  }

  const makeWetCells = (cellCount: number): WetCells => ({
    band: new Int16Array(cellCount),
    stamp: new Int32Array(cellCount),
    list: new Int32Array(0),
    generation: 0,
  });

  let wetCells = makeWetCells(0);
  let previousWetCells = makeWetCells(0);
  let wetGeneration = 0;

  const beginWetCells = (cellCount: number): void => {
    if (wetCells.band.length !== cellCount) {
      wetCells = makeWetCells(cellCount);
      previousWetCells = makeWetCells(cellCount);
      wetGeneration = 0;
    }
    const rotated = previousWetCells;
    previousWetCells = wetCells;
    wetCells = rotated;
    wetGeneration++;
    wetCells.generation = wetGeneration;
  };

  const regionTriangles: number[] = [];

  const EMPTY_TRIANGLES: readonly number[] = [];

  let emittedRunKeys = new Set<number>();

  interface PendingTile {
    key: number;
    region: WaterRegion;
    tile: number;
    surfaceY: number;
  }

  interface DrainJob {
    mirror: TerrainMirror;
    sources: RiverSurface['sources'];
    waterBandAt: (cellX: number, cellZ: number) => number | null;
  }

  const pendingTiles: PendingTile[] = [];
  let pendingCursor = 0;
  let drainJob: DrainJob | null = null;

  const clearPendingTiles = (): void => {
    pendingTiles.length = 0;
    pendingCursor = 0;
    drainJob = null;
  };

  const springRingMaterial = new MeshStandardMaterial({
    color: SPRING_FOAM_COLOR,
    transparent: true,
    opacity: SPRING_RING_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    side: DoubleSide,
  });
  const springDomeMaterial = new MeshStandardMaterial({
    color: SPRING_FOAM_COLOR,
    transparent: true,
    opacity: SPRING_DOME_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    flatShading: true,
  });
  let spring: SpringState | null = null;

  let lastRebuildMs = Number.NEGATIVE_INFINITY;

  const rebuildSprings = (
    mirror: TerrainMirror,
    sourceCells: Int32Array,
    waterSurfaceYAt: (x: number, y: number) => number | null,
  ): void => {
    if (spring !== null) {
      parent.remove(spring.ringMesh);
      parent.remove(spring.domeMesh);
      spring.ringGeometry.dispose();
      spring.domeGeometry.dispose();
      spring = null;
    }

    const siteCells = new Map<number, { readonly x: number; readonly y: number }>();
    for (const cell of sourceCells) {
      siteCells.set(cell, {
        x: cellX(mirror.map.size, cell),
        y: cellY(mirror.map.size, cell),
      });
    }
    const springs = [...siteCells.values()];
    if (springs.length === 0) return;

    const ringVertsPerRing = SPRING_RING_SEGMENTS * 2;
    const ringVertsPerSpring = SPRING_RING_COUNT * ringVertsPerRing;
    const ringVertexCount = springs.length * ringVertsPerSpring;
    const ringPositions = new Float32Array(ringVertexCount * 3);
    const ringNormals = new Float32Array(ringVertexCount * 3);
    const ringCentreX = new Float32Array(ringVertexCount);
    const ringCentreZ = new Float32Array(ringVertexCount);
    const ringDirX = new Float32Array(ringVertexCount);
    const ringDirZ = new Float32Array(ringVertexCount);
    const ringEdge = new Float32Array(ringVertexCount);
    const ringCycleOffset = new Float32Array(ringVertexCount);
    const ringPlotScale = new Float32Array(ringVertexCount);
    const ringIndices = new Uint32Array(
      springs.length * SPRING_RING_COUNT * SPRING_RING_SEGMENTS * 2 * 3,
    );

    const domeVertsPerDome = SPRING_DOME_SEGMENTS * 2 + 1;
    const domeVertexCount = springs.length * domeVertsPerDome;
    const domePositions = new Float32Array(domeVertexCount * 3);
    const domeRestOffsetY = new Float32Array(domeVertexCount);
    const domeSurfaceY = new Float32Array(domeVertexCount);
    const domePhase = new Float32Array(domeVertexCount);
    const domeIndices = new Uint32Array(springs.length * SPRING_DOME_SEGMENTS * 3 * 3);

    let ringIndexWrite = 0;
    let domeIndexWrite = 0;
    for (let w = 0; w < springs.length; w++) {
      const site = springs[w]!;
      const centreX = site.x * CELL_WORLD_SIZE;
      const centreZ = site.y * CELL_WORLD_SIZE;
      const surfaceY =
        Math.max(waterSurfaceYAt(site.x, site.y) ?? SEA_SURFACE_WORLD_Y, SEA_SURFACE_WORLD_Y) +
        SPRING_EFFECT_LIFT_WORLD_UNITS;
      const springStagger = w / springs.length;
      const fittedRadiusCells = Math.min(
        SPRING_RING_MAX_RADIUS_CELLS,
        plotRadiusCells(mirror, site.x, site.y) * SPRING_RING_PLOT_FILL_FRACTION,
      );
      const plotScale = fittedRadiusCells / SPRING_RING_MAX_RADIUS_CELLS;

      for (let r = 0; r < SPRING_RING_COUNT; r++) {
        const ringBase = w * ringVertsPerSpring + r * ringVertsPerRing;
        const cycleOffset = (r / SPRING_RING_COUNT + springStagger) % 1;
        for (let s = 0; s < SPRING_RING_SEGMENTS; s++) {
          const angle = (s / SPRING_RING_SEGMENTS) * TWO_PI;
          const dirX = Math.cos(angle);
          const dirZ = Math.sin(angle);
          for (let edge = 0; edge < 2; edge++) {
            const v = ringBase + s + edge * SPRING_RING_SEGMENTS;
            ringCentreX[v] = centreX;
            ringCentreZ[v] = centreZ;
            ringDirX[v] = dirX;
            ringDirZ[v] = dirZ;
            ringEdge[v] = edge;
            ringCycleOffset[v] = cycleOffset;
            ringPlotScale[v] = plotScale;
            ringPositions[v * 3 + 1] = surfaceY;
            ringNormals[v * 3 + 1] = 1;
          }
          const sn = (s + 1) % SPRING_RING_SEGMENTS;
          const innerS = ringBase + s;
          const innerSn = ringBase + sn;
          const outerS = ringBase + SPRING_RING_SEGMENTS + s;
          const outerSn = ringBase + SPRING_RING_SEGMENTS + sn;
          ringIndices[ringIndexWrite++] = innerS;
          ringIndices[ringIndexWrite++] = outerS;
          ringIndices[ringIndexWrite++] = innerSn;
          ringIndices[ringIndexWrite++] = innerSn;
          ringIndices[ringIndexWrite++] = outerS;
          ringIndices[ringIndexWrite++] = outerSn;
        }
      }

      const domeBase = w * domeVertsPerDome;
      const apex = domeBase + SPRING_DOME_SEGMENTS * 2;
      const domeSwellPhase = springStagger * TWO_PI;
      for (let s = 0; s < SPRING_DOME_SEGMENTS; s++) {
        const angle = (s / SPRING_DOME_SEGMENTS) * TWO_PI;
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        const baseV = domeBase + s;
        const midV = domeBase + SPRING_DOME_SEGMENTS + s;
        domePositions[baseV * 3] =
          centreX + dirX * SPRING_DOME_RADIUS_CELLS * plotScale * CELL_WORLD_SIZE;
        domePositions[baseV * 3 + 2] =
          centreZ + dirZ * SPRING_DOME_RADIUS_CELLS * plotScale * CELL_WORLD_SIZE;
        domeRestOffsetY[baseV] = 0;
        domePositions[midV * 3] =
          centreX +
          dirX * SPRING_DOME_RADIUS_CELLS * SPRING_DOME_MID_PROFILE * plotScale * CELL_WORLD_SIZE;
        domePositions[midV * 3 + 2] =
          centreZ +
          dirZ * SPRING_DOME_RADIUS_CELLS * SPRING_DOME_MID_PROFILE * plotScale * CELL_WORLD_SIZE;
        domeRestOffsetY[midV] = SPRING_DOME_HEIGHT_WORLD_UNITS * SPRING_DOME_MID_PROFILE;

        const sn = (s + 1) % SPRING_DOME_SEGMENTS;
        const baseVn = domeBase + sn;
        const midVn = domeBase + SPRING_DOME_SEGMENTS + sn;
        domeIndices[domeIndexWrite++] = baseV;
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = baseVn;
        domeIndices[domeIndexWrite++] = baseVn;
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = midVn;
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = apex;
        domeIndices[domeIndexWrite++] = midVn;
      }
      domePositions[apex * 3] = centreX;
      domePositions[apex * 3 + 2] = centreZ;
      domeRestOffsetY[apex] = SPRING_DOME_HEIGHT_WORLD_UNITS;
      for (let v = domeBase; v < domeBase + domeVertsPerDome; v++) {
        domeSurfaceY[v] = surfaceY;
        domePhase[v] = domeSwellPhase;
        domePositions[v * 3 + 1] = surfaceY + domeRestOffsetY[v]!;
      }
    }

    const ringGeometry = new BufferGeometry();
    const ringPositionAttribute = new BufferAttribute(ringPositions, 3);
    ringPositionAttribute.setUsage(DynamicDrawUsage);
    ringGeometry.setAttribute('position', ringPositionAttribute);
    ringGeometry.setAttribute('normal', new BufferAttribute(ringNormals, 3));
    ringGeometry.setIndex(new BufferAttribute(ringIndices, 1));
    const ringMesh = new Mesh(ringGeometry, springRingMaterial);
    ringMesh.frustumCulled = false;
    parent.add(ringMesh);

    const domeGeometry = new BufferGeometry();
    const domePositionAttribute = new BufferAttribute(domePositions, 3);
    domePositionAttribute.setUsage(DynamicDrawUsage);
    domeGeometry.setAttribute('position', domePositionAttribute);
    domeGeometry.setIndex(new BufferAttribute(domeIndices, 1));
    domeGeometry.computeVertexNormals();
    const domeMesh = new Mesh(domeGeometry, springDomeMaterial);
    domeMesh.frustumCulled = false;
    parent.add(domeMesh);

    spring = {
      ringMesh,
      ringGeometry,
      ringCentreX,
      ringCentreZ,
      ringDirX,
      ringDirZ,
      ringEdge,
      ringCycleOffset,
      ringPlotScale,
      domeMesh,
      domeGeometry,
      domeRestOffsetY,
      domeSurfaceY,
      domePhase,
    };
  };

  const rebuild = (
    mirror: TerrainMirror,
    surface: RiverSurface,
    dirtyChunks: ReadonlySet<number> | null,
  ): void => {
    const worldSize = mirror.map.size;
    beginWetCells(worldSize * worldSize);
    const wetBand = wetCells.band;
    const wetStamp = wetCells.stamp;
    const wetList = surface.cells;
    const generation = wetCells.generation;
    const affectedChunks = new Set<number>();
    const tileCols = chunksPerEdge(worldSize);
    const noteChunkAndNeighbours = (chunkIdx: number): void => {
      const chunkX = chunkIdx % tileCols;
      const chunkZ = (chunkIdx - chunkX) / tileCols;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = chunkX + dx;
          const nz = chunkZ + dz;
          if (nx < 0 || nz < 0 || nx >= tileCols || nz >= tileCols) continue;
          affectedChunks.add(nz * tileCols + nx);
        }
      }
    };
    const noteCell = (cell: number): void => {
      const x = cell % worldSize;
      noteChunkAndNeighbours(chunkIndexOfCell(worldSize, x, (cell - x) / worldSize));
    };
    if (dirtyChunks !== null) for (const chunkIdx of dirtyChunks) noteChunkAndNeighbours(chunkIdx);

    const previousBand = previousWetCells.band;
    const previousStamp = previousWetCells.stamp;
    const previousGeneration = previousWetCells.generation;
    for (let i = 0; i < wetList.length; i++) {
      const cell = wetList[i]!;
      const band = surface.bands[i]!;
      wetStamp[cell] = generation;
      wetBand[cell] = band;
      if (previousStamp[cell] !== previousGeneration || previousBand[cell] !== band) {
        noteCell(cell);
      }
    }
    for (const cell of previousWetCells.list) {
      if (wetStamp[cell] !== generation) noteCell(cell);
    }
    wetCells.list = wetList;

    const regions = new Map<number, WaterRegion>();
    const lastCell = worldSize - 1;
    const tileOfCell = (coord: number): number => Math.floor(coord / CHUNK_SIZE);
    let lastBand = Number.NaN;
    let lastRegion: WaterRegion | undefined;
    for (const cell of wetList) {
      const band = wetBand[cell]!;
      let region = band === lastBand ? lastRegion : regions.get(band);
      if (region === undefined) {
        region = {
          anchorCell: cell,
          surfaceBand: band,
          tiles: new Set<number>(),
        };
        regions.set(band, region);
      }
      lastRegion = region;
      lastBand = band;
      const x = cell % worldSize;
      const y = (cell - x) / worldSize;
      const loX = Math.max(0, x - DRAWN_BLEND_REACH_CELLS);
      const hiX = Math.min(lastCell, x + DRAWN_BLEND_REACH_CELLS);
      const loY = Math.max(0, y - DRAWN_BLEND_REACH_CELLS);
      const hiY = Math.min(lastCell, y + DRAWN_BLEND_REACH_CELLS);
      for (let tileY = tileOfCell(loY); tileY <= tileOfCell(hiY); tileY++) {
        for (let tileX = tileOfCell(loX); tileX <= tileOfCell(hiX); tileX++) {
          region.tiles.add(tileY * tileCols + tileX);
        }
      }
    }

    const waterBandAt = (cellXCoord: number, cellYCoord: number): number | null => {
      if (cellXCoord < 0 || cellYCoord < 0 || cellXCoord >= worldSize || cellYCoord >= worldSize) {
        return null;
      }
      const cell = cellYCoord * worldSize + cellXCoord;
      return wetStamp[cell] === generation ? wetBand[cell]! : null;
    };

    const carriedKeys = new Set<number>();
    for (let i = pendingCursor; i < pendingTiles.length; i++) {
      carriedKeys.add(pendingTiles[i]!.key);
    }
    clearPendingTiles();

    const tileCount = tileCols * tileCols;
    const currentKeys = new Set<number>();
    for (const region of regions.values()) {
      const surfaceY = waterBandWorldY(region.surfaceBand);
      for (const tile of region.tiles) {
        const key = runKeyOf(region.surfaceBand, tile, tileCount);
        currentKeys.add(key);
        const stale =
          dirtyChunks === null ||
          affectedChunks.has(tile) ||
          carriedKeys.has(key) ||
          !emittedRunKeys.has(key);
        if (stale) pendingTiles.push({ key, region, tile, surfaceY });
      }
    }

    for (const key of Array.from(waterRunOrder)) {
      if (currentKeys.has(key)) continue;
      spliceRun(key, EMPTY_TRIANGLES, 0);
    }
    emittedRunKeys = currentKeys;

    drainJob = { mirror, sources: surface.sources, waterBandAt };
    publishWaterBuffer();
  };

  const publishWaterBuffer = (): void => {
    waterMesh.geometry.setDrawRange(0, liveWaterVertices);
    waterPositionAttribute.needsUpdate = true;
  };

  const emitPendingTile = (job: DrainJob, entry: PendingTile): void => {
    regionTriangles.length = 0;
    appendDrawnWaterTile(
      job.mirror.renderMap,
      entry.region,
      entry.tile,
      entry.surfaceY,
      job.waterBandAt,
      SEA_SURFACE_WORLD_Y,
      regionTriangles,
    );
    spliceRun(entry.key, regionTriangles, regionTriangles.length / 3);
  };

  const finishDrain = (): void => {
    const job = drainJob;
    drainJob = null;
    publishWaterBuffer();
    recomputeWaterBounds();
    if (job === null) return;
    rebuildSprings(job.mirror, job.sources, (x, y) => {
      const band = job.waterBandAt(x, y);
      return band === null ? null : waterBandWorldY(band);
    });
    applySpringPose(elapsedSeconds);
  };

  const drainWaterTiles = (): void => {
    const job = drainJob;
    if (job === null) return;
    if (pendingCursor >= pendingTiles.length) {
      pendingTiles.length = 0;
      pendingCursor = 0;
      finishDrain();
      return;
    }
    const startedMs = now();
    for (;;) {
      emitPendingTile(job, pendingTiles[pendingCursor]!);
      pendingCursor++;
      if (now() - startedMs >= WATER_TILE_FRAME_BUDGET_MS || pendingCursor >= pendingTiles.length) {
        publishWaterBuffer();
        return;
      }
    }
  };

  const applySpringPose = (seconds: number): void => {
    if (spring === null) return;

    const ringAttribute = spring.ringGeometry.getAttribute('position') as BufferAttribute;
    const ringArray = ringAttribute.array as Float32Array;
    const ringCycle = seconds / SPRING_RIPPLE_PERIOD_SECONDS;
    const radiusSpanCells = SPRING_RING_MAX_RADIUS_CELLS - SPRING_RING_MIN_RADIUS_CELLS;
    for (let i = 0; i < spring.ringEdge.length; i++) {
      const progress = (ringCycle + spring.ringCycleOffset[i]!) % 1;
      const centreLineRadiusCells = SPRING_RING_MIN_RADIUS_CELLS + radiusSpanCells * progress;
      const halfWidthCells = (SPRING_RING_MAX_WIDTH_CELLS * Math.sin(Math.PI * progress)) / 2;
      const radiusWorld =
        (centreLineRadiusCells + (spring.ringEdge[i]! * 2 - 1) * halfWidthCells) *
        spring.ringPlotScale[i]! *
        CELL_WORLD_SIZE;
      ringArray[i * 3] = spring.ringCentreX[i]! + spring.ringDirX[i]! * radiusWorld;
      ringArray[i * 3 + 2] = spring.ringCentreZ[i]! + spring.ringDirZ[i]! * radiusWorld;
    }
    ringAttribute.needsUpdate = true;

    const domeAttribute = spring.domeGeometry.getAttribute('position') as BufferAttribute;
    const domeArray = domeAttribute.array as Float32Array;
    const swellAngle = (seconds / SPRING_DOME_SWELL_PERIOD_SECONDS) * TWO_PI;
    for (let i = 0; i < spring.domeRestOffsetY.length; i++) {
      const swell = 1 + SPRING_DOME_SWELL_FRACTION * Math.sin(swellAngle + spring.domePhase[i]!);
      domeArray[i * 3 + 1] = spring.domeSurfaceY[i]! + spring.domeRestOffsetY[i]! * swell;
    }
    domeAttribute.needsUpdate = true;
  };

  const reducedMotion = watchReducedMotion();
  let elapsedSeconds = 0;
  const unregisterFrame = onFrame((dt: number) => {
    drainWaterTiles();
    if (!reducedMotion.matches()) elapsedSeconds += dt;
    if (spring === null || reducedMotion.matches()) return;
    applySpringPose(elapsedSeconds);
  });

  const pendingDirty = new Set<number>();
  let pendingEverything = false;
  let pendingMirror: TerrainMirror | null = null;
  let computingFor: TerrainMirror | null = null;
  let recomputeWhenDone = false;
  let disposed = false;

  const startCompute = (): void => {
    const mirror = pendingMirror;
    if (mirror === null) return;
    if (computingFor !== null) {
      recomputeWhenDone = true;
      return;
    }
    computingFor = mirror;
    const dirty = pendingEverything ? null : new Set(pendingDirty);
    pendingDirty.clear();
    pendingEverything = false;

    const finish = (surface: RiverSurface): void => {
      computingFor = null;
      if (disposed) return;
      if (pendingMirror !== mirror) return;
      rebuild(mirror, surface, dirty);
      if (recomputeWhenDone) {
        recomputeWhenDone = false;
        startCompute();
      }
    };

    const answer = networkSource.compute(mirror);
    if (answer instanceof Promise) void answer.then(finish);
    else finish(answer);
  };

  return {
    refresh(mirror: TerrainMirror, dirty: ReadonlySet<number>): void {
      pendingMirror = mirror;
      for (const chunkIdx of dirty) pendingDirty.add(chunkIdx);
      const now = performance.now();
      if (now - lastRebuildMs < RIVER_RECOMPUTE_INTERVAL_MS) return;
      lastRebuildMs = now;
      startCompute();
    },

    forceRefresh(mirror: TerrainMirror): void {
      pendingMirror = mirror;
      pendingEverything = true;
      clearPendingTiles();
      lastRebuildMs = performance.now();
      startCompute();
    },

    dispose(): void {
      disposed = true;
      clearPendingTiles();
      networkSource.dispose();
      unregisterFrame();
      reducedMotion.stop();
      parent.remove(waterMesh);
      waterMesh.geometry.dispose();
      waterMaterial.dispose();
      springRingMaterial.dispose();
      springDomeMaterial.dispose();
      if (spring !== null) {
        parent.remove(spring.ringMesh);
        parent.remove(spring.domeMesh);
        spring.ringGeometry.dispose();
        spring.domeGeometry.dispose();
      }
    },
  };
}
