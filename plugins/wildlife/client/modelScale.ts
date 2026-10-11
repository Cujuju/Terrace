import {
  DEFAULT_SIZE_CLASS,
  SPECIES_REAL_LENGTH_METRES,
  drawnLengthWorldUnits,
  realLengthMetres,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../protocol.ts';
import { ANGELFISH_ENVELOPE } from './species/angelfish.ts';
import { BIRD_ENVELOPE } from './species/bird.ts';
import { BISON_ENVELOPE } from './species/bison.ts';
import { DEEPSEA_ENVELOPE } from './species/deepsea.ts';
import { EEL_ENVELOPE } from './species/eel.ts';
import { FISH_ENVELOPE } from './species/fish.ts';
import { GRAZER_ENVELOPE } from './species/grazer.ts';
import { IBEX_ENVELOPE } from './species/ibex.ts';
import { RAY_ENVELOPE } from './species/ray.ts';
import { SHARK_ENVELOPE } from './species/shark.ts';
import { WOLF_ENVELOPE } from './species/wolf.ts';
import { WHALE_ENVELOPE } from './whaleSpecies.ts';

const AUTHORED_LENGTH_WORLD_UNITS: Readonly<Record<WildlifeSpecies, number>> = {
  fish: FISH_ENVELOPE.length,
  whale: WHALE_ENVELOPE.length,
  deepsea: DEEPSEA_ENVELOPE.length,
  grazer: GRAZER_ENVELOPE.length,
  wolf: WOLF_ENVELOPE.length,
  ibex: IBEX_ENVELOPE.length,
  bison: BISON_ENVELOPE.length,
  ray: RAY_ENVELOPE.length,
  shark: SHARK_ENVELOPE.length,
  eel: EEL_ENVELOPE.length,
  angelfish: ANGELFISH_ENVELOPE.length,
  bird: BIRD_ENVELOPE.length,
};

/** Walkers have one body per species, so their scale needs no variant seed. */
export function walkerModelScale(species: Exclude<WildlifeSpecies, 'whale'>): number {
  return (
    drawnLengthWorldUnits(SPECIES_REAL_LENGTH_METRES[species], DEFAULT_SIZE_CLASS) /
    AUTHORED_LENGTH_WORLD_UNITS[species]
  );
}

export function modelScaleFor(
  species: WildlifeSpecies,
  sizeClass: WildlifeSizeClass,
  variantSeed: number,
): number {
  return (
    drawnLengthWorldUnits(realLengthMetres(species, variantSeed), sizeClass) /
    AUTHORED_LENGTH_WORLD_UNITS[species]
  );
}
