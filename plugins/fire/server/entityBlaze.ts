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
import {
  entityFuelAt,
  entityFuelSource,
  type EntityFuelSource,
  type FlammableIndividual,
} from './entityFuel.ts';

/** A burning individual as the server holds it. */
interface BurningEntity {
  readonly sourceName: string;
  readonly id: number;
  readonly fuelHeight: number;
  readonly burnSeconds: number;
  /** The only mutable field. */
  ageSeconds: number;
  /**
   * True until this fire has been checked against the source that owns it —
   * set only by `restore`, cleared by the first `advance` that sees it. See
   * ./entityFuel.ts's idsSurviveRestore.
   */
  awaitingIdentityCheck?: boolean;
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

  /**
   * Where each newly-caught individual WAS STANDING when it caught, for every
   * one caught since this was last drained — ./blaze.ts's `ignitedSinceDrain`,
   * same contract and same reason, applied to the registry that moves.
   *
   * A POSITION AND NOT AN IDENTITY, and this is the half of the seam that is
   * easy to get wrong. The plugin that OWNS the creature is told which of its
   * own individuals caught, through `onIgnited` below; that is a private answer
   * to a private question. What goes out to the world is where the flame
   * appeared, because a bystander's question is "what do I run away from" and
   * "pilgrims' walker 12" is not an answer to it (../protocol.ts's
   * FIRE_IGNITED_EVENT).
   *
   * Recorded at the moment of ignition rather than looked up later for the
   * obvious reason: by the next tick it has moved, and by the tick after that
   * its owner may not have it at all.
   */
  private ignitedSinceDrain: Array<{ readonly x: number; readonly y: number }> = [];

  get size(): number {
    return this.burning.size;
  }

  /**
   * The shortest burn among everything alight, or null when nothing is —
   * what ../index.ts derives the re-send cadence from, so a plugin that
   * registers a shorter-lived fuel than anything shipped today gets a faster
   * repair automatically instead of falling through a constant tuned for
   * somebody else's numbers.
   */
  shortestBurnSeconds(): number | null {
    let shortest: number | null = null;
    for (const entity of this.burning.values()) {
      if (shortest === null || entity.burnSeconds < shortest) shortest = entity.burnSeconds;
    }
    return shortest;
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

    // The registry is told what is ALREADY ALIGHT so it can offer the nearest
    // thing that could actually catch, rather than offering something that is
    // burning already and having it refused here — which is how a burning boat
    // used to mask its whole reach (./entityFuel.ts's alreadyBurning note).
    const found = entityFuelAt(x, y, (sourceName, id) =>
      this.burning.has(fireEntityKey(sourceName, id)),
    );
    if (found === null) return null;

    // Belt and suspenders: the registry has just filtered these out, and a
    // source that ignored the filter still must not light the same thing twice.
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
    // WHERE IT ACTUALLY STANDS, not the cell that was aimed at: the registry
    // arbitrates by distance and may hand back something up to its own reach
    // away from (x, y) (./entityFuel.ts's nearest-wins rule), so the aimed cell
    // is the wrong point to tell the world a fire started at. Falling back to
    // it when the source cannot say is honest — it has just answered `entityAt`
    // for this cell, so the two are within that source's reach of each other.
    this.ignitedSinceDrain.push(found.source.positionOf(found.id) ?? { x, y });
    found.source.onIgnited?.([found.id]);
    return toState(entity);
  }

  /**
   * Lights ONE NAMED INDIVIDUAL, if there is room under the cap.
   *
   * THE SPREAD COUNTERPART OF `igniteAtCell`, and the difference between them
   * is which question was asked. A torch asks about a CELL and the registry
   * decides who was meant (./entityFuel.ts's arbitration); a flame reaching a
   * boat has already picked the boat, because ../server/spread.ts ranked every
   * candidate by distance to decide it was in reach at all. Routing spread
   * through `igniteAtCell` would throw that answer away and re-ask a cell
   * question, which is how a fire would end up lighting the neighbour of the
   * thing it actually reached.
   *
   * Returns null when nothing caught — the cap is full, it is already alight,
   * or the source has since let go of the id.
   */
  igniteIndividual(candidate: FlammableIndividual): FireEntityState | null {
    if (this.burning.size >= FIRE_ENTITY_CAP) return null;

    const { sourceName, id, fuel } = candidate;
    const key = fireEntityKey(sourceName, id);
    if (this.burning.has(key)) return null;

    const source = entityFuelSource(sourceName);
    if (source === null) return null;

    // THE FUEL COMES WITH THE CANDIDATE rather than being looked up again: the
    // same sweep that decided this thing was in reach already carries what
    // burning it amounts to, and a second lookup would be a second chance for
    // the two to disagree.
    if (fuel.burnSeconds <= 0) return null;

    // It must still be THERE. `flammable()` is swept once at the top of the
    // spread step and the rolls happen after it, so this is the window in which
    // an animal can die between being offered and being lit.
    if (source.positionOf(id) === null) return null;

    const entity: BurningEntity = {
      sourceName,
      id,
      fuelHeight: fuel.height,
      burnSeconds: fuel.burnSeconds,
      ageSeconds: 0,
    };
    this.burning.set(key, entity);
    // The candidate's own position, which the spread sweep has just read off
    // its owner (./entityFuel.ts's FlammableIndividual) — the same number
    // `positionOf` would answer, without a second lookup that could disagree.
    this.ignitedSinceDrain.push({ x: candidate.x, y: candidate.y });
    source.onIgnited?.([id]);
    return toState(entity);
  }

  /**
   * Everything alight that can be a SOURCE of spread: where it is now, and how
   * far through its burn it is.
   *
   * Separate from `positions()` because that one answers "where is it" for rain
   * and this one has to carry the clock as well — ../server/spread.ts's
   * SpreadSource is position AND age, since a fire too young or too spent to
   * throw sparks is not a source at all. Skips the ones whose owner has let go,
   * exactly as `positions()` does.
   */
  burningWithAge(): Array<{
    sourceName: string;
    id: number;
    x: number;
    y: number;
    ageSeconds: number;
    burnSeconds: number;
  }> {
    const found: Array<{
      sourceName: string;
      id: number;
      x: number;
      y: number;
      ageSeconds: number;
      burnSeconds: number;
    }> = [];
    for (const entity of this.burning.values()) {
      const source = entityFuelSource(entity.sourceName);
      const at = source?.positionOf(entity.id) ?? null;
      if (at === null) continue;
      found.push({
        sourceName: entity.sourceName,
        id: entity.id,
        x: at.x,
        y: at.y,
        ageSeconds: entity.ageSeconds,
        burnSeconds: entity.burnSeconds,
      });
    }
    return found;
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
      // THE IDENTITY CHECK, once, on the first tick after a restore. A restored
      // fire names an individual by a number, and a number only means the same
      // individual if its owner keeps id spaces across a restore — so a source
      // that has not said it does gets its restored fires dropped rather than
      // re-attached to whoever holds those numbers now (./entityFuel.ts's
      // idsSurviveRestore). Silent, like every other way a fire's subject turns
      // out not to be there: there is nothing to tell anyone about a fire that
      // was never really burning on this world.
      if (entity.awaitingIdentityCheck === true) {
        if (source.idsSurviveRestore !== true) {
          this.burning.delete(key);
          changed = true;
          continue;
        }
        entity.awaitingIdentityCheck = false;
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
   * turn out not to have, on the very next tick — and on that same tick it
   * asks the harder question a restore raises, whether the id still means the
   * individual it meant when the snapshot was written (./entityFuel.ts's
   * idsSurviveRestore).
   */
  restore(entities: Iterable<FireEntityState>): void {
    this.burning.clear();
    // The pending announcements go with the set they described — see `clear`.
    this.ignitedSinceDrain = [];
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
        awaitingIdentityCheck: true,
      });
    }
  }

  /** Every ignition since the last call, and forgets them. ./blaze.ts's
   *  `takeIgnited`, same contract: drained so nothing is announced twice. */
  takeIgnited(): Array<{ readonly x: number; readonly y: number }> {
    const drained = this.ignitedSinceDrain;
    this.ignitedSinceDrain = [];
    return drained;
  }

  /**
   * Forgets everything, telling nobody. The rollback / reset path.
   *
   * The pending ignitions go too — ./blaze.ts's `clear` states why.
   */
  clear(): void {
    this.burning.clear();
    this.ignitedSinceDrain = [];
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
