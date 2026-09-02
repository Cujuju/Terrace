// TWO ANCHORS AND A LERP — how a plugin turns this world's difficulty rating
// into one of its own numbers.
//
// WorldApi.difficulty's own instruction is that "a consumer should treat the
// ends as the only fixed points and interpolate between them": a plugin states
// what its number is on the gentlest world and on the harshest one, and every
// rating between them is a straight line. What is here is that line and the two
// ends it is drawn between — not any plugin's anchors, which are the whole of
// what makes one mechanic feel different from another.
//
// CLAMPED AT BOTH ENDS RATHER THAN TRUSTED, because a hand-set WORLD_DIFFICULTY
// outside the documented range would otherwise extrapolate past the anchors —
// and past the hard end a "mean interval" becomes negative, which is a rate of
// minus infinity and an arrival every tick.

/**
 * The lowest and highest values WorldApi.difficulty takes. Restated from that
 * member's own doc comment ("an integer in [1, 100]") because the lerp needs
 * both ends, and a hard-coded 1 and 100 in the arithmetic would be two magic
 * numbers describing a documented contract.
 */
export const MIN_WORLD_DIFFICULTY = 1;
export const MAX_WORLD_DIFFICULTY = 100;

/**
 * `atEasiest` on a world rated MIN_WORLD_DIFFICULTY, `atHardest` on one rated
 * MAX_WORLD_DIFFICULTY, and the straight line between them everywhere else.
 */
export function interpolateByDifficulty(
  atEasiest: number,
  atHardest: number,
  difficulty: number,
): number {
  const clamped = Math.min(MAX_WORLD_DIFFICULTY, Math.max(MIN_WORLD_DIFFICULTY, difficulty));
  const t = (clamped - MIN_WORLD_DIFFICULTY) / (MAX_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY);
  return atEasiest + (atHardest - atEasiest) * t;
}
