import { CHUNK_SIZE } from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import { PluginHost } from '../src/plugins/host.ts';
import type { SiblingModule, TerracePlugin, WorldApi } from '../src/plugins/types.ts';
import {
  asLoadedPlugin,
  asLoadedPluginExporting,
  worldWithUnlockedChunks,
} from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;

const SIBLING_NAME = 'zebra';

interface ZebraApi {
  record(value: string): void;
}

class BridgeConsumer {
  readonly warnings: string[] = [];
  private api: ZebraApi | null = null;
  private warned = false;
  private readonly buffered: string[] = [];

  readonly plugin: TerracePlugin = {
    name: 'consumer',
    onWorldCreate: (world: WorldApi) => this.resolve(world),
  };

  private static asZebraApi(module: SiblingModule | null): ZebraApi | null {
    if (module === null) return null;
    return typeof module.record === 'function' ? (module as unknown as ZebraApi) : null;
  }

  private resolve(world: WorldApi): void {
    const resolved = BridgeConsumer.asZebraApi(world.sibling(SIBLING_NAME));
    if (resolved === null) {
      if (!this.warned) {
        this.warned = true;
        this.warnings.push(`[consumer] ${SIBLING_NAME} plugin not available`);
      }
      return;
    }
    this.api = resolved;
    for (const value of this.buffered) resolved.record(value);
    this.buffered.length = 0;
  }

  say(value: string): void {
    this.buffered.push(value);
    if (this.api !== null) {
      this.api.record(value);
      this.buffered.length = 0;
    }
  }

  get available(): boolean {
    return this.api !== null;
  }
}

function zebraPlugin(recorded: string[]): {
  readonly plugin: TerracePlugin;
  readonly exports: SiblingModule;
} {
  return {
    plugin: { name: SIBLING_NAME },
    exports: {
      record: (value: string) => recorded.push(value),
    },
  };
}

describe('WorldApi.sibling', () => {
  it('resolves a sibling that comes LATER in load order, in onWorldCreate', () => {
    const recorded: string[] = [];
    const consumer = new BridgeConsumer();
    const zebra = zebraPlugin(recorded);
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);

    const host = new PluginHost(world, [
      asLoadedPlugin(consumer.plugin),
      asLoadedPluginExporting(zebra.plugin, zebra.exports),
    ]);

    consumer.say('before-open');
    host.worldCreate();

    expect(consumer.available).toBe(true);
    expect(consumer.warnings).toEqual([]);
    expect(recorded).toEqual(['before-open']);

    consumer.say('after-open');
    expect(recorded).toEqual(['before-open', 'after-open']);
  });

  it('answers null for a sibling that is not installed, and the consumer warns once', () => {
    const consumer = new BridgeConsumer();
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [asLoadedPlugin(consumer.plugin)]);

    host.worldCreate();
    host.worldCreate();

    expect(consumer.available).toBe(false);
    expect(consumer.warnings).toHaveLength(1);
    expect(() => consumer.say('into-the-void')).not.toThrow();
  });

  it('answers null for a sibling INSTALLED BUT DISABLED for this world', () => {
    const recorded: string[] = [];
    const consumer = new BridgeConsumer();
    const zebra = zebraPlugin(recorded);
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);

    const host = new PluginHost(
      world,
      [asLoadedPlugin(consumer.plugin), asLoadedPluginExporting(zebra.plugin, zebra.exports)],
      new Set(['consumer']),
    );

    host.worldCreate();
    host.worldCreate();

    expect(consumer.available).toBe(false);
    expect(consumer.warnings).toHaveLength(1);
    consumer.say('into-the-void');
    expect(recorded).toEqual([]);
  });

  it('hands back the module namespace verbatim, for the caller to duck-type', () => {
    let seen: SiblingModule | null = null;
    const zebra = zebraPlugin([]);
    const looker: TerracePlugin = {
      name: 'looker',
      onWorldCreate: (world) => {
        seen = world.sibling(SIBLING_NAME);
      },
    };
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);

    new PluginHost(world, [
      asLoadedPlugin(looker),
      asLoadedPluginExporting(zebra.plugin, zebra.exports),
    ]).worldCreate();

    expect(seen).toBe(zebra.exports);
  });

  it('is unreachable once the world has closed, like every other member', () => {
    let captured: WorldApi | null = null;
    const looker: TerracePlugin = {
      name: 'looker',
      onWorldCreate: (world) => {
        captured = world;
      },
    };
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [asLoadedPlugin(looker)]);

    host.worldCreate();
    host.revokeApis();

    expect(() => captured?.sibling(SIBLING_NAME)).toThrow(/sibling/);
  });
});
