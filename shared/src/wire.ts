export const BROADCAST_POSITION_DECIMALS = 2;

const POSITION_QUANTUM = 10 ** BROADCAST_POSITION_DECIMALS;

export function roundBroadcastPosition(value: number): number {
  return Math.round(value * POSITION_QUANTUM) / POSITION_QUANTUM;
}

export function roundBroadcastCell(value: number, worldSize: number): number {
  const rounded = roundBroadcastPosition(value);
  if (rounded < 0) return 0;
  const lastRepresentableInside = worldSize - 1 / POSITION_QUANTUM;
  return rounded > lastRepresentableInside ? lastRepresentableInside : rounded;
}

export const BROADCAST_INTENSITY_DECIMALS = 3;

const INTENSITY_QUANTUM = 10 ** BROADCAST_INTENSITY_DECIMALS;

export function roundBroadcastIntensity(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * INTENSITY_QUANTUM) / INTENSITY_QUANTUM;
}
