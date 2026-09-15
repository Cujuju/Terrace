import {
  DEFAULT_SCULPT_AMOUNT,
  MIN_BAND,
  sculptOptionsOf,
  validateSculptIntent,
  type CellDiff,
  type SculptDeniedMessage,
  type SculptDeniedReason,
  type SculptIntent,
} from '@terrace/shared';
import type { Player } from '../player.ts';
import type { IntentVerdict } from '../plugins/types.ts';
import {
  applyServerSculpt,
  resendIntentFootprint,
  type TerrainChangeListener,
} from '../world/sculpt-service.ts';
import type { World } from '../world/world.ts';

export type IntentRejection = SculptDeniedReason;

export type IntentOutcome =
  | { readonly applied: true; readonly intent: SculptIntent; readonly diff: CellDiff[] }
  | { readonly applied: false; readonly reason: IntentRejection; readonly detail?: string };

export interface IntentPipelineDeps {
  readonly world: World;
  readonly interceptors: {
    runIntent(intent: SculptIntent, player: Player): IntentVerdict;
    notifyIntentApplied(intent: SculptIntent, player: Player, diff: readonly CellDiff[]): void;
    notifyIntentDenied(intent: SculptIntent, player: Player): void;
  } & TerrainChangeListener;
}

export function handleSculptIntent(
  deps: IntentPipelineDeps,
  player: Player,
  message: unknown,
): IntentOutcome {
  const { world, interceptors } = deps;

  const intent = validateSculptIntent(message, world.size);
  if (intent === null) {
    // No valid intent, so nothing to notify plugins about. Still nack an
    // extractable seq so the sender's prediction is not stranded; an
    // unroutable seq stays silent.
    const seq = sculptMessageSeq(message);
    if (seq !== undefined) {
      world.sendTo(player.id, { type: 'sculptDenied', seq, reason: 'malformed' });
    }
    return { applied: false, reason: 'malformed' };
  }

  const refuse = (reason: IntentRejection, detail?: string): IntentOutcome => {
    if (intent.seq !== undefined) {
      world.sendTo(player.id, {
        type: 'sculptDenied',
        seq: intent.seq,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });
    }
    interceptors.notifyIntentDenied(intent, player);
    return detail === undefined
      ? { applied: false, reason }
      : { applied: false, reason, detail };
  };

  if (!world.isCellUnlocked(intent.x, intent.y)) {
    return refuse('locked');
  }

  if (hangsTheTerrainEngine(intent)) {
    return refuse('malformed', BEDROCK_DRAG_REFUSAL);
  }

  const verdict = interceptors.runIntent(intent, player);
  if (verdict.kind === 'deny') {
    return refuse('plugin-denied', verdict.reason);
  }

  let effective = intent;
  if (verdict.kind === 'modify') {
    const revalidated = validateSculptIntent(verdict.intent, world.size);
    if (revalidated === null) {
      return refuse('plugin-modified-invalid');
    }
    if (!world.isCellUnlocked(revalidated.x, revalidated.y)) {
      return refuse('plugin-modified-invalid', 'centre is locked');
    }
    effective = revalidated;
  }

  const amount = DEFAULT_SCULPT_AMOUNT * effective.dir;
  const diff = applyServerSculpt(
    world,
    interceptors,
    effective.x,
    effective.y,
    effective.radius,
    amount,
    sculptOptionsOf(effective),
    player.token,
  );

  interceptors.notifyIntentApplied(effective, player, diff);

  if (intent.seq !== undefined) {
    world.sendTo(player.id, { type: 'sculptApplied', seq: intent.seq });
  }

  return { applied: true, intent: effective, diff };
}

export const BEDROCK_DRAG_REFUSAL = 'a drag cannot retreat past bedrock';

/**
 * Guard, not a fix: applyDragRegion never terminates for a lower-drag at
 * MIN_BAND, because bedrock re-flooring restores the ceiling it just cut.
 */
function hangsTheTerrainEngine(intent: SculptIntent): boolean {
  return intent.tool === 'drag' && intent.dir === -1 && intent.targetBand === MIN_BAND;
}

/**
 * Answers a sculpt whose handling threw: nack the sender, then resend the
 * authoritative chunks its footprint could have half-edited.
 */
export function refuseFaultedSculpt(
  world: World,
  message: unknown,
  send: (denial: SculptDeniedMessage) => void,
): void {
  const seq = sculptMessageSeq(message);
  if (seq !== undefined) send({ type: 'sculptDenied', seq, reason: 'server-fault' });

  const intent = validateSculptIntent(message, world.size);
  if (intent !== null) resendIntentFootprint(world, intent);
}

/**
 * The seq a sculpt message carries, for nacking a sender whose intent never
 * reached a verdict. A missing or non-integer seq is unroutable by construction.
 */
export function sculptMessageSeq(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { seq } = message as Record<string, unknown>;
  return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : undefined;
}
