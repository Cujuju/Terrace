// The river network, flattened to the only thing the renderer asks it.
//
// WHAT THE RENDERER ACTUALLY NEEDS, and why it is not the network. `RiverNetwork`
// is a tree — rivers, their courses, their points, each point an object with a
// pooled flag and an optional pool height. The rig reads that tree exactly once,
// to answer two questions:
//
//   1. WHICH BAND OF WATER STANDS ON EACH WET CELL, higher water winning where
//      two courses disagree. Everything downstream — the regions, their
//      outlines, the curtains' feet — is a function of that one map.
//   2. WHERE EACH RIVER STARTS, for the spring effect.
//
// Everything else in the tree is thrown away. Flattening it here rather than in
// the rig buys two things that matter:
//
//   * THE WORKER CAN DO IT. The flattening is pure heightmap math, so it runs
//     next to `computeRiverNetwork` and never touches the thread that draws.
//     On a network at the trace budget's ceiling (MAX_SPRINGS_PER_NETWORK x
//     RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER x worldSize wet cells, ~24.5k on
//     a 512-edge world) that walk was ~4 ms of a 6 ms main-thread refresh.
//   * NOTHING BUT BUFFERS CROSSES THE THREAD BOUNDARY. Posting the tree would
//     structured-clone ~24.5k small objects, and the DESERIALISATION lands on
//     the main thread — the cost the worker was supposed to remove. Three typed
//     arrays are transferred instead, which costs neither side a copy.
//
// DETERMINISM: the walk order is the network's own (rivers, then courses, then
// points), and the "higher water wins" rule is on the bands themselves, so the
// order decides nothing anyway. Same network in, same arrays out.

import { bandOf, cellIndex, type Heightmap, type RiverNetwork } from '@terrace/shared';

export interface RiverSurface {
  /** Wet cell indices (`cellIndex`), each appearing once. */
  readonly cells: Int32Array;
  /** The band the water's surface is drawn at, in lockstep with `cells`. */
  readonly bands: Int16Array;
  /**
   * The first cell of every river's trunk course — where water arrives from
   * nowhere. Not deduplicated: two rivers may share a head spring, and the rig
   * dedupes when it places the effect.
   */
  readonly sources: Int32Array;
}

/** An empty surface — the answer for a world with no rivers, and the initial state. */
export const EMPTY_RIVER_SURFACE: RiverSurface = {
  cells: new Int32Array(0),
  bands: new Int16Array(0),
  sources: new Int32Array(0),
};

export function flattenRiverNetwork(map: Heightmap, network: RiverNetwork): RiverSurface {
  const bandByCell = new Map<number, number>();
  const sources: number[] = [];

  for (const river of network.rivers) {
    const source = river.courses[0]?.points[0];
    if (source !== undefined) sources.push(cellIndex(map, source.x, source.y));
    for (const course of river.courses) {
      for (const point of course.points) {
        const cell = cellIndex(map, point.x, point.y);
        // A pooled point takes its basin's flat spill band; a flowing one takes
        // the band the terrain renders its own tread at. `map.cells[cell]` is
        // what `sampleHeight` returns for any in-bounds cell, and every point of
        // a trace is in bounds by construction.
        const band = point.pooled ? bandOf(point.poolHeight ?? 0) : bandOf(map.cells[cell]!);
        const existing = bandByCell.get(cell);
        // THE HIGHER WATER WINS where two courses disagree about a cell: the
        // higher surface is the one that covers it, and the lower one is
        // underneath. A rule on the bands themselves, so the order the courses
        // are walked in decides nothing.
        if (existing === undefined || band > existing) bandByCell.set(cell, band);
      }
    }
  }

  const cells = new Int32Array(bandByCell.size);
  const bands = new Int16Array(bandByCell.size);
  let write = 0;
  for (const [cell, band] of bandByCell) {
    cells[write] = cell;
    bands[write] = band;
    write++;
  }
  return { cells, bands, sources: Int32Array.from(sources) };
}
