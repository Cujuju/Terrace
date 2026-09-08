export const FIRE_IGNITED_EVENT_NAME = 'fire:ignited';

const MAX_IGNITIONS_PER_EVENT = 2048;

const IGNITION_STRIDE = 2;

export interface IgnitedAt {
  readonly x: number;
  readonly y: number;
}

function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseIgnitedPositions(payload: unknown): IgnitedAt[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const ignited = (payload as { ignited?: unknown }).ignited;
  if (!Array.isArray(ignited)) return null;

  const positions: IgnitedAt[] = [];
  for (let i = 0; i + IGNITION_STRIDE - 1 < ignited.length; i += IGNITION_STRIDE) {
    if (positions.length >= MAX_IGNITIONS_PER_EVENT) break;
    const x = ignited[i];
    const y = ignited[i + 1];
    if (!isPosition(x) || !isPosition(y)) continue;
    positions.push({ x, y });
  }
  return positions;
}
