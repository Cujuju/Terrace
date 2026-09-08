import { FIRE_ENTITY_CAP, fireEntityKey, isBurnedOut, type FireEntityState } from '../protocol.ts';
import {
  entityFuelAt,
  entityFuelSource,
  type EntityFuelSource,
  type FlammableIndividual,
} from './entityFuel.ts';

interface BurningEntity {
  readonly sourceName: string;
  readonly id: number;
  readonly burnSeconds: number;
  ageSeconds: number;
  awaitingIdentityCheck?: boolean;
}

export interface EntityAdvanceResult {
  readonly burnedOut: ReadonlyMap<string, number[]>;
  readonly changed: boolean;
}

const NO_BURNOUTS: ReadonlyMap<string, number[]> = new Map();

export class EntityBlaze {
  private readonly burning = new Map<string, BurningEntity>();

  private ignitedSinceDrain: Array<{ readonly x: number; readonly y: number }> = [];

  get size(): number {
    return this.burning.size;
  }

  shortestBurnSeconds(): number | null {
    let shortest: number | null = null;
    for (const entity of this.burning.values()) {
      if (shortest === null || entity.burnSeconds < shortest) shortest = entity.burnSeconds;
    }
    return shortest;
  }

  isBurning(sourceName: string, id: number): boolean {
    return this.isBurningKey(fireEntityKey(sourceName, id));
  }

  isBurningKey(key: string): boolean {
    return this.burning.has(key);
  }

  igniteAtCell(x: number, y: number): FireEntityState | null {
    if (this.burning.size >= FIRE_ENTITY_CAP) return null;

    const found = entityFuelAt(x, y, (sourceName, id) =>
      this.burning.has(fireEntityKey(sourceName, id)),
    );
    if (found === null) return null;

    const key = fireEntityKey(found.source.name, found.id);
    if (this.burning.has(key)) return null;

    const entity: BurningEntity = {
      sourceName: found.source.name,
      id: found.id,
      burnSeconds: found.fuel.burnSeconds,
      ageSeconds: 0,
    };
    this.burning.set(key, entity);
    this.ignitedSinceDrain.push(found.source.positionOf(found.id) ?? { x, y });
    found.source.onIgnited?.([found.id]);
    return toState(entity);
  }

  igniteIndividual(candidate: FlammableIndividual): FireEntityState | null {
    if (this.burning.size >= FIRE_ENTITY_CAP) return null;

    const { sourceName, id, fuel } = candidate;
    const key = fireEntityKey(sourceName, id);
    if (this.burning.has(key)) return null;

    const source = entityFuelSource(sourceName);
    if (source === null) return null;

    if (fuel.burnSeconds <= 0) return null;

    if (source.positionOf(id) === null) return null;

    const entity: BurningEntity = {
      sourceName,
      id,
      burnSeconds: fuel.burnSeconds,
      ageSeconds: 0,
    };
    this.burning.set(key, entity);
    this.ignitedSinceDrain.push({ x: candidate.x, y: candidate.y });
    source.onIgnited?.([id]);
    return toState(entity);
  }

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

  advance(dt: number): EntityAdvanceResult {
    let burnedOut: Map<string, number[]> | null = null;
    let changed = false;

    for (const [key, entity] of this.burning) {
      const source = entityFuelSource(entity.sourceName);
      if (source === null) {
        this.burning.delete(key);
        changed = true;
        continue;
      }
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

  extinguish(entities: Iterable<{ readonly sourceName: string; readonly id: number }>): number {
    let stopped = 0;
    for (const entity of entities) {
      if (this.burning.delete(fireEntityKey(entity.sourceName, entity.id))) stopped++;
    }
    return stopped;
  }

  entities(): FireEntityState[] {
    const states: FireEntityState[] = [];
    for (const entity of this.burning.values()) states.push(toState(entity));
    return states;
  }

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

  restore(entities: Iterable<FireEntityState>): void {
    this.burning.clear();
    this.ignitedSinceDrain = [];
    for (const entity of entities) {
      if (this.burning.size >= FIRE_ENTITY_CAP) break;
      if (entity.burnSeconds <= 0) continue;
      if (isBurnedOut(entity.ageSeconds, entity.burnSeconds)) continue;
      this.burning.set(fireEntityKey(entity.sourceName, entity.id), {
        sourceName: entity.sourceName,
        id: entity.id,
        burnSeconds: entity.burnSeconds,
        ageSeconds: entity.ageSeconds,
        awaitingIdentityCheck: true,
      });
    }
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

function toState(entity: BurningEntity): FireEntityState {
  return {
    sourceName: entity.sourceName,
    id: entity.id,
    ageSeconds: entity.ageSeconds,
    burnSeconds: entity.burnSeconds,
  };
}

export type { EntityFuelSource };
