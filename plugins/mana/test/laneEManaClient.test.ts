import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BRUSH_RADIUS } from '@terrace/shared';

type ManaClientState = typeof import('../client/state.ts');

let state: ManaClientState;

beforeEach(async () => {
  vi.resetModules();
  state = await import('../client/state.ts');
  state.clearInFlightDebits();
  state.setManaPool(null);
});

function fundedPool(balance: number): void {
  state.setManaPool({
    balance,
    capacity: 10000,
    manaPerBandCell: 10,
    regenPerSecond: 1,
  });
}

describe('lane E: mana denial pulse carries its cost', () => {
  it('recordDenial pulses the count and remembers the cost for the hint', () => {
    const before = state.deniedCount();
    state.recordDenial(42);
    expect(state.deniedCount()).toBe(before + 1);
    expect(state.lastDeniedCost()).toBe(42);
    // A costless pulse (legacy callers) keeps the last cost.
    state.recordDenial();
    expect(state.deniedCount()).toBe(before + 2);
    expect(state.lastDeniedCost()).toBe(42);
  });

  it('handleManaDenied applies the push, pulses, and records the cost', () => {
    fundedPool(100);
    const before = state.deniedCount();
    expect(state.handleManaDenied({ balance: 80, cost: 25 })).toBe(true);
    expect(state.deniedCount()).toBe(before + 1);
    expect(state.lastDeniedCost()).toBe(25);
    expect(state.manaPool()?.balance).toBe(80);
  });

  it('handleManaDenied ignores a malformed payload without pulsing', () => {
    fundedPool(100);
    const before = state.deniedCount();
    const costBefore = state.lastDeniedCost();
    expect(state.handleManaDenied({ nope: 1 })).toBe(false);
    expect(state.deniedCount()).toBe(before);
    expect(state.lastDeniedCost()).toBe(costBefore);
  });

  it('the local gate records the denied cost when broke', () => {
    fundedPool(5);
    const before = state.deniedCount();
    const bigStamp = {
      type: 'sculpt',
      x: 4,
      y: 4,
      radius: MAX_BRUSH_RADIUS,
      dir: 1,
      tool: 'stamp',
      profile: 'hard',
    } as const;
    expect(state.gateLocalSculpt(bigStamp, { worldSize: () => 0, revealedAt: () => true })).toBe(
      false,
    );
    expect(state.deniedCount()).toBe(before + 1);
    const cost = state.lastDeniedCost();
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
});
