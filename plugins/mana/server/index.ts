import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  WORLD_UNIT_CELLS,
  cellsAcross,
  sculptOptionsOf,
  sculptSweepSteps,
} from '@terrace/shared';
import type { CellDiff, SculptIntent } from '@terrace/shared';
import { chunkUnlockPenalty, openedChunkCount, sculptManaCost } from '../pricing.ts';
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../../../server/src/config.ts';
import type {
  IntentCtx,
  IntentVerdict,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';

export const MANA_PER_BAND_WORLD_UNIT_SQUARED = 6;
export const MANA_PER_BAND_CELL =
  MANA_PER_BAND_WORLD_UNIT_SQUARED / (WORLD_UNIT_CELLS * WORLD_UNIT_CELLS);

export const POINT_BRUSH_RADIUS_CELLS = cellsAcross(1);
export const MANA_COST_PER_MIN_RADIUS_SCULPT = sculptManaCost(
  MANA_PER_BAND_CELL,
  POINT_BRUSH_RADIUS_CELLS,
  'soft',
  'stamp',
);

export const MANA_COST_PER_MAX_RADIUS_HARD_SCULPT = sculptManaCost(
  MANA_PER_BAND_CELL,
  MAX_BRUSH_RADIUS,
  'hard',
  'stamp',
);

export const MANA_CAPACITY = 5000;

export const FULL_POOL_MAX_RADIUS_HARD_STAMPS = Math.floor(
  MANA_CAPACITY / MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
);

export const MANA_REGEN_AT_DIFFICULTY_1 = 300;

export const MANA_REGEN_AT_DIFFICULTY_100 = 30;

export function manaRegenForDifficulty(difficulty: number): number {
  const rated = Number.isFinite(difficulty) ? difficulty : DEFAULT_WORLD_DIFFICULTY;
  const span = MAX_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY;
  const t = Math.min(1, Math.max(0, (rated - MIN_WORLD_DIFFICULTY) / span));
  return (
    MANA_REGEN_AT_DIFFICULTY_1 +
    t * (MANA_REGEN_AT_DIFFICULTY_100 - MANA_REGEN_AT_DIFFICULTY_1)
  );
}

export const MANA_REGEN_ENV = 'MANA_REGEN_PER_S';

export const MAX_DRAINED_WAIT_S = 60;

export const MIN_FULL_REFILL_S = 1;

export const MIN_MANA_REGEN_PER_SECOND =
  MANA_COST_PER_MIN_RADIUS_SCULPT / MAX_DRAINED_WAIT_S;

export const MAX_MANA_REGEN_PER_SECOND = MANA_CAPACITY / MIN_FULL_REFILL_S;

export const MANA_INSTANT_REGEN_ENV = 'MANA_INSTANT_REGEN';

const MANA_INSTANT_REGEN_TRUTHY = new Set(['1', 'true', 'yes']);

export function instantRegenEnabled(raw: string | undefined): boolean {
  return raw !== undefined && MANA_INSTANT_REGEN_TRUTHY.has(raw.trim().toLowerCase());
}

export const MANA_INSTANT_REGEN_WARNING =
  `[mana] ${MANA_INSTANT_REGEN_ENV} is on — pools never drain. TEST SETTING; must not be on in a shipped world`;

export const MANA_REGEN_INVALID_WARNING = `[mana] ${MANA_REGEN_ENV} is not a positive finite number; falling back to this world's difficulty-derived rate`;

export const MANA_REGEN_CLAMPED_WARNING = `[mana] ${MANA_REGEN_ENV} clamped into [${MIN_MANA_REGEN_PER_SECOND}, ${MAX_MANA_REGEN_PER_SECOND}] mana/s`;

function clampManaRegenPerSecond(rate: number, onClamp?: () => void): number {
  if (rate < MIN_MANA_REGEN_PER_SECOND) {
    onClamp?.();
    return MIN_MANA_REGEN_PER_SECOND;
  }
  if (rate > MAX_MANA_REGEN_PER_SECOND) {
    onClamp?.();
    return MAX_MANA_REGEN_PER_SECOND;
  }
  return rate;
}

export function resolveManaRegenPerSecond(raw: string | undefined, difficulty: number): number {
  const derived = manaRegenForDifficulty(difficulty);

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return clampManaRegenPerSecond(derived);
  }

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(MANA_REGEN_INVALID_WARNING);
    return clampManaRegenPerSecond(derived);
  }

  return clampManaRegenPerSecond(parsed, () => {
    console.warn(MANA_REGEN_CLAMPED_WARNING);
  });
}

let regenPerSecond: number = manaRegenForDifficulty(DEFAULT_WORLD_DIFFICULTY);

let instantRegen = false;

export function manaRegenPerSecond(): number {
  return regenPerSecond;
}

export function manaRegenFor(playerId: string): number {
  return regenPerSecond * manaPerkOf(playerId).regenMultiplier;
}

export const MANA_PERK_MIN_MULTIPLIER = 0.25;
export const MANA_PERK_MAX_MULTIPLIER = 4;

export const NEUTRAL_MANA_MULTIPLIER = 1;

import { MANA_BALANCE_MESSAGE, MANA_DENIED_MESSAGE } from '../protocol.ts';

export { MANA_BALANCE_MESSAGE, MANA_DENIED_MESSAGE };

export const INSUFFICIENT_MANA_REASON = 'insufficient mana';

interface ManaPool {
  balance: number;
  lastSentBalance: number;
  msSinceLastSend: number;
  lastSeenSeq: number | null;
}

function noteSeq(pool: ManaPool, intent: SculptIntent): void {
  if (intent.seq === undefined) return;
  if (pool.lastSeenSeq === null || intent.seq > pool.lastSeenSeq) pool.lastSeenSeq = intent.seq;
}

function asOfSeqOf(pool: ManaPool): { asOfSeq?: number } {
  return pool.lastSeenSeq === null ? {} : { asOfSeq: pool.lastSeenSeq };
}

const NO_BALANCE_SENT = -1;

export const MANA_BALANCE_HEARTBEAT_MS = 1000;

const poolsByPlayer = new Map<string, ManaPool>();

export interface ManaPerk {
  readonly costMultiplier?: number;
  readonly regenMultiplier?: number;
}

interface EffectiveManaPerk {
  readonly costMultiplier: number;
  readonly regenMultiplier: number;
}

const NEUTRAL_PERK: EffectiveManaPerk = {
  costMultiplier: NEUTRAL_MANA_MULTIPLIER,
  regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
};

const perksByPlayer = new Map<string, EffectiveManaPerk>();

function normalizeMultiplier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NEUTRAL_MANA_MULTIPLIER;
  if (value < MANA_PERK_MIN_MULTIPLIER) return MANA_PERK_MIN_MULTIPLIER;
  if (value > MANA_PERK_MAX_MULTIPLIER) return MANA_PERK_MAX_MULTIPLIER;
  return value;
}

export function setManaPerk(playerId: string, perk: ManaPerk): void {
  perksByPlayer.set(playerId, {
    costMultiplier: normalizeMultiplier(perk.costMultiplier),
    regenMultiplier: normalizeMultiplier(perk.regenMultiplier),
  });
}

export function clearManaPerk(playerId: string): void {
  perksByPlayer.delete(playerId);
}

export function manaPerkOf(playerId: string): EffectiveManaPerk {
  return perksByPlayer.get(playerId) ?? NEUTRAL_PERK;
}

export function manaPerBandCellFor(playerId: string): number {
  return MANA_PER_BAND_CELL * manaPerkOf(playerId).costMultiplier;
}

export function manaCostFor(
  playerId: string,
  intent: SculptIntent,
  openedChunks: number = 0,
): number {
  const options = sculptOptionsOf(intent);
  const rate = manaPerBandCellFor(playerId);
  const stroke = sculptManaCost(
    rate,
    intent.radius,
    options.profile,
    options.tool,
    sculptSweepSteps(intent),
  );
  if (openedChunks === 0) return stroke;
  return (
    stroke +
    openedChunks * chunkUnlockPenalty(rate, intent.radius, options.profile, options.tool)
  );
}

function openedChunksFor(world: WorldApi, token: string, intent: SculptIntent): number {
  return openedChunkCount(world.worldSize, intent.x, intent.y, intent.radius, (cx, cy) =>
    world.isChunkUnlockedForToken(token, cx, cy),
  );
}

function displayBalance(pool: ManaPool): number {
  return Math.floor(pool.balance);
}

function sendBalance(world: WorldApi, playerId: string, pool: ManaPool): void {
  const balance = displayBalance(pool);
  pool.lastSentBalance = balance;
  pool.msSinceLastSend = 0;
  world.sendTo(playerId, MANA_BALANCE_MESSAGE, {
    balance,
    capacity: MANA_CAPACITY,
    ...asOfSeqOf(pool),
    manaPerBandCell: manaPerBandCellFor(playerId),
    regenPerSecond: manaRegenFor(playerId),
  });
}

function poolFor(playerId: string): ManaPool {
  const existing = poolsByPlayer.get(playerId);
  if (existing !== undefined) return existing;

  const created: ManaPool = {
    balance: MANA_CAPACITY,
    lastSentBalance: NO_BALANCE_SENT,
    msSinceLastSend: 0,
    lastSeenSeq: null,
  };
  poolsByPlayer.set(playerId, created);
  return created;
}

export function spendMana(world: WorldApi, playerId: string, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0) return false;

  const pool = poolFor(playerId);
  if (pool.balance < amount) return false;

  pool.balance -= amount;
  sendBalance(world, playerId, pool);
  return true;
}

function checkAffordability(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  noteSeq(pool, intent);
  const cost = manaCostFor(
    ctx.player.id,
    intent,
    openedChunksFor(world, ctx.player.token, intent),
  );

  if (pool.balance < cost) {
    world.sendTo(ctx.player.id, MANA_DENIED_MESSAGE, {
      balance: displayBalance(pool),
      cost,
      ...asOfSeqOf(pool),
    });
    return { kind: 'deny', reason: INSUFFICIENT_MANA_REASON };
  }

  return { kind: 'allow' };
}

function commitCharge(
  intent: SculptIntent,
  ctx: IntentCtx,
  diff: readonly CellDiff[],
): void {
  const { world } = ctx;
  const pool = poolFor(ctx.player.id);
  noteSeq(pool, intent);

  const opened = openedChunksFor(world, ctx.player.token, intent);
  const options = sculptOptionsOf(intent);
  const claimed =
    opened *
    chunkUnlockPenalty(
      manaPerBandCellFor(ctx.player.id),
      intent.radius,
      options.profile,
      options.tool,
    );

  if (diff.length === 0) {
    if (claimed > 0) pool.balance -= claimed;
    sendBalance(world, ctx.player.id, pool);
    return;
  }

  const cost = manaCostFor(ctx.player.id, intent, opened);
  pool.balance -= cost;
  sendBalance(world, ctx.player.id, pool);
}

const MILLISECONDS_PER_SECOND = 1000;

function regenerate(world: WorldApi, dt: number): void {
  const baseGain = regenPerSecond * dt;
  const dtMs = dt * MILLISECONDS_PER_SECOND;

  for (const [playerId, pool] of poolsByPlayer) {
    pool.msSinceLastSend += dtMs;

    if (pool.balance < MANA_CAPACITY) {
      if (instantRegen) {
        pool.balance = MANA_CAPACITY;
      } else {
        pool.balance = Math.min(
          MANA_CAPACITY,
          pool.balance + baseGain * manaPerkOf(playerId).regenMultiplier,
        );
      }
    }

    if (
      displayBalance(pool) !== pool.lastSentBalance ||
      pool.msSinceLastSend >= MANA_BALANCE_HEARTBEAT_MS
    ) {
      sendBalance(world, playerId, pool);
    }
  }
}

export const plugin: TerracePlugin = {
  name: 'mana',

  onWorldCreate(world: WorldApi): void {
    regenPerSecond = resolveManaRegenPerSecond(process.env[MANA_REGEN_ENV], world.difficulty);

    instantRegen = instantRegenEnabled(process.env[MANA_INSTANT_REGEN_ENV]);
    if (instantRegen) console.warn(MANA_INSTANT_REGEN_WARNING);

    poolsByPlayer.clear();
    perksByPlayer.clear();
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    const pool: ManaPool = {
    balance: MANA_CAPACITY,
    lastSentBalance: NO_BALANCE_SENT,
    msSinceLastSend: 0,
    lastSeenSeq: null,
  };
    poolsByPlayer.set(player.id, pool);
    sendBalance(world, player.id, pool);
  },

  onPlayerLeave(_world: WorldApi, player: Player): void {
    poolsByPlayer.delete(player.id);
    clearManaPerk(player.id);
  },

  onTick(world: WorldApi, dt: number): void {
    regenerate(world, dt);
  },

  onIntent(intent: SculptIntent, ctx: IntentCtx): IntentVerdict {
    return checkAffordability(intent, ctx);
  },

  onIntentApplied(intent: SculptIntent, ctx: IntentCtx, diff: readonly CellDiff[]): void {
    commitCharge(intent, ctx, diff);
  },

  onIntentDenied(intent: SculptIntent, ctx: IntentCtx): void {
    const pool = poolFor(ctx.player.id);
    noteSeq(pool, intent);
    sendBalance(ctx.world, ctx.player.id, pool);
  },
};

export function manaBalanceOf(playerId: string): number | null {
  const pool = poolsByPlayer.get(playerId);
  return pool === undefined ? null : displayBalance(pool);
}

export function resetManaState(): void {
  regenPerSecond = manaRegenForDifficulty(DEFAULT_WORLD_DIFFICULTY);
  poolsByPlayer.clear();
  perksByPlayer.clear();
}
