import { chunkIndexOfCell, computeRiverNetwork } from '@terrace/shared';
import { flattenRiverNetwork, type RiverSurface } from './riverSurface.ts';

export interface RiverNetworkRequest {
  readonly requestId: number;
  readonly size: number;
  readonly cells: Int16Array;
  readonly received: readonly number[];
}

export interface RiverNetworkResponse {
  readonly requestId: number;
  readonly surface: RiverSurface;
}

self.onmessage = (event: MessageEvent<RiverNetworkRequest>): void => {
  const { requestId, size, cells, received } = event.data;
  const active = new Set<number>(received);
  const map = { size, cells, columnSpans: new Map<number, Int16Array>() };
  const network = computeRiverNetwork(map, {
    isActive: (x, y) => active.has(chunkIndexOfCell(size, x, y)),
  });
  const surface = flattenRiverNetwork(map, network);
  const response: RiverNetworkResponse = { requestId, surface };
  (self as unknown as Worker).postMessage(response, [
    surface.cells.buffer,
    surface.bands.buffer,
    surface.sources.buffer,
  ]);
};
