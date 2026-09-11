import { CHUNK_SIZE, chunksPerEdge } from '@terrace/shared';
import type { Renderer } from 'three/webgpu';
import { CELL_WORLD_SIZE } from '../../config.ts';
import type { TerrainMirror } from '../../terrain/mirror.ts';
import { VERTICES_PER_TRIANGLE } from '../../terrain/vertexGrid.ts';
import type { ArenaStore } from '../arenaStore.ts';
import { createDirectChunkBuildSource } from '../chunkBuildSource.ts';
import type { TerrainMeshes } from '../terrainMeshes.ts';
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

export interface MesherDumpSources {
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
    const positions = backend.get(mesh.geometry.getAttribute('position')).buffer;
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

  const holder = globalThis as unknown as Record<string, unknown>;
  holder[DUMP_HANDLE] = { chunk, built };
  return () => {
    delete holder[DUMP_HANDLE];
  };
}
