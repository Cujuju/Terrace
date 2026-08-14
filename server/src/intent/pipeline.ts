// THE INTENT PIPELINE — the anti-cheat model and the sync model in one place
// (design §3.2: "clients send intents, never raw heightmap values").
//
// Everything a client can do to the terrain enters here, in this fixed order:
//
//   1. STRUCTURAL VALIDATION  — shared/validateSculptIntent: types, integrality,
//                               bounds, radius, direction. Untrusted input is
//                               never trusted past this line.
//   2. MASK CHECK             — the brush CENTRE cell's chunk must be unlocked.
//   3. PLUGIN INTERCEPTORS    — allow / deny / modify, first deny wins.
//   4. RE-VALIDATION          — only if a plugin modified the intent.
//   5. NORMALISE + APPLY +    — absent tool/profile resolved through shared's
//      BROADCAST                 sculptOptionsOf, then applied via
//                                sculpt-service (mask-filtered on the wire).
//
// The sculpt AMOUNT is server-side (DEFAULT_SCULPT_AMOUNT × direction) and is
// never read from the message, so a hacked client cannot sculpt harder than
// anyone else. The brush SHAPE (tool, profile) is client-chosen — it changes
// what the edit looks like, never how much it can move.

import {
  DEFAULT_SCULPT_AMOUNT,
  sculptOptionsOf,
  validateSculptIntent,
  type CellDiff,
  type SculptIntent,
} from '@terrace/shared';
import type { Player } from '../player.ts';
import type { IntentVerdict } from '../plugins/types.ts';
import { applyServerSculpt, type TerrainChangeListener } from '../world/sculpt-service.ts';
import type { World } from '../world/world.ts';

export type IntentRejection =
  /** Failed structural validation — malformed or out-of-bounds message. */
  | 'malformed'
  /** The brush centre is in a locked chunk. */
  | 'locked'
  /** A plugin interceptor denied it. */
  | 'plugin-denied'
  /** A plugin rewrote the intent into something invalid — the plugin's bug. */
  | 'plugin-modified-invalid';

export type IntentOutcome =
  | { readonly applied: true; readonly intent: SculptIntent; readonly diff: CellDiff[] }
  | { readonly applied: false; readonly reason: IntentRejection; readonly detail?: string };

/** What the pipeline needs. The room supplies the real World and PluginHost. */
export interface IntentPipelineDeps {
  readonly world: World;
  readonly interceptors: {
    runIntent(intent: SculptIntent, player: Player): IntentVerdict;
  } & TerrainChangeListener;
}

/**
 * Runs one inbound sculpt message end to end.
 *
 * Rejections are returned, not thrown, and carry no reply to the client in v1:
 * a well-behaved client never sends an invalid intent, and telling a hostile
 * one *why* its intent failed would confirm the existence of locked terrain —
 * exactly the information the mask exists to withhold. The caller logs at most.
 */
export function handleSculptIntent(
  deps: IntentPipelineDeps,
  player: Player,
  message: unknown,
): IntentOutcome {
  const { world, interceptors } = deps;

  // 1. Structural validation of untrusted input.
  const intent = validateSculptIntent(message, world.size);
  if (intent === null) return { applied: false, reason: 'malformed' };

  // 2. ANTI-CHEAT: the brush CENTRE must be in an unlocked chunk.
  //
  // Only the centre is checked, by design. The brush and the subsequent
  // gradient relaxation can legitimately reach into locked chunks — that spill
  // is real terrain change and is kept server-side — but a player may only aim
  // at terrain they have been granted. The outgoing diff is filtered separately
  // (sculpt-service.ts) so none of that spill is ever observable.
  if (!world.isCellUnlocked(intent.x, intent.y)) {
    return { applied: false, reason: 'locked' };
  }

  // 3. Plugin interceptor chain (mana, cooldowns, ownership, …).
  const verdict = interceptors.runIntent(intent, player);
  if (verdict.kind === 'deny') {
    // Nack PLUGIN denials — and only those — back to the sender, echoing the
    // intent's seq so the client can retire the exact prediction it made for
    // it immediately instead of waiting out its reconciliation deadline.
    // The mask rejection above stays silent on purpose (see its comment); a
    // plugin denial reveals nothing about the mask, and the plugin itself has
    // already had the chance to say why on its own channel (e.g. mana:denied).
    if (intent.seq !== undefined) {
      world.sendTo(player.id, { type: 'sculptDenied', seq: intent.seq });
    }
    return { applied: false, reason: 'plugin-denied', detail: verdict.reason };
  }

  let effective = intent;
  if (verdict.kind === 'modify') {
    // 4. DEFENCE IN DEPTH: a plugin's rewritten intent is re-validated exactly
    // like client input, and its new centre is re-checked against the mask.
    // Plugins are trusted, but a buggy one must not be able to move a brush
    // out of bounds (which would throw inside the shared brush math) or into
    // locked terrain (which would defeat the mask by proxy).
    const revalidated = validateSculptIntent(verdict.intent, world.size);
    if (revalidated === null) {
      return { applied: false, reason: 'plugin-modified-invalid' };
    }
    if (!world.isCellUnlocked(revalidated.x, revalidated.y)) {
      return { applied: false, reason: 'plugin-modified-invalid', detail: 'centre is locked' };
    }
    effective = revalidated;
  }

  // 5. Apply authoritatively and publish (filtered) to clients.
  //
  // THE ONE NORMALISATION POINT for player intents: an intent that named no
  // tool/profile is resolved here, by the shared contract function, and every
  // layer below this line receives concrete options. The client's prediction
  // store calls the SAME function on the SAME intent, which is what makes
  // "predicted a spire, server built a mound" impossible by construction
  // rather than by two copies of a default agreeing today.
  const amount = DEFAULT_SCULPT_AMOUNT * effective.dir;
  const diff = applyServerSculpt(
    world,
    interceptors,
    effective.x,
    effective.y,
    effective.radius,
    amount,
    sculptOptionsOf(effective),
  );

  return { applied: true, intent: effective, diff };
}
