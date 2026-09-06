// What a legged mover is DOING vertically, for the pose that draws it.
//
// THE DEFECT (owner, 2026-09-05, on the shipped climb: a peep rises up a cliff
// playing its walk cycle, and a doomed one drops at eight times that speed
// still walking). Three plugins draw legged movers — pilgrims, monsters and
// wildlife — and each had exactly one gait, so "am I climbing" had nowhere to
// be said. The animation contract each of them already has (`animate(seconds,
// phase, …)`) is where it belongs, and it takes this type rather than a
// boolean per state so the third case cannot be bolted on beside the second.
//
// DERIVED FROM THE WIRE, NEVER GUESSED. Both inputs come from the server
// (@terrace/shared's climb.ts, `climbWireOf`): the client cannot infer either
// one, for the reason the protocol comments state.

/**
 * The vertical acts a legged mover has a pose for.
 *
 * 'walk' is also the pose of standing still — a walker's beat is the ground it
 * covers, so a stopped walker is a walk cycle that is not advancing.
 */
export type MoverGait = 'walk' | 'climb' | 'fall';

/**
 * Every gait, in a fixed order — the order IS the pose-variant index a herd
 * palette is keyed by (client/src/render/rigHerd.ts's `poseVariants`), so
 * appending a gait is safe and reordering one is not.
 */
export const MOVER_GAITS: readonly MoverGait[] = ['walk', 'climb', 'fall'];

/** The variant row this gait's poses live in. */
export function moverGaitIndex(gait: MoverGait): number {
  return MOVER_GAITS.indexOf(gait);
}

/**
 * The gait a mover is in, from the two fields its wire carries.
 *
 * `climbHeight` null is the ordinary case: on the ground, walking. `falling` is
 * meaningless without a height and is ignored there rather than trusted, so a
 * stale flag can never strand a walking mover in a fall pose.
 */
export function moverGaitOf(climbHeight: number | null, falling: boolean): MoverGait {
  if (climbHeight === null) return 'walk';
  return falling ? 'fall' : 'climb';
}
