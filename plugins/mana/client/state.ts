// Reactive state shared between the mana plugin's wiring and its HUD panel.
// Module-scope signals, per the client's standing pattern (see hudState.ts).

import { createSignal } from 'solid-js';
import { sculptOptionsOf, type SculptIntent } from '@terrace/shared';
import { sculptManaCost } from '../pricing.ts';
// THE ACCEPTED COUPLING (documented, deliberate): a plugin's client half reaching
// into the core client's HUD state. Both compile into the same browser bundle
// from the same repo — this is not a network hop or a published API — and the
// import is type-safe, so a rename in hudState.ts breaks the build here rather
// than silently mispricing. The alternative, mirroring the brush selection into
// plugin-local state, would mean two sources of truth for "what brush is the
// player holding" and a way for them to disagree, which is exactly the drift the
// single shared pricing function exists to prevent.
import { brushProfile, brushRadius } from '../../../client/src/state/hudState.ts';

export interface ManaPool {
  readonly balance: number;
  readonly capacity: number;
  /**
   * Perk-adjusted mana per band-cell (server-pushed). A RATE, not a price: the
   * gate below turns it into the price of a specific intent through the same
   * shared function the server charges by.
   */
  readonly manaPerBandCell: number;
  /**
   * Perk-adjusted refill rate in mana per second (server-pushed). Feeds the
   * gauge's smoothing and its pulse period ONLY — the gate below never reads
   * it, so the client's affordability answer stays the server's answer.
   */
  readonly regenPerSecond: number;
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
 * The mana price of the brush the player is CURRENTLY holding, or 0 when no
 * economy has been declared.
 *
 * REACTIVE — reads the pool signal and the HUD's brush signals, so every caller
 * must invoke it at its use site rather than caching the result in a const (the
 * project's standing Solid rule). The gauge draws this number and derives its
 * grain rhythm from it.
 *
 * It is the same function on the same inputs the gate below uses, one line
 * apart, so what the player is shown is what they will be charged.
 *
 * `brushTool` is DELIBERATELY NOT READ. Only radius and profile price a sculpt
 * — the stamp/smooth choice changes how far the edit spills, and that spill is
 * free by design (see sculptDisplacementUnits in shared/src/heightmap.ts).
 * Subscribing to a signal that cannot change the answer would invite a future
 * reader to believe it does.
 */
export function currentBrushCost(): number {
  const pool = manaPool();
  if (pool === null) return 0;
  return sculptManaCost(pool.manaPerBandCell, brushRadius(), brushProfile());
}

/**
 * THE LOCAL INTENT GATE (wired to ClientPluginCtx.onLocalIntent).
 *
 * Decides against REPLICATED server state whether the player can pay for THIS
 * sculpt, so an unaffordable one is never sent and never predicted — the
 * refusal happens silently at the source instead of as a phantom stroke that
 * the server's nack has to claw back a round trip later.
 *
 * PRICED FROM THE INTENT, NOT FROM A PUSHED PRICE. The server pushes a rate; the
 * price of this particular sculpt is that rate times the volume this brush
 * displaces, through the ONE shared function the server itself charges with
 * (../pricing.ts) and the SAME option normalisation the terrain math uses
 * (`sculptOptionsOf`). Identical inputs, identical sequence of operations,
 * therefore an identical integer — a gate that computed the price its own way
 * would eventually disagree with the server by one unit and let through exactly
 * the stroke it exists to stop.
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
export function gateLocalSculpt(intent: SculptIntent): boolean {
  const pool = manaPool();
  if (pool === null) return true;

  const cost = sculptManaCost(
    pool.manaPerBandCell,
    intent.radius,
    sculptOptionsOf(intent).profile,
  );

  if (pool.balance < cost) {
    recordDenial();
    return false;
  }
  // Debit THIS intent's price, not a flat one: a held radius-4 hard brush drains
  // the local estimate 45× faster than a point brush, which is what the server
  // is simultaneously doing to the authoritative pool.
  setManaPool({ ...pool, balance: pool.balance - cost });
  return true;
}
