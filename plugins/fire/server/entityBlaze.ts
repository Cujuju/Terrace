// The burning-creature set: ./blaze.ts's state machine, for things that move.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SAME ONE PIECE OF STATE — how long it has been alight — and for the same
// reason (./blaze.ts's header): fierceness is `fireIntensity(age, burn)` on both
// sides of the wire, burnout is `age >= burn` on both sides, and a second
// representation of either would drift.
//
// THE FOUR WAYS THIS FIRE ENDS. ./blaze.ts has three; a moving thing adds one:
//
//   BURNED OUT   it burned for its whole life and died of it. The owner is told
//                (onBurnedOut) and destroys it.
//   EXTINGUISHED rain put it out. It lives, scorched.
//   VANISHED     the owner no longer has it — it died of something else, was
//                despawned, sailed out of the world. Nobody is told anything,
//                because the thing this fire was attached to is already gone;
//                telling its owner to destroy it would be telling it to destroy
//                something twice. THIS ENDING HAS NO EQUIVALENT FOR A CELL,
//                which is the whole reason positionOf may answer null.
//   CLEARED      rollback or reset. Not an event in the sim at all.
// ─────────────────────────────────────────────────────────────────────────────

import { FIRE_ENTITY_CAP, fireEntityKey, isBurnedOut, type FireEntityState } from '../protocol.ts';
import { entityFuelAt, entityFuelSource, type EntityFuelSource } from './entityFuel.ts';

/** A burning individual as the server holds it. */
interface BurningEntity {
  readonly sourceName: string;
  readonly id: number;
  readonly fuelHeight: number;
  readonly burnSeconds: number;
  /** The only mutable field. */
  ageSeconds: number;
}

/** What one `advance` produced. */
export interface EntityAdvanceResult {
  /** Individuals that burned to death, grouped by the source that owns them. */
  readonly burnedOut: ReadonlyMap<string, number[]>;
  /** True when anything at all left the set — the cue to re-broadcast. */
  readonly changed: boolean;
}

const NO_BURNOUTS: ReadonlyMap<string, number[]> = new Map();

export class EntityBlaze {
  private readonly burning = new Map<string, BurningEntity>();

  get size(): number {
    return this.burning.size;
  }

  isBurning(sourceName: string, id: number): boolean {
    return this.burning.has(fireEntityKey(sourceName, id));
  }

  /**
   * Lights whatever of a registered source is standing on this cell, if
   * anything is and there is room under the cap. Returns the new fire, or null
   * when nothing caught — which covers "nothing flammable is standing here",
   * "it is already alight" and "the cap is full", all of which mean the same
   * thing to every caller: no new fire.
   */
  igniteAtCell(x: number, y: number): FireEntityState | null {
    if (this.burning.size >= FIRE_ENTITY_CAP) return null;

    const found = entityFuelAt(x, y);
    if (found === null) return null;

    const key = fireEntityKey(found.source.name, found.id);
    if (this.burning.has(key)) return null;

    const entity: BurningEntity = {
      sourceName: found.source.name,
      id: found.id,
      fuelHeight: found.fuel.height,
      burnSeconds: found.fuel.burnSeconds,
      ageSeconds: 0,
    };
    this.burning.set(key, entity);
    found.source.onIgnited?.([found.id]);
    return toState(entity);
  }

  /**
   * Advances every burning individual and retires the ones that are finished.
   *
   * ALSO DROPS THE VANISHED, and that check is why this method takes no world
   * but does consult the registry: an animal that died of old age while alight
   * is not this plugin's to mourn, but a fire still pointing at it would be
   * broadcast forever and asked for its position every tick for the rest of the
   * world's life.
   */
  advance(dt: number): EntityAdvanceResult {
    let burnedOut: Map<string, number[]> | null = null;
    let changed = false;

    for (const [key, entity] of this.burning) {
      const source = entityFuelSource(entity.sourceName);
      // The source itself is gone (a plugin unregistered mid-life): the fire
      // goes with it, silently. There is nobody left to tell.
      if (source === null) {
        this.burning.delete(key);
        changed = true;
        continue;
      }
      if (source.positionOf(entity.id) === null) {
        this.burning.delete(key);
        changed = true;
        continue;
      }

      entity.ageSeconds += dt;
      if (!isBurnedOut(entity.ageSeconds, entity.burnSeconds)) continue;

      this.burning.delete(key);
      changed = true;
      burnedOut ??= new Map<string, number[]>();
      const ids = burnedOut.get(entity.sourceName);
      if (ids === undefined) burnedOut.set(entity.sourceName, [entity.id]);
      else ids.push(entity.id);
    }

    return { burnedOut: burnedOut ?? NO_BURNOUTS, changed };
  }

  /**
   * Puts these out WITHOUT killing them — the rain path. Returns how many were
   * actually alight, so a caller can tell whether anything changed.
   */
  extinguish(entities: Iterable<{ readonly sourceName: string; readonly id: number }>): number {
    let stopped = 0;
    for (const entity of entities) {
      if (this.burning.delete(fireEntityKey(entity.sourceName, entity.id))) stopped++;
    }
    return stopped;
  }

  /** Everything alight, in the wire shape. */
  entities(): FireEntityState[] {
    const states: FireEntityState[] = [];
    for (const entity of this.burning.values()) states.push(toState(entity));
    return states;
  }

  /**
   * Where each burning individual is right now, for the callers that need
   * positions (rain, and any spread that comes later). Skips the ones whose
   * owner no longer has them — `advance` is what actually retires those.
   */
  positions(): Array<{ sourceName: string; id: number; x: number; y: number }> {
    const found: Array<{ sourceName: string; id: number; x: number; y: number }> = [];
    for (const entity of this.burning.values()) {
      const source = entityFuelSource(entity.sourceName);
      const at = source?.positionOf(entity.id) ?? null;
      if (at === null) continue;
      found.push({ sourceName: entity.sourceName, id: entity.id, x: at.x, y: at.y });
    }
    return found;
  }

  /**
   * REPLACES the set — the rollback contract every plugin's load/onWorldCreate
   * pair must have.
   *
   * A restored fire is NOT re-validated against the registry here: the sources
   * that own these individuals restore their own state on the same pass, and
   * asking them now would ask before they had. `advance` drops anything they
   * turn out not to have, on the very next tick.
   */
  restore(entities: Iterable<FireEntityState>): void {
    this.burning.clear();
    for (const entity of entities) {
      if (this.burning.size >= FIRE_ENTITY_CAP) break;
      if (entity.burnSeconds <= 0) continue;
      if (isBurnedOut(entity.ageSeconds, entity.burnSeconds)) continue;
      this.burning.set(fireEntityKey(entity.sourceName, entity.id), {
        sourceName: entity.sourceName,
        id: entity.id,
        fuelHeight: entity.fuelHeight,
        burnSeconds: entity.burnSeconds,
        ageSeconds: entity.ageSeconds,
      });
    }
  }

  /** Forgets everything, telling nobody. The rollback / reset path. */
  clear(): void {
    this.burning.clear();
  }
}

/** Kept private so the wire shape has one origin — ./blaze.ts's toState rule. */
function toState(entity: BurningEntity): FireEntityState {
  return {
    sourceName: entity.sourceName,
    id: entity.id,
    fuelHeight: entity.fuelHeight,
    ageSeconds: entity.ageSeconds,
    burnSeconds: entity.burnSeconds,
  };
}

export type { EntityFuelSource };
