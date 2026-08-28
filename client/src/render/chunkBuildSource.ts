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
//
// A JOB THAT WILL NEVER ANSWER IS THE FAILURE THAT MATTERS, because the caller
// holds an in-flight slot per outstanding job and two lost slots across a pool
// of two stop the terrain updating with no error anywhere. So `build` answers
// with `null` rather than hanging or rejecting (see its doc comment), and every
// way a job can be lost is wired to produce one: an uncaught throw or an
// unloadable script (`onerror`), an undeserialisable answer (`onmessageerror`),
// a synchronous `postMessage` throw, and `dispose`. A worker that dies is
// terminated and dropped from the rotation; if all of them die, builds run on
// this thread, which is the same degradation as starting with no `Worker` at
// all.
//
// RESIDUAL, named: a worker that neither answers nor errors — an infinite loop
// inside the job — is invisible to this file and would still hold its slots.
// Nothing short of a per-job timeout detects it, and a timeout on a build whose
// honest cost is ~6 ms but can be tens of ms on a stalled machine is a
// false-positive generator; the job is deterministic, terminating code over a
// bounded window, so the loop would be a bug in the marcher rather than a
// condition to tolerate.

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
   *
   * FAILURE CONTRACT: `null` — synchronously or as the promise's value —
   * means "this build produced nothing; the chunk is not built". It NEVER
   * rejects and it never simply fails to settle, because a promise that never
   * settles would hold the caller's in-flight slot for the rest of the
   * session (render/terrainMeshes.ts's `inFlight`), and two of those across a
   * pool of two stop the terrain updating altogether. The caller releases the
   * slot and re-queues the chunk, so a later drain retries it; the chunk goes
   * on drawing its previous geometry meanwhile, exactly as a chunk waiting its
   * turn does.
   */
  build(
    mirror: TerrainMirror,
    chunkIdx: number,
    generation: number,
  ): ChunkJobAnswer | null | Promise<ChunkJobAnswer | null>;
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
  const owed = workers.map(() => [] as ((answer: ChunkJobAnswer | null) => void)[]);

  /**
   * Per worker, whether it has been given up on. A dead worker is terminated
   * and skipped by the dispatcher; it is never revived, because everything that
   * kills one (a script that will not load, a module the CSP blocks, a bug that
   * throws out of the job) is a permanent condition, and a live retry loop
   * against a dead thread is a spin, not a recovery.
   */
  const dead = workers.map(() => false);

  /**
   * The this-thread source, made only if the whole pool dies. Lazy because in
   * the overwhelmingly common case it is never needed and it owns a full
   * chunk's worth of scratch buffers.
   */
  let fallback: ChunkBuildSource | null = null;

  /**
   * Gives up on one worker: settles everything it owed with the documented
   * `null` failure so no caller's in-flight slot is held for ever, and takes it
   * out of the rotation.
   *
   * WHY THE OWED JOBS ARE SETTLED RATHER THAN LEFT: `error` on a Worker means
   * the job that was running is not coming back, and every job queued behind it
   * on the same thread is not coming back either. The caller re-queues each one
   * and a later drain builds it — on a surviving worker, or on this thread once
   * the pool is empty.
   */
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
      // FIFO within one worker: `onmessage` fires in post order, so the oldest
      // resolver this worker owes is this answer's.
      const resolve = owed[index]!.shift();
      resolve?.(event.data);
    };
    // An uncaught throw inside the job, or a script/module that never loaded —
    // the browser fires `error` at the Worker object for both, which is what
    // makes a job that will never answer detectable at all.
    worker.onerror = (): void => killWorker(index, 'error');
    // The answer could not be deserialised on this side. The job is lost the
    // same way, and a worker that has posted one undeserialisable answer is not
    // trustworthy for the next.
    worker.onmessageerror = (): void => killWorker(index, 'messageerror');
  });

  return {
    concurrency: CHUNK_WORKER_POOL_SIZE,
    build(mirror, chunkIdx, generation): ChunkJobAnswer | null | Promise<ChunkJobAnswer | null> {
      // LEAST LOADED among the LIVE workers, not round robin: a stroke's two
      // chunks differ wildly in cost, and handing the second to a worker
      // already several jobs deep would make the cheap chunk wait behind the
      // expensive one.
      let index = -1;
      for (let i = 0; i < owed.length; i++) {
        if (dead[i]) continue;
        if (index === -1 || owed[i]!.length < owed[index]!.length) index = i;
      }
      if (index === -1) {
        // THE WHOLE POOL IS GONE. Building on the thread that draws is the same
        // degradation this module already takes when no worker can be started
        // at all: slower, never wrong — and it is a real build rather than a
        // `null` the caller would re-queue into a spin.
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
        // A synchronous throw — a DataCloneError on a request field that is not
        // transferable, an already-detached buffer. Nothing was posted, so this
        // worker owes no answer for it; take the resolver back off its queue
        // (it is the newest, hence pop) and settle it. The worker itself is
        // fine, so it stays in the rotation.
        owed[index]!.pop()?.(null);
      }
      return answer;
    },
    dispose(): void {
      // Settled, not merely dropped: a caller still awaiting one of these would
      // otherwise hold its in-flight slot for ever. The answers are discarded
      // anyway — a dispose is a world replacement, and the generation stamp
      // makes anything from the old world unspliceable.
      for (const queue of owed) {
        for (const resolve of queue.splice(0, queue.length)) resolve(null);
      }
      for (const worker of workers) worker.terminate();
      fallback?.dispose();
    },
  };
}
