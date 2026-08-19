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
//   6. ANSWER THE SENDER      — a sculptApplied ack carrying the intent's seq.
//
// THE ANSWER CONTRACT (issue #21). An intent that carries a seq gets exactly
// one answer back to its sender: 'sculptApplied' from step 6, or 'sculptDenied'
// from step 3. Both exist for the same reason — the client retires the exact
// prediction it made for that intent when its answer arrives, instead of
// inferring acknowledgement from the heights in the broadcast diff. That
// inference cannot work for an edit whose shared math reads terrain the client
// was never sent (see SculptAppliedMessage in shared/src/protocol.ts), which is
// every edit at a territory frontier.
//
// The two silent rejections — 'malformed' and 'locked' — deliberately stay
// unanswered (see below), so their predictions still fall back to the client's
// reconciliation deadline. Neither is reachable from a well-behaved client: it
// runs the same validator, and it only predicts inside chunks it was actually
// sent, which are always a subset of the union mask this pipeline checks.
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
    // The SCULPTOR (issue #17): this is a player's own edit, so the reveal
    // plugin's per-player creep policy has someone to unlock chunks for.
    player.token,
  );

  // 6. ANSWER THE SENDER — and only after applyServerSculpt has returned.
  //
  // ORDERING IS THE WHOLE POINT, so this call sits here rather than inside
  // sculpt-service.ts. By the time applyServerSculpt returns it has already
  // (a) broadcast the filtered terrainDiff and (b) run the plugin listeners,
  // which is where the reveal plugin's per-player creep sends this sculptor
  // any chunkUnlock the spill just earned. Colyseus routes broadcast and
  // sendTo through the same per-client send queue, in call order (verified in
  // @colyseus/ws-transport 0.17.13: Room.broadcastMessageType and
  // Client.send both funnel into WebSocketClient.enqueueRaw), so the sender
  // sees diff → unlock → ack. Acking any earlier would retire the prediction
  // while the authoritative replacement was still in flight, and the sculpted
  // ground would drop for a frame — the very flicker this fixes.
  //
  // The ack is sent even when the diff was EMPTY. "Applied, and it moved
  // nothing" is a real outcome (a stroke clamped at MAX_HEIGHT, or a level
  // fill whose footprint is already at the target level), and it is exactly
  // the case where a client that predicted movement most needs telling.
  //
  // The seq comes from the ORIGINAL intent, not from `effective`: it is the
  // CLIENT's correlation id for the prediction it is holding, so a plugin that
  // rewrites the intent (and drops or changes the field) must not be able to
  // strand that prediction until the deadline. Same reasoning, same source, as
  // the sculptDenied nack above.
  if (intent.seq !== undefined) {
    world.sendTo(player.id, { type: 'sculptApplied', seq: intent.seq });
  }

  return { applied: true, intent: effective, diff };
}
