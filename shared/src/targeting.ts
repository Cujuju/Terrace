// Picking ONE thing out of many when the player aimed at a CELL.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SHARED CONTRACT AND NOT THREE PRIVATE LOOPS.
//
// Several plugins own things that stand on the map in fractional cell space —
// creatures, walkers, boats — and each of them has to answer the same question
// for the same reason: "the player put a torch to cell (x, y); which of mine did
// they mean?". Written per plugin, that loop came out as `return the FIRST one
// whose box covers the cell`, which is only right while the box is one cell
// wide. The moment a plugin picks a wider reach — a boat's hull is several cells
// of timber — "first" stops meaning "the one they aimed at" and starts meaning
// "the one that happened to be created earliest" (owner-observed 2026-08-24: a
// torch put to one boat set fire to its neighbour, and the boat the player
// clicked sailed on).
//
// So the rule lives here, once: WITHIN THE REACH, NEAREST WINS. A caller that
// uses this cannot re-introduce the bug, and the distance it hands back is what
// lets a caller arbitrate between several sets of candidates that do not know
// about each other.
//
// THE REACH IS A BOX, THE RANKING IS A RADIUS, and the pair is deliberate:
//   - the box is what "standing on this cell" means. Cells are picked by
//     rounding (client/src/terrain/picking.ts), so the cell (x, y) is the square
//     of side 1 centred on (x, y) and a half-cell box is exactly it. A radius
//     would cut the corners off that square and leave a creature standing in
//     plain sight of the cursor unlightable.
//   - the ranking is Euclidean because it is compared ACROSS callers with
//     different reaches, and a Chebyshev "distance" from a 2-cell box is not
//     comparable with one from a half-cell box in any way a player would agree
//     with.
// ─────────────────────────────────────────────────────────────────────────────

/** A winning candidate and how far it was from the cell that was aimed at. */
export interface NearestMatch<T> {
  readonly item: T;
  /** Euclidean distance in cells, for comparing winners from different sets. */
  readonly distanceCells: number;
}

/**
 * The candidate nearest to cell (cellX, cellY) whose position is within
 * `reachCells` of it on both axes, or null when none is.
 *
 * TIES GO TO THE FIRST IN ITERATION ORDER, so a caller iterating a stable
 * collection gets a stable answer — two things standing exactly on top of each
 * other must resolve the same way on every machine and every replay, which is
 * the same determinism rule the rest of this package is held to.
 *
 * `positionOf` is in FRACTIONAL CELL SPACE — the same space the callers steer
 * their things in — not world units.
 */
export function nearestWithinReach<T>(
  candidates: Iterable<T>,
  cellX: number,
  cellY: number,
  reachCells: number,
  positionOf: (item: T) => { readonly x: number; readonly y: number },
): NearestMatch<T> | null {
  let nearest: T | null = null;
  let nearestSquared = Infinity;

  for (const candidate of candidates) {
    const at = positionOf(candidate);
    const dx = at.x - cellX;
    const dy = at.y - cellY;
    if (Math.abs(dx) > reachCells) continue;
    if (Math.abs(dy) > reachCells) continue;
    const squared = dx * dx + dy * dy;
    // STRICTLY nearer to win, so the first of equals keeps the place.
    if (squared >= nearestSquared) continue;
    nearest = candidate;
    nearestSquared = squared;
  }

  return nearest === null ? null : { item: nearest, distanceCells: Math.sqrt(nearestSquared) };
}
