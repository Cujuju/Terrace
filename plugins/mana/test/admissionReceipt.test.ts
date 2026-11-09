import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bandLevelHeight, CHUNK_SIZE, chunksPerEdge, DEFAULT_SCULPT_AMOUNT,
  type SculptIntent,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import { RecordingSink, asLoadedPlugin, worldWithUnlockedChunks } from '../../../server/test/support/harness.ts';
import { plugin as reveal } from '../../reveal/server/index.ts';
import {
  INSUFFICIENT_MANA_REASON, manaBalanceOf, MANA_CAPACITY, MANA_DENIED_MESSAGE,
  MANA_PER_BAND_CELL, plugin as mana, resetManaState,
} from '../server/index.ts';
import { commitCharge, manaCostFor } from '../server/charging.ts';
import { poolFor, quoteFor } from '../server/pool.ts';
import { closedStrokeChunks, strokeChargeCost, strokeUnlockChunks } from '../pricing.ts';

const SIZE = 128;
const HOME = [3, 3] as const;
const CENTRE = { x: HOME[0] * CHUNK_SIZE, y: HOME[1] * CHUNK_SIZE };
const PLAYER = { id: 'receipt-player', token: 'receipt-token', name: 'Receipt' };
const ORIGINAL: SculptIntent = { type: 'sculpt', ...CENTRE, radius: 1, dir: 1, tool: 'stamp', profile: 'hard', seq: 1 };
const FINAL: SculptIntent = { ...ORIGINAL, x: CENTRE.x + 8, radius: 4, profile: 'stepped' };

function boot(modifierFirst: boolean) {
  const world = worldWithUnlockedChunks(SIZE, [HOME], undefined, bandLevelHeight(0));
  const sink = new RecordingSink(); world.setSink(sink);
  const modifier: TerracePlugin = { name: 'rewrite', onIntent: () => ({ kind: 'modify', intent: FINAL }) };
  const plugins = modifierFirst ? [modifier, mana, reveal] : [mana, modifier, reveal];
  const host = new PluginHost(world, plugins.map(asLoadedPlugin)); host.worldCreate();
  world.addPlayer(PLAYER); world.seedChunkForToken(PLAYER.token, ...HOME); host.playerJoined(PLAYER);
  return { world, host, sink };
}

function price(harness: ReturnType<typeof boot>, intent: SculptIntent): number {
  return manaCostFor(PLAYER.id, intent, closedStrokeChunks(SIZE, intent, (cx, cy) =>
    harness.world.isChunkUnlockedForToken(PLAYER.token, cx, cy)).length);
}

function territory(harness: ReturnType<typeof boot>): boolean[] {
  const edge = chunksPerEdge(SIZE);
  return Array.from({ length: edge * edge }, (_, index) =>
    harness.world.isChunkUnlockedForToken(PLAYER.token, index % edge, Math.floor(index / edge)));
}

beforeEach(resetManaState);

describe('final-intent admission receipts', () => {
  it.each([false, true])('prices the effective intent before application (modifier first: %s)', (modifierFirst) => {
    const harness = boot(modifierFirst);
    // A high core makes the stepped flanks reach every band the receipt must protect.
    harness.world.map.cells[FINAL.y * SIZE + FINAL.x] = bandLevelHeight(8);
    const finalPrice = price(harness, FINAL);
    expect(finalPrice).toBeGreaterThan(price(harness, ORIGINAL));
    const outcome = handleSculptIntent({ world: harness.world, interceptors: harness.host }, PLAYER, ORIGINAL);
    expect(outcome.applied).toBe(true);
    expect(MANA_CAPACITY - (manaBalanceOf(PLAYER.id) ?? 0)).toBe(finalPrice);
  });

  it.each([false, true])('denies the effective price before any effect (modifier first: %s)', (modifierFirst) => {
    const harness = boot(modifierFirst);
    const admittedBalance = price(harness, ORIGINAL);
    const finalPrice = price(harness, FINAL);
    expect(finalPrice).toBeGreaterThan(admittedBalance);
    poolFor(PLAYER.id).balance = admittedBalance;
    const cells = harness.world.map.cells.slice();
    const mask = territory(harness);
    const outcome = handleSculptIntent({ world: harness.world, interceptors: harness.host }, PLAYER, ORIGINAL);
    expect(outcome).toMatchObject({ applied: false, reason: 'plugin-denied', detail: INSUFFICIENT_MANA_REASON });
    expect(harness.sink.ofType(`mana:${MANA_DENIED_MESSAGE}`).at(-1)?.payload).toMatchObject({ cost: finalPrice });
    expect(harness.world.map.cells).toEqual(cells);
    expect(territory(harness)).toEqual(mask);
    expect(manaBalanceOf(PLAYER.id)).toBe(admittedBalance);
    expect(poolFor(PLAYER.id).quote).toBeNull();
  });

  it('never rereads territory after application without a valid receipt', () => {
    const send = vi.fn();
    const world = new Proxy({} as WorldApi, { get: (_target, property) => {
      if (property === 'worldSize') return SIZE;
      if (property === 'sendTo') return send;
      throw new Error(`unexpected post-effect read: ${String(property)}`);
    } });
    const before = poolFor(PLAYER.id).balance;
    commitCharge(FINAL, { world, player: PLAYER, displacementUnits: DEFAULT_SCULPT_AMOUNT }, []);
    expect(before - poolFor(PLAYER.id).balance).toBe(strokeChargeCost(DEFAULT_SCULPT_AMOUNT, MANA_PER_BAND_CELL, FINAL));
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects receipt coverage that misses effective unlock chunks', () => {
    const pool = poolFor(PLAYER.id);
    const remote = { ...FINAL, x: SIZE - 1, y: SIZE - 1 };
    pool.quote = quoteFor(SIZE, ORIGINAL, () => false);
    const touched = strokeUnlockChunks(SIZE, remote, []);
    expect(touched.some((chunk) => !pool.quote?.bound.includes(chunk))).toBe(true);
    const world = new Proxy({} as WorldApi, { get: (_target, property) => {
      if (property === 'worldSize') return SIZE;
      if (property === 'sendTo') return () => {};
      throw new Error(`unexpected post-effect read: ${String(property)}`);
    } });
    const before = pool.balance;
    commitCharge(remote, { world, player: PLAYER, displacementUnits: DEFAULT_SCULPT_AMOUNT }, []);
    expect(before - pool.balance).toBe(strokeChargeCost(DEFAULT_SCULPT_AMOUNT, MANA_PER_BAND_CELL, remote));
    expect(pool.quote).toBeNull();
  });
});
