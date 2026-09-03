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
// THE SCORCH RECORD PERSISTS TOO (scorch.ts, issue #297), as remaining seconds
// per cell, because it is the one countdown here whose loss is not cosmetic:
// burned meadow that forgets it burned is FUEL, and a fire alive at the scar's
// edge when the server went down takes the whole scar again on boot. At the
// live measurement in scorch.ts's header (~3 000 cells inside the window) it is
// ~36 KB of JSON text; a full-cap fire cycling for the whole window is a few
// times that. Its residual is the snapshot cadence, named in scorch.ts.
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

import {
  grassKey,
  isCellCoordinate,
  packTreeCells,
  parseTreeCells,
  treeKey,
  type TreeCell,
} from '../protocol.ts';
import { FLORA_RNG_DEFAULT_SEED, type FloraRng, type Forest } from './forest.ts';
import { FLORA_SCORCH_REGROW_SECONDS, type ScorchField, type ScorchRemaining } from './scorch.ts';

/**
 * Schema version of this plugin's persistence slice.
 *
 *   1  trees + rngState
 *   2  + scorch (issue #297). A version-1 slice is read as having no scorch
 *      record — the exact state it had — so there is no migration beyond
 *      accepting the older number.
 */
export const FLORA_SLICE_VERSION = 2;

/** Versions `loadForestSlice` can read. Anything newer is refused by ./index.ts. */
const READABLE_SLICE_VERSIONS: ReadonlySet<number> = new Set([1, FLORA_SLICE_VERSION]);

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
  /**
   * Burned meadow still bare, as flat `[x0, y0, s0, x1, y1, s1, …]` triples:
   * cell, then the WHOLE simulated seconds it has left before it regrows.
   * Remaining rather than a deadline, and integers rather than the float the
   * live record holds, for the reasons on ScorchField.remaining and
   * packScorch. Absent from a version-1 slice.
   */
  readonly scorch: readonly number[];
}

export function saveForest(
  forest: Forest,
  rng: FloraRng,
  scorch: ScorchField,
  nowSeconds: number,
): FloraSlice {
  return {
    version: FLORA_SLICE_VERSION,
    rngState: rng.state(),
    trees: packTreeCells(forest.cells()),
    scorch: packScorch(scorch.remaining(nowSeconds)),
  };
}

/**
 * Remaining seconds are written ROUNDED UP to a whole second. The live value is
 * a float on the sim clock; rounding it at all keeps the file free of
 * 17-digit fractions, and rounding UP rather than to nearest is the direction
 * that cannot re-create the bug this record exists for — a cell restored a
 * fraction of a second too bare is invisible, one restored a fraction too
 * early is fuel.
 */
function packScorch(entries: readonly ScorchRemaining[]): number[] {
  const packed: number[] = [];
  for (const entry of entries) packed.push(entry.x, entry.y, Math.ceil(entry.seconds));
  return packed;
}

/**
 * Defensive parse of the scorch triples. A triple is kept only if both
 * coordinates pass the wire's own coordinate test and the remainder is a whole
 * number of seconds inside (0, FLORA_SCORCH_REGROW_SECONDS] — a file cannot
 * make ground bare for longer than a fire can, and a zero or negative
 * remainder is a cell that has already regrown and has no business in the
 * record.
 *
 * NO COUNT CAP, for the reason ScorchField has none: the record is keyed by
 * cell, `restore` de-duplicates, and onWorldCreate's world bound is the true
 * ceiling. The parse is one linear pass over whatever the file holds.
 */
function parseScorch(value: unknown): ScorchRemaining[] {
  if (!Array.isArray(value)) return [];
  const entries: ScorchRemaining[] = [];
  const seen = new Set<number>();
  for (let i = 0; i + 2 < value.length; i += 3) {
    const x = value[i];
    const y = value[i + 1];
    const seconds = value[i + 2];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > FLORA_SCORCH_REGROW_SECONDS) continue;
    const key = grassKey(x, y);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ x, y, seconds });
  }
  return entries;
}

/** What a restore recovered. Every field always usable, whatever the input was. */
export interface RestoredForest {
  readonly cells: readonly TreeCell[];
  readonly rngState: number;
  readonly scorch: readonly ScorchRemaining[];
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
  const empty: RestoredForest = { cells: [], rngState: FLORA_RNG_DEFAULT_SEED, scorch: [] };

  if (typeof data !== 'object' || data === null) return empty;
  const slice = data as Partial<FloraSlice>;
  if (typeof slice.version !== 'number' || !READABLE_SLICE_VERSIONS.has(slice.version)) return empty;

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

  return { cells, rngState, scorch: parseScorch(slice.scorch) };
}
