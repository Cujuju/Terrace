import { WebGPURenderer } from 'three/webgpu';
import { createDirectChunkBuildSource } from '../src/render/chunkBuildSource.ts';
import { createGpuChunkBuildSource } from '../src/render/gpuMesher/gpuChunkBuildSource.ts';
import {
  GOLDEN_WORLD_NAMES,
  fixtureChunkCount,
  fixtureMirror,
  type GoldenWorldName,
} from './support/mesherFixtures.ts';

// THROWAWAY probe, reached only by navigating to preview-mesher-parity.html.
// No headless WebGPU exists, so CPU/GPU mesher parity over the golden fixtures
// is answered here and read back through `window.__parityReport`.

interface ChunkRow {
  readonly chunkIdx: number;
  readonly cpu: number;
  readonly gpu: number;
}

interface FixtureRow {
  readonly world: GoldenWorldName;
  readonly chunks: number;
  readonly cpuVertices: number;
  readonly gpuVertices: number;
  readonly disagreeing: readonly ChunkRow[];
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: false });
renderer.setSize(1, 1, false);
await renderer.init();

const cpuSource = createDirectChunkBuildSource();
const gpuSource = await createGpuChunkBuildSource(renderer, cpuSource);

async function measure(world: GoldenWorldName): Promise<FixtureRow> {
  const mirror = fixtureMirror(world);
  const chunks = fixtureChunkCount(mirror);
  const disagreeing: ChunkRow[] = [];
  let cpuVertices = 0;
  let gpuVertices = 0;
  for (let chunkIdx = 0; chunkIdx < chunks; chunkIdx++) {
    const cpuAnswer = cpuSource.build(mirror, chunkIdx, 0);
    if (cpuAnswer === null || cpuAnswer instanceof Promise || cpuAnswer.kind !== 'cpu') {
      throw new Error(`${world} chunk ${String(chunkIdx)} did not build on the CPU`);
    }
    const gpuAnswer = await gpuSource!.build(mirror, chunkIdx, 0);
    if (gpuAnswer === null || gpuAnswer.kind !== 'gpu') {
      throw new Error(`${world} chunk ${String(chunkIdx)} fell back off the GPU`);
    }
    const cpu = cpuAnswer.vertexCount;
    const gpu = gpuAnswer.vertexCount;
    gpuAnswer.gpu.release();
    cpuVertices += cpu;
    gpuVertices += gpu;
    if (cpu !== gpu) disagreeing.push({ chunkIdx, cpu, gpu });
  }
  return { world, chunks, cpuVertices, gpuVertices, disagreeing };
}

const rows: FixtureRow[] = [];
let failure: string | null = null;
try {
  if (gpuSource === null) throw new Error('the GPU mesher demoted; see the console');
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
