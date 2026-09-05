// The species drawn from a file — Blender-built (fish, shark, ray, eel, angelfish) or downloaded and
// rigidified (the deer grazer) — and where each file is served from. THE ONE LIST.
//
// Two consumers install these: the shipped plugin's `preload` (../index.ts)
// and the throwaway preview harness (client/src/previewSpecies.ts). Until the
// shark, each kept its own list, and a species added to one and not the other
// was a preview that threw "no asset installed" the first time someone looked
// at it. One table, imported by both, is how a pass of the model arc (ray,
// eel, angelfish, the three whales, deepsea) adds ONE row and nothing else.
//
// A `.glb?url` import, which is why client/vite.config.ts carries an
// assetsInclude entry for .glb files; the ambient declaration for the import
// pattern is types/glb-url.d.ts at the repo root, which every package's
// tsconfig inherits through tsconfig.base.json's `files`.
import type { SpeciesAssetSpec } from './assetSpecies.ts';
import { FISH_ASSET } from './fish.ts';
import fishUrl from '../assets/fish.glb?url';
import { SHARK_ASSET } from './shark.ts';
import sharkUrl from '../assets/shark.glb?url';
import { RAY_ASSET } from './ray.ts';
import rayUrl from '../assets/ray.glb?url';
import { EEL_ASSET } from './eel.ts';
import eelUrl from '../assets/eel.glb?url';
import { ANGELFISH_ASSET } from './angelfish.ts';
import angelfishUrl from '../assets/angelfish.glb?url';
import { GRAZER_ASSET } from './grazer.ts';
import grazerUrl from '../assets/grazer-deer.glb?url';

/** One asset-sourced species: what it must measure, and where its file is. */
export interface SpeciesAssetEntry {
  readonly spec: SpeciesAssetSpec;
  readonly url: string;
}

export const SPECIES_ASSETS: readonly SpeciesAssetEntry[] = [
  { spec: FISH_ASSET, url: fishUrl },
  { spec: SHARK_ASSET, url: sharkUrl },
  { spec: RAY_ASSET, url: rayUrl },
  { spec: EEL_ASSET, url: eelUrl },
  { spec: ANGELFISH_ASSET, url: angelfishUrl },
  { spec: GRAZER_ASSET, url: grazerUrl },
];
