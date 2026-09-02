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
// plugin that forces something is fog-of-war bound one way or another: storms'
// broadcast is filtered on the eye's cell, so a storm sited outside the square
// is a storm no client is ever told about, and mudslides refuses to sculpt
// unrevealed ground at all. A forced thing outside the square looks like a
// broken renderer or a broken sim.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS HERE AND WHAT IS NOT, verified from the two callers' source on
// 2026-09-01 rather than from their headers.
//
// ONLY THE REACH IS SHARED. storms' dev.ts searches outward in rings of spokes;
// mudslides' scans a grid, and its own header records why it must ("A GRID
// SCAN, NOT A RING SEARCH, which is the second thing this function got wrong…
// Qualifying hillsides are rare enough that a ring's few hundred samples missed
// every one of them on a 512-cell test world"). One wants the NEAREST patch of
// open water, where nearest is best; the other wants the BEST hillside, scored
// by how far mud would run. Those are different searches over the same reach,
// so the reach is what moved and the searches stayed where they are.

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
