import { chunksPerEdge, type SculptIntent } from '@terrace/shared';
import { MANA_BALANCE_MESSAGE } from '../protocol.ts';
import { DEFAULT_WORLD_DIFFICULTY } from '../../../server/src/config.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { manaPerBandCellFor, manaPerkOf } from './perks.ts';
import { manaUnlockPolicy } from './reveal-policy.ts';
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
  readonly bound: readonly number[];
  readonly closed: readonly number[];
}

/**
 * A seq-less intent carries no wire identity, so its quote is keyed on the
 * verdict that made it: one exists only while that verdict's effect is pending.
 */
const SEQLESS_QUOTE = null;

export function quoteFor(
  worldSize: number,
  intent: SculptIntent,
  isOpen: (cx: number, cy: number) => boolean,
  bound: readonly number[],
): ManaQuote {
  const edge = chunksPerEdge(worldSize);
  return {
    seq: intent.seq ?? SEQLESS_QUOTE,
    bound,
    closed: bound.filter((index) => !isOpen(index % edge, Math.floor(index / edge))),
  };
}

export function quotedOpenedChunkCount(pool: ManaPool, intent: SculptIntent, touched: readonly number[]): number {
  const { quote } = pool;
  if (quote === null || quote.seq !== (intent.seq ?? SEQLESS_QUOTE)) return 0;
  const bound = new Set(quote.bound);
  if (touched.some((index) => !bound.has(index))) return 0;
  const closed = new Set(quote.closed);
  return touched.filter((index) => closed.has(index)).length;
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

let manaWorld: WorldApi | null = null;

export function bindManaWorld(world: WorldApi | null): void {
  manaWorld = world;
}

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
    unlockPolicy: manaUnlockPolicy(),
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

/** The caller view remains for bridge compatibility; publishing uses mana's current view. */
export function spendMana(_callerWorld: WorldApi, playerId: string, amount: number): boolean {
  if (manaWorld === null || !Number.isFinite(amount) || amount < 0) return false;

  const pool = poolFor(playerId);
  if (pool.balance < amount) return false;

  pool.balance -= amount;
  sendBalance(manaWorld, playerId, pool);
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
