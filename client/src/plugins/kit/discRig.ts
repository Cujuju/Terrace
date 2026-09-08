import { Group } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { BufferGeometry, Material } from 'three';
import { createHazeBank, type HazeBank } from './hazeBank.ts';
import type { CumulusDeck } from './cumulusDeck.ts';
import {
  createPrecipitationColumn,
  type PrecipitationColumn,
  type PrecipitationProfile,
} from './precipitation.ts';
import type { InterpolatedDisc } from './discInterpolator.ts';

export const DISC_RENDER_ORDER = 1;

export interface DiscRig {
  readonly root: Group;
  update(disc: InterpolatedDisc, elapsed: number): boolean;
  park(): void;
  dispose(): void;
}

export interface DiscRigSpec {
  readonly hazeGeometry: BufferGeometry;
  readonly hazeStrength: number;
  readonly profile: PrecipitationProfile | null;
  readonly name: string;
  readonly deck: CumulusDeck | null;
  readonly applyRevealClip: ((material: Material, label: string) => void) | null;
}

export function createDiscRig(spec: DiscRigSpec): DiscRig {
  const root = new Group();
  root.name = spec.name;

  const column: PrecipitationColumn | null =
    spec.profile === null ? null : createPrecipitationColumn(spec.profile, DISC_RENDER_ORDER);
  if (column !== null) root.add(column.object);

  const haze: HazeBank = createHazeBank(spec.hazeGeometry, spec.hazeStrength, DISC_RENDER_ORDER);
  for (const sheet of haze.sheets) root.add(sheet);

  if (spec.applyRevealClip !== null) {
    if (column !== null) spec.applyRevealClip(column.material, `${spec.name} column`);
    for (const sheet of haze.sheets) {
      spec.applyRevealClip(sheet.material as Material, `${spec.name} haze`);
    }
  }

  const deckSlot = spec.deck === null ? -1 : spec.deck.claimSlot();

  return {
    root,

    update(disc: InterpolatedDisc, elapsed: number): boolean {
      const worldRadius = disc.radius * CELL_WORLD_SIZE;
      root.position.set(disc.x * CELL_WORLD_SIZE, 0, disc.y * CELL_WORLD_SIZE);

      const lit = disc.intensity > 0;
      root.visible = lit;
      if (!lit) {
        spec.deck?.park(deckSlot);
        return false;
      }
      spec.deck?.update(deckSlot, disc);

      if (column !== null && spec.profile !== null) {
        column.material.opacity = spec.profile.opacity * disc.intensity;
        column.advance(
          elapsed,
          worldRadius,
          disc.vx * CELL_WORLD_SIZE,
          disc.vy * CELL_WORLD_SIZE,
        );
      }

      haze.update(worldRadius, disc.intensity, elapsed);
      return true;
    },

    park(): void {
      spec.deck?.park(deckSlot);
    },

    dispose(): void {
      root.clear();
      column?.dispose();
      haze.dispose();
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
