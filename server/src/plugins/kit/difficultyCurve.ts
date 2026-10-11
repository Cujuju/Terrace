export const MIN_WORLD_DIFFICULTY = 1;
export const MAX_WORLD_DIFFICULTY = 100;

export function interpolateByDifficulty(
  atEasiest: number,
  atHardest: number,
  difficulty: number,
): number {
  const clamped = Math.min(MAX_WORLD_DIFFICULTY, Math.max(MIN_WORLD_DIFFICULTY, difficulty));
  const t = (clamped - MIN_WORLD_DIFFICULTY) / (MAX_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY);
  return atEasiest + (atHardest - atEasiest) * t;
}
