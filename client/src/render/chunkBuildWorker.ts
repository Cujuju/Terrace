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
