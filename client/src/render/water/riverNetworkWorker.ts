// The river network, computed off the main thread.
//
// WHAT RUNS HERE, and why it is safe to move. `computeRiverNetwork` is pure
// `shared/` math over a heightmap (docs/DESIGN.md, "Water is derived, never
// simulated"): same heightmap in, same network out, no state, no clock, nothing
// to synchronise. That is exactly the property that makes it movable — the
// worker holds no river state either, it is handed a copy of the terrain and
// hands back an answer.
//
// WHY IT MOVED. It is GLOBAL by nature — it scans every active cell for local
// maxima and traces every spring it finds — so unlike the geometry around it,
// it cannot be scoped to the chunks a stroke touched. Measured at ~24 ms per
// call on a 512² world with 400 chunks revealed, against a 7.1 ms frame budget
// (the project's 140 fps bar), it is over budget on its own and stays over
// budget however cheap the rest of the water rebuild becomes.
//
// WHAT IS SENT, and what deliberately is not. `computeRiverNetwork` reads a
// `Heightmap`'s `size` and `cells`, and nothing else — `columnSpans` (the
// layered-column table) is never touched by the spring scan, the trace or the
// basin fill, so it is not sent and the reconstruction below leaves it empty.
// The cells arrive as a COPY, transferred rather than cloned, so the main
// thread's own `map.cells` is never shared with another thread. The active
// mask travels as the list of received chunk indices, which is what the
// client's own `isActive` closure is built from on the main thread.
//
// DETERMINISM IS UNAFFECTED. The answer depends on the bytes, not the thread:
// two runs over identical cells produce identical networks (pinned by
// shared/test/rivers.test.ts), so a network computed here is the same one the
// main thread would have computed, and the same one the server computes from
// its own authoritative map.

import { chunkIndexOfCell, computeRiverNetwork } from '@terrace/shared';
import { flattenRiverNetwork, type RiverSurface } from './riverSurface.ts';

/** One request: the terrain to trace, and which chunks count as revealed. */
export interface RiverNetworkRequest {
  /** Echoed back, so a late answer to a superseded request can be dropped. */
  readonly requestId: number;
  readonly size: number;
  /** A COPY of the mirror's cells, transferred in. */
  readonly cells: Int16Array;
  /** Chunk indices the mirror has received — the `isActive` mask. */
  readonly received: readonly number[];
}

export interface RiverNetworkResponse {
  readonly requestId: number;
  /**
   * The FLATTENED answer, not the network tree — see riverSurface.ts. Three
   * typed arrays are transferred; posting ~24.5k point objects would move the
   * cost to the main thread's deserialiser, which is the thread this whole
   * change exists to unload.
   */
  readonly surface: RiverSurface;
}

self.onmessage = (event: MessageEvent<RiverNetworkRequest>): void => {
  const { requestId, size, cells, received } = event.data;
  const active = new Set<number>(received);
  // columnSpans is untouched by the river math — see the header.
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
