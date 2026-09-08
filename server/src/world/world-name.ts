export type RandomSource = () => number;

const QUALIFIER_ROOTS: readonly string[] = [
  'Ash', 'Ember', 'Storm', 'Frost', 'Gloam', 'Thorn', 'Amber', 'Dusk',
  'Dawn', 'Mire', 'Iron', 'Silver', 'Hollow', 'Wither', 'Sun', 'Moon',
  'Cinder', 'Wild', 'Still', 'Whisper', 'Bramble', 'Gale', 'Rune', 'Elder',
  'Wind', 'Rain', 'Stone', 'Salt', 'Fern', 'Bright',
];

const COMPOUND_ROOTS: readonly string[] = [
  'fall', 'reach', 'moor', 'mere', 'wold', 'crag', 'vale', 'holt',
  'march', 'spire', 'hollow', 'wick', 'barrow', 'fen', 'gard', 'helm',
  'watch', 'deep', 'rise', 'thorn',
];

const LANDFORMS: readonly string[] = [
  'Reach', 'Basin', 'Expanse', 'Hollows', 'Wastes', 'Marches', 'Downs',
  'Steppe', 'Isles', 'Shallows', 'Coast', 'Sound', 'Strand', 'Fells',
  'Verge', 'Wilds',
];

const EPITHETS: readonly string[] = [
  'Sundered', 'Drowned', 'Gilded', 'Restless', 'Forgotten', 'Weeping',
  'Endless', 'Shattered', 'Hallowed', 'Sleeping', 'Windward', 'Sunken',
  'Wandering', 'Kindled', 'Riven', 'Verdant',
];

function pickIndex(length: number, random: RandomSource): number {
  const index = Math.floor(random() * length);
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}

function pick<T>(list: readonly T[], random: RandomSource): T {
  return list[pickIndex(list.length, random)];
}

function compound(random: RandomSource): string {
  const qualifier = pick(QUALIFIER_ROOTS, random);
  const rootIndex = pickIndex(COMPOUND_ROOTS.length, random);
  const root = COMPOUND_ROOTS[rootIndex];
  if (root.toLowerCase() !== qualifier.toLowerCase()) return `${qualifier}${root}`;
  return `${qualifier}${COMPOUND_ROOTS[(rootIndex + 1) % COMPOUND_ROOTS.length]}`;
}

const TEMPLATES: readonly ((random: RandomSource) => string)[] = [
  (random) => compound(random),
  (random) => `${compound(random)} ${pick(LANDFORMS, random)}`,
  (random) => `The ${pick(EPITHETS, random)} ${pick(LANDFORMS, random)}`,
  (random) => `${pick(LANDFORMS, random)} of ${compound(random)}`,
];

export function generateWorldName(random: RandomSource = Math.random): string {
  return pick(TEMPLATES, random)(random);
}
