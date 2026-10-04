import { chunkIndexOfCell, computeRiverNetwork } from '@terrace/shared';
import { type TerrainMirror } from '../../terrain/mirror.ts';
import { flattenRiverNetwork, type RiverSurface } from './riverSurface.ts';
import type {
  RiverNetworkRequest,
  RiverNetworkResponse,
} from './riverNetworkWorker.ts';

export interface RiverNetworkSource {
  compute(mirror: TerrainMirror): RiverSurface | Promise<RiverSurface>;
  dispose(): void;
}

function receivedChunks(mirror: TerrainMirror): number[] {
  return Array.from(mirror.received);
}

function computeOnMainThread(mirror: TerrainMirror): RiverSurface {
  return flattenRiverNetwork(
    mirror.map,
    computeRiverNetwork(mirror.map, {
      isActive: (x, y) => mirror.received.has(chunkIndexOfCell(mirror.map.size, x, y)),
    }),
  );
}

export const directRiverNetworkSource: RiverNetworkSource = {
  compute: computeOnMainThread,
  dispose(): void {},
};

export function createWorkerRiverNetworkSource(): RiverNetworkSource | null {
  if (typeof Worker === 'undefined') return null;

  let worker: Worker;
  try {
    worker = new Worker(new URL('./riverNetworkWorker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    return null;
  }

  let nextRequestId = 1;
  const pending = new Map<
    number,
    { readonly mirror: TerrainMirror; readonly resolve: (surface: RiverSurface) => void }
  >();
  let dead = false;

  // A dead worker answers what it owed on the main thread: slower, never stalled.
  const killWorker = (cause: string): void => {
    if (dead) return;
    dead = true;
    console.warn(`[terrace] river network worker died (${cause}); computing without it`);
    worker.terminate();
    const owed = [...pending.values()];
    pending.clear();
    for (const { mirror, resolve } of owed) resolve(computeOnMainThread(mirror));
  };

  worker.onmessage = (event: MessageEvent<RiverNetworkResponse>): void => {
    const job = pending.get(event.data.requestId);
    if (job === undefined) return;
    pending.delete(event.data.requestId);
    job.resolve(event.data.surface);
  };
  worker.onerror = (): void => killWorker('error');
  worker.onmessageerror = (): void => killWorker('messageerror');

  return {
    compute(mirror: TerrainMirror): RiverSurface | Promise<RiverSurface> {
      if (dead) return computeOnMainThread(mirror);
      const requestId = nextRequestId++;
      const cells = mirror.map.cells.slice();
      const request: RiverNetworkRequest = {
        requestId,
        size: mirror.map.size,
        cells,
        received: receivedChunks(mirror),
      };
      const answer = new Promise<RiverSurface>((resolve) => {
        pending.set(requestId, { mirror, resolve });
      });
      try {
        worker.postMessage(request, [cells.buffer]);
      } catch {
        killWorker('postMessage');
      }
      return answer;
    },
    dispose(): void {
      pending.clear();
      worker.terminate();
    },
  };
}
