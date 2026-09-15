import { Group } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { CumulusDeck } from './cumulusDeck.ts';
import type { HazeDeck } from './hazeDeck.ts';
import type { PrecipitationField } from './precipitationField.ts';
import type { InterpolatedDisc } from './discInterpolator.ts';

export const DISC_RENDER_ORDER = 1;

export interface DiscRig {
  readonly root: Group;
  update(disc: InterpolatedDisc, elapsed: number): boolean;
  park(): void;
  dispose(): void;
}

export interface DiscRigSpec {
  readonly name: string;
  readonly deck: CumulusDeck | null;
  readonly haze: HazeDeck | null;
  readonly field: PrecipitationField | null;
}

export function createDiscRig(spec: DiscRigSpec): DiscRig {
  const root = new Group();
  root.name = spec.name;

  const deckSlot = spec.deck === null ? -1 : spec.deck.claimSlot();
  const hazeSlot = spec.haze === null ? -1 : spec.haze.claimSlot();
  const fieldSlot = spec.field === null ? -1 : spec.field.claimSlot();

  function park(): void {
    spec.deck?.park(deckSlot);
    spec.haze?.park(hazeSlot);
    spec.field?.park(fieldSlot);
  }

  return {
    root,

    update(disc: InterpolatedDisc, elapsed: number): boolean {
      root.position.set(disc.x * CELL_WORLD_SIZE, 0, disc.y * CELL_WORLD_SIZE);

      const lit = disc.intensity > 0;
      root.visible = lit;
      if (!lit) {
        park();
        return false;
      }
      spec.deck?.update(deckSlot, disc);
      spec.haze?.update(hazeSlot, disc, elapsed);
      spec.field?.update(fieldSlot, disc, elapsed);
      return true;
    },

    park,

    dispose(): void {
      root.clear();
    },
  };
}

export interface RigPool<T> {
  acquire(): T;
  release(rig: T): void;
  dispose(): void;
}

export function createRigPool<T extends { dispose(): void }>(
  create: () => T,
  onRelease?: (rig: T) => void,
): RigPool<T> {
  const free: T[] = [];
  const all: T[] = [];

  return {
    acquire(): T {
      const reused = free.pop();
      if (reused !== undefined) return reused;
      const rig = create();
      all.push(rig);
      return rig;
    },
    release(rig: T): void {
      onRelease?.(rig);
      free.push(rig);
    },
    dispose(): void {
      for (const rig of all) rig.dispose();
      all.length = 0;
      free.length = 0;
    },
  };
}
