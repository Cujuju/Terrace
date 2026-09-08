import { grassKey, grassCellOf, type GrassCell } from '../protocol.ts';

export const FLORA_SCORCH_REGROW_SECONDS = 180;

export interface ScorchRemaining {
  readonly x: number;
  readonly y: number;
  readonly seconds: number;
}

export class ScorchField {
  private readonly regrowsAt = new Map<number, number>();

  private readonly regrowSeconds: number;

  constructor(regrowSeconds: number = FLORA_SCORCH_REGROW_SECONDS) {
    this.regrowSeconds = regrowSeconds;
  }

  get count(): number {
    return this.regrowsAt.size;
  }

  has(x: number, y: number): boolean {
    return this.regrowsAt.has(grassKey(x, y));
  }

  cells(): GrassCell[] {
    return Array.from(this.regrowsAt.keys(), grassCellOf);
  }

  remaining(nowSeconds: number): ScorchRemaining[] {
    const out: ScorchRemaining[] = [];
    for (const [key, deadline] of this.regrowsAt) {
      const cell = grassCellOf(key);
      out.push({ x: cell.x, y: cell.y, seconds: Math.max(1, deadline - nowSeconds) });
    }
    return out;
  }

  restore(entries: readonly ScorchRemaining[], nowSeconds: number): void {
    const ordered = entries.slice().sort((a, b) => a.seconds - b.seconds);
    for (const entry of ordered) {
      const key = grassKey(entry.x, entry.y);
      this.regrowsAt.delete(key);
      this.regrowsAt.set(key, nowSeconds + entry.seconds);
    }
  }

  clear(): void {
    this.regrowsAt.clear();
  }

  scorch(x: number, y: number, nowSeconds: number): void {
    const key = grassKey(x, y);
    this.regrowsAt.delete(key);
    this.regrowsAt.set(key, nowSeconds + this.regrowSeconds);
  }

  advanceRegrowth(nowSeconds: number): void {
    if (this.regrowsAt.size === 0) return;

    const regrown: number[] = [];
    for (const [key, deadline] of this.regrowsAt) {
      if (deadline > nowSeconds) break;
      regrown.push(key);
    }
    for (const key of regrown) this.regrowsAt.delete(key);
  }
}
