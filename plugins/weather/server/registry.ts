import { logWarn } from '../../../server/src/log.ts';

export interface SkyCell {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

export interface SkyKindEntry {
  readonly name: string;
  cells(): readonly SkyCell[];
  wetnessAt(x: number, y: number): number;
  spawnOne?(): boolean;
}

export interface SkyKindSystem extends SkyCell {
  readonly kind: string;
}

const entries: SkyKindEntry[] = [];

function isSkyKindEntry(entry: unknown): entry is SkyKindEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const candidate = entry as Partial<SkyKindEntry>;
  if (typeof candidate.name !== 'string' || candidate.name === '') return false;
  if (typeof candidate.cells !== 'function') return false;
  if (typeof candidate.wetnessAt !== 'function') return false;
  if (candidate.spawnOne !== undefined && typeof candidate.spawnOne !== 'function') return false;
  return true;
}

function isSkyCell(cell: unknown): cell is SkyCell {
  if (typeof cell !== 'object' || cell === null) return false;
  const candidate = cell as Partial<SkyCell>;
  return (
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number.isFinite(candidate.radius) &&
    Number.isFinite(candidate.intensity)
  );
}

export function registerSkyKind(entry: SkyKindEntry): () => void {
  if (!isSkyKindEntry(entry)) {
    throw new TypeError(
      '[weather] a sky kind must register { name, cells(), wetnessAt(x, y) } — registration refused',
    );
  }

  const existing = entries.findIndex((candidate) => candidate.name === entry.name);
  if (existing >= 0) entries.splice(existing, 1);
  entries.push(entry);

  return () => {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  };
}

// The hub is the fault boundary: a kind that throws is dropped here, so the
// consumer plugin reading the sky is never charged with the kind's fault.
function dropFaulted(entry: SkyKindEntry, member: string, error: unknown): void {
  const index = entries.indexOf(entry);
  if (index >= 0) entries.splice(index, 1);
  logWarn(`[weather] sky kind "${entry.name}" threw in ${member} and was dropped: ${String(error)}`);
}

export function spawnSkyKind(name: string): boolean {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry?.spawnOne === undefined) return false;
  try {
    return entry.spawnOne() === true;
  } catch (error) {
    dropFaulted(entry, 'spawnOne', error);
    return false;
  }
}

export function precipitationAt(x: number, y: number): number {
  let wettest = 0;
  for (const entry of entries.slice()) {
    let wetness: number;
    try {
      wetness = entry.wetnessAt(x, y);
    } catch (error) {
      dropFaulted(entry, 'wetnessAt', error);
      continue;
    }
    if (!Number.isFinite(wetness)) continue;
    if (wetness > wettest) wettest = wetness;
  }
  return Math.min(1, Math.max(0, wettest));
}

export function livingSystems(): readonly SkyKindSystem[] {
  const all: SkyKindSystem[] = [];
  for (const entry of entries.slice()) {
    let cells: readonly SkyCell[];
    try {
      cells = entry.cells();
    } catch (error) {
      dropFaulted(entry, 'cells', error);
      continue;
    }
    if (!Array.isArray(cells)) continue;
    for (const cell of cells) {
      if (!isSkyCell(cell)) continue;
      all.push({
        kind: entry.name,
        x: cell.x,
        y: cell.y,
        radius: cell.radius,
        intensity: cell.intensity,
      });
    }
  }
  return all;
}

export function resetSkyRegistry(): void {
  entries.length = 0;
}
