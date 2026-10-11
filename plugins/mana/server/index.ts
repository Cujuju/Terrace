import type { SculptIntent } from '@terrace/shared';
import { MANA_BALANCE_MESSAGE, MANA_DENIED_MESSAGE } from '../protocol.ts';
import type {
  AppliedIntentCtx,
  IntentCtx,
  IntentVerdict,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { checkAffordability, commitCharge, forgetQuote } from './charging.ts';
import { clearAllManaPerks, clearManaPerk } from './perks.ts';
import {
  clearManaPools,
  closePoolFor,
  configureManaRegen,
  openPoolFor,
  regenerate,
  resetManaRegen,
  sendBalance,
} from './pool.ts';

export { MANA_BALANCE_MESSAGE, MANA_DENIED_MESSAGE };

export {
  FULL_POOL_MAX_RADIUS_HARD_STAMPS,
  MANA_CAPACITY,
  MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
  MANA_COST_PER_MIN_RADIUS_SCULPT,
  MANA_INSTANT_REGEN_ENV,
  MANA_INSTANT_REGEN_WARNING,
  MANA_PER_BAND_CELL,
  MANA_PER_BAND_WORLD_UNIT_SQUARED,
  MANA_REGEN_AT_DIFFICULTY_1,
  MANA_REGEN_AT_DIFFICULTY_100,
  MANA_REGEN_CLAMPED_WARNING,
  MANA_REGEN_ENV,
  MANA_REGEN_INVALID_WARNING,
  MAX_DRAINED_WAIT_S,
  MAX_MANA_REGEN_PER_SECOND,
  MIN_FULL_REFILL_S,
  MIN_MANA_REGEN_PER_SECOND,
  POINT_BRUSH_RADIUS_CELLS,
  instantRegenEnabled,
  manaRegenForDifficulty,
  resolveManaRegenPerSecond,
} from './scale.ts';

export {
  MANA_PERK_MAX_MULTIPLIER,
  MANA_PERK_MIN_MULTIPLIER,
  NEUTRAL_MANA_MULTIPLIER,
  clearManaPerk,
  manaPerBandCellFor,
  manaPerkOf,
  setManaPerk,
} from './perks.ts';
export type { ManaPerk } from './perks.ts';

export {
  MANA_BALANCE_HEARTBEAT_MS,
  manaBalanceOf,
  manaRegenFor,
  manaRegenPerSecond,
  spendMana,
} from './pool.ts';

export { INSUFFICIENT_MANA_REASON, manaCostFor } from './charging.ts';
export { CHUNK_UNLOCK_MANA, chunkUnlockFee } from '../pricing.ts';

export const plugin: TerracePlugin = {
  name: 'mana',

  onWorldCreate(world: WorldApi): void {
    configureManaRegen(world.difficulty);

    clearManaPools();
    clearAllManaPerks();
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    const pool = openPoolFor(player.id);
    sendBalance(world, player.id, pool);
  },

  onPlayerLeave(_world: WorldApi, player: Player): void {
    closePoolFor(player.id);
    clearManaPerk(player.id);
  },

  onTick(world: WorldApi, dt: number): void {
    regenerate(world, dt);
  },

  onIntent(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
    return checkAffordability(intent, ctx);
  },

  onIntentApplied(intent: SculptIntent, ctx: AppliedIntentCtx): void {
    commitCharge(intent, ctx);
  },

  onIntentDenied(intent: SculptIntent, ctx: IntentCtx): void {
    forgetQuote(intent, ctx);
  },
};

export function resetManaState(): void {
  resetManaRegen();
  clearManaPools();
  clearAllManaPerks();
}
