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
  | 'malformed'
  | 'locked'
  | 'plugin-denied'
  | 'plugin-modified-invalid';

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
  if (intent === null) return { applied: false, reason: 'malformed' };

  if (!world.isCellUnlocked(intent.x, intent.y)) {
    return { applied: false, reason: 'locked' };
  }

  const refuse = (reason: IntentRejection, detail?: string): IntentOutcome => {
    if (intent.seq !== undefined) {
      world.sendTo(player.id, { type: 'sculptDenied', seq: intent.seq });
    }
    interceptors.notifyIntentDenied(intent, player);
    return detail === undefined
      ? { applied: false, reason }
      : { applied: false, reason, detail };
  };

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
