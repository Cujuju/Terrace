// mana — wire contract shared by both halves.
//
// Two messages, both server → client, both on the plugin's namespaced channel:
//   mana:balance  — the pool moved (join, spend, whole-unit regen tick)
//   mana:denied   — an intent was refused for lack of mana
//
// The client half renders these; the sculptDenied nack in core protocol is
// what rolls the predicted stroke back — this channel is purely for the HUD.

export const MANA_PLUGIN_NAME = 'mana';

/** Un-namespaced type of the server → client balance push (`mana:balance`). */
export const MANA_BALANCE_MESSAGE = 'balance';

/** Un-namespaced type of the server → client refusal (`mana:denied`). */
export const MANA_DENIED_MESSAGE = 'denied';

export interface ManaBalanceMessage {
  /** Whole mana units the player holds right now. */
  readonly balance: number;
  /** Pool size, so the HUD can draw a fraction without knowing the config. */
  readonly capacity: number;
  /**
   * What THIS player's next sculpt costs (perk-adjusted). Load-bearing for the
   * client half's local intent gate: affordability is balance vs cost, and
   * neither is a constant the client could hard-code.
   */
  readonly cost: number;
}

export interface ManaDeniedMessage {
  readonly balance: number;
  /** What the refused sculpt would have cost (perk-adjusted, not a constant). */
  readonly cost: number;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Defensive parse; null means "ignore the message". */
export function parseManaBalancePayload(payload: unknown): ManaBalanceMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { balance?: unknown; capacity?: unknown; cost?: unknown };
  const balance = finiteNonNegative(p.balance);
  const capacity = finiteNonNegative(p.capacity);
  const cost = finiteNonNegative(p.cost);
  if (balance === null || capacity === null || capacity === 0 || cost === null) {
    return null;
  }
  return { balance, capacity, cost };
}

/** Defensive parse; null means "ignore the message". */
export function parseManaDeniedPayload(payload: unknown): ManaDeniedMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { balance?: unknown; cost?: unknown };
  const balance = finiteNonNegative(p.balance);
  const cost = finiteNonNegative(p.cost);
  if (balance === null || cost === null) return null;
  return { balance, cost };
}
