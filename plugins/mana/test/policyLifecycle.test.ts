import { afterEach, describe, expect, it } from 'vitest';
import { bandLevelHeight, CHUNK_SIZE, type SculptIntent } from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { createWorldApi } from '../../../server/src/plugins/world-api.ts';
import { RecordingSink, asLoadedPluginExporting, worldWithUnlockedChunks } from '../../../server/test/support/harness.ts';
import * as reveal from '../../reveal/server/index.ts';
import * as mana from '../server/index.ts';
import { parseManaBalancePayload } from '../protocol.ts';
import { poolFor } from '../server/pool.ts';

const SIZE = 128;
const HOME = [3, 3] as const;
const PLAYER = { id: 'policy-session', token: 'policy-token', name: 'Policy' };
const INTENT: SculptIntent = {
  type: 'sculpt', x: (HOME[0] + 1) * CHUNK_SIZE - 1, y: HOME[1] * CHUNK_SIZE + 4,
  radius: 2, dir: -1, tool: 'smooth', seq: 1,
};

function boot(policy: 'enabled' | 'disabled' | 'absent') {
  mana.resetManaState();
  const world = worldWithUnlockedChunks(SIZE, [HOME], 100, bandLevelHeight(8));
  const sink = new RecordingSink(); world.setSink(sink);
  const installed = [asLoadedPluginExporting(mana.plugin, mana)];
  if (policy !== 'absent') installed.push(asLoadedPluginExporting(reveal.plugin, reveal));
  const enabled = new Set(policy === 'enabled' ? ['mana', 'reveal'] : ['mana']);
  const host = new PluginHost(world, installed, enabled); host.worldCreate();
  world.addPlayer(PLAYER); world.seedChunkForToken(PLAYER.token, ...HOME); host.playerJoined(PLAYER);
  return { world, host, sink };
}

afterEach(mana.resetManaState);

describe('active territory admission and charge', () => {
  it.each(['disabled', 'absent'] as const)('reserves and charges no unlocks when reveal is %s', (policy) => {
    const harness = boot(policy);
    const initial = parseManaBalancePayload(harness.sink.ofType('mana:balance')[0].payload);
    expect(initial?.unlockPolicy).toBe('none');
    const nominal = mana.manaCostFor(PLAYER.id, INTENT);
    poolFor(PLAYER.id).balance = nominal;
    for (const seq of [1, 2]) {
      const outcome = handleSculptIntent({ world: harness.world, interceptors: harness.host }, PLAYER, { ...INTENT, seq });
      expect(outcome).toMatchObject({ applied: true, diff: [] });
      expect(mana.manaBalanceOf(PLAYER.id)).toBe(nominal);
      expect(harness.world.isChunkUnlockedForToken(PLAYER.token, HOME[0] + 1, HOME[1])).toBe(false);
    }
  });

  it('bills the active policy once and carries its policy to the client', () => {
    const harness = boot('enabled');
    const initial = parseManaBalancePayload(harness.sink.ofType('mana:balance')[0].payload);
    expect(initial?.unlockPolicy).toBe('reveal');
    const edge = harness.world.chunksPerEdge;
    const closed = reveal.sculptUnlockChunks(SIZE, INTENT, []).filter((index) =>
      !harness.world.isChunkUnlockedForToken(PLAYER.token, index % edge, Math.floor(index / edge)));
    const before = mana.manaBalanceOf(PLAYER.id)!;
    expect(handleSculptIntent({ world: harness.world, interceptors: harness.host }, PLAYER, INTENT))
      .toMatchObject({ applied: true, diff: [] });
    const after = mana.manaBalanceOf(PLAYER.id)!;
    expect(before - after).toBe(mana.chunkUnlockFee(closed.length));
    expect(closed.every((index) => harness.world.isChunkUnlockedForToken(PLAYER.token, index % edge, Math.floor(index / edge))))
      .toBe(true);
    handleSculptIntent({ world: harness.world, interceptors: harness.host }, PLAYER, { ...INTENT, seq: 2 });
    expect(mana.manaBalanceOf(PLAYER.id)).toBe(after);
  });
});

describe('mana owns spend notifications', () => {
  it.each(['fire', 'hydro'])('publishes a %s debit under mana and revokes spending on close', (caller) => {
    const harness = boot('enabled');
    const callerView = createWorldApi(harness.world, harness.host, caller).api;
    harness.sink.clear();
    expect(mana.spendMana(callerView, PLAYER.id, 100)).toBe(true);
    expect(harness.sink.messages.map((message) => message.type)).toEqual(['mana:balance']);
    expect(harness.sink.ofType('mana:balance')[0].payload).toMatchObject({ balance: mana.MANA_CAPACITY - 100 });
    harness.host.closeWorld(); harness.host.revokeApis();
    expect(mana.spendMana(callerView, PLAYER.id, 100)).toBe(false);
    expect(mana.manaBalanceOf(PLAYER.id)).toBeNull();
    const reopened = boot('disabled');
    reopened.sink.clear();
    expect(mana.spendMana(callerView, PLAYER.id, 100)).toBe(true);
    expect(reopened.sink.messages.map((message) => message.type)).toEqual(['mana:balance']);
    expect(harness.sink.ofType('mana:balance')).toHaveLength(1);
  });
});
