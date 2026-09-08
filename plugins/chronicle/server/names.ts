const PLACE_PREFIXES = [
  'Harrow', 'Frost', 'Alder', 'Ember', 'Stone', 'Fen',
  'Gale', 'Moss', 'Thorn', 'Bram', 'Wolf', 'Raven',
  'Salt', 'Ash', 'Briar', 'Elm', 'Heath', 'Crag',
  'Mire', 'Dun', 'Loam', 'Rowan', 'Sedge', 'Tarn',
] as const;

const PLACE_SUFFIXES = [
  'mere', 'wick', 'holt', 'fell', 'stead', 'combe',
  'ford', 'gate', 'moor', 'dale', 'strand', 'barrow',
  'cliff', 'reach', 'march', 'hollow',
] as const;

function mix32(cx: number, cy: number): number {
  let h = (Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function placeName(cx: number, cy: number): string {
  const h = mix32(cx, cy);
  const prefix = PLACE_PREFIXES[h % PLACE_PREFIXES.length];
  const suffix = PLACE_SUFFIXES[(h >>> 8) % PLACE_SUFFIXES.length];
  return `${prefix}${suffix}`;
}
