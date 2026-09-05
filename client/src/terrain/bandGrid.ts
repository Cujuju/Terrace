// bandGrid.ts — the drawn-ground band grid's STEP, and nothing else.
//
// WHY ITS OWN FILE. The step belongs to drawnGroundStore.ts, which is where the
// grid is rasterised and read; but that module reaches capPlanFlat.ts and so
// client/src/config.ts, whose `import.meta.env` cannot be evaluated in a plain
// node test run (see plugins/mana/client/env.d.ts for the same trap). A caller
// that only needs to know how finely the drawn ground is resolved — such as
// plugins/structures/client/site.ts, which steps a mooring's clearance square
// at this pitch and runs under node — would otherwise have to restate a
// quarter, which is exactly the drift a shared constant exists to prevent.
//
// LEAF BY CONTRACT: this file imports nothing and must keep importing nothing.

/**
 * The band grid's step, in CELLS — the resolution at which "which level does
 * the terrain draw here" is precomputed (drawnGroundStore.ts).
 *
 * A QUARTER CELL, and the number is not free: it is the curtain's own probe
 * step (render/water/waterCurtain.ts re-exports it as `CURTAIN_PROBE_CELLS`,
 * with the full argument for the value), so the lattice this answers on is the
 * lattice the only sub-cell caller already reasons about. Halving it would
 * quarter the quantisation error and quadruple both the memory (4.2 KB per
 * chunk today) and the rasterisation cost; doubling it would let one grid
 * sample straddle a whole terrace face.
 */
export const BAND_GRID_CELLS = 1 / 4;
