import { sculptOptionsOf, strokeSweep } from '@terrace/shared';
import type { SculptIntent, SculptTool } from '@terrace/shared';
import {
  chunkUnlockFee,
  displacementManaCost,
  openedChunkCount,
  sculptIntentCost,
} from '../pricing.ts';
import { MANA_DENIED_MESSAGE } from '../protocol.ts';
import type {
  AppliedIntentCtx,
  IntentCtx,
  IntentVerdict,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { manaPerBandCellFor } from './perks.ts';
import {
  asOfSeqOf,
  displayBalance,
  noteSeq,
  poolFor,
  quoteFor,
  quotedOpenedChunksFor,
  sendBalance,
} from './pool.ts';

export const INSUFFICIENT_MANA_REASON = 'insufficient mana';

/** The nominal worst case a stroke is admitted against. */
export function manaCostFor(
  playerId: string,
  intent: SculptIntent,
  openedChunks: number = 0,
): number {
  return sculptIntentCost(manaPerBandCellFor(playerId), intent, openedChunks);
}

/** The charge: the material the stroke moved, plus the frontier it opened. */
export function manaChargeFor(
  playerId: string,
  displacementUnits: number,
  openedChunks: number,
  tool: SculptTool,
): number {
  return (
    displacementManaCost(displacementUnits, manaPerBandCellFor(playerId), tool) +
    chunkUnlockFee(openedChunks)
  );
}

function openedChunksFor(world: WorldApi, token: string, intent: SculptIntent): number {
  return openedChunkCount(world.worldSize, strokeSweep(intent), (cx, cy) =>
    world.isChunkUnlockedForToken(token, cx, cy),
  );
}

export function checkAffordability(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  pool.quote = null;
  noteSeq(pool, intent);
  const opened = openedChunksFor(world, ctx.player.token, intent);
  const cost = manaCostFor(ctx.player.id, intent, opened);

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
  pool.quote = quoteFor(intent, opened);
  return { kind: 'allow' };
}

export function commitCharge(intent: SculptIntent, ctx: AppliedIntentCtx): void {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  noteSeq(pool, intent);

  const quoted = quotedOpenedChunksFor(pool, intent);
  const opened = quoted ?? openedChunksFor(world, ctx.player.token, intent);
  pool.quote = null;

  // Charge follows effect: a stroke that moved nothing displaced nothing.
  // Reveal opens the sweep whatever the diff, so the unlock fee still stands.
  pool.balance -= manaChargeFor(
    ctx.player.id,
    ctx.displacementUnits,
    opened,
    sculptOptionsOf(intent).tool,
  );
  sendBalance(world, ctx.player.id, pool);
}

export function forgetQuote(intent: SculptIntent, ctx: IntentCtx): void {
  const pool = poolFor(ctx.player.id);
  pool.quote = null;
  noteSeq(pool, intent);
  sendBalance(ctx.world, ctx.player.id, pool);
}
