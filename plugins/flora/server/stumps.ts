import { FLORA_STUMP_CAP, stumpCellOf, stumpKey, type StumpCell } from '../protocol.ts';

export const FLORA_STUMP_ROT_SECONDS = 360;

export class StumpField {
  private readonly rotsAt = new Map<number, number>();

  get count(): number {
    return this.rotsAt.size;
  }

  has(x: number, y: number): boolean {
    return this.rotsAt.has(stumpKey(x, y));
  }

  cells(): StumpCell[] {
    return Array.from(this.rotsAt.keys(), stumpCellOf);
  }

  clear(): void {
    this.rotsAt.clear();
  }

  leave(x: number, y: number, nowSeconds: number): StumpCell | null {
    const key = stumpKey(x, y);
    if (this.rotsAt.has(key)) {
      this.rotsAt.set(key, nowSeconds + FLORA_STUMP_ROT_SECONDS);
      return null;
    }
    if (this.rotsAt.size >= FLORA_STUMP_CAP) return null;
    this.rotsAt.set(key, nowSeconds + FLORA_STUMP_ROT_SECONDS);
    return { x, y };
  }

  reactToEdit(x: number, y: number): StumpCell | null {
    if (!this.rotsAt.delete(stumpKey(x, y))) return null;
    return { x, y };
  }

  advanceDecay(nowSeconds: number): StumpCell[] {
    if (this.rotsAt.size === 0) return [];

    const rotted: StumpCell[] = [];
    for (const [key, deadline] of this.rotsAt) {
      if (deadline <= nowSeconds) rotted.push(stumpCellOf(key));
    }
    for (const cell of rotted) this.rotsAt.delete(stumpKey(cell.x, cell.y));
    return rotted;
  }
}
