import { sculptOptionsOf, sculptSweepSteps } from '@terrace/shared';
import type { CellDiff, SculptIntent } from '@terrace/shared';
import { chunkUnlockFee, openedChunkCount, sculptManaCost } from '../pricing.ts';
import { MANA_DENIED_MESSAGE } from '../protocol.ts';
import type { IntentCtx, IntentVerdict, WorldApi } from '../../../server/src/plugins/types.ts';
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

export function manaCostFor(
  playerId: string,
  intent: SculptIntent,
  openedChunks: number = 0,
): number {
  const options = sculptOptionsOf(intent);
  const stroke = sculptManaCost(
    manaPerBandCellFor(playerId),
    intent.radius,
    options.profile,
    options.tool,
    sculptSweepSteps(intent),
  );
  return stroke + chunkUnlockFee(openedChunks);
}

function openedChunksFor(world: WorldApi, token: string, intent: SculptIntent): number {
  return openedChunkCount(world.worldSize, intent.x, intent.y, intent.radius, (cx, cy) =>
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

export function commitCharge(
  intent: SculptIntent,
  ctx: IntentCtx,
  diff: readonly CellDiff[],
): void {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  noteSeq(pool, intent);

  const quoted = quotedOpenedChunksFor(pool, intent);
  const opened = quoted ?? openedChunksFor(world, ctx.player.token, intent);
  pool.quote = null;

  // Charge follows effect: a no-op waives the displacement price. Opening the
  // frontier is a separate effect — reveal opens the footprint whatever the
  // diff — so the unlock fee still stands.
  const cost =
    diff.length === 0
      ? chunkUnlockFee(opened)
      : manaCostFor(ctx.player.id, intent, opened);
  pool.balance -= cost;
  sendBalance(world, ctx.player.id, pool);
}

export function forgetQuote(intent: SculptIntent, ctx: IntentCtx): void {
  const pool = poolFor(ctx.player.id);
  pool.quote = null;
  noteSeq(pool, intent);
  sendBalance(ctx.world, ctx.player.id, pool);
}
