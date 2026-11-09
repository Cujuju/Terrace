import type { CellDiff, SculptIntent } from '@terrace/shared';
import {
  chunkUnlockFee,
  strokeUnlockChunks,
  sculptIntentCost,
  strokeChargeCost,
} from '../pricing.ts';
import { MANA_DENIED_MESSAGE } from '../protocol.ts';
import type {
  AppliedIntentCtx,
  IntentCtx,
  IntentVerdict,
} from '../../../server/src/plugins/types.ts';
import { manaPerBandCellFor } from './perks.ts';
import {
  asOfSeqOf,
  displayBalance,
  noteSeq,
  poolFor,
  quoteFor,
  quotedOpenedChunkCount,
  sendBalance,
} from './pool.ts';

export const INSUFFICIENT_MANA_REASON = 'insufficient mana';

/** The nominal price a stroke is admitted against; its charge never exceeds it. */
export function manaCostFor(
  playerId: string,
  intent: SculptIntent,
  openedChunks: number = 0,
): number {
  return sculptIntentCost(manaPerBandCellFor(playerId), intent, openedChunks);
}

/** The charge: the material the stroke moved, capped at its nominal, plus the frontier it opened. */
export function manaChargeFor(
  playerId: string,
  displacementUnits: number,
  openedChunks: number,
  intent: SculptIntent,
): number {
  return (
    strokeChargeCost(displacementUnits, manaPerBandCellFor(playerId), intent) +
    chunkUnlockFee(openedChunks)
  );
}

export function checkAffordability(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  pool.quote = null;
  noteSeq(pool, intent);
  const quote = quoteFor(world.worldSize, intent, (cx, cy) =>
    world.isChunkUnlockedForToken(ctx.player.token, cx, cy));
  const cost = manaCostFor(ctx.player.id, intent, quote.closed.length);

  if (pool.balance < cost) {
    world.sendTo(ctx.player.id, MANA_DENIED_MESSAGE, {
      balance: displayBalance(pool),
      cost,
      ...asOfSeqOf(pool),
    });
    return { kind: 'deny', reason: INSUFFICIENT_MANA_REASON };
  }

  // Only a verdict that allowed leaves a quote, so nothing a refusal or a
  // fault aborts can strand one for a later stroke to spend.
  pool.quote = quote;
  return { kind: 'allow' };
}

export function commitCharge(intent: SculptIntent, ctx: AppliedIntentCtx, diff: readonly CellDiff[]): void {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  noteSeq(pool, intent);

  // A faulted mana check is skipped by the host; without its receipt, no pre-effect unlock price is recoverable.
  const opened = quotedOpenedChunkCount(pool, intent, strokeUnlockChunks(world.worldSize, intent, diff));
  pool.quote = null;

  // Charge follows effect: a stroke that moved nothing displaced nothing.
  // Reveal opens the sweep whatever the diff, so the unlock fee still stands.
  pool.balance -= manaChargeFor(ctx.player.id, ctx.displacementUnits, opened, intent);
  sendBalance(world, ctx.player.id, pool);
}

export function forgetQuote(intent: SculptIntent, ctx: IntentCtx): void {
  const pool = poolFor(ctx.player.id);
  pool.quote = null;
  noteSeq(pool, intent);
  sendBalance(ctx.world, ctx.player.id, pool);
}
