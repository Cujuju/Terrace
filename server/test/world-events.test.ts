import { describe, expect, it } from 'vitest';
import { MAX_WORLD_EVENT_DEPTH, PluginHost } from '../src/plugins/host.ts';
import type { TerracePlugin, WorldApi } from '../src/plugins/types.ts';
import { RecordingSink, asLoadedPlugin, worldWithUnlockedChunks } from './support/harness.ts';

function hostWith(...plugins: TerracePlugin[]): PluginHost {
  const world = worldWithUnlockedChunks(64, [[0, 0]]);
  world.setSink(new RecordingSink());
  return new PluginHost(world, plugins.map(asLoadedPlugin));
}

function listener(
  name: string,
  heard: Array<{ hearer: string; event: string; payload: unknown }>,
  extra?: Partial<TerracePlugin>,
): TerracePlugin {
  return {
    name,
    onWorldEvent(_world: WorldApi, event: string, payload: unknown): void {
      heard.push({ hearer: name, event, payload });
    },
    ...extra,
  };
}

describe('WorldApi.emitEvent → onWorldEvent', () => {
  it('namespaces the event with the EMITTER’s name — a plugin cannot forge another’s events', () => {
    const heard: Array<{ hearer: string; event: string; payload: unknown }> = [];
    const ref: { api: WorldApi | null } = { api: null };

    const emitter: TerracePlugin = {
      name: 'emitter',
      onWorldCreate(world: WorldApi): void {
        ref.api = world;
      },
    };
    const host = hostWith(emitter, listener('hearer', heard));
    host.worldCreate();

    ref.api?.emitEvent('changes', { n: 1 });
    ref.api?.emitEvent('structures:changes', { forged: true });

    expect(heard.map((h) => h.event)).toEqual(['emitter:changes', 'emitter:structures:changes']);
    expect(heard[0]?.payload).toEqual({ n: 1 });
  });

  it('fans out to every plugin in load order, the emitter itself included', () => {
    const heard: Array<{ hearer: string; event: string; payload: unknown }> = [];
    const ref: { api: WorldApi | null } = { api: null };

    const self = listener('aa-self', heard, {
      onWorldCreate(world: WorldApi): void {
        ref.api = world;
      },
    });
    const host = hostWith(self, listener('zz-other', heard));
    host.worldCreate();

    ref.api?.emitEvent('ping', null);
    expect(heard.map((h) => h.hearer)).toEqual(['aa-self', 'zz-other']);
  });

  it('a consumer that throws is logged and skipped; later consumers still hear the event', () => {
    const heard: Array<{ hearer: string; event: string; payload: unknown }> = [];
    let api: WorldApi | null = null;

    const thrower: TerracePlugin = {
      name: 'aa-thrower',
      onWorldCreate(world: WorldApi): void {
        api = world;
      },
      onWorldEvent(): void {
        throw new Error('consumer bug');
      },
    };
    const host = hostWith(thrower, listener('zz-hearer', heard));
    host.worldCreate();

    expect(() => api?.emitEvent('ping', null)).not.toThrow();
    expect(heard).toHaveLength(1);
  });

  it('an unconditional emit-from-handler cascade is cut at MAX_WORLD_EVENT_DEPTH', () => {
    let deliveries = 0;
    const ref: { api: WorldApi | null } = { api: null };

    const looper: TerracePlugin = {
      name: 'looper',
      onWorldCreate(world: WorldApi): void {
        ref.api = world;
      },
      onWorldEvent(world: WorldApi): void {
        deliveries++;
        world.emitEvent('again', null);
      },
    };
    const host = hostWith(looper);
    host.worldCreate();

    ref.api?.emitEvent('start', null);
    expect(deliveries).toBe(MAX_WORLD_EVENT_DEPTH);
  });
});
