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
// DERIVED FROM THE WIRE, NEVER GUESSED. Every input comes from the server
// (@terrace/shared's climb.ts, `climbWireOf`, and stance.ts, `stanceWireOf`):
// the client cannot infer any of them, for the reason the protocol comments
// state.

import { type MoverStance } from '@terrace/shared';

/**
 * The acts a legged mover has a pose for — the wall's two, over the ground's
 * three.
 *
 * THE GROUND'S THREE ARE `MoverStance` ITSELF (@terrace/shared's stance.ts),
 * widened rather than restated: the server decides which of walk, stand and sit
 * a body is in, and a second spelling of that union here would be a second
 * place for it to fall out of step. 'walk' no longer doubles as the pose of
 * standing still — that was the simplification the owner rejected on
 * 2026-09-06, and 'stand' and 'sit' are what replaced it.
 */
export type MoverGait = MoverStance | 'climb' | 'fall';

/**
 * Every gait, in a fixed order — the order IS the pose-variant index a herd
 * palette is keyed by (client/src/render/rigHerd.ts's `poseVariants`), so
 * appending a gait is safe and reordering one is not. 'stand' and 'sit' were
 * APPENDED on 2026-09-06 for exactly that reason: every shipped index holds.
 */
export const MOVER_GAITS: readonly MoverGait[] = ['walk', 'climb', 'fall', 'stand', 'sit'];

/** The variant row this gait's poses live in. */
export function moverGaitIndex(gait: MoverGait): number {
  return MOVER_GAITS.indexOf(gait);
}

/**
 * The gait a mover is in, from the three fields its wire carries.
 *
 * `climbHeight` null is the ordinary case: on the ground, where the server's
 * `stance` is the whole answer. `falling` is meaningless without a height and
 * is ignored there rather than trusted, so a stale flag can never strand a
 * walking mover in a fall pose.
 *
 * THE WALL BEATS THE GROUND, and it has to: `stance` is stillness measured off
 * the body's x/y, and a climber's x/y are pinned at the foot of the wall for
 * the whole ascent. The server already refuses to accumulate stillness during a
 * climb (stance.ts's `advanceStillness`), so this is belt and suspenders — but
 * the failure it guards is a peep sitting down halfway up a cliff.
 *
 * `stance` defaults to 'walk' so every caller written before the ground gaits —
 * and every test that pins the wall ones — keeps its answers exactly.
 */
export function moverGaitOf(
  climbHeight: number | null,
  falling: boolean,
  stance: MoverStance = 'walk',
): MoverGait {
  if (climbHeight === null) return stance;
  return falling ? 'fall' : 'climb';
}
