import { afterEach, describe, expect, it, vi } from 'vitest';
import { bandLevelHeight, createHeightmap, packColumnSpans, type SculptIntent } from '@terrace/shared';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import * as hud from '../src/state/hudState.ts';
import { createHoverQuoteCache } from '../../plugins/mana/client/hoverQuote.ts';
import { dryRunSculpt, measureSculpt, type QuoteReply, type QuoteRequest } from '../../plugins/mana/client/quote.ts';
import * as state from '../../plugins/mana/client/state.ts';
import { clientPlugin } from '../../plugins/mana/client/index.ts';
import { parseManaBalancePayload } from '../../plugins/mana/protocol.ts';

vi.mock('../../plugins/mana/client/ManaGauge.tsx', () => ({ ManaGauge: () => null }));

const SIZE = 128;
const RATE = { capacity: 5000, manaPerBandCell: 0.375, regenPerSecond: 300 };
const STAMP: SculptIntent = { type: 'sculpt', x: 64, y: 64, radius: 4, dir: 1, tool: 'stamp', profile: 'hard', seq: 10 };
const UNKNOWN = { worldSize: () => 0, revealedAt: () => true, terrainSampleAt: () => null, terrainSpansAt: () => null };

function terrain() {
  const map = createHeightmap(SIZE); map.cells.fill(bandLevelHeight(8));
  const read = vi.fn((x: number, y: number) => map.cells[y * SIZE + x]!);
  return { worldSize: () => SIZE, revealedAt: () => false, terrainSampleAt: read,
    terrainSpansAt: (x: number, y: number) => packColumnSpans(map, x, y), read };
}

class QuoteWorker {
  onmessage: ((event: MessageEvent<QuoteReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly requests: QuoteRequest[] = [];
  readonly terminate = vi.fn();
  postMessage(request: QuoteRequest): void { this.requests.push(request); }
  finish(index: number): void {
    const request = this.requests[index]!;
    const measurement = measureSculpt(structuredClone(request.sample));
    this.onmessage?.({ data: { id: request.id, measurement } } as MessageEvent<QuoteReply>);
  }
}

afterEach(() => {
  clientPlugin.dispose?.();
  vi.restoreAllMocks();
});

describe('client world-session economy', () => {
  it('clears old debits and pool on reset and disposal', () => {
    const reset: Array<() => void> = [];
    const messages = new Map<string, (payload: unknown) => void>();
    const ctx = { ...UNKNOWN, onWorldReset: (handler: () => void) => { reset.push(handler); return () => {}; },
      onTerrainChanged: () => () => {}, onLocalIntent: () => () => {}, registerHudPanel: () => {},
      onMessage: (name: string, handler: (payload: unknown) => void) => { messages.set(name, handler); return () => {}; },
    } as unknown as ClientPluginCtx;
    clientPlugin.attach(ctx);
    messages.get('balance')!({ balance: 5000, ...RATE });
    expect(state.gateLocalSculpt(STAMP, UNKNOWN)).toBe(true);
    expect(state.manaPool()!.balance).toBeLessThan(5000);
    expect(reset).toHaveLength(1);
    reset[0]!();
    expect(state.manaPool()).toBeNull();
    messages.get('balance')!({ balance: 5000, ...RATE });
    expect(state.manaPool()!.balance).toBe(5000);
    state.gateLocalSculpt({ ...STAMP, seq: 11 }, UNKNOWN);
    clientPlugin.dispose?.();
    expect(state.manaPool()).toBeNull();
    state.applyBalancePush({ balance: 5000, ...RATE });
    expect(state.manaPool()!.balance).toBe(5000);
  });

  it.each([5000, 4990, 2500])('discards full-time regen and preserves earned regen from %i', (balance) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    state.setManaPool({ balance, ...RATE });
    clock.mockReturnValue(900);
    const before = state.liveBalance(state.manaPool()!);
    expect(state.gateLocalSculpt(STAMP, UNKNOWN)).toBe(true);
    const charge = balance - state.manaPool()!.balance;
    expect(state.liveBalance(state.manaPool()!)).toBeCloseTo(before - charge);
    expect(state.manaPool()!.balance).toBe(balance - charge);
  });

  it('uses no unlock fee until the balance declares an active policy', () => {
    const local = terrain();
    state.setLocalTerritory(local);
    hud.setBrushTool('stamp'); hud.setBrushProfile('hard'); hud.setBrushRadius(4);
    hud.setHoverPick({ x: 64, y: 64, face: 'tread', band: 8, sculptTarget: { x: 64, y: 64, spanBand: null } });
    state.applyBalancePush({ balance: 5000, ...RATE });
    expect(state.currentBrushQuote().unlockCost).toBe(0);
    state.applyBalancePush({ balance: 5000, ...RATE, unlockPolicy: 'reveal' });
    expect(state.currentBrushQuote().unlockCost).toBeGreaterThan(0);
    state.applyBalancePush({ balance: 5000, ...RATE, unlockPolicy: 'none' });
    expect(state.currentBrushQuote().unlockCost).toBe(0);
    expect(parseManaBalancePayload({ balance: 5000, ...RATE, unlockPolicy: 'unknown' })).toBeNull();
  });
});

describe('terrain measurements are independent of pool pushes', () => {
  it('reuses the same measurement for balance, rate and perk changes until terrain changes', () => {
    const local = terrain();
    state.setLocalTerritory(local);
    hud.setBrushTool('stamp'); hud.setBrushProfile('hard'); hud.setBrushRadius(4);
    hud.setHoverPick({ x: 64, y: 64, face: 'tread', band: 8, sculptTarget: { x: 64, y: 64, spanBand: null } });
    state.applyBalancePush({ balance: 5000, ...RATE });
    const before = state.currentBrushQuote();
    const reads = local.read.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    state.applyBalancePush({ balance: 4999, ...RATE, manaPerBandCell: RATE.manaPerBandCell / 2 });
    expect(state.currentBrushQuote().cost).toBeLessThan(before.cost);
    expect(local.read).toHaveBeenCalledTimes(reads);
    state.invalidateHoverQuotes(); state.currentBrushQuote();
    expect(local.read.mock.calls.length).toBeGreaterThan(reads);
  });

  it.each(['smooth', 'nudge'] as const)('coalesces %s aims and rejects stale replies off the read path', (tool) => {
    const worker = new QuoteWorker();
    const changed = vi.fn();
    const cache = createHoverQuoteCache(changed, () => worker as unknown as Worker);
    const local = terrain();
    const first: SculptIntent = { ...STAMP, tool, dir: -1 };
    const latest = { ...first, x: first.x + 2 };
    expect(cache.read(local, first)).toBeNull();
    const reads = local.read.mock.calls.length;
    for (let n = 0; n < 20; n++) expect(cache.read(local, first)).toBeNull();
    expect(local.read).toHaveBeenCalledTimes(reads);
    cache.read(local, { ...first, x: first.x + 1 }); cache.read(local, latest);
    expect(worker.requests).toHaveLength(1);
    worker.finish(0);
    expect(changed).not.toHaveBeenCalled();
    expect(worker.requests).toHaveLength(2);
    worker.finish(1);
    expect(changed).toHaveBeenCalledOnce();
    expect(cache.read(local, latest)).toEqual(dryRunSculpt(local, latest));
    cache.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('keeps the nominal estimate without a worker and stops a failed worker', () => {
    const local = terrain();
    const smooth: SculptIntent = { ...STAMP, tool: 'smooth', dir: -1 };
    const unavailable = createHoverQuoteCache(() => {}, () => null);
    expect(unavailable.read(local, smooth)).toBeNull();
    expect(local.read).not.toHaveBeenCalled();
    const worker = new QuoteWorker();
    const cache = createHoverQuoteCache(() => {}, () => worker as unknown as Worker);
    expect(cache.read(local, smooth)).toBeNull();
    worker.onerror!();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(cache.read(local, { ...smooth, x: smooth.x + 1 })).toBeNull();
    expect(worker.requests).toHaveLength(1);
    cache.dispose();
  });

  it('terminates pending work and ignores replies from a disposed session', () => {
    const worker = new QuoteWorker();
    const changed = vi.fn();
    const cache = createHoverQuoteCache(changed, () => worker as unknown as Worker);
    cache.read(terrain(), { ...STAMP, tool: 'smooth', dir: -1 });
    const deliver = worker.onmessage!;
    cache.dispose();
    changed.mockClear();
    const request = worker.requests[0]!;
    deliver({ data: { id: request.id, measurement: measureSculpt(request.sample) } } as MessageEvent<QuoteReply>);
    expect(changed).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
