import { createSignal } from 'solid-js';
import { sculptOptionsOf, sculptProfileOf, sculptSweepSteps, type SculptIntent } from '@terrace/shared';
import { chunkOriginCell, chunkUnlockPenalty, openedChunkCount, sculptManaCost } from '../pricing.ts';
import type { ManaBalanceMessage, ManaDeniedMessage } from '../protocol.ts';
import { brushProfile, brushRadius, brushTool } from '../../../client/src/state/hudState.ts';

export interface ManaPool {
  readonly balance: number;
  readonly capacity: number;
  readonly manaPerBandCell: number;
  readonly regenPerSecond: number;
}

let balanceAsOfMs = 0;

const nowMs = (): number => performance.now();

export function liveBalance(pool: ManaPool, at: number = nowMs()): number {
  const earned = ((at - balanceAsOfMs) / 1000) * pool.regenPerSecond;
  const grown = earned > 0 ? pool.balance + earned : pool.balance;
  return grown > pool.capacity ? pool.capacity : grown;
}

const [manaPool, setPoolSignal] = createSignal<ManaPool | null>(null);

const setManaPool: typeof setPoolSignal = ((value) => {
  balanceAsOfMs = nowMs();
  return setPoolSignal(value as never);
}) as typeof setPoolSignal;

function debitLocally(pool: ManaPool, cost: number): void {
  setPoolSignal({ ...pool, balance: pool.balance - cost });
}

interface InFlightDebit {
  readonly seq: number | null;
  readonly cost: number;
  readonly debitedAtMs: number;
}

const IN_FLIGHT_DEBIT_TTL_MS = 1000;

let inFlight: InFlightDebit[] = [];

function settleInFlight(asOfSeq: number | undefined, at: number): number {
  inFlight = inFlight.filter(
    (debit) =>
      debit.seq !== null &&
      at - debit.debitedAtMs < IN_FLIGHT_DEBIT_TTL_MS &&
      (asOfSeq === undefined || debit.seq > asOfSeq),
  );
  let owed = 0;
  for (const debit of inFlight) owed += debit.cost;
  return owed;
}

export function applyBalancePush(msg: ManaBalanceMessage): void {
  const owed = settleInFlight(msg.asOfSeq, nowMs());
  setManaPool({
    balance: Math.max(0, msg.balance - owed),
    capacity: msg.capacity,
    manaPerBandCell: msg.manaPerBandCell,
    regenPerSecond: msg.regenPerSecond,
  });
}

export function applyDenial(denied: ManaDeniedMessage): void {
  const owed = settleInFlight(denied.asOfSeq, nowMs());
  setManaPool((pool) =>
    pool === null ? null : { ...pool, balance: Math.max(0, denied.balance - owed) },
  );
}

export function clearInFlightDebits(): void {
  inFlight = [];
}

const [deniedCount, setDeniedCount] = createSignal(0);

export { manaPool, setManaPool, deniedCount };

export function recordDenial(): void {
  setDeniedCount((n) => n + 1);
}

export function currentBrushCost(): number {
  const pool = manaPool();
  if (pool === null) return 0;
  const tool = brushTool();
  return sculptManaCost(
    pool.manaPerBandCell,
    brushRadius(),
    sculptProfileOf(tool, brushProfile()),
    tool,
  );
}

export function currentBalance(): number | null {
  const pool = manaPool();
  return pool === null ? null : liveBalance(pool);
}

export interface LocalTerritory {
  worldSize(): number;
  revealedAt(x: number, y: number): boolean;
}

export function gateLocalSculpt(intent: SculptIntent, territory: LocalTerritory): boolean {
  const pool = manaPool();
  if (pool === null) return true;

  const options = sculptOptionsOf(intent);
  const worldSize = territory.worldSize();
  const opened =
    worldSize <= 0
      ? 0
      : openedChunkCount(worldSize, intent.x, intent.y, intent.radius, (cx, cy) => {
          const origin = chunkOriginCell(cx, cy);
          return territory.revealedAt(origin.x, origin.y);
        });
  const cost =
    sculptManaCost(
      pool.manaPerBandCell,
      intent.radius,
      options.profile,
      options.tool,
      sculptSweepSteps(intent),
    ) +
    opened *
      chunkUnlockPenalty(pool.manaPerBandCell, intent.radius, options.profile, options.tool);

  if (pool.balance < cost) {
    recordDenial();
    return false;
  }
  debitLocally(pool, cost);
  inFlight.push({ seq: intent.seq ?? null, cost, debitedAtMs: nowMs() });
  return true;
}
