export interface EntityFuel {
  readonly burnSeconds: number;
}

export interface FlammableIndividual {
  readonly sourceName: string;
  readonly id: number;
  readonly fuel: EntityFuel;
  readonly x: number;
  readonly y: number;
  readonly radiusCells: number;
}

export interface EntityFuelSource {
  readonly name: string;

  entityAt(x: number, y: number): { id: number; fuel: EntityFuel; distanceCells: number } | null;

  positionOf(id: number): { x: number; y: number } | null;

  onBurnedOut(ids: readonly number[]): void;

  onIgnited?(ids: readonly number[]): void;

  flammable?(): Iterable<FlammableIndividual>;

  readonly idsSurviveRestore?: boolean;
}

const sources: EntityFuelSource[] = [];

export function registerEntityFuel(source: EntityFuelSource): void {
  const existing = sources.findIndex((candidate) => candidate.name === source.name);
  if (existing >= 0) sources[existing] = source;
  else sources.push(source);
}

export function unregisterEntityFuel(name: string): void {
  const index = sources.findIndex((candidate) => candidate.name === name);
  if (index >= 0) sources.splice(index, 1);
}

export function entityFuelSources(): readonly EntityFuelSource[] {
  return sources;
}

export function clearEntityFuelRegistry(): void {
  sources.length = 0;
}

export function entityFuelSource(name: string): EntityFuelSource | null {
  return sources.find((candidate) => candidate.name === name) ?? null;
}

export function entityFuelAt(
  x: number,
  y: number,
  alreadyBurning?: (sourceName: string, id: number) => boolean,
): { id: number; fuel: EntityFuel; source: EntityFuelSource } | null {
  let best: { id: number; fuel: EntityFuel; source: EntityFuelSource } | null = null;
  let bestDistance = Infinity;

  for (const source of sources) {
    const found = source.entityAt(x, y);
    if (found === null) continue;
    if (found.fuel.burnSeconds <= 0) continue;
    if (!Number.isFinite(found.distanceCells)) continue;
    if (alreadyBurning?.(source.name, found.id) === true) continue;
    if (found.distanceCells >= bestDistance) continue;
    best = { id: found.id, fuel: found.fuel, source };
    bestDistance = found.distanceCells;
  }

  return best;
}
