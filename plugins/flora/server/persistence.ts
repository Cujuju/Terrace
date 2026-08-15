// The on-disk shape of a forest, and the defensive read-back.
//
// Separate from forest.ts on purpose, in wildlife's house style: that module
// owns LIVE state and its rules, this one owns the SERIALIZED format and its
// validation. Keeping them apart is what stops a future field being added to the
// live forest and silently becoming part of the snapshot contract.
//
// ─────────────────────────────────────────────────────────────────────────────
// TREES PERSIST. That is the opposite of the call wildlife made for its birds,
// and the difference is what each thing IS.
//
// A flock is a crossing in progress: its whole state is how far along a path it
// will have finished in a minute, so restoring one resumes a journey nobody was
// watching. A tree is the RESULT OF SOMETHING THE PLAYER DID — they levelled a
// shelf, they left it alone, it greened over. Dropping that on restart would
// undo work, and worse, it would undo it invisibly: the ground is still flat and
// still green, so a returning player sees a bare meadow with no way to tell that
// the server ate their forest rather than that it never grew. Trees are world
// state, like the relic positions relics persists and unlike the per-session
// skills it does not.
//
// WHAT IS NOT PERSISTED, deliberately: the stability stamps (stability.ts). They
// are 1 MB of Int32 at 512² — larger than the heightmap snapshot itself — to buy
// nothing a player can see: on restore, every cell reads as "unchanged since
// second 0", so the world simply waits out one FLORA_STABILITY_SECONDS before it
// grows anything new. The trees that already exist are unaffected. The one
// consequence worth naming: a player who levels a meadow and restarts the server
// 80 seconds later restarts that meadow's clock, so their trees arrive 90 s late
// rather than 10 s late. That is invisible without a stopwatch, and it is a
// megabyte of snapshot and a validation branch cheaper than the alternative.
// ─────────────────────────────────────────────────────────────────────────────

import { packTreeCells, parseTreeCells, treeKey, type TreeCell } from '../protocol.ts';
import { FLORA_RNG_DEFAULT_SEED, type FloraRng, type Forest } from './forest.ts';

/** Schema version of this plugin's persistence slice. */
export const FLORA_SLICE_VERSION = 1;

/**
 * The persisted forest.
 *
 * `trees` is the same flat `[x0, y0, x1, y1, …]` form the wire uses, and reusing
 * it is deliberate: one pack/parse pair means the snapshot and the broadcast
 * cannot disagree about what a tree list is. At the 3000-tree cap it is ~24 KB
 * of JSON text, next to the heightmap blob's 512 KB.
 *
 * `rngState` continues the growth sequence across a restart, exactly as relics
 * does for its spawn sequence — so a world's forest is reproducible from its
 * snapshot rather than diverging at every boot.
 */
export interface FloraSlice {
  readonly version: number;
  readonly rngState: number;
  readonly trees: readonly number[];
}

export function saveForest(forest: Forest, rng: FloraRng): FloraSlice {
  return {
    version: FLORA_SLICE_VERSION,
    rngState: rng.state(),
    trees: packTreeCells(forest.cells()),
  };
}

/** What a restore recovered. Both fields always usable, whatever the input was. */
export interface RestoredForest {
  readonly cells: readonly TreeCell[];
  readonly rngState: number;
}

/**
 * Reads a persisted slice defensively, in reveal's and relics' house style: the
 * row comes from this server's own SQLite file, but a truncated, forward-
 * versioned or hand-edited one must degrade to "an empty forest that regrows
 * itself" and never crash a boot.
 *
 * Cells are validated by the SAME parser the wire uses (coordinates are
 * non-negative integers below the key stride, count capped at FLORA_TREE_CAP)
 * and then de-duplicated, because "one tree per cell" is an invariant the live
 * Forest guarantees but a hand-edited file can violate.
 *
 * Cells are NOT checked against the world here, because there is no world yet —
 * the host restores persistence before onWorldCreate. Anything restored onto
 * ground that can no longer hold it is felled by the first survey's cull sweep
 * (forest.ts), which is the same self-correction wildlife relies on for a
 * population restored onto changed terrain.
 */
export function loadForestSlice(data: unknown): RestoredForest {
  const empty: RestoredForest = { cells: [], rngState: FLORA_RNG_DEFAULT_SEED };

  if (typeof data !== 'object' || data === null) return empty;
  const slice = data as Partial<FloraSlice>;
  if (slice.version !== FLORA_SLICE_VERSION) return empty;

  const parsed = parseTreeCells(slice.trees) ?? [];
  const seen = new Set<number>();
  const cells: TreeCell[] = [];
  for (const cell of parsed) {
    // The wire's own packing, so "the same cell" means exactly what it means
    // everywhere else in this plugin.
    const key = treeKey(cell.x, cell.y);
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push(cell);
  }

  const rngState =
    Number.isInteger(slice.rngState) && (slice.rngState as number) >= 0
      ? (slice.rngState as number)
      : FLORA_RNG_DEFAULT_SEED;

  return { cells, rngState };
}
