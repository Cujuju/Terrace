import type { Object3D } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import { createCumulusDeck, CUMULUS_DECK_DRAW_OBJECTS, type CumulusDeck } from './cumulusDeck.ts';
import { createDiscRig, createRigPool, DISC_RENDER_ORDER, type DiscRig, type RigPool } from './discRig.ts';
import { createHazeDeck, HAZE_DECK_DRAW_OBJECTS, type HazeDeck } from './hazeDeck.ts';
import type { PrecipitationProfile } from './precipitation.ts';
import {
  createPrecipitationField,
  PRECIPITATION_FIELD_DRAW_OBJECTS,
  type PrecipitationField,
} from './precipitationField.ts';

export interface DiscKindDeckSpec {
  readonly puffSizeFraction: number;
  readonly color: number;
}

export interface DiscKindRigsSpec {
  readonly name: string;
  readonly maxMasses: number;
  readonly hazeStrength: number;
  readonly deck: DiscKindDeckSpec | null;
  readonly profile: PrecipitationProfile | null;
  readonly applyRevealClip: (material: NodeMaterial, label: string) => void;
}

export interface DiscKindRigs extends RigPool<DiscRig> {
  readonly deck: CumulusDeck | null;
  readonly haze: HazeDeck;
  readonly field: PrecipitationField | null;
  kindObjects(): readonly Object3D[];
}

export type DiscKindBudget = Pick<DiscKindRigsSpec, 'deck' | 'profile'>;

export function discKindDrawObjects(spec: DiscKindBudget): number {
  return (
    HAZE_DECK_DRAW_OBJECTS +
    (spec.deck === null ? 0 : CUMULUS_DECK_DRAW_OBJECTS) +
    (spec.profile === null ? 0 : PRECIPITATION_FIELD_DRAW_OBJECTS)
  );
}

// Everything a disc kind draws lives in per-kind decks; rigs are slot holders.
export function createDiscKindRigs(spec: DiscKindRigsSpec): DiscKindRigs {
  const deck =
    spec.deck === null
      ? null
      : createCumulusDeck({
          maxMasses: spec.maxMasses,
          puffSizeFraction: spec.deck.puffSizeFraction,
          color: spec.deck.color,
          name: `${spec.name}:deck`,
          applyRevealClip: spec.applyRevealClip,
        });
  const haze = createHazeDeck({
    maxMasses: spec.maxMasses,
    strength: spec.hazeStrength,
    name: spec.name,
    applyRevealClip: spec.applyRevealClip,
  });
  const field =
    spec.profile === null
      ? null
      : createPrecipitationField(spec.profile, {
          maxMasses: spec.maxMasses,
          name: spec.name,
          renderOrder: DISC_RENDER_ORDER,
          applyRevealClip: spec.applyRevealClip,
        });

  const pool = createRigPool<DiscRig>(
    () => createDiscRig({ name: `${spec.name}:system`, deck, haze, field }),
    (rig) => rig.park(),
  );

  return {
    deck,
    haze,
    field,
    kindObjects(): readonly Object3D[] {
      const objects: Object3D[] = [haze.object];
      if (deck !== null) objects.push(deck.object);
      if (field !== null) objects.push(field.object);
      return objects;
    },
    acquire: pool.acquire,
    release: pool.release,
    dispose(): void {
      pool.dispose();
      deck?.dispose();
      haze.dispose();
      field?.dispose();
    },
  };
}
