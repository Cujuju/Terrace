// World names: what a world is CALLED, minted once at genesis.
//
// A world's name is identity, not simulation. It is generated exactly once —
// when a world is first created — and then persisted alongside the heightmap
// (persistence/snapshot-store.ts), so it survives restarts and every player who
// ever joins sees the same name. Nothing reads it back into the world model.
//
// WHY RANDOMNESS IS SAFE HERE, AND ONLY HERE. Terrain math is a determinism
// contract shared by client and server (design §3.3), and world genesis itself
// is deliberately RNG-free (see freshGenesisHeightAt). This file is neither: it
// produces a string that is stored the instant it is made and never re-derived,
// so a different draw next boot is impossible by construction rather than by
// discipline. It lives server-side, in `server/`, and shared/ never sees it.
//
// STYLE (owner brief: "evocative god-game world names"). Word-pair composition
// from curated roots, in four sentence shapes: a bare compound (Emberfall), a
// compound with a landform (Ashmoor Basin), a definite epithet (The Sundered
// Reach), and a possessive landform (Isles of Gloamwatch). Curated lists rather
// than free syllable assembly because unconstrained syllables produce as much
// noise as it does poetry, and every draw here becomes a permanent name on
// somebody's server.

/**
 * Source of randomness, injectable so tests can pin an exact draw. Must behave
 * like `Math.random`: a float in [0, 1).
 */
export type RandomSource = () => number;

/**
 * Qualifier roots — the first half of a compound. Chosen to read as weather,
 * matter or mood rather than as fantasy proper nouns, so any pairing below is
 * a place a player could imagine standing in.
 */
const QUALIFIER_ROOTS: readonly string[] = [
  'Ash', 'Ember', 'Storm', 'Frost', 'Gloam', 'Thorn', 'Amber', 'Dusk',
  'Dawn', 'Mire', 'Iron', 'Silver', 'Hollow', 'Wither', 'Sun', 'Moon',
  'Cinder', 'Wild', 'Still', 'Whisper', 'Bramble', 'Gale', 'Rune', 'Elder',
  'Wind', 'Rain', 'Stone', 'Salt', 'Fern', 'Bright',
];

/**
 * Landform roots — the second half of a compound. Deliberately the small,
 * old-English kind of word (moor, wold, holt) that compounds without a seam:
 * "Ashmoor" reads as one place, "AshMountain" reads as two words jammed
 * together.
 */
const COMPOUND_ROOTS: readonly string[] = [
  'fall', 'reach', 'moor', 'mere', 'wold', 'crag', 'vale', 'holt',
  'march', 'spire', 'hollow', 'wick', 'barrow', 'fen', 'gard', 'helm',
  'watch', 'deep', 'rise', 'thorn',
];

/**
 * Standalone landforms, used as a following noun ("Ashmoor Basin") or as the
 * head of a possessive ("Isles of Ashmoor"). Plural and singular are mixed on
 * purpose — both templates below read correctly with either.
 */
const LANDFORMS: readonly string[] = [
  'Reach', 'Basin', 'Expanse', 'Hollows', 'Wastes', 'Marches', 'Downs',
  'Steppe', 'Isles', 'Shallows', 'Coast', 'Sound', 'Strand', 'Fells',
  'Verge', 'Wilds',
];

/** Epithets for the definite template ("The Sundered Reach"). */
const EPITHETS: readonly string[] = [
  'Sundered', 'Drowned', 'Gilded', 'Restless', 'Forgotten', 'Weeping',
  'Endless', 'Shattered', 'Hallowed', 'Sleeping', 'Windward', 'Sunken',
  'Wandering', 'Kindled', 'Riven', 'Verdant',
];

/**
 * Uniform index into a list — the one place a draw becomes a position, so the
 * clamp below exists exactly once.
 *
 * The clamp is not defensive noise: `random` is injectable, and a source that
 * returns exactly 1 (or a NaN) would index one past the end and yield
 * `undefined` — a name with the word "undefined" in it, written permanently to
 * somebody's database.
 */
function pickIndex(length: number, random: RandomSource): number {
  const index = Math.floor(random() * length);
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}

/** Uniform pick from a list. */
function pick<T>(list: readonly T[], random: RandomSource): T {
  return list[pickIndex(list.length, random)];
}

/**
 * A compound name: qualifier root + landform root, e.g. "Emberfall".
 *
 * The one rule applied to the draw is that the two halves must not repeat each
 * other — "Thornthorn" and "Hollowhollow" are the only pairings in these lists
 * that read as a mistake rather than as a place. The retry is a deterministic
 * step to the next root rather than a redraw, so a caller's RNG is consumed a
 * fixed number of times per name and a pinned test draw stays predictable.
 */
function compound(random: RandomSource): string {
  const qualifier = pick(QUALIFIER_ROOTS, random);
  const rootIndex = pickIndex(COMPOUND_ROOTS.length, random);
  const root = COMPOUND_ROOTS[rootIndex];
  if (root.toLowerCase() !== qualifier.toLowerCase()) return `${qualifier}${root}`;
  return `${qualifier}${COMPOUND_ROOTS[(rootIndex + 1) % COMPOUND_ROOTS.length]}`;
}

/**
 * The name shapes, one function each. Four rather than one because a server
 * list where every world is "<Word><word>" stops feeling named at all; the
 * definite and possessive forms are what make a world sound like somewhere with
 * a history.
 */
const TEMPLATES: readonly ((random: RandomSource) => string)[] = [
  (random) => compound(random),
  (random) => `${compound(random)} ${pick(LANDFORMS, random)}`,
  (random) => `The ${pick(EPITHETS, random)} ${pick(LANDFORMS, random)}`,
  (random) => `${pick(LANDFORMS, random)} of ${compound(random)}`,
];

/**
 * Mints a name for a brand-new world. Called exactly once per world, at
 * genesis (or on the first boot of a world created before names existed); the
 * result is persisted and never regenerated.
 */
export function generateWorldName(random: RandomSource = Math.random): string {
  return pick(TEMPLATES, random)(random);
}
