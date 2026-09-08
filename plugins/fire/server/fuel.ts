export interface CellFuel {
  readonly burnSeconds: number;
  readonly height: number;
}

export interface FuelCell {
  readonly x: number;
  readonly y: number;
}

export interface FuelSource {
  readonly name: string;

  fuelAt(x: number, y: number): CellFuel | null;

  onBurnedOut(cells: readonly FuelCell[]): void;

  onIgnited?(cells: readonly FuelCell[]): void;
}

const sources: FuelSource[] = [];

export function registerFuel(source: FuelSource): void {
  const existing = sources.findIndex((candidate) => candidate.name === source.name);
  if (existing >= 0) sources[existing] = source;
  else sources.push(source);
}

export function unregisterFuel(name: string): void {
  const index = sources.findIndex((candidate) => candidate.name === name);
  if (index >= 0) sources.splice(index, 1);
}

export function fuelSources(): readonly FuelSource[] {
  return sources;
}

export function clearFuelRegistry(): void {
  sources.length = 0;
}

export function fuelAt(x: number, y: number): { fuel: CellFuel; source: FuelSource } | null {
  for (const source of sources) {
    const fuel = source.fuelAt(x, y);
    if (fuel !== null && fuel.burnSeconds > 0) return { fuel, source };
  }
  return null;
}
