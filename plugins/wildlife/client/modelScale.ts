// How large each species is drawn, and the one expression that combines that
// with an individual's size class. Its own module rather than a section of
// ./placement.ts because ./models.ts needs it too, and placement.ts already
// imports models.ts (BIRD_ENVELOPE) — a cycle would leave whichever module
// loaded second reading the other's uninitialised consts.

import {
  WILDLIFE_SIZE_MODEL_SCALE,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../protocol.ts';
import { GRAZER_DRAW_SCALE } from './species/grazer.ts';

/**
 * How large each species is DRAWN against its own authored/asset dimensions —
 * the per-species half of the model scale, where WILDLIFE_SIZE_MODEL_SCALE is
 * the per-INDIVIDUAL half.
 *
 * WHY IT IS NOT IN THE SPECIES FILES' OWN NUMBERS. Every body figure in this
 * plugin is stated at model scale 1 and multiplied at use (see the envelope
 * tables below) — and for an ASSET species those figures are asserted against
 * the .glb at install, so a species that wanted to be drawn smaller could not
 * simply state smaller numbers. One factor, consumed only through
 * `modelScaleFor`/`speciesModelScale`, keeps every consumer of a body
 * measurement in step: the rig, the body column, the ground footprint and the
 * stride cannot be re-sized independently of each other.
 *
 * 1 is "drawn at the size it was authored", which is every species but the one
 * the owner has asked to re-size.
 */
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

/** The species term alone — for the callers that have no individual in hand. */
export function speciesModelScale(species: WildlifeSpecies): number {
  return SPECIES_DRAW_SCALE[species];
}

/**
 * The uniform scale one creature's model is drawn at: its species' size against
 * the authoring, times its own size class. THE one expression — anything that
 * multiplies a body measurement by a scale calls this, so a species can never
 * be drawn at one size and placed at another.
 */
export function modelScaleFor(species: WildlifeSpecies, sizeClass: WildlifeSizeClass): number {
  return WILDLIFE_SIZE_MODEL_SCALE[sizeClass] * SPECIES_DRAW_SCALE[species];
}
