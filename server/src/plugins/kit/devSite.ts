// How far a plugin's DEV FORCE-SPAWN looks for somewhere to put the thing it is
// forcing.
//
// WHAT A DEV FORCE-SPAWN IS. An environment variable that puts a storm, or a
// mudslide, in the middle of the world at boot so a developer can look at one
// without waiting out a Poisson process. It is deliberately not a setting: a
// setting is a choice an OPERATOR makes about how their world plays, and this
// bypasses the very rules the plugin exists to enforce.
//
// WHY THE SEARCH RUNS FROM THE MIDDLE OF THE WORLD. That is where a fresh
// world's revealed square is (server/src/world/initial-unlock.ts), and every
// plugin that forces something is fog-of-war bound one way or another: a
// rotating storm's broadcast is filtered on its own cell, so one sited outside
// the square is a storm no client is ever told about, and a plugin that sculpts
// refuses to touch unrevealed ground at all. A forced thing outside the square looks like a
// broken renderer or a broken sim.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS HERE AND WHAT IS NOT.
//
// THE REACH, and THE OUTWARD RING SEARCH that two plugins now run over it. When
// this module was cut (2026-09-01) the ring search had one caller and stayed
// with it; the 2026-09-02 split turned that one caller into two — one wants the
// nearest LAND to the centre, the other the nearest OPEN WATER — and one search
// asked two questions is exactly the shape that belongs here. What each caller
// passes is a PREDICATE; this file has no opinion about ground.
//
// WHAT IS NOT HERE: the other force-spawn in this repo, which scans a GRID
// rather than walking rings, and its own header records why it must ("A GRID
// SCAN, NOT A RING SEARCH, which is the second thing this function got wrong… Qualifying
// hillsides are rare enough that a ring's few hundred samples missed every one
// of them on a 512-cell test world"). It wants the BEST hillside, scored by how
// far mud would run, where a ring search wants the NEAREST anything. Two
// different searches over the same reach.

/**
 * How far from the centre a forced site is searched, in cells.
 *
 * 160 — half the edge of a fresh world's revealed square (that square is
 * INITIAL_UNLOCK_CHUNK_SPAN × CHUNK_SIZE = 320 cells), so a search covers the
 * territory a new player can see and stops at its edge rather than wandering
 * into fog.
 *
 * PINNED RATHER THAN DERIVED from core's unlock constants, deliberately, and
 * this is the one part of the two copies' reasoning that is worth keeping
 * exactly: if that policy changes, a forced storm lands somewhere slightly less
 * convenient — which is the correct blast radius for a development aid, and a
 * far better one than a boot-time coupling between a plugin's fixture and
 * core's reveal policy.
 */
export const DEV_SEARCH_RADIUS_CELLS = 160;

/**
 * Cells between samples of the outward search. Coarse: a development aid is
 * looking for A site, not the best one to the cell, and both callers run this
 * once, at boot, on a world that exists to be photographed.
 */
export const DEV_SEARCH_STEP_CELLS = 4;

/**
 * Samples taken around each ring of the outward search.
 *
 * SIXTEEN — enough that a ring at the full reach has a sample every ten degrees,
 * which finds a coastline of any ordinary shape without turning the search into
 * a scan.
 */
const DEV_SEARCH_SPOKES = 16;

/**
 * How far around a candidate must match it, in cells.
 *
 * THIRTY-TWO — eight world units. Without this the search returns the FIRST cell
 * that qualifies, which walking outward from a sea centre means the very edge of
 * the first beach: a forced storm stood in the surf and photographed as a
 * waterspout. Requiring the four cells this far out to agree puts a thing that
 * wants land properly inland, and one that wants water in water that is properly
 * open, without needing a second area test.
 */
const DEV_SITE_CLEARANCE_CELLS = 32;

/** The four bearings a candidate's clearance is checked along. */
const CLEARANCE_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The first cell at or near `centre` that `accepts` likes and that is surrounded
 * by ground it also likes, or null if the search found none.
 *
 * A RING SEARCH RATHER THAN A SCAN, because the answer wanted is "as close to the
 * middle as possible": an ordinary raster scan would find the site nearest the
 * top-left corner of the search box instead.
 *
 * `accepts` is only ever called with cells INSIDE the world, so an
 * implementation may read the heightmap without bounds-checking. A clearance
 * sample that falls outside the world fails the candidate, which keeps a forced
 * thing off the map edge as well as off a shoreline.
 */
export function searchOutwardFromCentre(
  worldSize: number,
  accepts: (x: number, y: number) => boolean,
  // The boot-time force searches from the middle of the world; an admin panel's
  // action from wherever the operator is looking.
  centre: { readonly x: number; readonly y: number } = {
    x: Math.floor(worldSize / 2),
    y: Math.floor(worldSize / 2),
  },
): { x: number; y: number } | null {
  for (let radius = 0; radius <= DEV_SEARCH_RADIUS_CELLS; radius += DEV_SEARCH_STEP_CELLS) {
    // The centre itself is one sample, not sixteen of the same cell.
    const spokes = radius === 0 ? 1 : DEV_SEARCH_SPOKES;
    for (let spoke = 0; spoke < spokes; spoke++) {
      const angle = (spoke * 2 * Math.PI) / spokes;
      const x = Math.round(centre.x + Math.cos(angle) * radius);
      const y = Math.round(centre.y + Math.sin(angle) * radius);
      if (x < 0 || y < 0 || x >= worldSize || y >= worldSize) continue;
      if (!accepts(x, y)) continue;
      let clear = true;
      for (const [dx, dy] of CLEARANCE_OFFSETS) {
        const cx = x + dx * DEV_SITE_CLEARANCE_CELLS;
        const cy = y + dy * DEV_SITE_CLEARANCE_CELLS;
        if (cx < 0 || cy < 0 || cx >= worldSize || cy >= worldSize) {
          clear = false;
          break;
        }
        if (!accepts(cx, cy)) {
          clear = false;
          break;
        }
      }
      if (clear) return { x, y };
    }
  }
  return null;
}
