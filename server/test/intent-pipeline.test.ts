// The intent pipeline is the anti-cheat surface: every test here is a rule a
// hostile or buggy client (or plugin) must not be able to break.

import { DEFAULT_SCULPT_AMOUNT, type SculptIntent } from '@terrace/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleSculptIntent, type IntentPipelineDeps } from '../src/intent/pipeline.ts';
import { PluginHost } from '../src/plugins/host.ts';
import type { IntentVerdict, TerracePlugin } from '../src/plugins/types.ts';
import type { World } from '../src/world/world.ts';
import { RecordingSink, asLoadedPlugin, worldWithUnlockedChunks } from './support/harness.ts';

/** 4×4 chunks of 16 cells: chunk (0,0) covers cells [0..15]². */
const WORLD_SIZE = 64;
const PLAYER = { id: 'session-1', token: 'token-1', name: 'Tester' };

/** A cell well inside the single unlocked chunk. */
const UNLOCKED_CELL = { x: 4, y: 4 };
/** A cell inside a locked chunk. */
const LOCKED_CELL = { x: 40, y: 40 };

function makeDeps(world: World, plugins: TerracePlugin[]): IntentPipelineDeps {
  const host = new PluginHost(world, plugins.map(asLoadedPlugin));
  return { world, interceptors: host };
}

function sculptMessage(overrides: Partial<SculptIntent> = {}): unknown {
  return { type: 'sculpt', x: UNLOCKED_CELL.x, y: UNLOCKED_CELL.y, radius: 1, dir: 1, ...overrides };
}

describe('handleSculptIntent', () => {
  let world: World;
  let sink: RecordingSink;

  beforeEach(() => {
    world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    sink = new RecordingSink();
    world.setSink(sink);
  });

  it('applies a valid intent, broadcasts the diff, and marks the world dirty', () => {
    const outcome = handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage());

    expect(outcome.applied).toBe(true);
    expect(world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBeGreaterThan(0);
    expect(world.dirty).toBe(true);

    const broadcasts = sink.ofType('terrainDiff');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].target).toBe('broadcast');
  });

  it('uses the server-side sculpt amount and only the direction from the client', () => {
    // The message carries no amount at all — a hacked client cannot ask for
    // more. Direction -1 must dig, +1 must raise, both by the same magnitude.
    handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage({ dir: -1 }));
    const lowered = world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y);

    const raised = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    handleSculptIntent(makeDeps(raised, []), PLAYER, sculptMessage({ dir: 1 }));

    expect(lowered).toBeLessThan(0);
    expect(raised.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBe(-lowered);
    expect(Math.abs(lowered)).toBeLessThanOrEqual(DEFAULT_SCULPT_AMOUNT);
  });

  it('rejects malformed messages without touching the world', () => {
    const deps = makeDeps(world, []);
    const malformed: unknown[] = [
      null,
      'sculpt',
      { type: 'nuke', x: 1, y: 1, radius: 1, dir: 1 },
      sculptMessage({ x: 1.5 }),
      sculptMessage({ x: WORLD_SIZE }),
      sculptMessage({ radius: 0 }),
      sculptMessage({ radius: 99 }),
      { type: 'sculpt', x: 1, y: 1, radius: 1, dir: 2 },
    ];

    for (const message of malformed) {
      const outcome = handleSculptIntent(deps, PLAYER, message);
      expect(outcome.applied).toBe(false);
      if (!outcome.applied) expect(outcome.reason).toBe('malformed');
    }
    expect(world.dirty).toBe(false);
    expect(sink.messages).toHaveLength(0);
  });

  it('rejects an intent whose brush centre is in a locked chunk', () => {
    const outcome = handleSculptIntent(
      makeDeps(world, []),
      PLAYER,
      sculptMessage({ x: LOCKED_CELL.x, y: LOCKED_CELL.y }),
    );

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('locked');
    expect(world.heightAt(LOCKED_CELL.x, LOCKED_CELL.y)).toBe(0);
    expect(sink.messages).toHaveLength(0);
  });

  it('lets a plugin deny an intent, and the first deny stops the chain', () => {
    const seen: string[] = [];
    const denier: TerracePlugin = {
      name: 'denier',
      onIntent(): IntentVerdict {
        seen.push('denier');
        return { kind: 'deny', reason: 'no mana' };
      },
    };
    const laterPlugin: TerracePlugin = {
      name: 'later',
      onIntent(): IntentVerdict {
        seen.push('later');
        return { kind: 'allow' };
      },
    };

    const outcome = handleSculptIntent(makeDeps(world, [denier, laterPlugin]), PLAYER, sculptMessage());

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.reason).toBe('plugin-denied');
      expect(outcome.detail).toBe('no mana');
    }
    expect(seen).toEqual(['denier']);
    expect(world.dirty).toBe(false);
    expect(sink.messages).toHaveLength(0);
  });

  it('applies a plugin-modified intent, and the modification flows down the chain', () => {
    const moved = { x: 9, y: 9 };
    const observedBySecond: SculptIntent[] = [];

    const mover: TerracePlugin = {
      name: 'mover',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, x: moved.x, y: moved.y } };
      },
    };
    const widener: TerracePlugin = {
      name: 'widener',
      onIntent(intent): IntentVerdict {
        observedBySecond.push(intent);
        return { kind: 'modify', intent: { ...intent, radius: 2 } };
      },
    };

    const outcome = handleSculptIntent(makeDeps(world, [mover, widener]), PLAYER, sculptMessage());

    expect(outcome.applied).toBe(true);
    if (outcome.applied) {
      expect(outcome.intent).toEqual({ type: 'sculpt', x: moved.x, y: moved.y, radius: 2, dir: 1 });
    }
    // The second interceptor saw the FIRST one's rewrite, not the original.
    expect(observedBySecond).toHaveLength(1);
    expect(observedBySecond[0].x).toBe(moved.x);

    expect(world.heightAt(moved.x, moved.y)).toBeGreaterThan(0);
    expect(world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBe(0);
  });

  it('refuses a plugin rewrite that is out of bounds or aimed at locked terrain', () => {
    const outOfBounds: TerracePlugin = {
      name: 'out-of-bounds',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, x: WORLD_SIZE + 10 } };
      },
    };
    const intoLocked: TerracePlugin = {
      name: 'into-locked',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, x: LOCKED_CELL.x, y: LOCKED_CELL.y } };
      },
    };

    for (const plugin of [outOfBounds, intoLocked]) {
      const fresh = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
      const outcome = handleSculptIntent(makeDeps(fresh, [plugin]), PLAYER, sculptMessage());
      expect(outcome.applied).toBe(false);
      if (!outcome.applied) expect(outcome.reason).toBe('plugin-modified-invalid');
      expect(fresh.dirty).toBe(false);
    }
  });

  it('treats a throwing interceptor as allow rather than letting it block the world', () => {
    const broken: TerracePlugin = {
      name: 'broken',
      onIntent(): IntentVerdict {
        throw new Error('plugin bug');
      },
    };

    const outcome = handleSculptIntent(makeDeps(world, [broken]), PLAYER, sculptMessage());

    expect(outcome.applied).toBe(true);
    expect(world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBeGreaterThan(0);
  });

  it('notifies plugins of the full server-side diff after an applied edit', () => {
    const seenDiffs: number[] = [];
    const watcher: TerracePlugin = {
      name: 'watcher',
      onTerrainChanged(_world, diff): void {
        seenDiffs.push(diff.length);
      },
    };

    handleSculptIntent(makeDeps(world, [watcher]), PLAYER, sculptMessage({ radius: 2 }));

    expect(seenDiffs).toHaveLength(1);
    expect(seenDiffs[0]).toBeGreaterThan(0);
  });

  // Issue #17: onTerrainChanged's sculptorToken is how the reveal plugin's
  // per-player creep policy knows WHO to unlock a chunk for. This is the
  // contract at the pipeline layer — reveal's own tests cover the policy that
  // consumes it.
  it('hands onTerrainChanged the SCULPTOR\'s token for a player-originated edit', () => {
    const seenTokens: Array<string | undefined> = [];
    const watcher: TerracePlugin = {
      name: 'token-watcher',
      onTerrainChanged(_world, _diff, sculptorToken): void {
        seenTokens.push(sculptorToken);
      },
    };

    handleSculptIntent(makeDeps(world, [watcher]), PLAYER, sculptMessage());

    expect(seenTokens).toEqual([PLAYER.token]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE EFFECT PHASE (issue #19): onIntentApplied fires ONLY after every
// interceptor in the verdict phase has allowed AND the edit has actually
// landed. This is the pipeline-level guarantee PluginHost.notifyIntentApplied
// itself does not enforce (it is a plain fan-out — see plugin-host.test.ts);
// it holds because pipeline.ts only ever reaches the call on the path where
// every earlier `return` was skipped.
// ────────────────────────────────────────────────────────────────────────────

describe('the effect phase runs only after unanimous allow (issue #19)', () => {
  let world: World;

  beforeEach(() => {
    world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.setSink(new RecordingSink());
  });

  /** A plugin that would commit an irreversible side effect if ever called. */
  function ledgerPlugin(calls: SculptIntent[]): TerracePlugin {
    return {
      name: 'ledger',
      onIntentApplied(intent): void {
        calls.push(intent);
      },
    };
  }

  it('never calls onIntentApplied when a later interceptor denies', () => {
    const applied: SculptIntent[] = [];
    const denier: TerracePlugin = {
      name: 'zzz-denier',
      onIntent(): IntentVerdict {
        return { kind: 'deny', reason: 'no' };
      },
    };

    // Ledger sorts first in the array, so its onIntent (it has none) would run
    // before the denier's either way — the claim under test is that ITS EFFECT
    // hook, which only core calls after the whole chain clears, never fires.
    const outcome = handleSculptIntent(
      makeDeps(world, [ledgerPlugin(applied), denier]),
      PLAYER,
      sculptMessage(),
    );

    expect(outcome.applied).toBe(false);
    expect(applied).toEqual([]);
  });

  it('calls onIntentApplied exactly once, with the EFFECTIVE (post-modify) intent and the real diff, when every interceptor allows', () => {
    const applied: SculptIntent[] = [];
    const widener: TerracePlugin = {
      name: 'widener',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, radius: 2 } };
      },
    };

    const outcome = handleSculptIntent(
      makeDeps(world, [widener, ledgerPlugin(applied)]),
      PLAYER,
      sculptMessage({ radius: 1 }),
    );

    expect(outcome.applied).toBe(true);
    expect(applied).toHaveLength(1);
    // The WIDENED radius, not the radius-1 the client sent — onIntentApplied
    // describes what was actually built.
    expect(applied[0].radius).toBe(2);
    if (outcome.applied) {
      expect(applied[0]).toEqual(outcome.intent);
    }
  });

  it('never calls onIntentApplied for a malformed or locked-centre intent', () => {
    const applied: SculptIntent[] = [];
    const deps = makeDeps(world, [ledgerPlugin(applied)]);

    handleSculptIntent(deps, PLAYER, 'not an intent');
    handleSculptIntent(deps, PLAYER, sculptMessage({ x: LOCKED_CELL.x, y: LOCKED_CELL.y }));

    expect(applied).toEqual([]);
  });
});

describe('brush tool and edge profile passthrough (decision 2026-08-14)', () => {
  let world: World;

  /** The 4-neighbours of a cell — what relaxation would move and stamp must not. */
  const neighbourHeights = (w: World, x: number, y: number): number[] => [
    w.heightAt(x - 1, y),
    w.heightAt(x + 1, y),
    w.heightAt(x, y - 1),
    w.heightAt(x, y + 1),
  ];

  beforeEach(() => {
    world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.setSink(new RecordingSink());
  });

  it('a stamp intent does NOT relax the neighbours, end to end', () => {
    const outcome = handleSculptIntent(
      makeDeps(world, []),
      PLAYER,
      sculptMessage({ tool: 'stamp' }),
    );

    expect(outcome.applied).toBe(true);
    expect(world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(neighbourHeights(world, UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toEqual([0, 0, 0, 0]);
    // The diff is the footprint alone — a radius-1 stamp is exactly one cell.
    if (outcome.applied) expect(outcome.diff).toHaveLength(1);
  });

  it('a smooth intent still relaxes the neighbours', () => {
    handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage({ tool: 'smooth' }));

    expect(
      neighbourHeights(world, UNLOCKED_CELL.x, UNLOCKED_CELL.y).some((h) => h > 0),
    ).toBe(true);
  });

  it('an intent naming NO tool is applied as a stamp (the wire default)', () => {
    // The pipeline normalises through shared's sculptOptionsOf, whose default is
    // the player-facing stamp — deliberately NOT the library's smooth default.
    handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage());

    expect(world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(neighbourHeights(world, UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toEqual([0, 0, 0, 0]);
  });

  it('a hard profile lays a flat plateau across the footprint', () => {
    handleSculptIntent(
      makeDeps(world, []),
      PLAYER,
      sculptMessage({ radius: 3, tool: 'stamp', profile: 'hard' }),
    );

    // Every cell out to the footprint edge got the SAME delta...
    expect(world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(world.heightAt(UNLOCKED_CELL.x + 2, UNLOCKED_CELL.y)).toBe(DEFAULT_SCULPT_AMOUNT);
    // ...and the cell beyond it is untouched: a sheer edge.
    expect(world.heightAt(UNLOCKED_CELL.x + 3, UNLOCKED_CELL.y)).toBe(0);
  });

  it('rejects an intent carrying an unknown tool or profile as malformed', () => {
    const deps = makeDeps(world, []);
    // Spread over a valid message rather than through sculptMessage's typed
    // overrides: these values are exactly what the type system forbids, which
    // is the point — only a hostile or out-of-date client can send them.
    for (const message of [
      { ...(sculptMessage() as object), tool: 'chisel' },
      { ...(sculptMessage() as object), profile: 'medium' },
    ]) {
      const outcome = handleSculptIntent(deps, PLAYER, message);
      expect(outcome.applied).toBe(false);
      if (!outcome.applied) expect(outcome.reason).toBe('malformed');
    }
    expect(world.dirty).toBe(false);
  });

  it('carries a plugin-rewritten tool through to the applied edit', () => {
    // A plugin may reshape the brush; the rewrite is re-validated and then
    // normalised by the same one function, so it reaches the math intact.
    const smoother: TerracePlugin = {
      name: 'smoother',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, tool: 'smooth' } };
      },
    };

    handleSculptIntent(makeDeps(world, [smoother]), PLAYER, sculptMessage({ tool: 'stamp' }));

    expect(
      neighbourHeights(world, UNLOCKED_CELL.x, UNLOCKED_CELL.y).some((h) => h > 0),
    ).toBe(true);
  });
});

describe('sculptDenied nack', () => {
  let world: World;
  let sink: RecordingSink;
  const denier: TerracePlugin = {
    name: 'denier',
    onIntent(): IntentVerdict {
      return { kind: 'deny', reason: 'no mana' };
    },
  };

  beforeEach(() => {
    world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    sink = new RecordingSink();
    world.setSink(sink);
  });

  it('nacks a plugin-denied intent that carried a seq, to the sender only', () => {
    const outcome = handleSculptIntent(makeDeps(world, [denier]), PLAYER, sculptMessage({ seq: 42 }));
    expect(outcome.applied).toBe(false);
    expect(sink.messages).toEqual([
      { target: PLAYER.id, type: 'sculptDenied', payload: { type: 'sculptDenied', seq: 42 } },
    ]);
  });

  it('sends nothing for a plugin-denied intent without a seq', () => {
    handleSculptIntent(makeDeps(world, [denier]), PLAYER, sculptMessage());
    expect(sink.messages).toHaveLength(0);
  });

  it('stays SILENT for a mask rejection even when the intent carried a seq', () => {
    // The anti-cheat boundary: a locked-centre intent must remain
    // indistinguishable from a dropped packet (protocol.ts, pipeline step 2).
    const outcome = handleSculptIntent(
      makeDeps(world, [denier]),
      PLAYER,
      sculptMessage({ x: LOCKED_CELL.x, y: LOCKED_CELL.y, seq: 42 }),
    );
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('locked');
    expect(sink.messages).toHaveLength(0);
  });
});
