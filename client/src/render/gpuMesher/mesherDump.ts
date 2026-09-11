import { CHUNK_SIZE, chunksPerEdge, drawnBandOfSample } from '@terrace/shared';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector2,
  type PerspectiveCamera,
} from 'three';
import type { Renderer } from 'three/webgpu';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE } from '../../config.ts';
import { LATTICE_PER_CHUNK } from '../../terrain/contours.ts';
import type { TerrainMirror } from '../../terrain/mirror.ts';
import { VERTICES_PER_TRIANGLE } from '../../terrain/vertexGrid.ts';
import type { ArenaStore } from '../arenaStore.ts';
import { createDirectChunkBuildSource } from '../chunkBuildSource.ts';
import type { TerrainMeshes } from '../terrainMeshes.ts';
import { OVER_BUDGET, extractWindowEntry } from './terrainGpuInputs.ts';
import {
  GPU_POSITION_BYTES_PER_VERTEX,
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  POSITION_Y_UNITS_PER_WORLD_UNIT,
} from './gpuChunkAnswer.ts';
import type { GpuChunkBuildSource } from './gpuChunkBuildSource.ts';

/** DEV-only mesher diagnostic: `window.__terraceMesherDump.chunk(idx)`. Design section 11. */
const DUMP_HANDLE = '__terraceMesherDump';

const COMPONENTS_PER_PACKED_POSITION = GPU_POSITION_BYTES_PER_VERTEX / Int16Array.BYTES_PER_ELEMENT;
const COMPONENTS_PER_CPU_POSITION = 3;
const AXES = 3;
const UNITS_PER_TRIANGLE = VERTICES_PER_TRIANGLE * AXES;

/** Examples the report carries for the worst square; enough to name the missing wall. */
const DUMP_EXAMPLE_LIMIT = 8;

/** A ray is cast through the centre of the pixel, not its corner. */
const HALF_PIXEL = 0.5;

/** A triangle whose three vertices share one y is a cap; anything else is a riser. */
const CAP_TRIANGLE_Y_SPREAD_UNITS = 0;

/** The two meshers tessellate differently, so only area is comparable; below this a
 *  level or square counts as agreeing. One square world unit is 1/16 of a cell. */
const AREA_EPSILON_WORLD_UNITS = 1e-4;

interface TriangleSet {
  readonly count: number;
  /** x, y, z position units for each of the three vertices, 9 per triangle. */
  readonly units: Int32Array;
}

interface Areas {
  gpuCap: number;
  cpuCap: number;
  gpuRiser: number;
  cpuRiser: number;
}

export interface MesherDumpBucket extends Areas {
  readonly key: string;
}

export interface MesherDumpExample {
  readonly y: number;
  readonly vertices: readonly (readonly [number, number, number])[];
}

export interface MesherDumpReport {
  readonly chunkIdx: number;
  readonly cx: number;
  readonly cy: number;
  readonly localOriginX: number;
  readonly localOriginZ: number;
  readonly slot: { offset: number; count: number; capacity: number } | null;
  /** What a fresh GPU build of this chunk answers right now, released without emitting. */
  readonly rebuild: { kind: string; vertexCount: number } | null;
  readonly gpuTriangles: number;
  readonly cpuTriangles: number;
  /** World-space extent of each side's vertices: `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  readonly gpuBox: readonly number[];
  readonly cpuBox: readonly number[];
  /** Cap area is the horizontal area; riser area is the true 3D area of the walls. */
  readonly totals: Areas;
  /** Areas per cap height (risers keyed by their top), so a missing wall shows as a level. */
  readonly byLevel: readonly MesherDumpBucket[];
  /** Areas per lattice square of the chunk, `lx,lz` keyed; only squares that disagree. */
  readonly disagreeingSquares: readonly MesherDumpBucket[];
  /** CPU riser triangles inside the worst disagreeing square. */
  readonly missingExamples: readonly MesherDumpExample[];
}

/** Which side neighbours a chunk has, and the per-square data the exposure rule reads. */
export interface MesherDumpFacts {
  readonly chunkIdx: number;
  readonly cx: number;
  readonly cy: number;
  readonly layered: boolean;
  readonly exposed: boolean;
  readonly chunkLowestBand: number;
  readonly highestBand: number;
  /** `west,east,north,south,nw,ne,sw,se` -> whether that neighbour chunk is received. */
  readonly neighbours: Readonly<Record<string, boolean>>;
  /** Band of every lattice sample, row-major over `LATTICE_PER_CHUNK` squared. */
  readonly latticeBands: readonly number[];
}

/** The CPU triangle the camera sees at one pixel, tagged by square, level and kind. */
export interface MesherDumpHit {
  readonly px: number;
  readonly py: number;
  readonly chunkIdx: number;
  readonly lx: number;
  readonly lz: number;
  readonly y: number;
  readonly band: number;
  readonly kind: string;
  /** Signed XZ area of the triangle: caps wind one way, ceilings the other. */
  readonly facing: number;
  readonly distance: number;
}

export interface MesherDumpHitReport {
  readonly drawingBuffer: readonly [number, number];
  readonly chunks: readonly MesherDumpFacts[];
  readonly triangles: number;
  readonly hits: readonly (MesherDumpHit | null)[];
}

export interface MesherDumpSources {
  readonly camera: PerspectiveCamera;
  readonly renderer: Renderer;
  readonly mirror: () => TerrainMirror | null;
  readonly meshes: () => TerrainMeshes | null;
  readonly store: () => ArenaStore | null;
  readonly gpuMesher: GpuChunkBuildSource | null;
}

interface WebGpuBackendInternals {
  readonly isWebGPUBackend?: boolean;
  readonly device?: GPUDevice;
  get(object: object): { buffer?: GPUBuffer };
}

const worldXz = (units: number): number => units / POSITION_XZ_UNITS_PER_WORLD_UNIT;
const worldY = (units: number): number => units / POSITION_Y_UNITS_PER_WORLD_UNIT;

const isCap = (units: Int32Array, at: number): boolean => {
  const y0 = units[at + 1]!;
  for (let v = 1; v < VERTICES_PER_TRIANGLE; v++) {
    if (Math.abs(units[at + v * AXES + 1]! - y0) > CAP_TRIANGLE_Y_SPREAD_UNITS) return false;
  }
  return true;
};

/** Half the cross product magnitude, in world units; the invariant both tessellations share. */
function triangleArea(units: Int32Array, at: number): number {
  const p = [0, 1, 2].map((v) => [
    worldXz(units[at + v * AXES]!),
    worldY(units[at + v * AXES + 1]!),
    worldXz(units[at + v * AXES + 2]!),
  ]);
  const u = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!];
  const w = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];
  const cx = u[1]! * w[2]! - u[2]! * w[1]!;
  const cy = u[2]! * w[0]! - u[0]! * w[2]!;
  const cz = u[0]! * w[1]! - u[1]! * w[0]!;
  return Math.hypot(cx, cy, cz) / 2;
}

/** A riser is keyed by its top; a cap by its own height. */
const levelOf = (units: Int32Array, at: number): number =>
  Math.max(units[at + 1]!, units[at + AXES + 1]!, units[at + 2 * AXES + 1]!);

function exampleAt(units: Int32Array, at: number): MesherDumpExample {
  const vertices: [number, number, number][] = [];
  for (let v = 0; v < VERTICES_PER_TRIANGLE; v++) {
    const o = at + v * AXES;
    vertices.push([worldXz(units[o]!), worldY(units[o + 1]!), worldXz(units[o + 2]!)]);
  }
  return { y: worldY(levelOf(units, at)), vertices };
}

/** `[minX, minY, minZ, maxX, maxY, maxZ]` in world units, over every vertex of the set. */
function worldBox(set: TriangleSet, localOriginX: number, localOriginZ: number): number[] {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let v = 0; v < set.count * VERTICES_PER_TRIANGLE; v++) {
    const at = v * AXES;
    const point = [
      worldXz(set.units[at]!) + localOriginX,
      worldY(set.units[at + 1]!),
      worldXz(set.units[at + 2]!) + localOriginZ,
    ];
    for (let a = 0; a < AXES; a++) {
      box[a] = Math.min(box[a]!, point[a]!);
      box[a + AXES] = Math.max(box[a + AXES]!, point[a]!);
    }
  }
  return box;
}

function areasAt(into: Map<string, Areas>, key: string): Areas {
  let areas = into.get(key);
  if (areas === undefined) {
    areas = { gpuCap: 0, cpuCap: 0, gpuRiser: 0, cpuRiser: 0 };
    into.set(key, areas);
  }
  return areas;
}

const disagrees = (a: Areas): boolean =>
  Math.abs(a.gpuCap - a.cpuCap) > AREA_EPSILON_WORLD_UNITS ||
  Math.abs(a.gpuRiser - a.cpuRiser) > AREA_EPSILON_WORLD_UNITS;

const shortfall = (a: Areas): number => a.cpuCap - a.gpuCap + (a.cpuRiser - a.gpuRiser);

/** The arena's packed snorm16 slot, read back and decoded to position units. */
async function readGpuSlot(
  device: GPUDevice,
  positions: GPUBuffer,
  offset: number,
  count: number,
): Promise<TriangleSet> {
  const bytes = count * GPU_POSITION_BYTES_PER_VERTEX;
  const readback = device.createBuffer({
    label: 'terrace.mesherDump.readback',
    size: bytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: 'terrace.mesherDump.copy' });
  encoder.copyBufferToBuffer(positions, offset * GPU_POSITION_BYTES_PER_VERTEX, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const packed = new Int16Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();

  const triangles = Math.floor(count / VERTICES_PER_TRIANGLE);
  const units = new Int32Array(triangles * UNITS_PER_TRIANGLE);
  for (let v = 0; v < triangles * VERTICES_PER_TRIANGLE; v++) {
    const from = v * COMPONENTS_PER_PACKED_POSITION;
    const to = v * AXES;
    units[to] = packed[from]!;
    units[to + 1] = packed[from + 1]!;
    units[to + 2] = packed[from + 2]!;
  }
  return { count: triangles, units };
}

/** The same chunk from the CPU mesher, quantized by writeVertex's rule. */
function buildCpuTriangles(
  mirror: TerrainMirror,
  chunkIdx: number,
  localOriginX: number,
  localOriginZ: number,
): TriangleSet {
  const source = createDirectChunkBuildSource();
  const answer = source.build(mirror, chunkIdx, 0);
  source.dispose();
  if (answer === null || answer instanceof Promise || answer.kind !== 'cpu') {
    return { count: 0, units: new Int32Array(0) };
  }
  const triangles = Math.floor(answer.vertexCount / VERTICES_PER_TRIANGLE);
  const units = new Int32Array(triangles * UNITS_PER_TRIANGLE);
  for (let v = 0; v < triangles * VERTICES_PER_TRIANGLE; v++) {
    const from = v * COMPONENTS_PER_CPU_POSITION;
    const to = v * AXES;
    units[to] = Math.round(
      (answer.positions[from]! - localOriginX) * POSITION_XZ_UNITS_PER_WORLD_UNIT,
    );
    units[to + 1] = Math.round(answer.positions[from + 1]! * POSITION_Y_UNITS_PER_WORLD_UNIT);
    units[to + 2] = Math.round(
      (answer.positions[from + 2]! - localOriginZ) * POSITION_XZ_UNITS_PER_WORLD_UNIT,
    );
  }
  return { count: triangles, units };
}

const NEIGHBOUR_OFFSETS: readonly (readonly [string, number, number])[] = [
  ['west', -1, 0], ['east', 1, 0], ['north', 0, -1], ['south', 0, 1],
  ['nw', -1, -1], ['ne', 1, -1], ['sw', -1, 1], ['se', 1, 1],
];

function chunkFacts(mirror: TerrainMirror, chunkIdx: number): MesherDumpFacts | null {
  const chunkCols = chunksPerEdge(mirror.map.size);
  const cx = chunkIdx % chunkCols;
  const cy = (chunkIdx - cx) / chunkCols;
  const entry = extractWindowEntry(mirror, chunkIdx);
  if (entry === OVER_BUDGET) return null;
  const neighbours: Record<string, boolean> = {};
  for (const [name, dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = cx + dx;
    const ny = cy + dy;
    neighbours[name] =
      nx >= 0 && ny >= 0 && nx < chunkCols && ny < chunkCols &&
      mirror.received.has(ny * chunkCols + nx);
  }
  const latticeBands: number[] = [];
  for (let at = 0; at < LATTICE_PER_CHUNK * LATTICE_PER_CHUNK; at++) {
    latticeBands.push(drawnBandOfSample(entry.lattice[at]!));
  }
  return {
    chunkIdx, cx, cy,
    layered: entry.layered,
    exposed: entry.exposed,
    chunkLowestBand: entry.chunkLowestBand,
    highestBand: entry.highestBand,
    neighbours,
    latticeBands,
  };
}

/** One mesh over several chunks' CPU triangles, with the chunk each triangle came from.
 *  Unreceived chunks are skipped: the CPU mesher would build them, but nothing draws them. */
function cpuMeshOf(mirror: TerrainMirror, chunkIdxs: readonly number[]): {
  mesh: Mesh;
  owner: Int32Array;
} {
  const source = createDirectChunkBuildSource();
  const parts: { positions: Float32Array; chunkIdx: number }[] = [];
  let vertices = 0;
  for (const chunkIdx of chunkIdxs) {
    if (!mirror.received.has(chunkIdx)) continue;
    const answer = source.build(mirror, chunkIdx, 0);
    if (answer === null || answer instanceof Promise || answer.kind !== 'cpu') continue;
    const used = answer.positions.slice(0, answer.vertexCount * COMPONENTS_PER_CPU_POSITION);
    parts.push({ positions: used, chunkIdx });
    vertices += answer.vertexCount;
  }
  source.dispose();

  const positions = new Float32Array(vertices * COMPONENTS_PER_CPU_POSITION);
  const owner = new Int32Array(vertices / VERTICES_PER_TRIANGLE);
  let at = 0;
  let triangle = 0;
  for (const part of parts) {
    positions.set(part.positions, at * COMPONENTS_PER_CPU_POSITION);
    const count = part.positions.length / (COMPONENTS_PER_CPU_POSITION * VERTICES_PER_TRIANGLE);
    owner.fill(part.chunkIdx, triangle, triangle + count);
    at += part.positions.length / COMPONENTS_PER_CPU_POSITION;
    triangle += count;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, COMPONENTS_PER_CPU_POSITION));
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  mesh.updateMatrixWorld();
  return { mesh, owner };
}

export function installMesherDump(sources: MesherDumpSources): () => void {
  const built = (): number[] => {
    const meshes = sources.meshes();
    if (meshes === null) return [];
    const out: number[] = [];
    for (const layout of meshes.arenaLayout()) {
      for (const slot of layout.slots) out.push(slot.chunkIdx);
    }
    return out.sort((a, b) => a - b);
  };

  const chunk = async (chunkIdx: number): Promise<MesherDumpReport | string> => {
    const mirror = sources.mirror();
    const meshes = sources.meshes();
    if (mirror === null || meshes === null) return 'the world has no terrain yet';
    const backend = sources.renderer.backend as unknown as WebGpuBackendInternals;
    const device = backend.device;
    if (backend.isWebGPUBackend !== true || device === undefined) {
      return 'the renderer is not running the WebGPU backend';
    }

    const chunkCols = chunksPerEdge(mirror.map.size);
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;

    sources.store()?.commit();
    const layout = meshes.arenaLayout();
    const pickables = meshes.pickables();
    let slot: { offset: number; count: number; capacity: number } | null = null;
    let superAt = -1;
    for (let i = 0; i < layout.length && slot === null; i++) {
      for (const candidate of layout[i]!.slots) {
        if (candidate.chunkIdx !== chunkIdx) continue;
        slot = { offset: candidate.offset, count: candidate.count, capacity: candidate.capacity };
        superAt = i;
        break;
      }
    }
    const mesh = superAt === -1 ? undefined : pickables[superAt];
    if (slot === null || mesh === undefined) return `chunk ${String(chunkIdx)} has no arena slot`;
    const localOriginX = mesh.position.x;
    const localOriginZ = mesh.position.z;
    // Interleaved attributes keep their GPU buffer on the InterleavedBuffer they share
    // (WebGPUAttributeUtils._getBufferAttribute), which is what the store injects into.
    const positionAttribute = mesh.geometry.getAttribute('position');
    const positions = backend.get(
      'isInterleavedBufferAttribute' in positionAttribute ? positionAttribute.data : positionAttribute,
    ).buffer;
    if (positions === undefined) return `arena super-mesh ${String(superAt)} has no GPU buffer`;

    const gpu = await readGpuSlot(device, positions, slot.offset, slot.count);
    const cpu = buildCpuTriangles(mirror, chunkIdx, localOriginX, localOriginZ);

    let rebuild: { kind: string; vertexCount: number } | null = null;
    if (sources.gpuMesher !== null) {
      const answer = await sources.gpuMesher.build(mirror, chunkIdx, 0);
      if (answer !== null) {
        rebuild = { kind: answer.kind, vertexCount: answer.vertexCount };
        if (answer.kind === 'gpu') answer.gpu.release();
      }
    }

    const originCellX = cx * CHUNK_SIZE;
    const originCellZ = cy * CHUNK_SIZE;
    const byLevel = new Map<string, Areas>();
    const bySquare = new Map<string, Areas>();
    const totals: Areas = { gpuCap: 0, cpuCap: 0, gpuRiser: 0, cpuRiser: 0 };
    const note = (set: TriangleSet, side: 'gpu' | 'cpu'): void => {
      for (let t = 0; t < set.count; t++) {
        const at = t * UNITS_PER_TRIANGLE;
        const area = triangleArea(set.units, at);
        const field = isCap(set.units, at) ? `${side}Cap` : `${side}Riser`;
        let sumX = 0;
        let sumZ = 0;
        for (let v = 0; v < VERTICES_PER_TRIANGLE; v++) {
          sumX += worldXz(set.units[at + v * AXES]!);
          sumZ += worldXz(set.units[at + v * AXES + 2]!);
        }
        const lx = Math.floor(
          (sumX / VERTICES_PER_TRIANGLE + localOriginX) / CELL_WORLD_SIZE - originCellX,
        );
        const lz = Math.floor(
          (sumZ / VERTICES_PER_TRIANGLE + localOriginZ) / CELL_WORLD_SIZE - originCellZ,
        );
        const key = field as keyof Areas;
        totals[key] += area;
        areasAt(byLevel, String(worldY(levelOf(set.units, at))))[key] += area;
        areasAt(bySquare, `${String(lx)},${String(lz)}`)[key] += area;
      }
    };
    note(gpu, 'gpu');
    note(cpu, 'cpu');

    const disagreeingSquares = [...bySquare]
      .filter(([, areas]) => disagrees(areas))
      .map(([key, areas]) => ({ key, ...areas }))
      .sort((a, b) => shortfall(b) - shortfall(a));
    const worstSquare = disagreeingSquares[0]?.key ?? null;
    const missingExamples: MesherDumpExample[] = [];
    for (let t = 0; t < cpu.count && missingExamples.length < DUMP_EXAMPLE_LIMIT; t++) {
      const at = t * UNITS_PER_TRIANGLE;
      if (isCap(cpu.units, at)) continue;
      let sumX = 0;
      let sumZ = 0;
      for (let v = 0; v < VERTICES_PER_TRIANGLE; v++) {
        sumX += worldXz(cpu.units[at + v * AXES]!);
        sumZ += worldXz(cpu.units[at + v * AXES + 2]!);
      }
      const lx = Math.floor(
        (sumX / VERTICES_PER_TRIANGLE + localOriginX) / CELL_WORLD_SIZE - originCellX,
      );
      const lz = Math.floor(
        (sumZ / VERTICES_PER_TRIANGLE + localOriginZ) / CELL_WORLD_SIZE - originCellZ,
      );
      if (`${String(lx)},${String(lz)}` !== worstSquare) continue;
      missingExamples.push(exampleAt(cpu.units, at));
    }

    return {
      chunkIdx,
      cx,
      cy,
      localOriginX,
      localOriginZ,
      slot,
      rebuild,
      gpuTriangles: gpu.count,
      cpuTriangles: cpu.count,
      gpuBox: worldBox(gpu, localOriginX, localOriginZ),
      cpuBox: worldBox(cpu, localOriginX, localOriginZ),
      totals,
      byLevel: [...byLevel]
        .map(([key, areas]) => ({ key, ...areas }))
        .sort((a, b) => Number(a.key) - Number(b.key)),
      disagreeingSquares,
      missingExamples,
    };
  };

  /** First CPU triangle each pixel's camera ray meets, over `chunkIdxs` only. */
  const hits = (
    chunkIdxs: readonly number[],
    pixels: readonly (readonly [number, number])[],
  ): MesherDumpHitReport | string => {
    const mirror = sources.mirror();
    if (mirror === null) return 'the world has no terrain yet';
    const chunkCols = chunksPerEdge(mirror.map.size);
    const { mesh, owner } = cpuMeshOf(mirror, chunkIdxs);
    const buffer = sources.renderer.domElement;
    const width = buffer.width;
    const height = buffer.height;
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const position = mesh.geometry.getAttribute('position');

    const found: (MesherDumpHit | null)[] = [];
    for (const [px, py] of pixels) {
      ndc.set(((px + HALF_PIXEL) / width) * 2 - 1, -(((py + HALF_PIXEL) / height) * 2 - 1));
      raycaster.setFromCamera(ndc, sources.camera);
      const first = raycaster.intersectObject(mesh, false)[0];
      const face = first?.faceIndex ?? null;
      if (first === undefined || face === null) {
        found.push(null);
        continue;
      }
      const base = face * VERTICES_PER_TRIANGLE;
      const y = [0, 1, 2].map((v) => position.getY(base + v));
      const x = [0, 1, 2].map((v) => position.getX(base + v));
      const z = [0, 1, 2].map((v) => position.getZ(base + v));
      const flat = y[0] === y[1] && y[1] === y[2];
      const chunkIdx = owner[face]!;
      const originCellX = (chunkIdx % chunkCols) * CHUNK_SIZE;
      const originCellZ = ((chunkIdx - (chunkIdx % chunkCols)) / chunkCols) * CHUNK_SIZE;
      found.push({
        px, py, chunkIdx,
        lx: Math.floor(first.point.x / CELL_WORLD_SIZE) - originCellX,
        lz: Math.floor(first.point.z / CELL_WORLD_SIZE) - originCellZ,
        y: first.point.y,
        band: Math.round(Math.max(...y) / BAND_WORLD_HEIGHT),
        kind: flat ? 'cap' : 'riser',
        facing: Math.sign(
          (x[1]! - x[0]!) * (z[2]! - z[0]!) - (z[1]! - z[0]!) * (x[2]! - x[0]!),
        ),
        distance: first.distance,
      });
    }
    mesh.geometry.dispose();
    (mesh.material as MeshBasicMaterial).dispose();

    const chunks: MesherDumpFacts[] = [];
    for (const chunkIdx of chunkIdxs) {
      const facts = chunkFacts(mirror, chunkIdx);
      if (facts !== null) chunks.push(facts);
    }
    return {
      drawingBuffer: [width, height],
      chunks,
      triangles: owner.length,
      hits: found,
    };
  };

  const holder = globalThis as unknown as Record<string, unknown>;
  holder[DUMP_HANDLE] = { chunk, built, hits };
  return () => {
    delete holder[DUMP_HANDLE];
  };
}
