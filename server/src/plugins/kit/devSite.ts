export const DEV_SEARCH_RADIUS_CELLS = 160;

export const DEV_SEARCH_STEP_CELLS = 4;

const DEV_SEARCH_SPOKES = 16;

const DEV_SITE_CLEARANCE_CELLS = 32;

const CLEARANCE_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function searchOutwardFromCentre(
  worldSize: number,
  accepts: (x: number, y: number) => boolean,
  centre: { readonly x: number; readonly y: number } = {
    x: Math.floor(worldSize / 2),
    y: Math.floor(worldSize / 2),
  },
): { x: number; y: number } | null {
  for (let radius = 0; radius <= DEV_SEARCH_RADIUS_CELLS; radius += DEV_SEARCH_STEP_CELLS) {
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
