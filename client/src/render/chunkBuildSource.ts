import { createChunkGeometryBuffers } from '../terrain/capEmission.ts';
import {
  buildChunkAnswer,
  chunkRequestTransfers,
  extractChunkWindow,
  type ChunkJobAnswer,
  type ChunkJobRequest,
} from '../terrain/chunkJob.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import type { ChunkGpuAnswer } from './gpuMesher/gpuChunkAnswer.ts';

export type ChunkAnswer = ChunkJobAnswer | ChunkGpuAnswer;

/** Built-or-building answers held at once: two frames of splices (~4 per 1.5 ms) at ~1.6 MB each. */
export const CHUNK_ANSWER_BACKLOG_CAP = 8;

export interface ChunkBuildSource {
  build(
    mirror: TerrainMirror,
    chunkIdx: number,
    generation: number,
  ): ChunkAnswer | null | Promise<ChunkAnswer | null>;
  readonly concurrency: number;
  /** Answers held (in flight + ready) before the arena stops submitting; default CHUNK_ANSWER_BACKLOG_CAP. */
  readonly backlogCap?: number;
  dispose(): void;
}

const CHUNK_WORKER_POOL_SIZE = 2;

export function createDirectChunkBuildSource(): ChunkBuildSource {
  const scratch = createChunkGeometryBuffers();
  return {
    concurrency: 1,
    backlogCap: CHUNK_ANSWER_BACKLOG_CAP,
    build(mirror, chunkIdx, generation): ChunkJobAnswer {
      return buildChunkAnswer(mirror, scratch, chunkIdx, generation).answer;
    },
    dispose(): void {},
  };
}

export function createWorkerChunkBuildSource(): ChunkBuildSource | null {
  if (typeof Worker === 'undefined') return null;

  const workers: Worker[] = [];
  try {
    for (let i = 0; i < CHUNK_WORKER_POOL_SIZE; i++) {
      workers.push(
        new Worker(new URL('./chunkBuildWorker.ts', import.meta.url), { type: 'module' }),
      );
    }
  } catch {
    for (const worker of workers) worker.terminate();
    return null;
  }

  const owed = workers.map(() => [] as ((answer: ChunkJobAnswer | null) => void)[]);

  const dead = workers.map(() => false);

  let fallback: ChunkBuildSource | null = null;

  const killWorker = (index: number, cause: string): void => {
    if (dead[index]) return;
    dead[index] = true;
    console.warn(`[terrace] chunk build worker ${index} died (${cause}); rebuilding without it`);
    const queue = owed[index]!;
    const owedNow = queue.splice(0, queue.length);
    workers[index]!.terminate();
    for (const resolve of owedNow) resolve(null);
  };

  workers.forEach((worker, index) => {
    worker.onmessage = (event: MessageEvent<ChunkJobAnswer>): void => {
      const resolve = owed[index]!.shift();
      resolve?.(event.data);
    };
    worker.onerror = (): void => killWorker(index, 'error');
    worker.onmessageerror = (): void => killWorker(index, 'messageerror');
  });

  return {
    concurrency: CHUNK_WORKER_POOL_SIZE,
    backlogCap: CHUNK_ANSWER_BACKLOG_CAP,
    build(mirror, chunkIdx, generation): ChunkAnswer | null | Promise<ChunkAnswer | null> {
      let index = -1;
      for (let i = 0; i < owed.length; i++) {
        if (dead[i]) continue;
        if (index === -1 || owed[i]!.length < owed[index]!.length) index = i;
      }
      if (index === -1) {
        fallback ??= createDirectChunkBuildSource();
        return fallback.build(mirror, chunkIdx, generation);
      }
      const request: ChunkJobRequest = extractChunkWindow(mirror, chunkIdx, generation);
      const answer = new Promise<ChunkJobAnswer | null>((resolve) => {
        owed[index]!.push(resolve);
      });
      try {
        workers[index]!.postMessage(request, chunkRequestTransfers(request));
      } catch {
        owed[index]!.pop()?.(null);
      }
      return answer;
    },
    dispose(): void {
      for (const queue of owed) {
        for (const resolve of queue.splice(0, queue.length)) resolve(null);
      }
      for (const worker of workers) worker.terminate();
      fallback?.dispose();
    },
  };
}
