// Settler races, as the chronicle knows them. A COPY of the structures
// plugin's derivation (plugins/structures/protocol.ts, landed 2026-08-19,
// commit 5756ef2), NOT an import — every plugin must build and test with
// every other plugin deleted, so cross-plugin agreement travels as a
// documented copy plus pinned golden vectors (test/chronicle.test.ts pins the
// same six cells structures' own suite pins). If the two derivations ever
// drift, those vectors fail on whichever side moved.
//
// THE PEOPLE (owner decision 2026-08-19): RUDYS are little dog people, UNOS
// are cat people. Naming in prose: a Rudy / an Uno; plural Rudys / Unos.
// Race is DERIVED from where a settlement stands — bit 24 of the district
// hash, one 16×16-cell district = one people — never stored, never synced.

export const SETTLER_RACES = ['rudy', 'uno'] as const;

export type SettlerRace = (typeof SETTLER_RACES)[number];

/** Edge of the square district that shares one race (structures' constant). */
export const SETTLER_DISTRICT_CELLS = 16;

/**
 * 32-bit integer hash — the same function structures (and before it, flora)
 * carries as `hashStructureCell`. Math.imul keeps every step exact int32, so
 * the copy cannot drift by engine.
 */
function hashDistrict(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The race of the settlement standing at cell (x, y) — structures' rule. */
export function settlementRace(x: number, y: number): SettlerRace {
  const districtX = Math.floor(x / SETTLER_DISTRICT_CELLS);
  const districtY = Math.floor(y / SETTLER_DISTRICT_CELLS);
  return SETTLER_RACES[(hashDistrict(districtX, districtY) >>> 24) & 1];
}

/** "Rudy homes", "an Uno village" — the adjective/singular form. */
export const RACE_SINGULAR: Record<SettlerRace, string> = {
  rudy: 'Rudy',
  uno: 'Uno',
};

/** "The Rudys of Harrowmere" — the people, plural. */
export const RACE_PLURAL: Record<SettlerRace, string> = {
  rudy: 'Rudys',
  uno: 'Unos',
};
