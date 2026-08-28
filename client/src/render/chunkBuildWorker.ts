// One chunk's geometry, built off the main thread.
//
// The module is a shell. Everything it does is the chunk job from
// terrain/chunkJob.ts — the SAME code the direct source runs on the main
// thread, over a mirror this thread reconstructs from the job's own window. See
// that module's header for why the job is stateless and what its window
// contains.
//
// THE WORKSPACE IS PER WORKER and long-lived: one mirror of the world's size
// and one geometry scratch, reused across jobs for the same amortisation reason
// the main thread's scratch is reused. It is rebuilt when a request names a
// different world size, which is the only way a worker can be handed a
// different world (the pool is not torn down on a rejoin at the same size).

import {
  buildChunkAnswer,
  chunkJobTransfers,
  createChunkJobWorkspace,
  loadWindow,
  type ChunkJobAnswer,
  type ChunkJobRequest,
  type ChunkJobWorkspace,
} from '../terrain/chunkJob.ts';

let workspace: ChunkJobWorkspace | null = null;

self.onmessage = (event: MessageEvent<ChunkJobRequest>): void => {
  const request = event.data;
  if (workspace === null || workspace.mirror.map.size !== request.worldSize) {
    workspace = createChunkJobWorkspace(request.worldSize);
  }
  const mirror = loadWindow(workspace, request);
  const { answer } = buildChunkAnswer(
    mirror,
    workspace.scratch,
    request.chunkIdx,
    request.generation,
  );
  (self as unknown as Worker).postMessage(answer, chunkJobTransfers(answer));
};
