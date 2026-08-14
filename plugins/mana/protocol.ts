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
   * THIS player's price RATE: mana per band-cell displaced, perk-adjusted.
   *
   * Load-bearing for the client half's local intent gate. It is a rate rather
   * than a price because since volume pricing (2026-08-14) there is no single
   * "next sculpt cost" — the price depends on the brush the player is holding,
   * which is client-side state the server does not track. A rate plus the shared
   * volume function (../pricing.ts, shared/src/heightmap.ts) prices any intent
   * the client might send, so affordability stays balance vs a number the server
   * vouched for, with no round trip when the player changes brushes.
   *
   * Strictly positive: a zero rate would make every sculpt free and silently
   * delete the economy on the client side only.
   */
  readonly manaPerBandCell: number;
  /**
   * Mana per second THIS player's pool refills at — the world's configured rate
   * (MANA_REGEN_PER_S) times whatever regen perk they hold. Strictly positive.
   *
   * DISPLAY ONLY. The client advances the gauge between pushes at this rate so
   * a fast world visibly fills fast and a slow one trickles, and derives the
   * gauge's pulse period from it; the pool arithmetic that decides whether a
   * sculpt is affordable stays balance-vs-cost, exactly as before.
   */
  readonly regenPerSecond: number;
}

export interface ManaDeniedMessage {
  readonly balance: number;
  /**
   * What THE REFUSED SCULPT would have cost: a concrete price for a concrete
   * intent (its brush's volume × this player's perk-adjusted rate), not the rate
   * the balance push carries. A refusal is about one edit that did not happen,
   * so it names that edit's price rather than making the reader re-derive it.
   */
  readonly cost: number;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Defensive parse; null means "ignore the message".
 *
 * ALL-OR-NOTHING, including the newer `regenPerSecond` field: both halves of
 * this plugin ship from the same directory, so a balance push missing a field
 * is a bug in the server half rather than an older peer to degrade gracefully
 * for, and a half-parsed pool would drive the local intent gate off numbers
 * nobody vouched for. A rejected push leaves the client with no pool state at
 * all, which the gate already treats as "this server declares no economy" and
 * lets through — the pre-gate behaviour, not a broken one.
 *
 * `regenPerSecond` must be strictly positive: zero would make the gauge's pulse
 * period (cost / regen) infinite and its fill-time estimate a division by zero.
 *
 * `manaPerBandCell` must be strictly positive for a blunter reason: at zero
 * every sculpt prices out at zero, so the client gate would wave through strokes
 * the server is about to deny — an economy that exists on one side of the wire
 * only. Rejecting the push leaves the client with no pool state, which the gate
 * reads as "no economy declared" and handles correctly.
 */
export function parseManaBalancePayload(payload: unknown): ManaBalanceMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as {
    balance?: unknown;
    capacity?: unknown;
    manaPerBandCell?: unknown;
    regenPerSecond?: unknown;
  };
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
    regenPerSecond === 0
  ) {
    return null;
  }
  return { balance, capacity, manaPerBandCell, regenPerSecond };
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
