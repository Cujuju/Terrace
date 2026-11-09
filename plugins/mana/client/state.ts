import { createSignal } from 'solid-js';
import {
  sculptProfileOf,
  type CellDiff,
} from '@terrace/shared';
import type { SculptIntent, SculptTool } from '@terrace/shared';
import {
  chunkOriginCell,
  chunkUnlockFee,
  closedStrokeChunks,
  sculptIntentCost,
  sculptManaCost,
  strokeChargeCost,
} from '../pricing.ts';
import { dryRunSculpt, type LocalHeights } from './quote.ts';
import { pointSculptIntent } from '../../../client/src/input/sculpt/intent.ts';
import { parseManaDeniedPayload, type ManaBalanceMessage, type ManaDeniedMessage } from '../protocol.ts';
import {
  brushProfile,
  brushRadius,
  brushTool,
  carveDepthBands,
  effectiveSculptMode,
  hoverPick,
  sculptDirection,
  sculptAlt,
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

export interface LocalTerritory extends LocalHeights {
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

function openedChunksAt(territory: LocalTerritory | null, intent: SculptIntent, diff?: readonly CellDiff[]): number {
  if (territory === null) return 0;
  const worldSize = territory.worldSize();
  if (worldSize <= 0) return 0;
  return closedStrokeChunks(worldSize, intent, (cx, cy) => {
    const origin = chunkOriginCell(cx, cy);
    return territory.revealedAt(origin.x, origin.y);
  }, diff).length;
}

function nominalAimIntent(tool: SculptTool): SculptIntent | null {
  const aim = hoverPick();
  return aim === null ? null : {
    type: 'sculpt' as const, x: aim.x, y: aim.y, radius: brushRadius(),
    dir: sculptDirection(effectiveSculptMode()), tool, profile: sculptProfileOf(tool, brushProfile()),
  };
}

/**
 * A quote is measured when the client could run the stroke itself; otherwise it
 * is the nominal worst case the server admits against, and says so.
 */
export interface BrushQuote {
  readonly cost: number;
  readonly estimated: boolean;
  readonly unlockCost: number;
}

/** The tools a hover alone fully describes; a carve and a drag need a grasp. */
const SELF_DESCRIBING_TOOLS: readonly SculptTool[] = ['stamp', 'smooth', 'nudge'];

function aimedIntent(tool: SculptTool): SculptIntent | null {
  const aim = hoverPick();
  if (aim?.sculptTarget == null || !SELF_DESCRIBING_TOOLS.includes(tool)) return null;
  return pointSculptIntent(aim.sculptTarget, tool, sculptDirection(effectiveSculptMode()), sculptAlt());
}

export function currentBrushQuote(): BrushQuote {
  const pool = manaPool();
  if (pool === null) return { cost: 0, estimated: false, unlockCost: 0 };

  const tool = brushTool();
  const intent = aimedIntent(tool);
  const measured = intent === null || localTerritory === null
    ? null
    : dryRunSculpt(localTerritory, intent);
  const unlockIntent = intent ?? nominalAimIntent(tool);
  const unlock = unlockIntent === null ? 0
    : chunkUnlockFee(openedChunksAt(localTerritory, unlockIntent, measured?.diff));
  if (intent !== null && measured !== null) {
    return {
      cost: strokeChargeCost(measured.units, pool.manaPerBandCell, intent) + unlock,
      estimated: false,
      unlockCost: unlock,
    };
  }

  const nominal = sculptManaCost(
    pool.manaPerBandCell,
    brushRadius(),
    sculptProfileOf(tool, brushProfile()),
    tool,
    carveDepthBands(),
  );
  return { cost: nominal + unlock, estimated: true, unlockCost: unlock };
}

export function currentBrushCost(): number {
  return currentBrushQuote().cost;
}

export function currentBalance(): number | null {
  const pool = manaPool();
  return pool === null ? null : liveBalance(pool);
}

/** What the server will charge for a stroke, run on local ground; null where that ground is unknown. */
function measuredCharge(pool: ManaPool, territory: LocalTerritory, intent: SculptIntent): number | null {
  const measured = dryRunSculpt(territory, intent);
  if (measured === null) return null;
  return strokeChargeCost(measured.units, pool.manaPerBandCell, intent) +
    chunkUnlockFee(openedChunksAt(territory, intent, measured.diff));
}

export function gateLocalSculpt(intent: SculptIntent, territory: LocalTerritory): boolean {
  const pool = manaPool();
  if (pool === null) return true;

  const opened = openedChunksAt(territory, intent);
  const cost = sculptIntentCost(pool.manaPerBandCell, intent, opened);

  if (pool.balance < cost) {
    recordDenial(cost);
    return false;
  }
  // Admit on the nominal, as the server does; debit what it will charge.
  const charge = measuredCharge(pool, territory, intent) ?? cost;
  debitLocally(pool, charge);
  inFlight.push({ seq: intent.seq ?? null, cost: charge, debitedAtMs: nowMs() });
  return true;
}
