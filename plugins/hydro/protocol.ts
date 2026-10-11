import { cellsAcross } from '@terrace/shared';

export const HYDRO_PLUGIN_NAME = 'hydro';

export const HYDRO_POUR_MESSAGE = 'pour';

export const HYDRO_PATCHES_MESSAGE = 'patches';

export const HYDRO_CHANGES_MESSAGE = 'changes';

export const HYDRO_PATCH_CAP = 12;

export const HYDRO_FIXED_POINT_SCALE = 10;

export const HYDRO_CELL_KEY_STRIDE = 65536;

export function hydroKey(x: number, y: number): number {
  return y * HYDRO_CELL_KEY_STRIDE + x;
}

export function hydroCellOf(key: number): { x: number; y: number } {
  return { x: key % HYDRO_CELL_KEY_STRIDE, y: Math.floor(key / HYDRO_CELL_KEY_STRIDE) };
}

export const HYDRO_PATCH_RADIUS_WORLD_UNITS = 1.5;

export const HYDRO_PATCH_RADIUS_CELLS = cellsAcross(HYDRO_PATCH_RADIUS_WORLD_UNITS);

export const HYDRO_PATCH_CORE_FRACTION = 0.45;

export const HYDRO_PATCH_SECONDS = 40;

export const HYDRO_DRYING_FRACTION = 0.55;

export function hydroWetness(ageSeconds: number): number {
  if (ageSeconds < 0 || ageSeconds >= HYDRO_PATCH_SECONDS) return 0;

  const progress = ageSeconds / HYDRO_PATCH_SECONDS;
  const dryingBegins = 1 - HYDRO_DRYING_FRACTION;
  if (progress <= dryingBegins) return 1;
  return (1 - progress) / HYDRO_DRYING_FRACTION;
}

export function isDried(ageSeconds: number): boolean {
  return ageSeconds >= HYDRO_PATCH_SECONDS;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function hydroFalloff(distanceCells: number): number {
  if (distanceCells <= 0) return 1;
  const d = distanceCells / HYDRO_PATCH_RADIUS_CELLS;
  if (d >= 1) return 0;
  return 1 - smoothstep(HYDRO_PATCH_CORE_FRACTION, 1, d);
}

export interface HydroPatchState {
  readonly x: number;
  readonly y: number;
  readonly ageSeconds: number;
}

export function parsePourPayload(payload: unknown): { x: number; y: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const request = payload as { x?: unknown; y?: unknown };
  const { x, y } = request;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= HYDRO_CELL_KEY_STRIDE || y >= HYDRO_CELL_KEY_STRIDE) return null;
  return { x, y };
}

function toFixed(value: number): number {
  return Math.max(0, Math.round(value * HYDRO_FIXED_POINT_SCALE));
}

function fromFixed(value: number): number {
  return value / HYDRO_FIXED_POINT_SCALE;
}

export const HYDRO_WIRE_STRIDE = 3;

export function packPatches(patches: Iterable<HydroPatchState>): number[] {
  const packed: number[] = [];
  for (const patch of patches) packed.push(patch.x, patch.y, toFixed(patch.ageSeconds));
  return packed;
}

function isWireInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < HYDRO_CELL_KEY_STRIDE
  );
}

export function parsePatches(value: unknown): HydroPatchState[] | null {
  if (!Array.isArray(value)) return null;

  const patches: HydroPatchState[] = [];
  for (let i = 0; i + HYDRO_WIRE_STRIDE - 1 < value.length; i += HYDRO_WIRE_STRIDE) {
    if (patches.length >= HYDRO_PATCH_CAP) break;
    const [x, y, age] = value.slice(i, i + HYDRO_WIRE_STRIDE);
    if (!isWireInteger(x) || !isWireInteger(y) || !isWireInteger(age)) continue;
    const ageSeconds = fromFixed(age);
    if (isDried(ageSeconds)) continue;
    patches.push({ x, y, ageSeconds });
  }
  return patches;
}

export function packCells(cells: Iterable<{ readonly x: number; readonly y: number }>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseCells(value: unknown): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(value)) return null;

  const cells: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= HYDRO_PATCH_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isWireInteger(x) || !isWireInteger(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

export interface HydroPatchesPayload {
  readonly patches: readonly number[];
}

export interface HydroChangesPayload {
  readonly poured: readonly number[];
  readonly dried: readonly number[];
}

export function parsePatchesPayload(payload: unknown): HydroPatchState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parsePatches((payload as { patches?: unknown }).patches);
}

export function parseChangesPayload(
  payload: unknown,
): { poured: HydroPatchState[]; dried: Array<{ x: number; y: number }> } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { poured?: unknown; dried?: unknown };
  const poured = parsePatches(message.poured ?? []);
  const dried = parseCells(message.dried ?? []);
  if (poured === null || dried === null) return null;
  return { poured, dried };
}
