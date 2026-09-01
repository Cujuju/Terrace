// What stands on a cell — the contract that lets the pointed-at pick resolve a
// whole population by lookup instead of by raycast (GH #252).
//
// ITS OWN MODULE, and deliberately an empty one: this pair of types is imported
// by ../plugins/types.ts, which every plugin's typecheck pulls in. Declaring it
// in ./picking.ts instead would drag that module's `../config.ts` import — and
// therefore Vite's `import.meta.env` types — into the compilation of plugins
// that have never rendered anything. Types only, no imports, no runtime.

/**
 * The vertical extent, in world units, of one registrant's drawn geometry over
 * one cell — the "there is a thing standing here, and it reaches from here to
 * there" answer a cell-space occupancy lookup gives.
 */
export interface CellColumn {
  readonly loY: number;
  readonly hiY: number;
}

/**
 * Where the ray crosses one cell, in world X/Z — the chord from where it
 * entered the cell to where it leaves.
 *
 * WHY THE LOOKUP IS TOLD THIS. A cell is a quarter of a world unit and a tree
 * crown is two cells wide, so "does this cell hold something?" answered at the
 * cell's CENTRE rounds every partly covered cell up to a fully covered one: a
 * ray threading the gap beside a crown is told it hit the tree. Measured over a
 * scripted sweep of camera angles, answering at the ray's own line through the
 * cell instead is what closes most of the gap to the raycast it replaces.
 */
export interface CellRayChord {
  readonly fromX: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toZ: number;
}

/**
 * What one plugin has standing over cell (x, y), where the ray crosses it.
 *
 * A LOOKUP, NOT A RAYCAST, and that is the whole point: the caller marches the
 * cell lattice and asks this once per cell the ray crosses, so no pick ever
 * touches the whole population. Null means "nothing of mine stands over that
 * cell".
 *
 * The extent is the SILHOUETTE along that chord, not the object's bounding box:
 * a tree crown two cells wide reaches higher over its trunk than over its rim,
 * and answering with a box instead would let a player point at a tree through
 * the clear gap beside it.
 */
export type CellOccupancy = (x: number, y: number, chord: CellRayChord) => CellColumn | null;
