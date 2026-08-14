// Reactive state shared between the mana plugin's wiring and its HUD panel.
// Module-scope signals, per the client's standing pattern (see hudState.ts).

import { createSignal } from 'solid-js';

export interface ManaPool {
  readonly balance: number;
  readonly capacity: number;
  /** Perk-adjusted price of this player's next sculpt (server-pushed). */
  readonly cost: number;
}

/** Null until the first mana:balance arrives (e.g. server runs no mana). */
const [manaPool, setManaPool] = createSignal<ManaPool | null>(null);

/**
 * Monotonic count of denials, not a boolean: the panel keys its flash off the
 * VALUE CHANGING, so two denials in quick succession restart the flash instead
 * of the second one being swallowed while the first is still showing.
 */
const [deniedCount, setDeniedCount] = createSignal(0);

export { manaPool, setManaPool, deniedCount };

export function recordDenial(): void {
  setDeniedCount((n) => n + 1);
}

/**
 * THE LOCAL INTENT GATE (wired to ClientPluginCtx.onLocalIntent).
 *
 * Decides against REPLICATED server state whether the player can pay for the
 * next sculpt, so an unaffordable one is never sent and never predicted — the
 * refusal happens silently at the source instead of as a phantom stroke that
 * the server's nack has to claw back a round trip later.
 *
 * On allow, the balance is DEBITED locally: the held brush emits ~8 intents
 * between server balance pushes, and without the debit every one of them
 * would pass the gate against the same stale balance — recreating exactly the
 * burst-of-rejections this gate exists to remove. The next authoritative
 * mana:balance replaces the estimate wholesale, so drift (regen between
 * pushes, a perk collected mid-stroke) self-corrects within one push.
 *
 * With NO pool state at all (server runs no mana plugin, or the first push
 * has not landed), the gate allows: the mana client half must never invent an
 * economy the server did not declare.
 */
export function gateLocalSculpt(): boolean {
  const pool = manaPool();
  if (pool === null) return true;
  if (pool.balance < pool.cost) {
    recordDenial();
    return false;
  }
  setManaPool({ ...pool, balance: pool.balance - pool.cost });
  return true;
}
