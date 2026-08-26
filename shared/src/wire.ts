// Broadcast coordinate precision — the one rounding every plugin that puts a
// moving thing on the wire shares.
//
// WHY IT IS HERE AND NOT IN EACH PLUGIN. Five plugins (boats, monsters,
// pilgrims, weather, wildlife) each carried a byte-identical copy of the
// rounding below, and the copies are what let issue #180 happen: the bounded
// form did not exist, so nothing stopped a rounded coordinate from leaving the
// map, and fixing it in one plugin would have left the other four exposed. The
// precision of a broadcast position is a property of the PROTOCOL, which is
// what this package is the single source of truth for.
//
// DETERMINISM. Both functions are `Math.round` on an integer-scaled value —
// exactly specified IEEE, no accumulation, no iteration order — so server and
// client agree byte for byte, as terrain math must (docs/DESIGN.md §3.3).

/**
 * Decimal places kept on broadcast cell coordinates. 1/100 of a cell is far
 * below what any camera distance in this game can resolve — four orders of
 * magnitude finer than a weather system (24 cells across), roughly 280× finer
 * than the smallest creature (a fish is 2.8 cells long) — and it makes a
 * payload's encoded size bounded and exactly assertable in a test.
 */
export const BROADCAST_POSITION_DECIMALS = 2;

const POSITION_QUANTUM = 10 ** BROADCAST_POSITION_DECIMALS;

/**
 * Rounds a value to the broadcast precision, with NO bound on the result.
 *
 * This is the form for a quantity that has no map to be inside of: a heading,
 * an angular rate, a cells-per-second velocity — and for a position that is
 * legitimately allowed off the map (wildlife's birds are born and die outside
 * the world, on their crossing ring). For a position that must land on a cell,
 * use `roundBroadcastCell` instead.
 */
export function roundBroadcastPosition(value: number): number {
  return Math.round(value * POSITION_QUANTUM) / POSITION_QUANTUM;
}

/**
 * The same rounding for a cell-space coordinate, kept INSIDE a
 * `worldSize`-cell map.
 *
 * ROUNDING IS NOT ORDER-PRESERVING WITH RESPECT TO THE MAP EDGE, and that is
 * the whole reason this exists (issue #180). A creature standing legally at
 * x = 255.9987 on a 256-cell world — floor 255, a real cell — rounds to exactly
 * 256.00, which is not a cell at all. Any recipient that turns a broadcast
 * coordinate back into a cell or a chunk (the plugin host's own visibility
 * filter does exactly that, and bounds-checks by contract) is then handed an
 * off-map position for something that never left the map, and throws.
 *
 * So the bound belongs HERE, on the conversion to wire coordinates, rather than
 * on each caller that later divides one by a chunk size: half a quantum of
 * rounding error must not be able to move anything off the world. The clamp
 * target is the largest value this precision can express that still floors to
 * the last cell.
 *
 * It only ever moves a value that rounding itself pushed out of bounds — a
 * position already inside the map is returned exactly as `roundBroadcastPosition`
 * would return it, so no wire value changes for anything not on the edge.
 */
export function roundBroadcastCell(value: number, worldSize: number): number {
  const rounded = roundBroadcastPosition(value);
  if (rounded < 0) return 0;
  const lastRepresentableInside = worldSize - 1 / POSITION_QUANTUM;
  return rounded > lastRepresentableInside ? lastRepresentableInside : rounded;
}
