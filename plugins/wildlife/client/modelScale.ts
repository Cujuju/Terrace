import {
  WILDLIFE_SIZE_MODEL_SCALE,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../protocol.ts';
import { GRAZER_DRAW_SCALE } from './species/grazer.ts';

const SPECIES_DRAW_SCALE: Readonly<Record<WildlifeSpecies, number>> = {
  fish: 1,
  whale: 1,
  deepsea: 1,
  grazer: GRAZER_DRAW_SCALE,
  wolf: 1,
  ibex: 1,
  bison: 1,
  ray: 1,
  shark: 1,
  eel: 1,
  angelfish: 1,
  bird: 1,
};

export function speciesModelScale(species: WildlifeSpecies): number {
  return SPECIES_DRAW_SCALE[species];
}

export function modelScaleFor(species: WildlifeSpecies, sizeClass: WildlifeSizeClass): number {
  return WILDLIFE_SIZE_MODEL_SCALE[sizeClass] * SPECIES_DRAW_SCALE[species];
}
