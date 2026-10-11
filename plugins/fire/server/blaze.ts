import {
  FIRE_CELL_CAP,
  fireKey,
  isBurnedOut,
  type FireCellState,
} from '../protocol.ts';
import { fuelAt, type FuelCell, type FuelSource } from './fuel.ts';

interface BurningCell {
  readonly x: number;
  readonly y: number;
  readonly fuelHeight: number;
  readonly burnSeconds: number;
  readonly sourceName: string;
  ageSeconds: number;
}

export interface AdvanceResult {
  readonly burnedOut: ReadonlyMap<string, FuelCell[]>;
  readonly stopped: readonly FuelCell[];
}

const NO_BURNOUTS: ReadonlyMap<string, FuelCell[]> = new Map();
const NOTHING_STOPPED: readonly FuelCell[] = [];

export class Blaze {
  private readonly burning = new Map<number, BurningCell>();

  private ignitedSinceDrain: Array<{ readonly x: number; readonly y: number }> = [];

  get size(): number {
    return this.burning.size;
  }

  isBurning(x: number, y: number): boolean {
    return this.burning.has(fireKey(x, y));
  }

  ignite(x: number, y: number): FireCellState | null {
    if (this.burning.size >= FIRE_CELL_CAP) return null;

    const key = fireKey(x, y);
    if (this.burning.has(key)) return null;

    const found = fuelAt(x, y);
    if (found === null) return null;

    const cell: BurningCell = {
      x,
      y,
      fuelHeight: found.fuel.height,
      burnSeconds: found.fuel.burnSeconds,
      sourceName: found.source.name,
      ageSeconds: 0,
    };
    this.burning.set(key, cell);
    this.ignitedSinceDrain.push({ x, y });
    found.source.onIgnited?.([{ x, y }]);
    return toState(cell);
  }

  advance(dt: number): AdvanceResult {
    let burnedOut: Map<string, FuelCell[]> | null = null;
    let stopped: FuelCell[] | null = null;

    for (const [key, cell] of this.burning) {
      cell.ageSeconds += dt;
      if (!isBurnedOut(cell.ageSeconds, cell.burnSeconds)) continue;

      this.burning.delete(key);

      burnedOut ??= new Map<string, FuelCell[]>();
      stopped ??= [];
      const cells = burnedOut.get(cell.sourceName);
      const fuelCell: FuelCell = { x: cell.x, y: cell.y };
      if (cells === undefined) burnedOut.set(cell.sourceName, [fuelCell]);
      else cells.push(fuelCell);
      stopped.push(fuelCell);
    }

    return { burnedOut: burnedOut ?? NO_BURNOUTS, stopped: stopped ?? NOTHING_STOPPED };
  }

  extinguish(cells: Iterable<{ readonly x: number; readonly y: number }>): FuelCell[] {
    const stopped: FuelCell[] = [];
    for (const cell of cells) {
      const key = fireKey(cell.x, cell.y);
      if (!this.burning.delete(key)) continue;
      stopped.push({ x: cell.x, y: cell.y });
    }
    return stopped;
  }

  fires(): FireCellState[] {
    const states: FireCellState[] = [];
    for (const cell of this.burning.values()) states.push(toState(cell));
    return states;
  }

  restore(fires: Iterable<FireCellState & { readonly sourceName: string }>): void {
    this.burning.clear();
    this.ignitedSinceDrain = [];
    for (const fire of fires) {
      if (this.burning.size >= FIRE_CELL_CAP) break;
      if (fire.burnSeconds <= 0) continue;
      if (isBurnedOut(fire.ageSeconds, fire.burnSeconds)) continue;
      this.burning.set(fireKey(fire.x, fire.y), {
        x: fire.x,
        y: fire.y,
        fuelHeight: fire.fuelHeight,
        burnSeconds: fire.burnSeconds,
        sourceName: fire.sourceName,
        ageSeconds: fire.ageSeconds,
      });
    }
  }

  entries(): Array<FireCellState & { readonly sourceName: string }> {
    const out: Array<FireCellState & { readonly sourceName: string }> = [];
    for (const cell of this.burning.values()) out.push({ ...toState(cell), sourceName: cell.sourceName });
    return out;
  }

  takeIgnited(): Array<{ readonly x: number; readonly y: number }> {
    const drained = this.ignitedSinceDrain;
    this.ignitedSinceDrain = [];
    return drained;
  }

  clear(): void {
    this.burning.clear();
    this.ignitedSinceDrain = [];
  }
}

function toState(cell: BurningCell): FireCellState {
  return {
    x: cell.x,
    y: cell.y,
    fuelHeight: cell.fuelHeight,
    ageSeconds: cell.ageSeconds,
    burnSeconds: cell.burnSeconds,
  };
}

export type { FuelCell, FuelSource };
