export const MANA_PLUGIN_NAME = 'mana';

export const MANA_BALANCE_MESSAGE = 'balance';

export const MANA_DENIED_MESSAGE = 'denied';

export interface ManaBalanceMessage {
  readonly balance: number;
  readonly asOfSeq?: number;
  readonly capacity: number;
  readonly manaPerBandCell: number;
  readonly regenPerSecond: number;
}

export interface ManaDeniedMessage {
  readonly balance: number;
  readonly cost: number;
  readonly asOfSeq?: number;
}

function parseAsOfSeq(value: unknown): { asOfSeq?: number } | null {
  if (value === undefined) return {};
  return Number.isSafeInteger(value) ? { asOfSeq: value as number } : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function parseManaBalancePayload(payload: unknown): ManaBalanceMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as {
    balance?: unknown;
    capacity?: unknown;
    manaPerBandCell?: unknown;
    regenPerSecond?: unknown;
    asOfSeq?: unknown;
  };
  const asOf = parseAsOfSeq(p.asOfSeq);
  const balance = finiteNonNegative(p.balance);
  const capacity = finiteNonNegative(p.capacity);
  const manaPerBandCell = finiteNonNegative(p.manaPerBandCell);
  const regenPerSecond = finiteNonNegative(p.regenPerSecond);
  if (
    balance === null ||
    capacity === null ||
    capacity === 0 ||
    manaPerBandCell === null ||
    manaPerBandCell === 0 ||
    regenPerSecond === null ||
    regenPerSecond === 0 ||
    asOf === null
  ) {
    return null;
  }
  return { balance, capacity, manaPerBandCell, regenPerSecond, ...asOf };
}

export function parseManaDeniedPayload(payload: unknown): ManaDeniedMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { balance?: unknown; cost?: unknown; asOfSeq?: unknown };
  const balance = finiteNonNegative(p.balance);
  const cost = finiteNonNegative(p.cost);
  const asOf = parseAsOfSeq(p.asOfSeq);
  if (balance === null || cost === null || asOf === null) return null;
  return { balance, cost, ...asOf };
}
