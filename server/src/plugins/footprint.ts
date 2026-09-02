// Is a brush's whole footprint revealed? The one guard that keeps a plugin's
// own sculpt out of territory nobody has unlocked.
//
// WHY IT HAS TO EXIST AT ALL. `WorldApi.sculpt` writes heights whatever the
// mask says — the mask is applied to the BROADCAST, not to the write (see
// server/src/world/sculpt-service.ts). That is right for a player intent, whose
// brush core has already validated, and wrong for a plugin that picked its own
// coordinates: a slide or a surge that ran into fog would silently regrade
// ground the world has not revealed, and a player unlocking that chunk later
// would be handed a scar with no history.
//
// SHARED BY EVERY PLUGIN THAT SCULPTS ON ITS OWN INITIATIVE (mudslides, storm
// surge). It was mudslides' alone until the owner made surge default on
// (issue #230, 2026-09-01) — the same guard in two plugins would be a rule each
// could drift from; it lives here, beside the WorldApi it guards, instead.

import { CHUNK_SIZE } from '@terrace/shared';

/** The slice of WorldApi the guard reads. Structurally satisfied by WorldApi. */
export interface FootprintWorld {
  readonly worldSize: number;
  isChunkUnlocked(cx: number, cy: number): boolean;
}

/**
 * True when every cell a sculpt of `radius` at (x, y) can touch is unlocked.
 *
 * THE FOOTPRINT, NOT THE CENTRE, IS WHAT IS TESTED. A sculpt of radius r
 * touches every cell in the square [x−r, x+r] × [y−r, y+r] (the brush is round,
 * but the square is the cheap superset and erring outward is the safe direction
 * here). Tested by CHUNK rather than by cell: the mask's quantum IS the chunk,
 * so a radius-3 brush costs at most four `isChunkUnlocked` calls instead of
 * forty-nine `isCellUnlocked` ones, and the two can never disagree.
 *
 * A footprint that runs off the world edge is refused too: a brush there would
 * be writing cells that do not exist.
 */
export function footprintUnlocked(
  world: FootprintWorld,
  x: number,
  y: number,
  radius: number,
): boolean {
  const minX = x - radius;
  const maxX = x + radius;
  const minY = y - radius;
  const maxY = y + radius;
  if (minX < 0 || minY < 0 || maxX >= world.worldSize || maxY >= world.worldSize) return false;

  const minCx = Math.floor(minX / CHUNK_SIZE);
  const maxCx = Math.floor(maxX / CHUNK_SIZE);
  const minCy = Math.floor(minY / CHUNK_SIZE);
  const maxCy = Math.floor(maxY / CHUNK_SIZE);
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      if (!world.isChunkUnlocked(cx, cy)) return false;
    }
  }
  return true;
}
