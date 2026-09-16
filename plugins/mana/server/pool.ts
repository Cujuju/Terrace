import { sculptOptionsOf } from '@terrace/shared';
import type { SculptIntent, SculptProfile, SculptTool } from '@terrace/shared';
import { MANA_BALANCE_MESSAGE } from '../protocol.ts';
import { DEFAULT_WORLD_DIFFICULTY } from '../../../server/src/config.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { manaPerBandCellFor, manaPerkOf } from './perks.ts';
import {
  MANA_CAPACITY,
  MANA_INSTANT_REGEN_ENV,
  MANA_INSTANT_REGEN_WARNING,
  MANA_REGEN_ENV,
  instantRegenEnabled,
  manaRegenForDifficulty,
  resolveManaRegenPerSecond,
} from './scale.ts';

export interface ManaPool {
  balance: number;
  lastSentBalance: number;
  msSinceLastSend: number;
  lastSeenSeq: number | null;
  quote: ManaQuote | null;
}

/**
 * The territory half of a price, measured at verdict time: the stroke's own
 * creep opens chunks before the effect phase, so re-measuring bills too few.
 */
export interface ManaQuote {
  readonly seq: number | null;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly tool: SculptTool;
  readonly profile: SculptProfile;
  readonly openedChunks: number;
}

/**
 * A seq-less intent carries no wire identity, so its quote is keyed on the
 * verdict that made it: one exists only while that verdict's effect is pending.
 */
const SEQLESS_QUOTE = null;

export function quoteFor(intent: SculptIntent, openedChunks: number): ManaQuote {
  const options = sculptOptionsOf(intent);
  return {
    seq: intent.seq ?? SEQLESS_QUOTE,
    x: intent.x,
    y: intent.y,
    radius: intent.radius,
    tool: options.tool,
    profile: options.profile,
    openedChunks,
  };
}

export function quotedOpenedChunksFor(pool: ManaPool, intent: SculptIntent): number | null {
  const { quote } = pool;
  if (quote === null || quote.seq !== (intent.seq ?? SEQLESS_QUOTE)) return null;
  const options = sculptOptionsOf(intent);
  const sameBrush =
    quote.x === intent.x &&
    quote.y === intent.y &&
    quote.radius === intent.radius &&
    quote.tool === options.tool &&
    quote.profile === options.profile;
  return sameBrush ? quote.openedChunks : null;
}

function newPool(): ManaPool {
  return {
    balance: MANA_CAPACITY,
    lastSentBalance: NO_BALANCE_SENT,
    msSinceLastSend: 0,
    lastSeenSeq: null,
    quote: null,
  };
}

export function noteSeq(pool: ManaPool, intent: SculptIntent): void {
  if (intent.seq === undefined) return;
  if (pool.lastSeenSeq === null || intent.seq > pool.lastSeenSeq) pool.lastSeenSeq = intent.seq;
}

export function asOfSeqOf(pool: ManaPool): { asOfSeq?: number } {
  return pool.lastSeenSeq === null ? {} : { asOfSeq: pool.lastSeenSeq };
}

const NO_BALANCE_SENT = -1;

export const MANA_BALANCE_HEARTBEAT_MS = 1000;

const poolsByPlayer = new Map<string, ManaPool>();

let regenPerSecond: number = manaRegenForDifficulty(DEFAULT_WORLD_DIFFICULTY);

let instantRegen = false;

export function manaRegenPerSecond(): number {
  return regenPerSecond;
}

export function manaRegenFor(playerId: string): number {
  return regenPerSecond * manaPerkOf(playerId).regenMultiplier;
}

/** Reads this world's regen rate and the instant-regen test switch out of the environment. */
export function configureManaRegen(difficulty: number): void {
  regenPerSecond = resolveManaRegenPerSecond(process.env[MANA_REGEN_ENV], difficulty);

  instantRegen = instantRegenEnabled(process.env[MANA_INSTANT_REGEN_ENV]);
  if (instantRegen) console.warn(MANA_INSTANT_REGEN_WARNING);
}

export function resetManaRegen(): void {
  regenPerSecond = manaRegenForDifficulty(DEFAULT_WORLD_DIFFICULTY);
}

export function clearManaPools(): void {
  poolsByPlayer.clear();
}

export function displayBalance(pool: ManaPool): number {
  return Math.floor(pool.balance);
}

export function sendBalance(world: WorldApi, playerId: string, pool: ManaPool): void {
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

export function poolFor(playerId: string): ManaPool {
  const existing = poolsByPlayer.get(playerId);
  if (existing !== undefined) return existing;

  const created = newPool();
  poolsByPlayer.set(playerId, created);
  return created;
}

export function openPoolFor(playerId: string): ManaPool {
  const pool = newPool();
  poolsByPlayer.set(playerId, pool);
  return pool;
}

export function closePoolFor(playerId: string): void {
  poolsByPlayer.delete(playerId);
}

export function spendMana(world: WorldApi, playerId: string, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0) return false;

  const pool = poolFor(playerId);
  if (pool.balance < amount) return false;

  pool.balance -= amount;
  sendBalance(world, playerId, pool);
  return true;
}

const MILLISECONDS_PER_SECOND = 1000;

export function regenerate(world: WorldApi, dt: number): void {
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

export function manaBalanceOf(playerId: string): number | null {
  const pool = poolsByPlayer.get(playerId);
  return pool === undefined ? null : displayBalance(pool);
}
