// FRESHWATER — a point lookup over the river network, so a mover can be asked
// "is there fresh water in this cell, and is it flowing or standing?" without
// re-walking every river's point list.
//
// WHY THIS EXISTS SEPARATELY FROM rivers.ts. rivers.ts answers "where do the
// rivers GO" — its output is per-river ordered courses, the shape a renderer
// needs to draw a ribbon. Traversal asks the transposed question: given one
// cell, what is in it. Answering that from the course lists means a linear
// scan of every point of every river per query, and `isWalkableCell` is
// called up to eight times per A* expansion (shared/src/pathing.ts's
// ROUTE_NODE_BUDGET is 4096), which would make the scan the dominant cost of
// routing. This module is that transpose, built once per network.
//
// THE DISTINCTION THIS FILE EXISTS TO CARRY (owner, 2026-08-20): "terrestrial
// monsters should only be able to traverse the rivers, not the lakes". A
// river's flowing channel is a step across; a basin's standing pool is a body
// of water to go around. rivers.ts already separates them — RiverPoint.pooled
// — and this module is what makes that fact answerable per cell.
//
// DETERMINISM CONTRACT: the index is built by a fixed traversal of the
// network in its own emitted order, and the lookup is a pure Set membership
// test on an integer key. Two builds over the same network produce the same
// answers; nothing here reads a clock, an RNG, or Map iteration order.

import type { RiverNetwork } from './rivers.ts';

/**
 * What fresh water, if any, occupies a cell.
 *
 * - `none`    — no river point here at all.
 * - `channel` — a FLOWING river point: water crossing the cell on its way
 *               downhill. Narrow by construction (a traced course is one
 *               cell wide), so it is the kind of water a long-legged thing
 *               can step over.
 * - `pool`    — a STANDING point: part of a basin filled to its spill height
 *               (rivers.ts's `fillBasin`). A lake, however small — the kind
 *               of water something walks around.
 */
export type Freshwater = 'none' | 'channel' | 'pool';

/**
 * A per-cell freshwater lookup. Deliberately a one-method interface rather
 * than the concrete class below, so a caller with no rivers at all (every
 * `shared/` unit test, a plugin built with rivers deleted) can satisfy it
 * with NO_FRESHWATER and never construct a network.
 */
export interface FreshwaterMap {
  at(x: number, y: number): Freshwater;
}

/**
 * The empty map: nothing anywhere is fresh water. The DEFAULT everywhere a
 * `TerrainSampler` does not supply one (see traversal.ts) — a world with no
 * river network behaves exactly as it did before this module existed, which
 * is what keeps the freshwater axis additive rather than a migration every
 * existing caller has to perform.
 */
export const NO_FRESHWATER: FreshwaterMap = {
  at: (): Freshwater => 'none',
};

/**
 * Builds the transpose of `network`: one lookup answering `Freshwater` per
 * cell.
 *
 * POOL BEATS CHANNEL where a cell is both. A basin's spillway is emitted as a
 * pooled point AND is the cell the course flows on through, so the two sets
 * genuinely overlap at the rim. Standing water is the stronger claim — it is
 * the one that stops a river-crossing walker — so a cell that is any part of
 * a pool reads as `pool` regardless of what else crosses it. Encoded by
 * checking `pools` first in `at`, not by ordering the writes, so the answer
 * does not depend on which river was walked first.
 *
 * `worldSize` is the key stride, and must be the same world size the network
 * was computed over; a mismatch would fold distant cells onto the same key.
 */
export function buildFreshwaterMap(network: RiverNetwork, worldSize: number): FreshwaterMap {
  const channels = new Set<number>();
  const pools = new Set<number>();

  for (const river of network.rivers) {
    for (const point of river.points) {
      const key = point.y * worldSize + point.x;
      if (point.pooled) pools.add(key);
      else channels.add(key);
    }
  }

  return {
    at(x: number, y: number): Freshwater {
      const key = Math.floor(y) * worldSize + Math.floor(x);
      if (pools.has(key)) return 'pool';
      return channels.has(key) ? 'channel' : 'none';
    },
  };
}
