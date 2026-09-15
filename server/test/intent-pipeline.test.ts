import {
  CHUNK_SIZE,
  DRAWN_SHORE_HEIGHT,
  MAX_HEIGHT,
  SEA_LEVEL,
  bandLevelHeight,
  chunkHeightsAsCells,
  drawnBandOfSample,
  stepTowardBand,
  type ChunkPayload,
  type ChunkUnlockMessage,
  type SculptDeniedMessage,
  type SculptIntent,
} from '@terrace/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleSculptIntent,
  refuseFaultedSculpt,
  sculptMessageSeq,
  type IntentPipelineDeps,
} from '../src/intent/pipeline.ts';
import type { MessageSink } from '../src/net/message-sink.ts';
import { PluginHost, SECOND_LOOK_MODIFY_REASON } from '../src/plugins/host.ts';
import type { IntentVerdict, TerracePlugin } from '../src/plugins/types.ts';
import type { World } from '../src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
  worldWithUnlockedChunks,
} from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const PLAYER = { id: 'session-1', token: 'token-1', name: 'Tester' };

const UNLOCKED_CELL = { x: 4, y: 4 };
const LOCKED_CELL = { x: CHUNK_SIZE * 2 + 8, y: CHUNK_SIZE * 2 + 8 };

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

  it('applies a valid intent, sends the sculptor the diff, and marks the world dirty', () => {
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    const outcome = handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage());

    expect(outcome.applied).toBe(true);
    expect(world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBeGreaterThan(0);
    expect(world.dirty).toBe(true);

    const broadcasts = sink.ofType('terrainDiff');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].target).toBe(PLAYER.id);
  });

  it('uses the server-side sculpt amount and only the direction from the client', () => {
    handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage({ dir: -1 }));
    const lowered = world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y);

    const raised = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    handleSculptIntent(makeDeps(raised, []), PLAYER, sculptMessage({ dir: 1 }));

    // Drawn contract: from genesis sea (0, band -1) a raise lands on the
    // shore level while a lower lands on band -2's canonical level.
    expect(lowered).toBe(bandLevelHeight(-2));
    expect(drawnBandOfSample(lowered)).toBe(-2);
    expect(raised.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBe(DRAWN_SHORE_HEIGHT);
    expect(lowered).toBe(stepTowardBand(SEA_LEVEL, false));
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

  it('nacks a malformed intent when a routable seq can be extracted', () => {
    const outcome = handleSculptIntent(
      makeDeps(world, []),
      PLAYER,
      sculptMessage({ x: 1.5, seq: 21 }),
    );

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('malformed');
    expect(world.dirty).toBe(false);
    expect(sink.messages).toEqual([
      {
        target: PLAYER.id,
        type: 'sculptDenied',
        payload: { type: 'sculptDenied', seq: 21, reason: 'malformed' },
      },
    ]);
  });

  it('stays silent for a malformed intent with no routable seq', () => {
    const deps = makeDeps(world, []);
    const unroutable: unknown[] = [
      null,
      'sculpt',
      sculptMessage({ x: 1.5 }),
      sculptMessage({ x: 1.5, seq: 1.5 }),
    ];

    for (const message of unroutable) {
      handleSculptIntent(deps, PLAYER, message);
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

  it('nacks a locked-centre intent that carried a seq, so the prediction rolls back loudly', () => {
    const outcome = handleSculptIntent(
      makeDeps(world, []),
      PLAYER,
      sculptMessage({ x: LOCKED_CELL.x, y: LOCKED_CELL.y, seq: 43 }),
    );

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('locked');
    expect(world.heightAt(LOCKED_CELL.x, LOCKED_CELL.y)).toBe(0);
    expect(sink.messages).toEqual([
      {
        target: PLAYER.id,
        type: 'sculptDenied',
        payload: { type: 'sculptDenied', seq: 43, reason: 'locked' },
      },
    ]);
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

describe('the effect phase runs only after unanimous allow (issue #19)', () => {
  let world: World;

  beforeEach(() => {
    world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.setSink(new RecordingSink());
  });

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

  it('an intent naming NO tool is applied as a stamp (the wire default)', () => {
    handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage());

    expect(world.heightAt(UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toBe(DRAWN_SHORE_HEIGHT);
    expect(neighbourHeights(world, UNLOCKED_CELL.x, UNLOCKED_CELL.y)).toEqual([0, 0, 0, 0]);
  });

  it('rejects an intent carrying an unknown tool or profile as malformed', () => {
    const deps = makeDeps(world, []);
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
      {
        target: PLAYER.id,
        type: 'sculptDenied',
        payload: { type: 'sculptDenied', seq: 42, reason: 'plugin-denied', detail: 'no mana' },
      },
    ]);
  });

  it('sends nothing for a plugin-denied intent without a seq', () => {
    handleSculptIntent(makeDeps(world, [denier]), PLAYER, sculptMessage());
    expect(sink.messages).toHaveLength(0);
  });

  it('nacks a plugin rewrite that failed re-validation, so the prediction is not stranded', () => {
    const breaker: TerracePlugin = {
      name: 'breaker',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, x: -1 } };
      },
    };
    const outcome = handleSculptIntent(makeDeps(world, [breaker]), PLAYER, sculptMessage({ seq: 7 }));

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('plugin-modified-invalid');
    expect(sink.messages).toEqual([
      {
        target: PLAYER.id,
        type: 'sculptDenied',
        payload: { type: 'sculptDenied', seq: 7, reason: 'plugin-modified-invalid' },
      },
    ]);
  });

  it('nacks a plugin rewrite that aimed the centre at locked terrain', () => {
    const intoLocked: TerracePlugin = {
      name: 'into-locked',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, x: LOCKED_CELL.x, y: LOCKED_CELL.y } };
      },
    };
    const outcome = handleSculptIntent(
      makeDeps(world, [intoLocked]),
      PLAYER,
      sculptMessage({ seq: 8 }),
    );

    expect(outcome.applied).toBe(false);
    expect(sink.messages).toEqual([
      {
        target: PLAYER.id,
        type: 'sculptDenied',
        payload: {
          type: 'sculptDenied',
          seq: 8,
          reason: 'plugin-modified-invalid',
          detail: 'centre is locked',
        },
      },
    ]);
  });

  it('sends nothing for a plugin rewrite that failed re-validation without a seq', () => {
    const breaker: TerracePlugin = {
      name: 'breaker',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, x: -1 } };
      },
    };
    handleSculptIntent(makeDeps(world, [breaker]), PLAYER, sculptMessage());
    expect(sink.messages).toHaveLength(0);
  });

  it('nacks a locked-centre intent even when a plugin would also deny it', () => {
    const outcome = handleSculptIntent(
      makeDeps(world, [denier]),
      PLAYER,
      sculptMessage({ x: LOCKED_CELL.x, y: LOCKED_CELL.y, seq: 42 }),
    );
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('locked');
    expect(sink.messages).toEqual([
      {
        target: PLAYER.id,
        type: 'sculptDenied',
        payload: { type: 'sculptDenied', seq: 42, reason: 'locked' },
      },
    ]);
  });
});

describe('sculptApplied ack', () => {
  let world: World;
  let sink: RecordingSink;

  beforeEach(() => {
    world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    sink = new RecordingSink();
    world.setSink(sink);
  });

  it('acks an applied intent to the sender only, AFTER the diff', () => {
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    sink.clear();
    const outcome = handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage({ seq: 7 }));
    expect(outcome.applied).toBe(true);

    expect(sink.messages.map((message) => [message.target, message.type])).toEqual([
      [PLAYER.id, 'terrainDiff'],
      [PLAYER.id, 'sculptApplied'],
    ]);
    expect(sink.ofType('sculptApplied')[0].payload).toEqual({
      type: 'sculptApplied',
      seq: 7,
    });
  });

  it('acks AFTER the chunkUnlock a frontier sculpt earned for the sculptor', () => {
    const creeper: TerracePlugin = {
      name: 'creeper',
      onTerrainChanged(api, _diff, sculptorToken): void {
        if (sculptorToken !== undefined) api.unlockChunkForToken(sculptorToken, 1, 0);
      },
    };
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    sink.clear();

    handleSculptIntent(makeDeps(world, [creeper]), PLAYER, sculptMessage({ seq: 8 }));

    expect(sink.messages.map((message) => [message.target, message.type])).toEqual([
      [PLAYER.id, 'terrainDiff'],
      [PLAYER.id, 'chunkUnlock'],
      [PLAYER.id, 'sculptApplied'],
    ]);
  });

  it('acks even when the applied edit changed nothing', () => {
    const ceiling = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]], undefined, MAX_HEIGHT);
    const ceilingSink = new RecordingSink();
    ceiling.setSink(ceilingSink);

    const outcome = handleSculptIntent(
      makeDeps(ceiling, []),
      PLAYER,
      sculptMessage({ dir: 1, radius: 1, seq: 9 }),
    );

    expect(outcome.applied).toBe(true);
    if (outcome.applied) expect(outcome.diff).toHaveLength(0);
    expect(ceilingSink.messages.map((message) => [message.target, message.type])).toEqual([
      [PLAYER.id, 'sculptApplied'],
    ]);
  });

  it('sends no ack for an intent that carried no seq', () => {
    handleSculptIntent(makeDeps(world, []), PLAYER, sculptMessage());
    expect(sink.ofType('sculptApplied')).toHaveLength(0);
  });

  it("echoes the CLIENT's seq even when a plugin rewrote the intent", () => {
    const mover: TerracePlugin = {
      name: 'mover',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, x: 8, y: 8, seq: undefined } };
      },
    };
    handleSculptIntent(makeDeps(world, [mover]), PLAYER, sculptMessage({ seq: 11 }));

    expect(sink.ofType('sculptApplied')[0].payload).toEqual({
      type: 'sculptApplied',
      seq: 11,
    });
  });

  it('sends no ack when a plugin rewrote the intent into something invalid', () => {
    const breaker: TerracePlugin = {
      name: 'breaker',
      onIntent(intent): IntentVerdict {
        return { kind: 'modify', intent: { ...intent, x: -1 } };
      },
    };
    const outcome = handleSculptIntent(
      makeDeps(world, [breaker]),
      PLAYER,
      sculptMessage({ seq: 12 }),
    );

    expect(outcome.applied).toBe(false);
    expect(sink.ofType('sculptApplied')).toHaveLength(0);
  });
});

describe('plugin denial reasons ride the wire detail (lane B)', () => {
  let world: World;
  let sink: RecordingSink;

  beforeEach(() => {
    world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    sink = new RecordingSink();
    world.setSink(sink);
  });

  it('threads the frozen monsters/relics denial reasons into sculptDenied detail', () => {
    // Literals, not imports: server core must not import plugin halves.
    // 'monster occupies the ground' is RAISE_BLOCKED_REASON
    // (plugins/monsters/server/protection.ts); 'warded' is CAST_DENIED_WARDED
    // (plugins/relics/protocol.ts). Both strings are frozen.
    for (const reason of ['monster occupies the ground', 'warded']) {
      const fresh = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
      const freshSink = new RecordingSink();
      fresh.setSink(freshSink);
      const denier: TerracePlugin = {
        name: 'denier',
        onIntent(): IntentVerdict {
          return { kind: 'deny', reason };
        },
      };

      const outcome = handleSculptIntent(
        makeDeps(fresh, [denier]),
        PLAYER,
        sculptMessage({ seq: 99 }),
      );

      expect(outcome.applied).toBe(false);
      if (!outcome.applied) {
        expect(outcome.reason).toBe('plugin-denied');
        expect(outcome.detail).toBe(reason);
      }
      expect(freshSink.messages).toEqual([
        {
          target: PLAYER.id,
          type: 'sculptDenied',
          payload: { type: 'sculptDenied', seq: 99, reason: 'plugin-denied', detail: reason },
        },
      ]);
    }
  });

  it('surfaces a second-look modify as a plugin-denied nack naming the fault', () => {
    const flipFlop: TerracePlugin = {
      name: 'a-flipflop',
      onIntent(intent) {
        return intent.radius === 1
          ? { kind: 'allow' }
          : { kind: 'modify', intent: { ...intent, radius: 1 } };
      },
    };
    const widener: TerracePlugin = {
      name: 'b-widener',
      onIntent(intent) {
        return { kind: 'modify', intent: { ...intent, radius: intent.radius + 1 } };
      },
    };

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = handleSculptIntent(
      makeDeps(world, [flipFlop, widener]),
      PLAYER,
      sculptMessage({ radius: 1, seq: 5 }),
    );
    errors.mockRestore();

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.reason).toBe('plugin-denied');
      expect(outcome.detail).toBe(SECOND_LOOK_MODIFY_REASON);
    }
    expect(sink.messages).toEqual([
      {
        target: PLAYER.id,
        type: 'sculptDenied',
        payload: {
          type: 'sculptDenied',
          seq: 5,
          reason: 'plugin-denied',
          detail: SECOND_LOOK_MODIFY_REASON,
        },
      },
    ]);
  });
});

describe('a pipeline fault is the caller\'s to contain', () => {
  const WORLD_FAULT = 'terrain engine fault';

  function throwingWorld(world: World): World {
    return new Proxy(world, {
      get(target, property, receiver): unknown {
        if (property === 'applySculpt') {
          return () => {
            throw new Error(WORLD_FAULT);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('lets a throw out rather than acking an edit that never landed', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);

    expect(() =>
      handleSculptIntent(
        makeDeps(throwingWorld(world), []),
        PLAYER,
        sculptMessage({ seq: 9 }),
      ),
    ).toThrow(WORLD_FAULT);

    expect(sink.ofType('sculptApplied')).toHaveLength(0);
    expect(sink.ofType('terrainDiff')).toHaveLength(0);
  });

  it('hands the sender\'s seq to whoever contains that throw, and nothing else', () => {
    expect(sculptMessageSeq(sculptMessage({ seq: 9 }))).toBe(9);
    expect(sculptMessageSeq(sculptMessage())).toBeUndefined();
    expect(sculptMessageSeq({ seq: 1.5 })).toBeUndefined();
    expect(sculptMessageSeq(null)).toBeUndefined();
    expect(sculptMessageSeq('sculpt')).toBeUndefined();
  });
});

describe('a contained sculpt fault leaves no client diverged', () => {
  const HALF_APPLIED_HEIGHT = 77;
  const FAULT = 'terrain engine fault';
  const OTHER = { id: 'session-2', token: 'token-2', name: 'Watcher' };
  const SEQ = 9;

  function worldThatHalfApplies(world: World): World {
    return new Proxy(world, {
      get(target, property, receiver): unknown {
        if (property === 'applySculpt') {
          return (x: number, y: number): never => {
            target.map.cells[y * target.size + x] = HALF_APPLIED_HEIGHT;
            throw new Error(FAULT);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function heightsOf(payload: ChunkPayload): ArrayLike<number> {
    return chunkHeightsAsCells(payload.heights);
  }

  it('nacks the sender as a server fault, not as locked territory', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.setSink(new RecordingSink());
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);

    const nacks: SculptDeniedMessage[] = [];
    refuseFaultedSculpt(world, sculptMessage({ seq: SEQ }), (denial) => nacks.push(denial));

    expect(nacks).toEqual([{ type: 'sculptDenied', seq: SEQ, reason: 'server-fault' }]);
  });

  it('stays silent when the faulted message carries no routable seq', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.setSink(new RecordingSink());

    const nacks: SculptDeniedMessage[] = [];
    refuseFaultedSculpt(world, sculptMessage(), (denial) => nacks.push(denial));
    refuseFaultedSculpt(world, { type: 'sculpt', seq: 1.5 }, (denial) => nacks.push(denial));

    expect(nacks).toHaveLength(0);
  });

  it('resends the authoritative chunk a half-applied edit left behind', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);

    const message = sculptMessage({ seq: SEQ });
    expect(() => handleSculptIntent(makeDeps(worldThatHalfApplies(world), []), PLAYER, message))
      .toThrow(FAULT);
    expect(sink.ofType('terrainDiff')).toHaveLength(0);
    sink.clear();

    refuseFaultedSculpt(world, message, () => {});

    const resyncs = sink.ofType('chunkUnlock');
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]!.target).toBe(PLAYER.id);
    const { chunks } = resyncs[0]!.payload as ChunkUnlockMessage;
    expect(chunks.map((chunk) => [chunk.cx, chunk.cy])).toEqual([[0, 0]]);
    const cell = UNLOCKED_CELL.y * CHUNK_SIZE + UNLOCKED_CELL.x;
    expect(heightsOf(chunks[0]!)[cell]).toBe(HALF_APPLIED_HEIGHT);
  });

  it('covers a drag sweep, not just the brush it ended on', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    sink.clear();

    refuseFaultedSculpt(
      world,
      sculptMessage({
        seq: SEQ,
        tool: 'drag',
        targetBand: 1,
        radius: 1,
        fromX: 4,
        fromY: 4,
        x: CHUNK_SIZE + 4,
        y: 4,
      }),
      () => {},
    );

    const { chunks } = sink.ofType('chunkUnlock')[0]!.payload as ChunkUnlockMessage;
    expect(chunks.map((chunk) => chunk.cx).sort()).toEqual([0, 1, 2]);
  });

  it('sends the resync only to viewers who can see those chunks', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer(PLAYER);
    world.addPlayer(OTHER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    sink.clear();

    refuseFaultedSculpt(world, sculptMessage({ seq: SEQ }), () => {});

    expect(sink.ofType('chunkUnlock').map((message) => message.target)).toEqual([PLAYER.id]);
  });

  it('keeps one viewer\'s broken socket from stranding the others', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    const brokenSink: MessageSink = {
      broadcast: (type, payload) => sink.broadcast(type, payload),
      sendTo: (playerId, type, payload) => {
        if (playerId === PLAYER.id && type === 'terrainDiff') {
          throw new Error('socket already closed');
        }
        sink.sendTo(playerId, type, payload);
      },
    };
    world.setSink(brokenSink);
    world.addPlayer(PLAYER);
    world.addPlayer(OTHER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    grantTokenEveryUnlockedChunk(world, OTHER.token);
    sink.clear();

    const applied: number[] = [];
    const witness: TerracePlugin = {
      name: 'witness',
      onIntentApplied: (intent) => {
        applied.push(intent.seq ?? -1);
      },
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = handleSculptIntent(
      makeDeps(world, [witness]),
      PLAYER,
      sculptMessage({ seq: SEQ }),
    );
    errors.mockRestore();

    expect(outcome.applied).toBe(true);
    expect(sink.ofType('terrainDiff').map((message) => message.target)).toEqual([OTHER.id]);
    expect(applied).toEqual([SEQ]);
    expect(sink.ofType('chunkUnlock').map((message) => message.target)).toEqual([PLAYER.id]);
    expect(sink.ofType('sculptApplied')).toHaveLength(1);
  });
});

describe('a carve names the span it grasps', () => {
  function bootWithFace(): { world: World; sink: RecordingSink } {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    return { world, sink };
  }

  it('rejects a carve that asks to raise', () => {
    const { world } = bootWithFace();
    const outcome = handleSculptIntent(
      makeDeps(world, []),
      PLAYER,
      sculptMessage({ tool: 'carve', dir: 1, spanBand: 2, seq: 40 }),
    );
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('malformed');
  });

  it('refuses a carve carrying no spanBand as malformed, the way a drag needs its targetBand', () => {
    const { world, sink } = bootWithFace();
    sink.clear();

    const outcome = handleSculptIntent(
      makeDeps(world, []),
      PLAYER,
      sculptMessage({ tool: 'carve', dir: -1, seq: 41 }),
    );

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('malformed');
    expect(sink.ofType('sculptApplied')).toHaveLength(0);
  });
});
