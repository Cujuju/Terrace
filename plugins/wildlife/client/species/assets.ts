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
import { HUMPBACK_ASSET } from './humpback.ts';
import humpbackUrl from '../assets/humpback.glb?url';
import { BLUE_WHALE_ASSET } from './blueWhale.ts';
import blueWhaleUrl from '../assets/blue-whale.glb?url';
import { SPERM_WHALE_ASSET } from './spermWhale.ts';
import spermWhaleUrl from '../assets/sperm-whale.glb?url';
import { DEEPSEA_ASSET } from './deepsea.ts';
import deepseaUrl from '../assets/deepsea.glb?url';
import { GRAZER_ASSET } from './grazer.ts';
import grazerUrl from '../assets/grazer-deer.glb?url';
import { WOLF_ASSET } from './wolf.ts';
import wolfUrl from '../assets/wolf.glb?url';

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
  { spec: HUMPBACK_ASSET, url: humpbackUrl },
  { spec: BLUE_WHALE_ASSET, url: blueWhaleUrl },
  { spec: SPERM_WHALE_ASSET, url: spermWhaleUrl },
  { spec: DEEPSEA_ASSET, url: deepseaUrl },
  { spec: GRAZER_ASSET, url: grazerUrl },
  { spec: WOLF_ASSET, url: wolfUrl },
];
