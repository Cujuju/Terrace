// THE HOST-MEDIATED SIBLING LOOKUP CONTRACT (issue #196, plan §7 Phase 2).
//
// Before this, a plugin that needed another plugin reached for it with
// `import('../../<sibling>/server/index.ts')` — a specifier that binds to a
// module URL, not to "the plugin running as <sibling> in this session". Two
// consequences, both verified in the plan's §1.1: a reloaded sibling leaves
// every consumer talking to the old module, and a sibling the operator
// DISABLED for this world still answers, because its module is resident either
// way.
//
// `WorldApi.sibling(name)` replaces that. The four rules the bridge pattern
// used to spell out at every callsite become guarantees of this method:
//
//   1. It never throws for an absent sibling — the folder a self-hoster
//      deleted resolves to null, not a boot failure.
//   2. It answers synchronously and completely, whatever the load order:
//      every plugin's module is imported before any host exists, so a plugin
//      may look up a sibling that sorts after it in its own onWorldCreate.
//   3. BUFFER-DON'T-DROP STAYS WITH THE CALLER. The host has no idea what a
//      consumer wanted to tell a sibling; the consumer records desired state
//      and replays it. Exercised here through a bridge-shaped consumer.
//   4. DUCK-TYPING STAYS WITH THE CALLER. What comes back is the sibling's
//      module namespace verbatim; a folder can exist and export the wrong
//      thing, and only the consumer knows which members it needs.
//
// Plus the new rule this phase adds: a sibling that is INSTALLED BUT NOT
// ENABLED for this session resolves to null, exactly like one that is not
// installed at all.

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

/** The sibling every consumer below looks for. Sorts AFTER 'consumer'. */
const SIBLING_NAME = 'zebra';

/** What the sibling module exports; the consumer duck-types for this member. */
interface ZebraApi {
  record(value: string): void;
}

/**
 * A bridge-shaped consumer: the exact shape the ported plugin bridges have,
 * reduced to one member. Resolves its sibling in onWorldCreate, buffers what
 * it would have said until it has one, and warns exactly once when it never
 * gets one.
 */
class BridgeConsumer {
  readonly warnings: string[] = [];
  private api: ZebraApi | null = null;
  private warned = false;
  private readonly buffered: string[] = [];

  readonly plugin: TerracePlugin = {
    name: 'consumer',
    onWorldCreate: (world: WorldApi) => this.resolve(world),
  };

  /** Rule 4: the module namespace is duck-typed, never trusted by name. */
  private static asZebraApi(module: SiblingModule | null): ZebraApi | null {
    if (module === null) return null;
    return typeof module.record === 'function' ? (module as unknown as ZebraApi) : null;
  }

  private resolve(world: WorldApi): void {
    const resolved = BridgeConsumer.asZebraApi(world.sibling(SIBLING_NAME));
    if (resolved === null) {
      // Rule: warn ONCE, then run degraded. Repeated resolution attempts (a
      // reopen, a rollback) must not turn one absent plugin into a log flood.
      if (!this.warned) {
        this.warned = true;
        this.warnings.push(`[consumer] ${SIBLING_NAME} plugin not available`);
      }
      return;
    }
    this.api = resolved;
    // Rule 3: replay everything said before the sibling was in hand.
    for (const value of this.buffered) resolved.record(value);
    this.buffered.length = 0;
  }

  /** Callers never branch on "is it loaded yet" — rule 3. */
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

    // 'consumer' < 'zebra', so the consumer's onWorldCreate runs FIRST — the
    // case the old dynamic import existed to survive, and the one this method
    // has to answer without any waiting at all.
    const host = new PluginHost(world, [
      asLoadedPlugin(consumer.plugin),
      asLoadedPluginExporting(zebra.plugin, zebra.exports),
    ]);

    // Said before the world even opened: buffered, then replayed on resolve.
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
    // A reopen / rollback replays the pair; the warning must not repeat.
    host.worldCreate();

    expect(consumer.available).toBe(false);
    expect(consumer.warnings).toHaveLength(1);
    // Degraded, not broken: saying things to an absent sibling is a no-op.
    expect(() => consumer.say('into-the-void')).not.toThrow();
  });

  it('answers null for a sibling INSTALLED BUT DISABLED for this world', () => {
    const recorded: string[] = [];
    const consumer = new BridgeConsumer();
    const zebra = zebraPlugin(recorded);
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);

    // zebra is installed — its module is resident and its exports are right
    // here — but the operator switched it off for this world. Under the old
    // import bridge this was invisible: the module answered anyway.
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
    // Same rule as the rest of the view (issue #164): after revoke, a stale
    // module-scope reference must not be able to reach a live sibling either.
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
