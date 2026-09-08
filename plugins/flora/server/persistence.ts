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

export const FLORA_SLICE_VERSION = 2;

const READABLE_SLICE_VERSIONS: ReadonlySet<number> = new Set([1, FLORA_SLICE_VERSION]);

export interface FloraSlice {
  readonly version: number;
  readonly rngState: number;
  readonly trees: readonly number[];
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

function packScorch(entries: readonly ScorchRemaining[]): number[] {
  const packed: number[] = [];
  for (const entry of entries) packed.push(entry.x, entry.y, Math.ceil(entry.seconds));
  return packed;
}

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

export interface RestoredForest {
  readonly cells: readonly TreeCell[];
  readonly rngState: number;
  readonly scorch: readonly ScorchRemaining[];
}

export function loadForestSlice(data: unknown): RestoredForest {
  const empty: RestoredForest = { cells: [], rngState: FLORA_RNG_DEFAULT_SEED, scorch: [] };

  if (typeof data !== 'object' || data === null) return empty;
  const slice = data as Partial<FloraSlice>;
  if (typeof slice.version !== 'number' || !READABLE_SLICE_VERSIONS.has(slice.version)) return empty;

  const parsed = parseTreeCells(slice.trees) ?? [];
  const seen = new Set<number>();
  const cells: TreeCell[] = [];
  for (const cell of parsed) {
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
