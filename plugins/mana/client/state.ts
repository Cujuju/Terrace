import { createSignal } from 'solid-js';
import {
  CARVE_DEFAULT_DEPTH_BANDS,
  sculptOptionsOf,
  sculptProfileOf,
  sculptSweepSteps,
  type SculptIntent,
} from '@terrace/shared';
import { chunkOriginCell, chunkUnlockFee, openedChunkCount, sculptManaCost } from '../pricing.ts';
import { parseManaDeniedPayload, type ManaBalanceMessage, type ManaDeniedMessage } from '../protocol.ts';
import { brushProfile, brushRadius, brushTool, hoverPick } from '../../../client/src/state/hudState.ts';

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

/**
 * Server `mana:denied` handler shared by index.ts and tests (kept in state.ts so
 * tests can cover it without pulling in ManaGauge.tsx). Returns false for a
 * malformed payload, recording nothing.
 */
export function handleManaDenied(payload: unknown): boolean {
  const denied = parseManaDeniedPayload(payload);
  if (denied === null) return false;
  applyDenial(denied);
  recordDenial(denied.cost);
  return true;
}

export function clearInFlightDebits(): void {
  inFlight = [];
}

const [deniedCount, setDeniedCount] = createSignal(0);

const [lastDeniedCost, setLastDeniedCost] = createSignal<number | null>(null);

export { manaPool, setManaPool, deniedCount, lastDeniedCost };

/**
 * Brush-refused pulse shared with the gauge flash: every denial (local gate or
 * server `mana:denied`) bumps deniedCount and records the denied cost for the
 * hint. The brush preview's red blink itself is wired at merge time (lane C
 * accessors); this counter is the pulse it reads.
 */
export function recordDenial(cost?: number): void {
  if (cost !== undefined) setLastDeniedCost(cost);
  setDeniedCount((n) => n + 1);
}

export interface LocalTerritory {
  worldSize(): number;
  revealedAt(x: number, y: number): boolean;
}

/**
 * What the client knows of its own reveal mask. The gate is handed one per
 * intent; the HUD quote has no intent, so the plugin parks it here at attach.
 */
let localTerritory: LocalTerritory | null = null;

export function setLocalTerritory(territory: LocalTerritory | null): void {
  localTerritory = territory;
}

function openedChunksAt(
  territory: LocalTerritory | null,
  x: number,
  y: number,
  radius: number,
): number {
  if (territory === null) return 0;
  const worldSize = territory.worldSize();
  if (worldSize <= 0) return 0;
  return openedChunkCount(worldSize, x, y, radius, (cx, cy) => {
    const origin = chunkOriginCell(cx, cy);
    return territory.revealedAt(origin.x, origin.y);
  });
}

/**
 * The unlock half of the quote: what the frontier under the aim would cost to
 * open. Zero away from the frontier, and zero until a pointer pick exists.
 */
export function currentUnlockFee(): number {
  const aim = hoverPick();
  if (aim === null) return 0;
  return chunkUnlockFee(openedChunksAt(localTerritory, aim.x, aim.y, brushRadius()));
}

export function currentBrushCost(): number {
  const pool = manaPool();
  if (pool === null) return 0;
  const tool = brushTool();
  return (
    sculptManaCost(
      pool.manaPerBandCell,
      brushRadius(),
      sculptProfileOf(tool, brushProfile()),
      tool,
      CARVE_DEFAULT_DEPTH_BANDS,
    ) + currentUnlockFee()
  );
}

export function currentBalance(): number | null {
  const pool = manaPool();
  return pool === null ? null : liveBalance(pool);
}

export function gateLocalSculpt(intent: SculptIntent, territory: LocalTerritory): boolean {
  const pool = manaPool();
  if (pool === null) return true;

  const options = sculptOptionsOf(intent);
  const opened = openedChunksAt(territory, intent.x, intent.y, intent.radius);
  const cost =
    sculptManaCost(
      pool.manaPerBandCell,
      intent.radius,
      options.profile,
      options.tool,
      options.depthBands,
      sculptSweepSteps(intent),
    ) + chunkUnlockFee(opened);

  if (pool.balance < cost) {
    recordDenial(cost);
    return false;
  }
  debitLocally(pool, cost);
  inFlight.push({ seq: intent.seq ?? null, cost, debitedAtMs: nowMs() });
  return true;
}
