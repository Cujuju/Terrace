// The wet set, and the whole of the water state machine.
//
// ─────────────────────────────────────────────────────────────────────────────
// A PATCH HAS ONE PIECE OF STATE: HOW LONG AGO IT LANDED.
//
// There is deliberately no `wetness` field, no 'fresh' | 'drying' | 'gone'
// union and no per-stage timer. Every one of those would be a second
// representation of a fact `ageSeconds` already carries exactly, and two
// representations of one fact drift — the client, which has only the age, would
// then be deriving a state the server had stored independently. That is
// plugins/fire/server/blaze.ts's rule, and this file is its division of labour
// applied to water: pure state and arithmetic, no `WorldApi`, nothing that
// broadcasts and nothing that touches the ground.
//
// THE ONE FIELD THAT IS NOT DERIVABLE is `askedForSlide`. It is not a fact
// about the water at all — it records that this patch has already put its
// question to mudslides, so that a patch sitting on gentle ground cannot ask
// the same question forty times a second for the rest of its life. See
// ../server/index.ts's HYDRO_SLIDE_SOAK_SECONDS for the rule it serves.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO WAYS A PATCH ENDS.
//
//   DRIED    it lived out HYDRO_PATCH_SECONDS. Ordinary, and the only ending
//            anybody is told about (a `hydro:changes` dry-out).
//   EVICTED  the cap bound and this was the driest patch in the world. Also
//            told, on the same delta and in the same shape: from the client's
//            side "the water at this cell is gone" is one fact however it went.
//
// CLEARED — a rollback or a world close — is not an ending in the sim at all
// and nobody is told anything, exactly as `Blaze.clear` does not announce.

import {
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_RADIUS_CELLS,
  hydroFalloff,
  hydroKey,
  hydroWetness,
  isDried,
  type HydroPatchState,
} from '../protocol.ts';

/** One wet cell as the server holds it: the wire state plus the slide record. */
interface WetCell {
  readonly x: number;
  readonly y: number;
  /** The only field the wire carries, and the only one that moves on its own. */
  ageSeconds: number;
  /** Whether this patch has already put its question to mudslides. */
  askedForSlide: boolean;
}

/** A patch as it is persisted: the wire state plus the un-derivable field. */
export interface StoredPatch extends HydroPatchState {
  readonly askedForSlide: boolean;
}

/** A cell this table has finished with — what the caller broadcasts as dried. */
export interface DriedCell {
  readonly x: number;
  readonly y: number;
}

const NOTHING_DRIED: readonly DriedCell[] = [];

export class Puddles {
  private readonly wet = new Map<number, WetCell>();

  /** How many patches are wet. The cap is checked against this. */
  get size(): number {
    return this.wet.size;
  }

  /**
   * Whether this cell can be given water that would buy the player anything.
   *
   * FALSE ONLY WHILE THE CELL IS ALREADY AT FULL STRENGTH. Refreshing full to
   * full changes nothing that anyone can see or that any consumer can measure,
   * so charging for it is the phantom debit fire's ignite rule
   * (`blaze.isBurning`) exists to rule out. A patch that has begun to dry CAN
   * be topped up, because that visibly buys the player more time.
   */
  canTakeWater(x: number, y: number): boolean {
    const cell = this.wet.get(hydroKey(x, y));
    if (cell === undefined) return true;
    return hydroWetness(cell.ageSeconds) < 1;
  }

  /**
   * Puts water on a cell and returns the patch, or null when the cell is
   * already at full strength (see `canTakeWater`).
   *
   * TOPPING UP RESETS THE AGE, and with it the slide question: fresh water on
   * half-dry ground is fresh water, and a patch that has already asked
   * mudslides and been refused may ask again once it has been re-poured. It
   * cannot become a way to hammer mudslides, because the refusal above holds
   * until the patch has begun to dry — which is far later than
   * HYDRO_SLIDE_SOAK_SECONDS, so a patch that was going to slide has already
   * done so before a top-up is even permitted.
   *
   * AT THE CAP THE DRIEST PATCH IS EVICTED rather than this pour refused (see
   * ../protocol.ts's HYDRO_PATCH_CAP). The evicted cell is returned alongside,
   * so the caller broadcasts exactly what changed.
   */
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

  /**
   * Ages every patch by `dt` simulated seconds and retires the ones that have
   * dried out.
   *
   * Allocation-free in the ordinary case — a world where nothing dries this
   * step, which is almost every step — because the result collection is only
   * built once something has actually ended. `Blaze.advance`'s shape exactly.
   */
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

  /**
   * How wet this cell is right now, in [0, 1] — the strongest patch covering
   * it, or 0 on dry ground.
   *
   * STRONGEST rather than summed, for the reason weather's own union
   * (plugins/weather/server/registry.ts's `precipitationAt`) gives: two
   * overlapping puddles do not make ground twice as wet as water can make it,
   * and a sum would exceed 1 and break every caller that treats this as a
   * fraction.
   *
   * O(HYDRO_PATCH_CAP) and no index, deliberately: the cap is 12, and the
   * hottest caller is fire's suppression roll over every burning cell on its
   * spread cadence. Twelve distance tests per query against a cell-keyed
   * spatial structure that would have to be maintained on every pour and every
   * dry-out is not a trade worth making at this cap. A world with no water pays
   * one comparison.
   */
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

  /** Every patch, in the shared wire shape. */
  patches(): HydroPatchState[] {
    const states: HydroPatchState[] = [];
    for (const cell of this.wet.values()) states.push(toState(cell));
    return states;
  }

  /**
   * Every patch whose soak has passed `soakSeconds` and that has not yet asked
   * mudslides, MARKING each one asked as it hands it over.
   *
   * DRAINED rather than read, for `Blaze.takeIgnited`'s reason: the caller
   * turns each of these into one request to a sibling plugin, and a second read
   * of the same list would ask twice for one pour.
   *
   * Insertion order — the order the water was poured in — which is fixed rather
   * than incidental: the consumer is sim code that moves terrain, and a
   * Map's iteration order has no business deciding which of two hillsides goes
   * first (design § determinism).
   */
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

  /** Every patch with the field the wire does not carry, for the slice. */
  entries(): StoredPatch[] {
    const stored: StoredPatch[] = [];
    for (const cell of this.wet.values()) {
      stored.push({ ...toState(cell), askedForSlide: cell.askedForSlide });
    }
    return stored;
  }

  /**
   * REPLACES the wet set — the shape every plugin's load/onWorldCreate pair
   * must have, so a world rollback cannot leave the previous world's water on
   * top of the restored water (server/src/plugins/types.ts, PersistenceSlice).
   */
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

  /** Forgets everything, telling nobody. The rollback / reset path. */
  clear(): void {
    this.wet.clear();
  }

  /**
   * Removes and returns the patch nearest to drying — the oldest, since every
   * patch has the same life. The cap's eviction rule; see `pour`.
   */
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

/** Strips the server-only field. Kept private so the wire shape has one origin. */
function toState(cell: WetCell): HydroPatchState {
  return { x: cell.x, y: cell.y, ageSeconds: cell.ageSeconds };
}
