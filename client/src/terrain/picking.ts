// Pointer → cell picking maths. Pure: no Three.js, no DOM types beyond a
// plain rectangle shape, so it is unit-tested headless.
//
// The raycast itself lives in input/sculptInput.ts (it needs the camera and
// the live meshes); everything either side of it — screen pixel to normalised
// device coordinates, and world hit point to cell — is here.

export interface Ndc {
  x: number;
  y: number;
}

/** The parts of a DOMRect this module needs. */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CellPick {
  x: number;
  y: number;
}

/**
 * Screen pixel → normalised device coordinates, the [-1, 1] square Three's
 * Raycaster expects. Y is flipped because page coordinates grow downward
 * while NDC grows upward.
 *
 * A zero-sized rect (canvas not laid out yet) would divide by zero, so it is
 * reported as "no valid position" rather than NaN propagating into a raycast.
 */
export function pointerToNdc(
  clientX: number,
  clientY: number,
  rect: ViewportRect,
): Ndc | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((clientY - rect.top) / rect.height) * 2 - 1),
  };
}

/**
 * World-space hit point → the cell to sculpt.
 *
 * World layout is one cell per world unit with cell (x,y) at world
 * (x, height, y) — see config.CELL_WORLD_SIZE — so this is pure rounding.
 *
 * ROUNDING, not flooring: a vertex IS a cell, and sculpting raises vertices,
 * so the cell the user means is the nearest vertex to the point they clicked,
 * not the lower-left corner of the quad they clicked inside. Flooring makes a
 * click on the right half of a tread lift the tread to its left, which reads
 * as an off-by-one to the player.
 *
 * Returns null outside the terrain's extent, [0, worldSize-1] on both axes
 * (the far row/column is a shared border vertex — see vertexGrid.ts).
 */
export function worldPointToCell(
  worldX: number,
  worldZ: number,
  worldSize: number,
): CellPick | null {
  const max = worldSize - 1;
  // Half a cell of tolerance on each side matches the rounding below, so the
  // outermost half-cell of the mesh still picks the edge cell instead of
  // failing.
  const lowerBound = -0.5;
  const upperBound = max + 0.5;
  if (
    !Number.isFinite(worldX) ||
    !Number.isFinite(worldZ) ||
    worldX < lowerBound ||
    worldZ < lowerBound ||
    worldX > upperBound ||
    worldZ > upperBound
  ) {
    return null;
  }

  // `<= 0` rather than `< 0`: rounding a small negative gives -0, which is not
  // less than 0 and would otherwise leak a negative zero out as a cell index.
  const clamp = (v: number): number => (v <= 0 ? 0 : v > max ? max : v);
  return { x: clamp(Math.round(worldX)), y: clamp(Math.round(worldZ)) };
}
