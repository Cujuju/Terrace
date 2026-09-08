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

export function spawnSkyKind(name: string): boolean {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry?.spawnOne === undefined) return false;
  return entry.spawnOne() === true;
}

export function precipitationAt(x: number, y: number): number {
  let wettest = 0;
  for (const entry of entries) {
    const wetness = entry.wetnessAt(x, y);
    if (!Number.isFinite(wetness)) continue;
    if (wetness > wettest) wettest = wetness;
  }
  return Math.min(1, Math.max(0, wettest));
}

export function livingSystems(): readonly SkyKindSystem[] {
  const all: SkyKindSystem[] = [];
  for (const entry of entries) {
    for (const cell of entry.cells()) {
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
