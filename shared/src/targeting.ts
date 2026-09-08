export interface NearestMatch<T> {
  readonly item: T;
  readonly distanceCells: number;
}

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
    if (squared >= nearestSquared) continue;
    nearest = candidate;
    nearestSquared = squared;
  }

  return nearest === null ? null : { item: nearest, distanceCells: Math.sqrt(nearestSquared) };
}
