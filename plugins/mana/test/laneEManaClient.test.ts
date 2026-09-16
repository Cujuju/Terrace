import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARVE_DEFAULT_DEPTH_BANDS,
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
} from '@terrace/shared';
import { CHUNK_UNLOCK_MANA, chunkUnlockFee, openedChunkCount, sculptManaCost } from '../pricing.ts';

type ManaClientState = typeof import('../client/state.ts');

let state: ManaClientState;

beforeEach(async () => {
  vi.resetModules();
  state = await import('../client/state.ts');
  state.clearInFlightDebits();
  state.setManaPool(null);
});

const POOL_CAPACITY = 10000;

const POOL_MANA_PER_BAND_CELL = 10;

function fundedPool(balance: number): void {
  state.setManaPool({
    balance,
    capacity: POOL_CAPACITY,
    manaPerBandCell: POOL_MANA_PER_BAND_CELL,
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

describe('the HUD quote prices the frontier under the aim', () => {
  const AIM = { x: CHUNK_SIZE * 2 - 1, y: CHUNK_SIZE + 4, face: 'tread', band: 0 } as const;

  const WORLD_SIZE = CHUNK_SIZE * 4;

  const HOME_CHUNK_X = 1;
  const HOME_CHUNK_Y = 1;

  const HOME_ONLY = {
    worldSize: () => WORLD_SIZE,
    revealedAt: (x: number, y: number) =>
      Math.floor(x / CHUNK_SIZE) === HOME_CHUNK_X && Math.floor(y / CHUNK_SIZE) === HOME_CHUNK_Y,
  };

  const EVERYWHERE = { worldSize: () => WORLD_SIZE, revealedAt: () => true };

  // Re-imported inside the reset registry, so it is the module state.ts reads.
  let hud: typeof import('../../../client/src/state/hudState.ts');

  beforeEach(async () => {
    hud = await import('../../../client/src/state/hudState.ts');
    hud.setBrushTool('stamp');
    hud.setBrushProfile('hard');
    hud.setBrushRadius(MIN_BRUSH_RADIUS);
    hud.setHoverPick(null);
    state.setLocalTerritory(null);
    fundedPool(POOL_CAPACITY);
  });

  const displacement = (): number =>
    sculptManaCost(POOL_MANA_PER_BAND_CELL, MIN_BRUSH_RADIUS, 'hard', 'stamp', CARVE_DEFAULT_DEPTH_BANDS);

  it('adds the unlock fee for the chunks the aimed stroke would open', () => {
    state.setLocalTerritory(HOME_ONLY);
    hud.setHoverPick(AIM);

    const opened = openedChunkCount(WORLD_SIZE, AIM.x, AIM.y, MIN_BRUSH_RADIUS, (cx, cy) =>
      HOME_ONLY.revealedAt(cx * CHUNK_SIZE, cy * CHUNK_SIZE),
    );
    expect(opened).toBeGreaterThan(0);
    expect(state.currentUnlockFee()).toBe(opened * CHUNK_UNLOCK_MANA);
    expect(state.currentBrushCost()).toBe(displacement() + chunkUnlockFee(opened));
  });

  it('quotes displacement alone inside owned territory', () => {
    state.setLocalTerritory(EVERYWHERE);
    hud.setHoverPick(AIM);

    expect(state.currentUnlockFee()).toBe(0);
    expect(state.currentBrushCost()).toBe(displacement());
  });

  it('quotes displacement alone while nothing is aimed at', () => {
    state.setLocalTerritory(HOME_ONLY);

    expect(state.currentUnlockFee()).toBe(0);
    expect(state.currentBrushCost()).toBe(displacement());
  });
});
