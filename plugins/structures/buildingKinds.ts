// Every drawable building model, with the radius in cells of the flat dry ground it covers
// at any yaw. client/buildingScale.ts refuses a model that outgrows it.
export const BUILDING_MODEL_FOOTPRINT_RADIUS_CELLS: Readonly<Record<string, number>> = {
  camp: 2,
  hut: 2,
  'prehistoric-granary': 2,
  'roman-granary': 4,
  longhouse: 7,
  'timber-house': 4,
  'stone-cottage': 3,
  watchtower: 2,
  'medieval-dovecote': 3,
  'renaissance-workshop': 4,
  'industrial-pump-house': 5,
  durands: 4,
  ricks: 8,
  'flipper-shrimp': 5,
  'reed-cone': 2,
  'lashed-a-frame': 2,
  'lashed-a-frame-plain': 2,
  'stilted-hut': 3,
  'stilted-hut-plain': 3,
  'windbreak-dome': 2,
  'upturned-hull': 2,
  'twin-hut-yard': 3,
  'twin-hut-yard-plain': 3,
  'drying-rack-long-hut': 3,
  'turf-roof-on-stone': 3,
  'turf-roof-on-stone-plain': 3,
  'net-draped-cone': 2,
  'smoke-pit-hut': 2,
  'smoke-pit-hut-plain': 2,
};

/** Tiers rank building complexity from 0 (straw and hide) to 10 (landmarks). */
export const MAX_BUILDING_TIER = 10;

/** A fish-free variant is drawn from the base model's size rules. */
export const PLAIN_VARIANT_SUFFIX = '-plain';

export function baseModelOf(id: string): string {
  return id.endsWith(PLAIN_VARIANT_SUFFIX) ? id.slice(0, -PLAIN_VARIANT_SUFFIX.length) : id;
}
