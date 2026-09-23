import { WebGPURenderer } from 'three/webgpu';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import { createDirectChunkBuildSource } from '../src/render/chunkBuildSource.ts';
import {
  GPU_POSITION_BYTES_PER_VERTEX,
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  POSITION_Y_UNITS_PER_WORLD_UNIT,
} from '../src/render/gpuMesher/gpuChunkAnswer.ts';
import { createGpuChunkBuildSource } from '../src/render/gpuMesher/gpuChunkBuildSource.ts';
import { CHUNK_SIZE, chunksPerEdge } from '@terrace/shared';
import { OVER_BUDGET, extractWindowEntry } from '../src/render/gpuMesher/terrainGpuInputs.ts';
import { VERTICES_PER_TRIANGLE } from '../src/terrain/vertexGrid.ts';
import {
  GOLDEN_WORLD_NAMES,
  fixtureChunkCount,
  fixtureMirror,
  type GoldenWorldName,
} from './support/mesherFixtures.ts';

// THROWAWAY probe for preview-mesher-parity.html: no headless WebGPU exists,
// so CPU/GPU parity over the golden fixtures is answered here.

// The GPU's vertexCount is the count pass's upper bound; unfilled slots go
// degenerate. Area is what the two tessellations share, as in mesherDump.ts.

const AXES = 3;
const UNITS_PER_TRIANGLE = VERTICES_PER_TRIANGLE * AXES;

/** Triangles sharing one y are caps; anything else is a wall. */
const CAP_TRIANGLE_Y_SPREAD_UNITS = 0;

/**
 * Per-chunk area drift the snorm16 positions alone explain: the y quantum is
 * 1/64 of a world unit over thousands of triangles. Measured max is 0.013.
 */
const SNORM16_AREA_DRIFT_WORLD_UNITS = 0.05;

interface ChunkRow {
  readonly chunkIdx: number;
  readonly layered: boolean;
  readonly exposed: boolean;
  readonly cpuVertices: number;
  readonly gpuCounted: number;
  readonly gpuDrawn: number;
  readonly cpuCap: number;
  readonly gpuCap: number;
  readonly cpuWall: number;
  readonly gpuWall: number;
}

interface FixtureRow {
  readonly world: GoldenWorldName;
  readonly chunks: number;
  readonly cpuVertices: number;
  readonly gpuCounted: number;
  readonly gpuDrawn: number;
  readonly capArea: readonly [number, number];
  readonly wallArea: readonly [number, number];
  readonly buriedCapCulled: number;
  readonly disagreeing: readonly ChunkRow[];
}

const worldXz = (units: number): number => units / POSITION_XZ_UNITS_PER_WORLD_UNIT;
const worldY = (units: number): number => units / POSITION_Y_UNITS_PER_WORLD_UNIT;

function isCap(units: Int32Array, at: number): boolean {
  const y0 = units[at + 1]!;
  for (let v = 1; v < VERTICES_PER_TRIANGLE; v++) {
    if (Math.abs(units[at + v * AXES + 1]! - y0) > CAP_TRIANGLE_Y_SPREAD_UNITS) return false;
  }
  return true;
}

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

/** `[capArea, wallArea, drawnTriangles]`: degenerate slots carry no area. */
function areasOf(units: Int32Array, count: number): [number, number, number] {
  let cap = 0;
  let wall = 0;
  let drawn = 0;
  for (let t = 0; t < count; t++) {
    const at = t * UNITS_PER_TRIANGLE;
    const area = triangleArea(units, at);
    if (area === 0) continue;
    drawn++;
    if (isCap(units, at)) cap += area;
    else wall += area;
  }
  return [cap, wall, drawn];
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: false });
renderer.setSize(1, 1, false);
await renderer.init();
const device = (renderer.backend as unknown as { device?: GPUDevice }).device;

const cpuSource = createDirectChunkBuildSource();
const gpuSource = await createGpuChunkBuildSource(renderer, cpuSource);

async function readBack(positions: GPUBuffer, vertices: number): Promise<Int32Array> {
  const bytes = vertices * GPU_POSITION_BYTES_PER_VERTEX;
  const readback = device!.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device!.createCommandEncoder();
  encoder.copyBufferToBuffer(positions, 0, readback, 0, bytes);
  device!.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const packed = new Int16Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const components = GPU_POSITION_BYTES_PER_VERTEX / Int16Array.BYTES_PER_ELEMENT;
  const units = new Int32Array(vertices * AXES);
  for (let v = 0; v < vertices; v++) {
    units[v * AXES] = packed[v * components]!;
    units[v * AXES + 1] = packed[v * components + 1]!;
    units[v * AXES + 2] = packed[v * components + 2]!;
  }
  return units;
}

function cpuUnits(positions: Float32Array, vertices: number, ox: number, oz: number): Int32Array {
  const units = new Int32Array(vertices * AXES);
  for (let v = 0; v < vertices; v++) {
    units[v * AXES] = Math.round((positions[v * AXES]! - ox) * POSITION_XZ_UNITS_PER_WORLD_UNIT);
    units[v * AXES + 1] = Math.round(positions[v * AXES + 1]! * POSITION_Y_UNITS_PER_WORLD_UNIT);
    units[v * AXES + 2] = Math.round(
      (positions[v * AXES + 2]! - oz) * POSITION_XZ_UNITS_PER_WORLD_UNIT,
    );
  }
  return units;
}

async function measure(world: GoldenWorldName): Promise<FixtureRow> {
  const mirror = fixtureMirror(world);
  if (new URLSearchParams(location.search).get('surface') === 'binomial') mirror.surfaceMode = 'binomial';
  const chunks = fixtureChunkCount(mirror);
  const cols = chunksPerEdge(mirror.map.size);
  const disagreeing: ChunkRow[] = [];
  let cpuVertices = 0;
  let gpuCounted = 0;
  let gpuDrawn = 0;
  let cpuCapTotal = 0;
  let gpuCapTotal = 0;
  let cpuWallTotal = 0;
  let gpuWallTotal = 0;
  let buriedCapCulled = 0;

  for (let chunkIdx = 0; chunkIdx < chunks; chunkIdx++) {
    const cx = chunkIdx % cols;
    const cy = (chunkIdx - cx) / cols;
    const ox = cx * CHUNK_SIZE * CELL_WORLD_SIZE;
    const oz = cy * CHUNK_SIZE * CELL_WORLD_SIZE;

    const entry = extractWindowEntry(mirror, chunkIdx);
    if (entry === OVER_BUDGET) throw new Error(`${world} chunk ${String(chunkIdx)} is over budget`);
    const { layered, exposed } = entry;

    const cpuAnswer = cpuSource.build(mirror, chunkIdx, 0);
    if (cpuAnswer === null || cpuAnswer instanceof Promise || cpuAnswer.kind !== 'cpu') {
      throw new Error(`${world} chunk ${String(chunkIdx)} did not build on the CPU`);
    }
    const cpu = areasOf(
      cpuUnits(cpuAnswer.positions, cpuAnswer.vertexCount, ox, oz),
      Math.floor(cpuAnswer.vertexCount / VERTICES_PER_TRIANGLE),
    );

    const gpuAnswer = await gpuSource!.build(mirror, chunkIdx, 0);
    if (gpuAnswer === null || gpuAnswer.kind !== 'gpu') {
      throw new Error(`${world} chunk ${String(chunkIdx)} fell back off the GPU`);
    }
    const target = device!.createBuffer({
      size: Math.max(1, gpuAnswer.vertexCount) * GPU_POSITION_BYTES_PER_VERTEX,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const encoder = device!.createCommandEncoder();
    gpuAnswer.gpu.emit(encoder, { positions: target, localOriginX: ox, localOriginZ: oz }, 0);
    device!.queue.submit([encoder.finish()]);
    const gpu = areasOf(
      await readBack(target, gpuAnswer.vertexCount),
      Math.floor(gpuAnswer.vertexCount / VERTICES_PER_TRIANGLE),
    );
    target.destroy();
    gpuAnswer.gpu.release();

    cpuVertices += cpuAnswer.vertexCount;
    gpuCounted += gpuAnswer.vertexCount;
    gpuDrawn += gpu[2] * VERTICES_PER_TRIANGLE;
    cpuCapTotal += cpu[0];
    gpuCapTotal += gpu[0];
    cpuWallTotal += cpu[1];
    gpuWallTotal += gpu[1];

    // An unlayered, unexposed chunk skips caps buried under its own
    // corners. Less cap is that rule; more cap is never legal; walls
    // must match.
    const capGap = cpu[0] - gpu[0];
    const culls = !layered && !exposed;
    if (culls && capGap > SNORM16_AREA_DRIFT_WORLD_UNITS) buriedCapCulled += capGap;
    const capDisagrees = culls
      ? capGap < -SNORM16_AREA_DRIFT_WORLD_UNITS
      : Math.abs(capGap) > SNORM16_AREA_DRIFT_WORLD_UNITS;
    if (capDisagrees || Math.abs(cpu[1] - gpu[1]) > SNORM16_AREA_DRIFT_WORLD_UNITS) {
      disagreeing.push({
        chunkIdx,
        layered,
        exposed,
        cpuVertices: cpuAnswer.vertexCount,
        gpuCounted: gpuAnswer.vertexCount,
        gpuDrawn: gpu[2] * VERTICES_PER_TRIANGLE,
        cpuCap: cpu[0],
        gpuCap: gpu[0],
        cpuWall: cpu[1],
        gpuWall: gpu[1],
      });
    }
  }

  return {
    world,
    chunks,
    cpuVertices,
    gpuCounted,
    gpuDrawn,
    capArea: [cpuCapTotal, gpuCapTotal],
    wallArea: [cpuWallTotal, gpuWallTotal],
    buriedCapCulled,
    disagreeing,
  };
}

const rows: FixtureRow[] = [];
let failure: string | null = null;
try {
  if (gpuSource === null) throw new Error('the GPU mesher demoted; see the console');
  if (device === undefined) throw new Error('the WebGPU backend has no device');
  for (const world of GOLDEN_WORLD_NAMES) rows.push(await measure(world));
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}

cpuSource.dispose();
gpuSource?.dispose();

(window as unknown as { __parityReport?: unknown }).__parityReport = {
  failure,
  rows,
  agree: failure === null && rows.every((row) => row.disagreeing.length === 0),
};
(window as unknown as { __parityReady?: boolean }).__parityReady = true;
