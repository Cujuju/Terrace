import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  SEA_LEVEL,
  anyColumnLayered,
  bandOf,
  columnCoversBand,
  isSpanDrawn,
  spanAt,
  spanCapHeight,
  spanCount,
} from '@terrace/shared';
import {
  BAND_WORLD_HEIGHT,
  CELL_WORLD_SIZE,
  WATER_SURFACE_LIFT,
} from '../config.ts';
import {
  bandPaletteIndex,
  isEmissivePaletteIndex,
  isSeabedPaletteIndex,
  type Rgb,
} from './bandColors.ts';
import {
  sampleRenderBandHeight,
  sampleRenderBandSolid,
  type TerrainMirror,
} from './mirror.ts';
import {
  LATTICE_PER_CHUNK,
  RECT_NONE,
  SAMPLE_COUNT,
  SHORE_EDGE_CROSSING,
  assembleLoops,
  isSeamSegment,
  loadSampleField,
  loadSamples,
  marchLevel,
  samples,
  type ContourLoop,
  type ContourPoint,
} from './contours.ts';
import { smoothLoop } from './contourSmoothing.ts';
import { bridgeHole, earClip, groupLoops, type CapPolygon } from './triangulation.ts';

export const SKIRT_PICK_INSET = 1 / 1024;

export const SEABED_CAP_SINK = WATER_SURFACE_LIFT / 2;

export const SEABED_RISER_BORDER_WORLD_HEIGHT = BAND_WORLD_HEIGHT / 16;

export const INITIAL_CHUNK_TRIANGLE_CAPACITY = 1024;

export const CHUNK_TRIANGLE_BUDGET = 131072;

export const CHUNK_TRIANGULATION_WORK_BUDGET = 4_194_304;

export const MAX_MERGED_POLYGON_VERTICES = 512;
export const CHUNK_POLYGON_WORK_BUDGET =
  MAX_MERGED_POLYGON_VERTICES * MAX_MERGED_POLYGON_VERTICES;

const COMPONENTS_PER_POSITION = 3;
const COMPONENTS_PER_NORMAL = 3;
const COMPONENTS_PER_COLOR = 3;
export const VERTICES_PER_TRIANGLE = 3;

export const LIT_BY_SCENE = 0;
export const SELF_LIT = 255;

export interface DrawnCapLevel {
  readonly threshold: number;
  readonly sampleBand: number;
  readonly capY: number;
  readonly polygons: readonly CapPolygon[];
}

export interface ChunkDrawnCaps {
  readonly blocky: boolean;
  readonly levels: readonly DrawnCapLevel[];
}

export interface ChunkGeometryCounts {
  capTriangleCount: number;
  skirtTriangleCount: number;
  ceilingTriangleCount: number;
  triangleCount: number;
  vertexCount: number;
  triangleCapacity: number;
  capacityGrew: boolean;
  usedFallback: boolean;
  triangulationWork: number;
  maxPolygonWork: number;
  drawnCaps: ChunkDrawnCaps;
}

export interface ChunkGeometryBuffers {
  positions: Float32Array;
  normals: Int8Array;
  colors: Uint8Array;
  selfLit: Uint8Array;
  triangleCapacity: number;
}

export interface ChunkPalettes {
  top: readonly Rgb[];
  cliff: readonly Rgb[];
}

export function createChunkGeometryBuffers(
  triangleCapacity: number = INITIAL_CHUNK_TRIANGLE_CAPACITY,
): ChunkGeometryBuffers {
  const vertices = triangleCapacity * VERTICES_PER_TRIANGLE;
  return {
    positions: new Float32Array(vertices * COMPONENTS_PER_POSITION),
    normals: new Int8Array(vertices * COMPONENTS_PER_NORMAL),
    colors: new Uint8Array(vertices * COMPONENTS_PER_COLOR),
    selfLit: new Uint8Array(vertices),
    triangleCapacity,
  };
}

interface ContourLevel {
  threshold: number;
  sampleBand: number;
  capY: number;
  undersideY: number;
  skirtDrop: number;
  capColor: Rgb;
  capSelfLit: number;
  skirtColor: Rgb;
  skirtBorderColor: Rgb | null;
  skirtSelfLit: number;
  ceilingColor: Rgb;
  ceilingSelfLit: number;
  crossingOverride: number | null;
  loops: ContourLoop[];
}

function makeLevels(palettes: ChunkPalettes, floorBand: number | null): ContourLevel[] {
  let lowestBand = Infinity;
  let highestBand = -Infinity;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const band = bandOf(samples[i]);
    if (band < lowestBand) lowestBand = band;
    if (band > highestBand) highestBand = band;
  }
  if (floorBand !== null && floorBand < lowestBand) lowestBand = floorBand;

  const levels: ContourLevel[] = [];
  for (let k = lowestBand; k <= highestBand; k++) {
    const paletteIndex = bandPaletteIndex(k * BAND_HEIGHT);
    const capY = k === 0 ? -SEABED_CAP_SINK : k * BAND_WORLD_HEIGHT;
    const below = k - 1 === 0 ? -SEABED_CAP_SINK : (k - 1) * BAND_WORLD_HEIGHT;
    const skirtDrop = k === lowestBand ? 0 : capY - below;
    const bordered =
      isSeabedPaletteIndex(paletteIndex) &&
      skirtDrop > SEABED_RISER_BORDER_WORLD_HEIGHT;
    const undersideHeight = (k === lowestBand ? k : k - 1) * BAND_HEIGHT;
    const undersideIndex = bandPaletteIndex(undersideHeight);
    const ceilingIndex = isSeabedPaletteIndex(undersideIndex)
      ? undersideIndex
      : paletteIndex;
    levels.push({
      threshold: k * BAND_HEIGHT,
      sampleBand: k,
      capY,
      undersideY: k === lowestBand ? capY : below,
      skirtDrop,
      capColor: palettes.top[paletteIndex],
      capSelfLit: capSelfLitFor(paletteIndex),
      skirtColor: palettes.cliff[paletteIndex],
      skirtBorderColor: bordered
        ? palettes.top[bandPaletteIndex((k - 1) * BAND_HEIGHT)]
        : null,
      skirtSelfLit: selfLitFor(paletteIndex),
      ceilingColor: palettes.cliff[ceilingIndex],
      ceilingSelfLit: selfLitFor(ceilingIndex),
      crossingOverride: null,
      loops: [],
    });
    if (k === 0) {
      const shoreIndex = bandPaletteIndex(SEA_LEVEL + 1);
      levels.push({
        threshold: SEA_LEVEL + 1,
        sampleBand: 0,
        capY: 0,
        undersideY: 0,
        skirtDrop: SEABED_CAP_SINK,
        capColor: palettes.top[shoreIndex],
        capSelfLit: capSelfLitFor(shoreIndex),
        skirtColor: palettes.cliff[shoreIndex],
        skirtBorderColor: null,
        skirtSelfLit: selfLitFor(shoreIndex),
        ceilingColor: palettes.cliff[shoreIndex],
        ceilingSelfLit: selfLitFor(shoreIndex),
        crossingOverride: SHORE_EDGE_CROSSING,
        loops: [],
      });
    }
  }
  return levels;
}

function selfLitFor(paletteIndex: number): number {
  return isSeabedPaletteIndex(paletteIndex) ? SELF_LIT : LIT_BY_SCENE;
}

function capSelfLitFor(paletteIndex: number): number {
  return isEmissivePaletteIndex(paletteIndex) ? SELF_LIT : LIT_BY_SCENE;
}

const SIGNED_BYTE_SCALE = 127;

const UNSIGNED_BYTE_SCALE = 255;

function quantizeNormal(component: number): number {
  return Math.round(component * SIGNED_BYTE_SCALE);
}

function quantizeChannel(channel: number): number {
  const scaled = Math.round(channel * UNSIGNED_BYTE_SCALE);
  return scaled < 0 ? 0 : scaled > UNSIGNED_BYTE_SCALE ? UNSIGNED_BYTE_SCALE : scaled;
}

let outBuffers: ChunkGeometryBuffers | null = null;
let outVertex = 0;

function pushVertex(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  color: Rgb,
  selfLit: number,
): void {
  const buffers = outBuffers as ChunkGeometryBuffers;
  buffers.selfLit[outVertex] = selfLit;
  let p = outVertex * COMPONENTS_PER_POSITION;
  buffers.positions[p++] = x;
  buffers.positions[p++] = y;
  buffers.positions[p] = z;
  let n = outVertex * COMPONENTS_PER_NORMAL;
  buffers.normals[n++] = quantizeNormal(nx);
  buffers.normals[n++] = quantizeNormal(ny);
  buffers.normals[n] = quantizeNormal(nz);
  let c = outVertex * COMPONENTS_PER_COLOR;
  buffers.colors[c++] = quantizeChannel(color[0]);
  buffers.colors[c++] = quantizeChannel(color[1]);
  buffers.colors[c] = quantizeChannel(color[2]);
  outVertex++;
}

function emitCapTriangle(
  a: ContourPoint,
  b: ContourPoint,
  c: ContourPoint,
  y: number,
  color: Rgb,
  selfLit: number,
): void {
  pushVertex(a.x * CELL_WORLD_SIZE, y, a.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
  pushVertex(c.x * CELL_WORLD_SIZE, y, c.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
  pushVertex(b.x * CELL_WORLD_SIZE, y, b.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
}

function emitCeilingTriangle(
  a: ContourPoint,
  b: ContourPoint,
  c: ContourPoint,
  y: number,
  color: Rgb,
  selfLit: number,
): void {
  pushVertex(a.x * CELL_WORLD_SIZE, y, a.z * CELL_WORLD_SIZE, 0, -1, 0, color, selfLit);
  pushVertex(b.x * CELL_WORLD_SIZE, y, b.z * CELL_WORLD_SIZE, 0, -1, 0, color, selfLit);
  pushVertex(c.x * CELL_WORLD_SIZE, y, c.z * CELL_WORLD_SIZE, 0, -1, 0, color, selfLit);
}

function emitSkirtQuad(
  p: ContourPoint,
  q: ContourPoint,
  topY: number,
  drop: number,
  color: Rgb,
  selfLit: number,
): void {
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return;
  const outX = dz / length;
  const outZ = -dx / length;
  const px = (p.x - outX * SKIRT_PICK_INSET) * CELL_WORLD_SIZE;
  const pz = (p.z - outZ * SKIRT_PICK_INSET) * CELL_WORLD_SIZE;
  const qx = (q.x - outX * SKIRT_PICK_INSET) * CELL_WORLD_SIZE;
  const qz = (q.z - outZ * SKIRT_PICK_INSET) * CELL_WORLD_SIZE;
  const bottomY = topY - drop;

  pushVertex(px, topY, pz, outX, 0, outZ, color, selfLit);
  pushVertex(qx, topY, qz, outX, 0, outZ, color, selfLit);
  pushVertex(qx, bottomY, qz, outX, 0, outZ, color, selfLit);

  pushVertex(px, topY, pz, outX, 0, outZ, color, selfLit);
  pushVertex(qx, bottomY, qz, outX, 0, outZ, color, selfLit);
  pushVertex(px, bottomY, pz, outX, 0, outZ, color, selfLit);
}

const CELL_HALF_EXTENT = 0.5;

const FALLBACK_CAP_TRIANGLES = 2 * LATTICE_PER_CHUNK * LATTICE_PER_CHUNK;
const FALLBACK_WALL_TRIANGLES = 2 * (2 * CHUNK_SIZE * LATTICE_PER_CHUNK);
const FALLBACK_CURTAIN_TRIANGLES = 2 * (4 * LATTICE_PER_CHUNK);
export const FALLBACK_MAX_TRIANGLES =
  FALLBACK_CAP_TRIANGLES + FALLBACK_WALL_TRIANGLES + FALLBACK_CURTAIN_TRIANGLES;

export function blockyCellCapY(height: number): number {
  const band = bandOf(height);
  if (band === 0 && height <= SEA_LEVEL) return -SEABED_CAP_SINK;
  return band * BAND_WORLD_HEIGHT;
}

function writeBlockyFallback(
  originX: number,
  originZ: number,
  palettes: ChunkPalettes,
): { caps: number; skirts: number } {
  let caps = 0;
  let skirts = 0;

  const heightAt = (i: number, j: number): number => samples[j * LATTICE_PER_CHUNK + i];
  const loX = (i: number): number => Math.max(originX + i - CELL_HALF_EXTENT, originX);
  const hiX = (i: number): number =>
    Math.min(originX + i + CELL_HALF_EXTENT, originX + CHUNK_SIZE);
  const loZ = (j: number): number => Math.max(originZ + j - CELL_HALF_EXTENT, originZ);
  const hiZ = (j: number): number =>
    Math.min(originZ + j + CELL_HALF_EXTENT, originZ + CHUNK_SIZE);

  let floorY = Infinity;
  for (let i = 0; i < SAMPLE_COUNT; i++) floorY = Math.min(floorY, blockyCellCapY(samples[i]));

  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
      const height = heightAt(i, j);
      const y = blockyCellCapY(height);
      const capIndex = bandPaletteIndex(height);
      const color = palettes.top[capIndex];
      const capLit = capSelfLitFor(capIndex);
      const west = { x: loX(i), z: loZ(j), rect: RECT_NONE };
      const east = { x: hiX(i), z: loZ(j), rect: RECT_NONE };
      const southWest = { x: loX(i), z: hiZ(j), rect: RECT_NONE };
      const southEast = { x: hiX(i), z: hiZ(j), rect: RECT_NONE };
      emitCapTriangle(west, east, southEast, y, color, capLit);
      emitCapTriangle(west, southEast, southWest, y, color, capLit);
      caps += 2;
    }
  }

  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const here = heightAt(i, j);
      const next = heightAt(i + 1, j);
      const hereY = blockyCellCapY(here);
      const nextY = blockyCellCapY(next);
      if (hereY === nextY) continue;
      const westHigher = hereY > nextY;
      const planeX = originX + i + CELL_HALF_EXTENT;
      const index = bandPaletteIndex(westHigher ? here : next);
      const a = { x: planeX, z: westHigher ? loZ(j) : hiZ(j), rect: RECT_NONE };
      const b = { x: planeX, z: westHigher ? hiZ(j) : loZ(j), rect: RECT_NONE };
      emitSkirtQuad(
        a,
        b,
        Math.max(hereY, nextY),
        Math.abs(hereY - nextY),
        palettes.cliff[index],
        selfLitFor(index),
      );
      skirts += 2;
    }
  }
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
      const here = heightAt(i, j);
      const next = heightAt(i, j + 1);
      const hereY = blockyCellCapY(here);
      const nextY = blockyCellCapY(next);
      if (hereY === nextY) continue;
      const northHigher = hereY > nextY;
      const planeZ = originZ + j + CELL_HALF_EXTENT;
      const index = bandPaletteIndex(northHigher ? here : next);
      const a = { x: northHigher ? hiX(i) : loX(i), z: planeZ, rect: RECT_NONE };
      const b = { x: northHigher ? loX(i) : hiX(i), z: planeZ, rect: RECT_NONE };
      emitSkirtQuad(
        a,
        b,
        Math.max(hereY, nextY),
        Math.abs(hereY - nextY),
        palettes.cliff[index],
        selfLitFor(index),
      );
      skirts += 2;
    }
  }

  const curtain = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    topY: number,
    height: number,
  ): void => {
    if (topY <= floorY) return;
    const index = bandPaletteIndex(height);
    emitSkirtQuad(
      { x: ax, z: az, rect: RECT_NONE },
      { x: bx, z: bz, rect: RECT_NONE },
      topY,
      topY - floorY,
      palettes.cliff[index],
      selfLitFor(index),
    );
    skirts += 2;
  };
  const last = CHUNK_SIZE;
  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    const west = heightAt(0, j);
    curtain(originX, hiZ(j), originX, loZ(j), blockyCellCapY(west), west);
    const east = heightAt(last, j);
    curtain(originX + last, loZ(j), originX + last, hiZ(j), blockyCellCapY(east), east);
  }
  for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
    const north = heightAt(i, 0);
    curtain(loX(i), originZ, hiX(i), originZ, blockyCellCapY(north), north);
    const south = heightAt(i, last);
    curtain(hiX(i), originZ + last, loX(i), originZ + last, blockyCellCapY(south), south);
  }

  return { caps, skirts };
}

const CEILING_EDGE_CROSSING = 0.5;

const CEILING_INSIDE = 1;
const CEILING_OUTSIDE = 0;

function chunkLatticeRect(
  worldSize: number,
  originX: number,
  originZ: number,
): { x0: number; y0: number; width: number; height: number } {
  const x0 = originX < 0 ? 0 : originX;
  const y0 = originZ < 0 ? 0 : originZ;
  const x1 = Math.min(originX + LATTICE_PER_CHUNK, worldSize);
  const y1 = Math.min(originZ + LATTICE_PER_CHUNK, worldSize);
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

function buriedFloorBand(
  mirror: TerrainMirror,
  originX: number,
  originZ: number,
): number | null {
  const rect = chunkLatticeRect(mirror.map.size, originX, originZ);
  if (!anyColumnLayered(mirror.map, rect.x0, rect.y0, rect.width, rect.height)) return null;
  let lowest = Infinity;
  for (let y = rect.y0; y < rect.y0 + rect.height; y++) {
    for (let x = rect.x0; x < rect.x0 + rect.width; x++) {
      const count = spanCount(mirror.map, x, y);
      if (count === 1) continue;
      for (let k = 0; k < count; k++) {
        const span = spanAt(mirror.map, x, y, k);
        if (!isSpanDrawn(span)) continue;
        const band = bandOf(spanCapHeight(span));
        if (band < lowest) lowest = band;
      }
    }
  }
  return lowest === Infinity ? null : lowest;
}

function marchCeiling(
  mirror: TerrainMirror,
  originX: number,
  originZ: number,
  band: number,
): CapPolygon[] {
  loadSampleField(
    (i, j) =>
      sampleRenderBandSolid(mirror, originX + i, originZ + j, band) &&
      !sampleRenderBandSolid(mirror, originX + i, originZ + j, band - 1)
        ? CEILING_INSIDE
        : CEILING_OUTSIDE,
    CHUNK_SIZE,
  );
  const segmentCount = marchLevel(CEILING_INSIDE, originX, originZ, CEILING_EDGE_CROSSING);
  const wholeInside = samples[0] >= CEILING_INSIDE;
  const loops = assembleLoops(segmentCount, originX, originZ, wholeInside)
    .map(smoothLoop)
    .filter((loop) => loop.length >= 3);
  return groupLoops(loops);
}

export interface ChunkCapPlan {
  readonly levels: ContourLevel[];
  readonly polygonsPerLevel: CapPolygon[][];
  readonly ceilingsPerLevel: CapPolygon[][];
  readonly overBudget: boolean;
  readonly capTriangles: number;
  readonly skirtTriangles: number;
  readonly ceilingTriangles: number;
  readonly triangulationWork: number;
  readonly maxPolygonWork: number;
}

export function planChunkCaps(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  palettes: ChunkPalettes,
): ChunkCapPlan {
  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  loadSamples(mirror, originX, originZ);

  const floorBand = buriedFloorBand(mirror, originX, originZ);
  const layered = floorBand !== null;
  const loadLevel = (band: number): void => {
    loadSampleField(
      (i, j) => sampleRenderBandHeight(mirror, originX + i, originZ + j, band),
      CHUNK_SIZE,
    );
  };

  const levels = makeLevels(palettes, floorBand);

  let capTriangles = 0;
  let skirtTriangles = 0;
  let ceilingTriangles = 0;
  let triangulationWork = 0;
  let maxPolygonWork = 0;
  let overBudget = false;
  const polygonsPerLevel: CapPolygon[][] = [];
  const ceilingsPerLevel: CapPolygon[][] = [];
  for (const level of levels) {
    if (layered) loadLevel(level.sampleBand);
    const segmentCount = marchLevel(
      level.threshold,
      originX,
      originZ,
      level.crossingOverride,
    );
    const wholeInside = samples[0] >= level.threshold;
    const rawLoops = assembleLoops(segmentCount, originX, originZ, wholeInside);
    level.loops = rawLoops.map(smoothLoop).filter((loop) => loop.length >= 3);

    const polygons = groupLoops(level.loops);
    polygonsPerLevel.push(polygons);
    for (const polygon of polygons) {
      let vertices = polygon.outer.length;
      for (const hole of polygon.holes) vertices += hole.length;
      const merged = vertices + 2 * polygon.holes.length;
      capTriangles += merged - 2;
      const polygonWork = merged * merged;
      triangulationWork += polygonWork;
      if (polygonWork > maxPolygonWork) maxPolygonWork = polygonWork;
    }
    if (level.skirtDrop > 0) {
      const trianglesPerSegment = level.skirtBorderColor !== null ? 4 : 2;
      for (const loop of level.loops) {
        for (let i = 0; i < loop.length; i++) {
          if (!isSeamSegment(loop[i], loop[(i + 1) % loop.length])) {
            skirtTriangles += trianglesPerSegment;
          }
        }
      }
    }
    ceilingsPerLevel.push(
      layered && level.threshold === level.sampleBand * BAND_HEIGHT
        ? marchCeiling(mirror, originX, originZ, level.sampleBand)
        : [],
    );
    for (const polygon of ceilingsPerLevel[ceilingsPerLevel.length - 1]) {
      let vertices = polygon.outer.length;
      for (const hole of polygon.holes) vertices += hole.length;
      const merged = vertices + 2 * polygon.holes.length;
      ceilingTriangles += merged - 2;
      const polygonWork = merged * merged;
      triangulationWork += polygonWork;
      if (polygonWork > maxPolygonWork) maxPolygonWork = polygonWork;
    }
    if (
      capTriangles + skirtTriangles + ceilingTriangles > CHUNK_TRIANGLE_BUDGET ||
      triangulationWork > CHUNK_TRIANGULATION_WORK_BUDGET ||
      maxPolygonWork > CHUNK_POLYGON_WORK_BUDGET
    ) {
      overBudget = true;
      break;
    }
  }

  return {
    levels,
    polygonsPerLevel,
    ceilingsPerLevel,
    overBudget,
    capTriangles,
    skirtTriangles,
    ceilingTriangles,
    triangulationWork,
    maxPolygonWork,
  };
}

export function writeChunkVertexData(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  buffers: ChunkGeometryBuffers,
  palettes: ChunkPalettes,
): ChunkGeometryCounts {
  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  const plan = planChunkCaps(mirror, cx, cy, palettes);
  const {
    levels,
    polygonsPerLevel,
    ceilingsPerLevel,
    overBudget,
    capTriangles,
    skirtTriangles,
    ceilingTriangles,
    triangulationWork,
    maxPolygonWork,
  } = plan;

  const triangleTarget = overBudget
    ? FALLBACK_MAX_TRIANGLES
    : capTriangles + skirtTriangles + ceilingTriangles;
  let capacityGrew = ensureCapacity(buffers, triangleTarget);

  outBuffers = buffers;
  outVertex = 0;
  let capEmitted = 0;
  let skirtEmitted = 0;
  let ceilingEmitted = 0;

  for (let index = 0; index < (overBudget ? 0 : levels.length); index++) {
    const level = levels[index];
    for (const polygon of polygonsPerLevel[index]) {
      let merged = polygon.outer;
      for (const hole of polygon.holes) merged = bridgeHole(merged, hole);
      earClip(merged, (a, b, c) => {
        emitCapTriangle(a, b, c, level.capY, level.capColor, level.capSelfLit);
        capEmitted++;
      });
    }
    for (const polygon of ceilingsPerLevel[index]) {
      let merged = polygon.outer;
      for (const hole of polygon.holes) merged = bridgeHole(merged, hole);
      earClip(merged, (a, b, c) => {
        emitCeilingTriangle(a, b, c, level.undersideY, level.ceilingColor, level.ceilingSelfLit);
        ceilingEmitted++;
      });
    }
    if (level.skirtDrop <= 0) continue;
    for (const loop of level.loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if (isSeamSegment(a, b)) continue;
        if (level.skirtBorderColor !== null) {
          emitSkirtQuad(
            a,
            b,
            level.capY,
            SEABED_RISER_BORDER_WORLD_HEIGHT,
            level.skirtBorderColor,
            level.skirtSelfLit,
          );
          emitSkirtQuad(
            a,
            b,
            level.capY - SEABED_RISER_BORDER_WORLD_HEIGHT,
            level.skirtDrop - SEABED_RISER_BORDER_WORLD_HEIGHT,
            level.skirtColor,
            level.skirtSelfLit,
          );
          skirtEmitted += 4;
        } else {
          emitSkirtQuad(
            a,
            b,
            level.capY,
            level.skirtDrop,
            level.skirtColor,
            level.skirtSelfLit,
          );
          skirtEmitted += 2;
        }
      }
    }
  }

  let usedFallback = overBudget;
  if (
    !overBudget &&
    (capEmitted !== capTriangles ||
      skirtEmitted !== skirtTriangles ||
      ceilingEmitted !== ceilingTriangles)
  ) {
    usedFallback = true;
  }
  if (usedFallback && !overBudget) {
    capacityGrew = ensureCapacity(buffers, FALLBACK_MAX_TRIANGLES) || capacityGrew;
  }
  if (usedFallback) {
    outVertex = 0;
    const emitted = writeBlockyFallback(originX, originZ, palettes);
    capEmitted = emitted.caps;
    skirtEmitted = emitted.skirts;
    ceilingEmitted = 0;
  }

  const triangleCount = capEmitted + skirtEmitted + ceilingEmitted;
  const vertexCount = triangleCount * VERTICES_PER_TRIANGLE;
  outBuffers = null;

  const drawnCaps: ChunkDrawnCaps = usedFallback
    ? { blocky: true, levels: [] }
    : {
        blocky: false,
        levels: levels.map((level, index) => ({
          threshold: level.threshold,
          sampleBand: level.sampleBand,
          capY: level.capY,
          polygons: polygonsPerLevel[index],
        })),
      };

  return {
    capTriangleCount: capEmitted,
    skirtTriangleCount: skirtEmitted,
    ceilingTriangleCount: ceilingEmitted,
    triangleCount,
    vertexCount,
    triangleCapacity: buffers.triangleCapacity,
    capacityGrew,
    usedFallback,
    triangulationWork,
    maxPolygonWork,
    drawnCaps,
  };
}

function ensureCapacity(buffers: ChunkGeometryBuffers, triangles: number): boolean {
  if (triangles <= buffers.triangleCapacity) return false;
  let capacity = buffers.triangleCapacity;
  while (capacity < triangles) capacity *= 2;
  const grown = createChunkGeometryBuffers(capacity);
  buffers.positions = grown.positions;
  buffers.normals = grown.normals;
  buffers.colors = grown.colors;
  buffers.selfLit = grown.selfLit;
  buffers.triangleCapacity = capacity;
  return true;
}

export function chunkCapTriangles(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  threshold: number,
): { x: number; z: number }[][] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  loadSamples(mirror, originX, originZ);
  const segmentCount = marchLevel(threshold, originX, originZ, null);
  const loops = assembleLoops(segmentCount, originX, originZ, samples[0] >= threshold)
    .map(smoothLoop)
    .filter((loop) => loop.length >= 3);
  const triangles: { x: number; z: number }[][] = [];
  for (const polygon of groupLoops(loops)) {
    let merged = polygon.outer;
    for (const hole of polygon.holes) merged = bridgeHole(merged, hole);
    earClip(merged, (a, b, c) => {
      triangles.push([
        { x: a.x, z: a.z },
        { x: b.x, z: b.z },
        { x: c.x, z: c.z },
      ]);
    });
  }
  return triangles;
}

function finishLoops(
  segmentCount: number,
  originX: number,
  originZ: number,
  wholeInside: boolean,
): { x: number; z: number; onBorder: boolean }[][] {
  return assembleLoops(segmentCount, originX, originZ, wholeInside)
    .map(smoothLoop)
    .filter((loop) => loop.length >= 3)
    .map((loop) =>
      loop.map((p) => ({ x: p.x, z: p.z, onBorder: p.rect !== RECT_NONE })),
    );
}

export function chunkContourLoops(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  threshold: number,
  crossingOverride: number | null = null,
): { x: number; z: number; onBorder: boolean }[][] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  loadSamples(mirror, originX, originZ);
  const segmentCount = marchLevel(threshold, originX, originZ, crossingOverride);
  return finishLoops(segmentCount, originX, originZ, samples[0] >= threshold);
}

export function chunkBandContourLoops(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  band: number,
): { x: number; z: number; onBorder: boolean }[][] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  loadSampleField(
    (i, j) => sampleRenderBandHeight(mirror, originX + i, originZ + j, band),
    CHUNK_SIZE,
  );
  const threshold = band * BAND_HEIGHT;
  const segmentCount = marchLevel(threshold, originX, originZ, null);
  return finishLoops(segmentCount, originX, originZ, samples[0] >= threshold);
}
