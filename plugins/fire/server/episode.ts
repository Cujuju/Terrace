import { parseIgnitePayload } from '../protocol.ts';
import type { FuelCell } from './fuel.ts';

export class FireEpisode {
  private consumed = 0;
  private origin: FuelCell | null = null;

  record(cells: readonly FuelCell[]): void {
    this.consumed += cells.length;
    this.origin ??= cells[0] ?? null;
  }

  save(): { consumed: number; origin: FuelCell | null } {
    return { consumed: this.consumed, origin: this.origin === null ? null : { ...this.origin } };
  }

  restore(data: unknown): void {
    this.clear();
    if (typeof data !== 'object' || data === null) return;
    const { consumed, origin } = data as { consumed?: unknown; origin?: unknown };
    if (typeof consumed !== 'number' || !Number.isSafeInteger(consumed) || consumed <= 0) return;
    const cell = parseIgnitePayload(origin);
    if (cell === null) return;
    this.consumed = consumed;
    this.origin = cell;
  }

  finish(): { consumed: number; x: number; y: number } | null {
    const result = this.origin === null || this.consumed === 0
      ? null
      : { consumed: this.consumed, x: this.origin.x, y: this.origin.y };
    this.clear();
    return result;
  }

  clear(): void {
    this.consumed = 0;
    this.origin = null;
  }
}
