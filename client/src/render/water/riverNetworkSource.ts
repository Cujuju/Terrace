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

export const directRiverNetworkSource: RiverNetworkSource = {
  compute(mirror: TerrainMirror): RiverSurface {
    return flattenRiverNetwork(
      mirror.map,
      computeRiverNetwork(mirror.map, {
        isActive: (x, y) => mirror.received.has(chunkIndexOfCell(mirror.map.size, x, y)),
      }),
    );
  },
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
  const pending = new Map<number, (surface: RiverSurface) => void>();

  worker.onmessage = (event: MessageEvent<RiverNetworkResponse>): void => {
    const resolve = pending.get(event.data.requestId);
    if (resolve === undefined) return;
    pending.delete(event.data.requestId);
    resolve(event.data.surface);
  };

  return {
    compute(mirror: TerrainMirror): Promise<RiverSurface> {
      const requestId = nextRequestId++;
      const cells = mirror.map.cells.slice();
      const request: RiverNetworkRequest = {
        requestId,
        size: mirror.map.size,
        cells,
        received: receivedChunks(mirror),
      };
      const answer = new Promise<RiverSurface>((resolve) => {
        pending.set(requestId, resolve);
      });
      worker.postMessage(request, [cells.buffer]);
      return answer;
    },
    dispose(): void {
      pending.clear();
      worker.terminate();
    },
  };
}
