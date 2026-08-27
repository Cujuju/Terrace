// Where the river network comes from — a strategy, so the rig does not have to
// know whether the answer arrives on this thread or another one.
//
// TWO IMPLEMENTATIONS, AND WHY BOTH ARE REAL:
//
//   * `directRiverNetworkSource` calls `computeRiverNetwork` inline and answers
//     synchronously. It is the DEFAULT, and it is what runs under vitest (node
//     has no `Worker` global) and in any harness that wants a rebuild to have
//     finished by the time the call returns.
//   * `createWorkerRiverNetworkSource` posts the terrain to a Web Worker
//     (render/water/riverNetworkWorker.ts) and answers with a promise. This is
//     what the client uses: ~24 ms of global scan-and-trace is over the whole
//     7.1 ms frame budget on its own.
//
// The rig treats a synchronous answer and a promised one identically, which is
// what keeps the two paths from drifting: there is one rebuild, not a fast one
// and a test one.

import { chunkIndexOfCell, computeRiverNetwork } from '@terrace/shared';
import { type TerrainMirror } from '../../terrain/mirror.ts';
import { flattenRiverNetwork, type RiverSurface } from './riverSurface.ts';
// TYPE-ONLY, and it must stay that way: a value import would EXECUTE the worker
// module on the main thread (its top level installs an `onmessage` handler on
// `self`, which does not exist in node). The worker is reached only through the
// `new Worker(new URL(...))` below.
import type {
  RiverNetworkRequest,
  RiverNetworkResponse,
} from './riverNetworkWorker.ts';

export interface RiverNetworkSource {
  /**
   * The water surface for the mirror's CURRENT terrain — the network, computed
   * and then flattened (riverSurface.ts). May answer synchronously (the direct
   * source) or with a promise (the worker source); the caller awaits either.
   *
   * The mirror is read HERE, at request time — an implementation that defers
   * must take its own copy rather than holding the live mirror, which is what
   * the worker source does.
   */
  compute(mirror: TerrainMirror): RiverSurface | Promise<RiverSurface>;
  dispose(): void;
}

/**
 * The client's own `isActive` mask: a cell counts only if its chunk has been
 * received. Stated once here so the main thread and the worker cannot disagree
 * about which cells a trace may cross.
 */
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

/**
 * The worker-backed source, or `null` where there is no `Worker` — a node test
 * run, or a browser that failed to start one. A null return is the caller's cue
 * to use `directRiverNetworkSource`: the water is still correct there, it is
 * merely computed on the thread that draws it.
 *
 * ONE REQUEST AT A TIME IS NOT ENFORCED HERE. The rig coalesces (a request made
 * while one is in flight only marks "again when this finishes"), so this keeps
 * a map of outstanding requests purely so a response can find its own promise —
 * and so a response to a request nobody is waiting for any more is dropped
 * rather than resolving something.
 */
export function createWorkerRiverNetworkSource(): RiverNetworkSource | null {
  if (typeof Worker === 'undefined') return null;

  let worker: Worker;
  try {
    worker = new Worker(new URL('./riverNetworkWorker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    // A worker can fail to start for reasons that have nothing to do with this
    // code (a strict CSP, a browser with module workers disabled). Rivers on
    // the main thread are the right degradation: slower, never wrong.
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
      // A COPY, transferred: the worker must not share the mirror's live cells
      // with the thread that is still sculpting them, and a transfer costs one
      // 512 KB memcpy rather than a structured clone of the same bytes.
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
