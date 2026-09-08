import {
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_RADIUS_CELLS,
  hydroFalloff,
  hydroKey,
  hydroWetness,
  isDried,
  type HydroPatchState,
} from '../protocol.ts';

interface WetCell {
  readonly x: number;
  readonly y: number;
  ageSeconds: number;
  askedForSlide: boolean;
}

export interface StoredPatch extends HydroPatchState {
  readonly askedForSlide: boolean;
}

export interface DriedCell {
  readonly x: number;
  readonly y: number;
}

const NOTHING_DRIED: readonly DriedCell[] = [];

export class Puddles {
  private readonly wet = new Map<number, WetCell>();

  get size(): number {
    return this.wet.size;
  }

  canTakeWater(x: number, y: number): boolean {
    const cell = this.wet.get(hydroKey(x, y));
    if (cell === undefined) return true;
    return hydroWetness(cell.ageSeconds) < 1;
  }

  pour(x: number, y: number): { patch: HydroPatchState; evicted: DriedCell | null } | null {
    if (!this.canTakeWater(x, y)) return null;

    const key = hydroKey(x, y);
    const existing = this.wet.get(key);
    if (existing !== undefined) {
      existing.ageSeconds = 0;
      existing.askedForSlide = false;
      return { patch: toState(existing), evicted: null };
    }

    const evicted = this.wet.size >= HYDRO_PATCH_CAP ? this.evictDriest() : null;
    const cell: WetCell = { x, y, ageSeconds: 0, askedForSlide: false };
    this.wet.set(key, cell);
    return { patch: toState(cell), evicted };
  }

  advance(dt: number): readonly DriedCell[] {
    let dried: DriedCell[] | null = null;

    for (const [key, cell] of this.wet) {
      cell.ageSeconds += dt;
      if (!isDried(cell.ageSeconds)) continue;

      this.wet.delete(key);
      dried ??= [];
      dried.push({ x: cell.x, y: cell.y });
    }

    return dried ?? NOTHING_DRIED;
  }

  wetnessAt(x: number, y: number): number {
    if (this.wet.size === 0) return 0;

    let wettest = 0;
    for (const cell of this.wet.values()) {
      const dx = x - cell.x;
      const dy = y - cell.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance >= HYDRO_PATCH_RADIUS_CELLS) continue;
      const wetness = hydroWetness(cell.ageSeconds) * hydroFalloff(distance);
      if (wetness > wettest) wettest = wetness;
    }
    return Math.min(1, Math.max(0, wettest));
  }

  patches(): HydroPatchState[] {
    const states: HydroPatchState[] = [];
    for (const cell of this.wet.values()) states.push(toState(cell));
    return states;
  }

  takeSoakedCells(soakSeconds: number): DriedCell[] {
    const soaked: DriedCell[] = [];
    for (const cell of this.wet.values()) {
      if (cell.askedForSlide) continue;
      if (cell.ageSeconds < soakSeconds) continue;
      cell.askedForSlide = true;
      soaked.push({ x: cell.x, y: cell.y });
    }
    return soaked;
  }

  entries(): StoredPatch[] {
    const stored: StoredPatch[] = [];
    for (const cell of this.wet.values()) {
      stored.push({ ...toState(cell), askedForSlide: cell.askedForSlide });
    }
    return stored;
  }

  restore(patches: Iterable<StoredPatch>): void {
    this.wet.clear();
    for (const patch of patches) {
      if (this.wet.size >= HYDRO_PATCH_CAP) break;
      if (isDried(patch.ageSeconds)) continue;
      this.wet.set(hydroKey(patch.x, patch.y), {
        x: patch.x,
        y: patch.y,
        ageSeconds: patch.ageSeconds,
        askedForSlide: patch.askedForSlide,
      });
    }
  }

  clear(): void {
    this.wet.clear();
  }

  private evictDriest(): DriedCell | null {
    let oldestKey: number | null = null;
    let oldestAge = -1;
    for (const [key, cell] of this.wet) {
      if (cell.ageSeconds <= oldestAge) continue;
      oldestAge = cell.ageSeconds;
      oldestKey = key;
    }
    if (oldestKey === null) return null;

    const cell = this.wet.get(oldestKey)!;
    this.wet.delete(oldestKey);
    return { x: cell.x, y: cell.y };
  }
}

function toState(cell: WetCell): HydroPatchState {
  return { x: cell.x, y: cell.y, ageSeconds: cell.ageSeconds };
}
