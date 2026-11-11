import { beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, DAY_LENGTH_MILLIS, DAWN_HOUR, HOURS_PER_WORLD_DAY } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { TerracePlugin } from '../../../server/src/plugins/types.ts';
import { asLoadedPlugin, worldWithUnlockedChunks } from '../../../server/test/support/harness.ts';
import { packEntries } from '../protocol.ts';
import { placeName } from '../server/names.ts';
import { CHRONICLE_CALAMITY_MIN_HOMES, parseStructuresChanges } from '../server/saga.ts';
import { chronicleEntries, plugin, resetChronicleState } from '../server/index.ts';

const WORLD_SIZE = CHUNK_SIZE * 8;
const TICK_SECONDS = 0.1;
const MILLISECONDS_PER_SECOND = 1000;
const MIDNIGHT_SIM_MILLIS =
  DAY_LENGTH_MILLIS * (HOURS_PER_WORLD_DAY - DAWN_HOUR) / HOURS_PER_WORLD_DAY;

function boot(restore?: unknown): PluginHost {
  resetChronicleState();
  const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
  const host = new PluginHost(world, [asLoadedPlugin(plugin)]);
  if (restore !== undefined) host.restorePersistence({ chronicle: restore });
  host.worldCreate();
  return host;
}

function texts(): string[] {
  return chronicleEntries().map((entry) => entry.text);
}

beforeEach(resetChronicleState);

describe('Chronicle event contracts', () => {
  it('records settled camps and wind calamities, leaving fire deaths to episode events', () => {
    const host = boot();
    const anchor = { x: CHUNK_SIZE, y: CHUNK_SIZE };
    const died = Array.from({ length: CHRONICLE_CALAMITY_MIN_HOMES }, (_, offset) => ({
      x: anchor.x + offset,
      y: anchor.y,
    }));
    host.notifyWorldEvent('structures:changes', { cause: 'settled', seeded: [anchor] });
    host.notifyWorldEvent('structures:changes', { cause: 'wind', died });
    expect(texts().slice(1)).toEqual([
      expect.stringContaining('pitched a new camp'),
      expect.stringContaining('Ruin took'),
    ]);
    expect(parseStructuresChanges({ cause: 'fire', died })).toBeNull();
    host.notifyWorldEvent('structures:changes', { cause: 'fire', died });
    expect(texts()).toHaveLength(3);
  });

  it('describes the supplied complexity rank without assigning it a building identity', () => {
    const host = boot();
    const granaryRank = 3;
    host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      upgraded: [{ x: CHUNK_SIZE, y: CHUNK_SIZE, tier: granaryRank }],
    });
    expect(texts().at(-1)).toContain(`world's first settlement of complexity rank ${granaryRank}`);
    expect(texts().at(-1)).not.toContain('longhouse');
  });

  it('records every newly seeded chunk in input order despite earlier told chunks', () => {
    const host = boot();
    const first = { x: CHUNK_SIZE, y: CHUNK_SIZE };
    const second = { x: CHUNK_SIZE * 2, y: CHUNK_SIZE };
    const third = { x: CHUNK_SIZE * 3, y: CHUNK_SIZE };
    host.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      seeded: [first, { x: first.x + 1, y: first.y }, second],
    });
    expect(texts().slice(1)).toEqual([
      expect.stringContaining(placeName(1, 1)),
      expect.stringContaining(placeName(2, 1)),
    ]);
    host.notifyWorldEvent('structures:changes', { cause: 'generation', seeded: [first, third] });
    expect(texts()).toHaveLength(4);
    expect(texts().at(-1)).toContain(placeName(3, 1));
  });

  it('records separate completed wildfires in the same district and day', () => {
    const host = boot();
    host.notifyWorldEvent('fire:burned', { consumed: 9, x: 10, y: 10 });
    host.notifyWorldEvent('fire:burned', { consumed: 12, x: 12, y: 10 });
    expect(texts().slice(1)).toEqual([
      expect.stringContaining('Fire took 9'),
      expect.stringContaining('Fire took 12'),
    ]);
  });

  it('dates synchronous events to the authoritative day before Chronicle receives its tick', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.simMillis = MIDNIGHT_SIM_MILLIS - TICK_SECONDS * MILLISECONDS_PER_SECOND;
    const boats: TerracePlugin = {
      name: 'boats',
      onTick(api): void {
        api.emitEvent('defeated', { kind: 'kraken', x: 10, y: 10 });
      },
    };
    const monsters: TerracePlugin = {
      name: 'monsters',
      onWorldEvent(api, event, payload): void {
        if (event === 'boats:defeated') api.emitEvent('departed', payload);
      },
    };
    const host = new PluginHost(world, [boats, plugin, monsters].map(asLoadedPlugin));
    host.worldCreate();
    host.tick(TICK_SECONDS);
    expect(chronicleEntries().at(-1)).toEqual({
      day: 1,
      text: 'The kraken was driven from the world.',
    });
    expect(host.faultCount('chronicle')).toBe(0);
  });

  it.each([1, 2])('restarts rank firsts from v%s while preserving historical entries', (version) => {
    const legacyEntries = [{ day: 0, text: "The Unos raised the world's first timber house." }];
    const host = boot({
      v: version,
      simMillis: 0,
      entries: packEntries(legacyEntries),
      tierFirsts: [2],
      monsterKinds: ['yeti'],
      toldDay: 0,
      toldToday: ['volcanoes:erupted'],
    });
    expect(chronicleEntries()).toEqual(legacyEntries);
    const saved = host.collectPersistence().chronicle;
    expect(saved).toEqual({
      v: 3,
      data: {
        v: 3,
        simMillis: 0,
        entries: packEntries(legacyEntries),
        rankFirsts: [],
        monsterKinds: ['yeti'],
        toldDay: 0,
        toldToday: ['volcanoes:erupted'],
      },
    });
    const restored = boot(saved);
    expect(chronicleEntries()).toEqual(legacyEntries);
    restored.notifyWorldEvent('structures:changes', {
      cause: 'generation',
      upgraded: [{ x: CHUNK_SIZE, y: CHUNK_SIZE, tier: 2 }],
    });
    expect(chronicleEntries()[0]).toEqual(legacyEntries[0]);
    expect(texts()).toHaveLength(2);
    expect(texts().at(-1)).toContain("world's first settlement of complexity rank 2");
  });
});
