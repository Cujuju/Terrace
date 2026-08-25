// The burning set, and the whole of the fire state machine.
//
// ─────────────────────────────────────────────────────────────────────────────
// A FIRE HAS ONE PIECE OF STATE: HOW LONG IT HAS BEEN ALIGHT.
//
// There is deliberately no `stage` field, no 'smouldering' | 'burning' |
// 'spent' union, no per-stage timer. Every one of those would be a second
// representation of a fact `ageSeconds` already carries exactly, and two
// representations of one fact drift — the client, which has only the age,
// would then be deriving a stage the server had stored independently.
//
// So: a fire is a cell, an age, a fixed lifetime and the fuel it is consuming.
// Fierceness is `fireIntensity(age, burn)` on both sides of the wire; burnout
// is `age >= burn` on both sides. Advancing the sim is one addition per fire.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE WAYS A FIRE ENDS, and why only one of them consumes the fuel.
//
//   BURNED OUT   the fire ran its full life. The fuel is gone: the owning
//                source is told (onBurnedOut) and fells its tree.
//   EXTINGUISHED the ground was dug from under it, or (later) rain put it out.
//                The fuel survives — a scorched tree that was saved is still a
//                tree — so the source is NOT told, and nothing is destroyed.
//   CLEARED      the world was rolled back or reset. Not an event in the sim at
//                all; nobody is told anything.
//
// Collapsing the first two into one "the fire is over" callback was the obvious
// simplification and it is wrong: it makes "we saved the forest" and "the forest
// burned down" the same message.
// ─────────────────────────────────────────────────────────────────────────────

import {
  FIRE_CELL_CAP,
  fireKey,
  isBurnedOut,
  type FireCellState,
} from '../protocol.ts';
import { fuelAt, type FuelCell, type FuelSource } from './fuel.ts';

/** A burning cell as the server holds it: the wire state plus who owns the fuel. */
interface BurningCell {
  readonly x: number;
  readonly y: number;
  readonly fuelHeight: number;
  readonly burnSeconds: number;
  /** Which registered source's stuff is burning — see fuel.ts. */
  readonly sourceName: string;
  /** The only mutable field, and the only state this whole plugin keeps. */
  ageSeconds: number;
}

/** What one `advance` produced — everything the caller must broadcast or route. */
export interface AdvanceResult {
  /** Cells whose fire ran to completion, grouped by the source that owns them. */
  readonly burnedOut: ReadonlyMap<string, FuelCell[]>;
  /** Every cell that stopped burning this step, for the extinguish delta. */
  readonly stopped: readonly FuelCell[];
}

const NO_BURNOUTS: ReadonlyMap<string, FuelCell[]> = new Map();
const NOTHING_STOPPED: readonly FuelCell[] = [];

export class Blaze {
  private readonly burning = new Map<number, BurningCell>();

  /** How many cells are alight. The cap is checked against this. */
  get size(): number {
    return this.burning.size;
  }

  /** True if this exact cell is already alight. */
  isBurning(x: number, y: number): boolean {
    return this.burning.has(fireKey(x, y));
  }

  /**
   * Lights a cell, if there is anything there to burn and there is room under
   * the cap. Returns the new fire, or null when nothing caught.
   *
   * Null covers three unremarkable cases the caller should not have to
   * distinguish: nothing flammable here, this cell is already alight, and the
   * world is already burning as hard as it is allowed to. All three mean the
   * same thing to every caller there will ever be — "no new fire" — and a
   * lightning bolt that hits bare rock is not an error.
   */
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
    found.source.onIgnited?.([{ x, y }]);
    return toState(cell);
  }

  /**
   * Advances every fire by `dt` simulated seconds and retires the ones that
   * have burned through their fuel.
   *
   * Allocation-free in the ordinary case — a world where nothing finishes this
   * step, which is almost every step — because the two result collections are
   * only built once something has actually ended.
   */
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

  /**
   * Puts these cells out WITHOUT consuming their fuel (see the header). Returns
   * the ones that were actually alight, so a caller can broadcast exactly what
   * changed rather than what it asked for.
   */
  extinguish(cells: Iterable<{ readonly x: number; readonly y: number }>): FuelCell[] {
    const stopped: FuelCell[] = [];
    for (const cell of cells) {
      const key = fireKey(cell.x, cell.y);
      if (!this.burning.delete(key)) continue;
      stopped.push({ x: cell.x, y: cell.y });
    }
    return stopped;
  }

  /** Every fire alight, in the shared wire shape. */
  fires(): FireCellState[] {
    const states: FireCellState[] = [];
    for (const cell of this.burning.values()) states.push(toState(cell));
    return states;
  }

  /**
   * REPLACES the burning set — the shape every plugin's load/onWorldCreate pair
   * must have, so a world rollback cannot leave the previous world's fires
   * burning on top of the restored ones (server/src/plugins/types.ts,
   * PersistenceSlice).
   *
   * A restored fire whose fuel no longer exists is kept, not re-validated: the
   * snapshot that holds these fires holds the trees too, and re-querying the
   * registry here would run before the plugins that own the fuel have restored
   * their own state.
   */
  restore(fires: Iterable<FireCellState & { readonly sourceName: string }>): void {
    this.burning.clear();
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

  /** The source that owns each fire, for the persistence slice. */
  entries(): Array<FireCellState & { readonly sourceName: string }> {
    const out: Array<FireCellState & { readonly sourceName: string }> = [];
    for (const cell of this.burning.values()) out.push({ ...toState(cell), sourceName: cell.sourceName });
    return out;
  }

  /** Forgets everything, telling nobody. The rollback / reset path. */
  clear(): void {
    this.burning.clear();
  }
}

/** Strips the server-only field. Kept private so the wire shape has one origin. */
function toState(cell: BurningCell): FireCellState {
  return {
    x: cell.x,
    y: cell.y,
    fuelHeight: cell.fuelHeight,
    ageSeconds: cell.ageSeconds,
    burnSeconds: cell.burnSeconds,
  };
}

/** Re-exported so callers routing burnouts do not also have to import fuel.ts. */
export type { FuelCell, FuelSource };
