// Where a chunk's geometry is built — a strategy, so render/terrainMeshes.ts
// does not have to know whether the answer arrives on this thread or another.
//
// The pattern is render/water/riverNetworkSource.ts's, deliberately: one
// interface, a direct implementation that answers synchronously and a
// worker-backed one that answers with a promise, and a caller that treats the
// two identically. There is one chunk build, not a fast one and a test one.
//
//   * `createDirectChunkBuildSource` runs the job inline over the LIVE mirror.
//     It is what vitest gets (node has no `Worker`), what the six preview-*
//     harnesses get, and what any caller that wants the world complete before
//     it looks at it gets.
//   * `createWorkerChunkBuildSource` posts each chunk's own window to a small
//     pool and answers with a promise. This is what the client uses: a chunk
//     build is ~6 ms on a developed world against a 7.1 ms frame budget, and
//     the pipeline is not resumable mid-chunk, so no frame budget can make one
//     chunk cost less than one chunk.
//
// POOL OF TWO. A radius-4 brush straddles at most two chunks at once, so two
// threads cover the stroke's own parallelism; the jobs are stateless, so a
// larger pool costs nothing but threads and buys nothing. `dispose` terminates
// them.

import { createChunkGeometryBuffers } from '../terrain/capEmission.ts';
import {
  buildChunkAnswer,
  chunkRequestTransfers,
  extractChunkWindow,
  type ChunkJobAnswer,
  type ChunkJobRequest,
} from '../terrain/chunkJob.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';

export interface ChunkBuildSource {
  /**
   * Builds one chunk. The mirror is read HERE, at request time — an
   * implementation that defers takes its own copy of the window rather than
   * holding the live mirror, which is what the worker source does.
   */
  build(
    mirror: TerrainMirror,
    chunkIdx: number,
    generation: number,
  ): ChunkJobAnswer | Promise<ChunkJobAnswer>;
  /**
   * How many builds may be outstanding at once. One for the direct source,
   * whose answer is already finished by the time `build` returns.
   */
  readonly concurrency: number;
  dispose(): void;
}

/** Workers in the pool — two, because a brush straddles at most two chunks. */
const CHUNK_WORKER_POOL_SIZE = 2;

export function createDirectChunkBuildSource(): ChunkBuildSource {
  // One scratch for the whole world, exactly as the inline builder kept one:
  // emission is synchronous and its result is copied out before the next chunk
  // is emitted.
  const scratch = createChunkGeometryBuffers();
  return {
    concurrency: 1,
    build(mirror, chunkIdx, generation): ChunkJobAnswer {
      return buildChunkAnswer(mirror, scratch, chunkIdx, generation).answer;
    },
    dispose(): void {},
  };
}

/**
 * The worker-backed source, or `null` where there is no `Worker` — a node test
 * run, or a browser that failed to start one. A null return is the caller's cue
 * to use the direct source: the terrain is still correct there, it is merely
 * built on the thread that draws it.
 */
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
    // A worker can fail to start for reasons that have nothing to do with this
    // code (a strict CSP, module workers disabled). Building on the main
    // thread is the right degradation: slower, never wrong.
    for (const worker of workers) worker.terminate();
    return null;
  }

  /** Per worker, the resolvers it still owes, oldest first. */
  const owed = workers.map(() => [] as ((answer: ChunkJobAnswer) => void)[]);

  workers.forEach((worker, index) => {
    worker.onmessage = (event: MessageEvent<ChunkJobAnswer>): void => {
      // FIFO within one worker: `onmessage` fires in post order, so the oldest
      // resolver this worker owes is this answer's.
      const resolve = owed[index]!.shift();
      resolve?.(event.data);
    };
  });

  return {
    concurrency: CHUNK_WORKER_POOL_SIZE,
    build(mirror, chunkIdx, generation): Promise<ChunkJobAnswer> {
      // LEAST LOADED, not round robin: a stroke's two chunks differ wildly in
      // cost, and handing the second to a worker already several jobs deep
      // would make the cheap chunk wait behind the expensive one.
      let index = 0;
      for (let i = 1; i < owed.length; i++) {
        if (owed[i]!.length < owed[index]!.length) index = i;
      }
      const request: ChunkJobRequest = extractChunkWindow(mirror, chunkIdx, generation);
      const answer = new Promise<ChunkJobAnswer>((resolve) => {
        owed[index]!.push(resolve);
      });
      workers[index]!.postMessage(request, chunkRequestTransfers(request));
      return answer;
    },
    dispose(): void {
      for (const queue of owed) queue.length = 0;
      for (const worker of workers) worker.terminate();
    },
  };
}
