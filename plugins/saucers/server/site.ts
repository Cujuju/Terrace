// WHERE A DOGFIGHT HAPPENS: the arena, the altitude it is flown at, and the
// cells the losers go into — one per saucer that could be shot down.
//
// ALL THREE ARE CHOSEN ONCE, UP FRONT, AND AN ENCOUNTER THAT CANNOT GET ALL
// THREE DOES NOT START. That is the load-bearing decision in this file.
//
// The obvious alternative — start the fight, and look for somewhere to put the
// wreck when the loser is decided — was rejected because its failure mode is
// silent and permanent: a resolve phase that finds nowhere legal to crash has to
// either sculpt somewhere illegal or quietly skip the crater, and the second is
// a saucer that dives into the ground and leaves nothing, which is the plugin
// visibly not working with no error anywhere to explain it. Siting the crash at
// birth turns that into "no encounter started this minute", which is invisible
// and correct.
//
// EVERY DRAW COMES FROM THE ENCOUNTER'S SEEDED GENERATOR, so the same seed sites
// the same fight over the same ground on any machine.

import { SEA_LEVEL } from '@terrace/shared';
import { ARENA_RADIUS_CELLS, CRUISE_ALTITUDE_WORLD_UNITS, HEIGHT_WORLD_SCALE } from '../protocol.ts';
import { isClearOfSettlements } from './structures-bridge.ts';

/**
 * The slice of the world this file reads. Structural, so the narrow interface
 * can be satisfied by `WorldApi` directly and by a plain object in a harness —
 * the same trick `TerrainSampler` relies on in @terrace/shared.
 */
export interface SiteWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

/**
 * Attempts made to find an arena centre before giving up on this encounter.
 *
 * TWENTY-FOUR. On a world whose unlocked territory is the starting square
 * (320 cells of a 512² map, ~39 % of it) and mostly land, a uniform draw hits a
 * legal centre in the first two or three tries; two dozen makes a legal site
 * overwhelmingly likely wherever there is one at all, and costs a few hundred
 * heightmap reads on a path that runs at most once every few minutes. It is NOT
 * sized to make failure impossible — an all-ocean world genuinely has nowhere
 * for this, and giving up is the honest answer there.
 */
const ARENA_SITE_ATTEMPTS = 24;

/**
 * Attempts made PER CRASH CELL WANTED inside a chosen arena. Same reasoning as
 * the arena's, scaled: an encounter of fifteen needs fourteen DISTINCT cells
 * out of the arena's ~200, and later draws are refused more often because
 * earlier draws already took the cell.
 */
const CRASH_SITE_ATTEMPTS_PER_CELL = 8;

/**
 * How far around the arena centre must also be unlocked land, in cells.
 *
 * THE ARENA'S OWN RADIUS: the pair fly a circle of that radius about the centre,
 * so requiring the ground under the circle to be unlocked land is the same
 * statement as "the fight is over land the player can see". Without it the
 * centre could sit one cell inside a beach and half the dogfight would be flown
 * over fog, where the broadcast's fog-of-war filter hides it — the player would
 * watch two saucers vanish and reappear.
 */
const ARENA_CLEARANCE_CELLS = ARENA_RADIUS_CELLS;

/** The four bearings the arena's clearance is checked along. */
const CLEARANCE_BEARINGS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Bearings the ground under the arena is sampled along when the cruise altitude
 * is measured — SIXTEEN, every 22.5°.
 *
 * WIDER THAN THE CLEARANCE TEST'S FOUR, and deliberately so: the two questions
 * are different. Clearance asks "is the circle over unlocked land", which four
 * cardinal probes answer well enough because a coastline that fails is a
 * coastline that fails in one of them. Altitude asks "what is the HIGHEST thing
 * under this circle", and a peak that sits between two probes is a peak the pair
 * fly through — the one bug in this plugin a player cannot miss. Each bearing is
 * sampled at HALF the arena radius as well as at the full one, so a summit
 * inside the ring is caught too.
 *
 * THIRTY-THREE HEIGHT READS PER ENCOUNTER, once, on a path that runs every few
 * minutes. There is no cost argument against it.
 */
const ALTITUDE_SAMPLE_SPOKES = 16;

/** Fractions of the arena radius each bearing is sampled at. */
const ALTITUDE_SAMPLE_RADII: readonly number[] = [0.5, 1];

/** A cell a wreck may go into. Integral. */
export interface CrashCell {
  readonly x: number;
  readonly y: number;
  /** World-space Y of the ground there when the site was chosen — where the dive ends. */
  readonly groundY: number;
}

/** Where one encounter is flown, and where it ends. Cells, integral. */
export interface ArenaSite {
  readonly centreX: number;
  readonly centreY: number;
  /**
   * One legal, DISTINCT cell per wreck the encounter might leave — exactly as
   * many as were asked for, in the order they were drawn. Saucer N that goes
   * down takes cell N; the order carries no meaning beyond being fixed.
   */
  readonly crashCells: readonly CrashCell[];
  /** World-space Y the saucers cruise and fight at. */
  readonly altitude: number;
}

/** Unlocked, dry ground — the one terrain question this file asks. */
function isOpenLand(world: SiteWorld, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return world.heightAt(x, y) > SEA_LEVEL;
}

/** Is the whole circle the pair will fly over open land? */
function hasArenaClearance(world: SiteWorld, x: number, y: number): boolean {
  for (const [dx, dy] of CLEARANCE_BEARINGS) {
    const sx = Math.round(x + dx * ARENA_CLEARANCE_CELLS);
    const sy = Math.round(y + dy * ARENA_CLEARANCE_CELLS);
    if (!isOpenLand(world, sx, sy)) return false;
  }
  return true;
}

/**
 * World-space Y for a fight over this arena: CRUISE_ALTITUDE_WORLD_UNITS above
 * the HIGHEST ground the samples find.
 *
 * The highest and not the average, because the altitude's job is clearance: an
 * average would put the pair through the one peak inside the arena, and a saucer
 * flying through a mountain is the one bug in this plugin a player cannot miss.
 */
function arenaAltitude(world: SiteWorld, x: number, y: number): number {
  let peak = world.heightAt(x, y);
  for (let spoke = 0; spoke < ALTITUDE_SAMPLE_SPOKES; spoke++) {
    const angle = (spoke * 2 * Math.PI) / ALTITUDE_SAMPLE_SPOKES;
    for (const fraction of ALTITUDE_SAMPLE_RADII) {
      const sx = Math.round(x + Math.cos(angle) * ARENA_RADIUS_CELLS * fraction);
      const sy = Math.round(y + Math.sin(angle) * ARENA_RADIUS_CELLS * fraction);
      // A sample off the map contributes nothing: there is no ground there to
      // fly into, and `heightAt` outside the world is not a question this file
      // is entitled to ask.
      if (sx < 0 || sy < 0 || sx >= world.worldSize || sy >= world.worldSize) continue;
      const height = world.heightAt(sx, sy);
      if (height > peak) peak = height;
    }
  }
  return peak * HEIGHT_WORLD_SCALE + CRUISE_ALTITUDE_WORLD_UNITS;
}

/**
 * `wanted` distinct cells inside the arena a wreck may legally go into, or null
 * if the arena cannot supply that many.
 *
 * DISTINCT, because the crater is two bands deep and two wrecks on one cell
 * would dig the four-band hole CRASH_CRATER_DEPTH_BANDS was chosen to avoid.
 * Adjacent cells still overlap their craters, which is a deeper hole in the
 * overlap but never a doubled one at the centre.
 *
 * THE THREE RULES, and each one is a different kind of "no":
 *   * open land — a crater in the seabed is invisible and a fire in the sea is
 *     nothing, so a wreck that came down there would leave no trace of the
 *     event at all;
 *   * unlocked — the sculpt would otherwise rewrite ground nobody has revealed,
 *     which is terrain the player will one day meet already broken with no
 *     account of why;
 *   * clear of settlements — see structures-bridge.ts for why this is asked of a
 *     sibling rather than enforced by core.
 *
 * DRAWN UNIFORMLY OVER THE DISC'S AREA (the `sqrt`), not over its radius, which
 * is what stops every wreck landing near the middle of the arena.
 */
function findCrashCells(
  world: SiteWorld,
  centreX: number,
  centreY: number,
  random: () => number,
  wanted: number,
): CrashCell[] | null {
  const cells: CrashCell[] = [];
  const taken = new Set<number>();
  const attempts = CRASH_SITE_ATTEMPTS_PER_CELL * wanted;
  for (let attempt = 0; attempt < attempts && cells.length < wanted; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * ARENA_RADIUS_CELLS;
    const x = Math.round(centreX + Math.cos(angle) * distance);
    const y = Math.round(centreY + Math.sin(angle) * distance);
    const key = y * world.worldSize + x;
    if (taken.has(key)) continue;
    if (!isOpenLand(world, x, y)) continue;
    if (!isClearOfSettlements(x, y)) continue;
    taken.add(key);
    cells.push({ x, y, groundY: world.heightAt(x, y) * HEIGHT_WORLD_SCALE });
  }
  return cells.length === wanted ? cells : null;
}

/**
 * Sites one encounter, or returns null when this world has nowhere to put one
 * right now — an all-ocean map, a world whose unlocked square is all coastline,
 * or a player who has built over every clear acre of it.
 *
 * NULL IS AN ORDINARY ANSWER, not an error: the arrival roll simply produced
 * nothing this time, exactly as tornado's `trySpawnTornado` reports a cloud with
 * no land under it.
 */
export function findArenaSite(
  world: SiteWorld,
  random: () => number,
  crashCellsWanted: number,
): ArenaSite | null {
  for (let attempt = 0; attempt < ARENA_SITE_ATTEMPTS; attempt++) {
    const centreX = Math.floor(random() * world.worldSize);
    const centreY = Math.floor(random() * world.worldSize);
    if (!isOpenLand(world, centreX, centreY)) continue;
    if (!hasArenaClearance(world, centreX, centreY)) continue;

    const crashCells = findCrashCells(world, centreX, centreY, random, crashCellsWanted);
    if (crashCells === null) continue;

    return { centreX, centreY, crashCells, altitude: arenaAltitude(world, centreX, centreY) };
  }
  return null;
}

/**
 * Sites one encounter as close to `near` as it can — the admin panel's path,
 * where the operator has told us WHERE by looking at it.
 *
 * IT IS NOT `searchOutwardFromCentre` (server/src/plugins/kit/devSite.ts), and
 * the difference is what has to be found: that kit finds ONE cell with clearance
 * around it, and an encounter needs a centre AND its crash cells inside the
 * arena around it that clear the towns. Running the kit and then failing the second
 * test would give up on a site the ring search had already committed to. What is
 * shared is the SHAPE — rings outward from a point, coarse steps — and it is
 * restated here for that reason rather than bent to fit.
 */
export function findArenaSiteNear(
  world: SiteWorld,
  near: { readonly x: number; readonly y: number },
  random: () => number,
  crashCellsWanted: number,
): ArenaSite | null {
  for (let radius = 0; radius <= ADMIN_SEARCH_RADIUS_CELLS; radius += ADMIN_SEARCH_STEP_CELLS) {
    // The centre itself is one sample, not a ring of identical ones.
    const spokes = radius === 0 ? 1 : ADMIN_SEARCH_SPOKES;
    for (let spoke = 0; spoke < spokes; spoke++) {
      const angle = (spoke * 2 * Math.PI) / spokes;
      const centreX = Math.round(near.x + Math.cos(angle) * radius);
      const centreY = Math.round(near.y + Math.sin(angle) * radius);
      if (!isOpenLand(world, centreX, centreY)) continue;
      if (!hasArenaClearance(world, centreX, centreY)) continue;

      const crashCells = findCrashCells(world, centreX, centreY, random, crashCellsWanted);
      if (crashCells === null) continue;

      return { centreX, centreY, crashCells, altitude: arenaAltitude(world, centreX, centreY) };
    }
  }
  return null;
}

/**
 * How far the admin search will walk from where the operator is looking.
 *
 * 160 CELLS, the same reach `DEV_SEARCH_RADIUS_CELLS` uses and pinned here for
 * the same reason that constant is pinned rather than derived: it covers the
 * territory a new world's initial unlock grants and stops at its edge, and if
 * core's reveal policy ever changes, an admin-summoned dogfight lands somewhere
 * slightly less convenient — which is the correct blast radius for this.
 */
export const ADMIN_SEARCH_RADIUS_CELLS = 160;

/**
 * Cells between rings of the admin search. Eight: the operator asked for a
 * dogfight near where they are looking, not for the single best acre, and the
 * arena is sixteen cells across, so a finer step would only re-test overlapping
 * ground.
 */
const ADMIN_SEARCH_STEP_CELLS = 8;

/** Samples per ring — sixteen, a bearing every 22.5°. */
const ADMIN_SEARCH_SPOKES = 16;
