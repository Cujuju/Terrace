import { createSignal } from 'solid-js';
import {
  CARVE_DEFAULT_DEPTH_BANDS,
  TOOLS_WITHOUT_EDGE_PROFILE,
  sculptProfileOf,
  strokeSweep,
  sweepAt,
  type StrokeSweep,
} from '@terrace/shared';
import type { SculptIntent, SculptTool } from '@terrace/shared';
import {
  chunkOriginCell,
  chunkUnlockFee,
  displacementManaCost,
  openedChunkCount,
  sculptIntentCost,
  sculptManaCost,
} from '../pricing.ts';
import { dryRunDisplacement } from './quote.ts';
import { parseManaDeniedPayload, type ManaBalanceMessage, type ManaDeniedMessage } from '../protocol.ts';
import {
  brushProfile,
  brushRadius,
  brushTool,
  effectiveSculptMode,
  hoverPick,
  sculptDirection,
} from '../../../client/src/state/hudState.ts';

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
 * Brush-refused pulse: every denial, local gate or server `mana:denied`, bumps
 * deniedCount and records the cost the hint shows.
 */
export function recordDenial(cost?: number): void {
  if (cost !== undefined) setLastDeniedCost(cost);
  setDeniedCount((n) => n + 1);
}

export interface LocalTerritory {
  worldSize(): number;
  revealedAt(x: number, y: number): boolean;
  terrainSampleAt(x: number, y: number): number | null;
}

/**
 * What the client knows of its own reveal mask. The gate is handed one per
 * intent; the HUD quote has no intent, so the plugin parks it here at attach.
 */
let localTerritory: LocalTerritory | null = null;

export function setLocalTerritory(territory: LocalTerritory | null): void {
  localTerritory = territory;
}

function openedChunksAt(territory: LocalTerritory | null, sweep: StrokeSweep): number {
  if (territory === null) return 0;
  const worldSize = territory.worldSize();
  if (worldSize <= 0) return 0;
  return openedChunkCount(worldSize, sweep, (cx, cy) => {
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
  return chunkUnlockFee(openedChunksAt(localTerritory, sweepAt(aim.x, aim.y, brushRadius())));
}

/**
 * A quote is measured when the client could run the stroke itself; otherwise it
 * is the nominal worst case the server admits against, and says so.
 */
export interface BrushQuote {
  readonly cost: number;
  readonly estimated: boolean;
}

/** The tools a hover alone fully describes; a carve and a drag need a grasp. */
const SELF_DESCRIBING_TOOLS: readonly SculptTool[] = ['stamp', 'smooth'];

function aimedIntent(tool: SculptTool): SculptIntent | null {
  const aim = hoverPick();
  if (aim === null || !SELF_DESCRIBING_TOOLS.includes(tool)) return null;
  const profile = sculptProfileOf(tool, brushProfile());
  return {
    type: 'sculpt',
    x: aim.x,
    y: aim.y,
    radius: brushRadius(),
    dir: sculptDirection(effectiveSculptMode()),
    tool,
    ...(TOOLS_WITHOUT_EDGE_PROFILE.includes(tool) ? {} : { profile }),
  };
}

export function currentBrushQuote(): BrushQuote {
  const pool = manaPool();
  if (pool === null) return { cost: 0, estimated: false };

  const tool = brushTool();
  const unlock = currentUnlockFee();
  const intent = aimedIntent(tool);
  const moved = intent === null || localTerritory === null
    ? null
    : dryRunDisplacement(localTerritory, intent);
  if (moved !== null) {
    return {
      cost: displacementManaCost(moved, pool.manaPerBandCell, tool) + unlock,
      estimated: false,
    };
  }

  const nominal = sculptManaCost(
    pool.manaPerBandCell,
    brushRadius(),
    sculptProfileOf(tool, brushProfile()),
    tool,
    CARVE_DEFAULT_DEPTH_BANDS,
  );
  return { cost: nominal + unlock, estimated: true };
}

export function currentBrushCost(): number {
  return currentBrushQuote().cost;
}

export function currentBalance(): number | null {
  const pool = manaPool();
  return pool === null ? null : liveBalance(pool);
}

export function gateLocalSculpt(intent: SculptIntent, territory: LocalTerritory): boolean {
  const pool = manaPool();
  if (pool === null) return true;

  const opened = openedChunksAt(territory, strokeSweep(intent));
  const cost = sculptIntentCost(pool.manaPerBandCell, intent, opened);

  if (pool.balance < cost) {
    recordDenial(cost);
    return false;
  }
  debitLocally(pool, cost);
  inFlight.push({ seq: intent.seq ?? null, cost, debitedAtMs: nowMs() });
  return true;
}
