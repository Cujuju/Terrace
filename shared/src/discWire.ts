import { isFiniteNumber } from './parse.ts';

export interface DiscSystemState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
  readonly vx: number;
  readonly vy: number;
}

export interface DiscSystemsPayload {
  readonly systems: readonly DiscSystemState[];
}

export function parseDiscSystemsPayload(
  payload: unknown,
  maxSystems: number = Number.POSITIVE_INFINITY,
): DiscSystemState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const systems = (payload as { systems?: unknown }).systems;
  if (!Array.isArray(systems)) return null;

  const parsed: DiscSystemState[] = [];
  const seen = new Set<number>();
  for (const raw of systems) {
    if (parsed.length >= maxSystems) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<DiscSystemState>;
    if (!Number.isInteger(entry.id) || (entry.id as number) <= 0) continue;
    if (seen.has(entry.id as number)) continue;
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) continue;
    if (!isFiniteNumber(entry.radius) || entry.radius <= 0) continue;
    if (!isFiniteNumber(entry.intensity)) continue;
    if (!isFiniteNumber(entry.vx) || !isFiniteNumber(entry.vy)) continue;
    seen.add(entry.id as number);
    parsed.push({
      id: entry.id as number,
      x: entry.x,
      y: entry.y,
      radius: entry.radius,
      intensity: Math.min(1, Math.max(0, entry.intensity)),
      vx: entry.vx,
      vy: entry.vy,
    });
  }
  return parsed;
}
