// World-rollback tests (2026-08-21).
//
// THE CONTRACT IS THE SUBJECT, not the callers. Every test below drives
// RollbackService — the one thing that owns the gate, the ordering and the
// undo point — rather than the room handler or the CLI, which are both two
// lines over it. A failure here is a failure of the feature; a failure in the
// room would only ever be a wiring mistake.
//
// The store is a real SQLite file in a temp directory, matching
// persistence.test.ts's reasoning: a restore point is a row on disk, and an
// in-memory database would test something adjacent to it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_HEIGHT } from '@terrace/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';
import { PluginHost } from '../src/plugins/host.ts';
import type { TerracePlugin } from '../src/plugins/types.ts';
import {
  ROLLBACK_LOCKOUT_MS,
  ROLLBACK_MAX_FAILED_ATTEMPTS,
  RollbackService,
} from '../src/world/rollback.ts';
import type { World } from '../src/world/world.ts';
import {
  asLoadedPlugin,
  RecordingSink,
  TEST_WORLD_NAME,
  worldWithUnlockedChunks,
} from './support/harness.ts';

const WORLD_SIZE = 64;
const KEY = 'correct-horse-battery';
const CLIENT = 'session-1';
/** The snapshot cadence the service reports to the panel; arbitrary here. */
const INTERVAL_S = 60;

/**
 * The height a test writes to mark "the world moved on".
 *
 * MAX_HEIGHT rather than an arbitrary number, and that is not cosmetic: the
 * snapshot store validates every cell against [MIN_HEIGHT, MAX_HEIGHT] on the
 * way back in (see loadSnapshot), so a marker picked out of the air can be one
 * the store is right to refuse — which is a test failing for a reason that has
 * nothing to do with rollback. Taking it from the bound guarantees a value
 * that is extreme, valid, and never a fresh world's own.
 */
const MARKER_HEIGHT = MAX_HEIGHT;

let dir: string;
let store: SnapshotStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'terrace-rollback-'));
  store = SnapshotStore.open(join(dir, 'world.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A plugin whose whole state is one counter, so a slice restore is visible. */
function counterPlugin(): TerracePlugin & { value: number } {
  const plugin = {
    name: 'counter',
    value: 0,
    persistence: {
      save(): unknown {
        return { value: plugin.value };
      },
      load(data: unknown): void {
        plugin.value = (data as { value: number }).value;
      },
    },
  };
  return plugin;
}

interface Harness {
  world: World;
  host: PluginHost;
  plugin: TerracePlugin & { value: number };
  sink: RecordingSink;
  service: RollbackService;
  /** Moves the service's injected clock; see RollbackDeps.now. */
  advance(ms: number): void;
}

function harness(key: string | null = KEY): Harness {
  const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
  const plugin = counterPlugin();
  const host = new PluginHost(world, [asLoadedPlugin(plugin)]);
  const sink = new RecordingSink();
  world.setSink(sink);
  let clock = 1_000_000;
  const service = new RollbackService({
    world,
    host,
    store,
    key,
    retention: 10,
    intervalS: INTERVAL_S,
    now: () => clock,
  });
  return {
    world,
    host,
    plugin,
    sink,
    service,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Writes the live world as a restore point, the way the scheduler would. */
function snapshot(h: Harness): number {
  return store.saveSnapshot({
    worldSize: h.world.size,
    name: TEST_WORLD_NAME,
    cells: h.world.map.cells,
    mask: h.world.mask,
    pluginSlices: h.host.collectPersistence(),
    tokenMasks: h.world.tokenMasks(),
  });
}

describe('the operator gate', () => {
  it('refuses everything when no key is configured', () => {
    const h = harness(null);
    expect(h.service.enabled).toBe(false);
    expect(h.service.listRestorePoints(CLIENT, 'anything').refused).toBe('disabled');
    expect(h.service.rollback(CLIENT, 'anything', 1)).toMatchObject({
      ok: false,
      refused: 'disabled',
    });
  });

  it('refuses a wrong key and accepts the right one', () => {
    const h = harness();
    snapshot(h);
    expect(h.service.listRestorePoints(CLIENT, 'wrong').refused).toBe('badKey');
    expect(h.service.listRestorePoints(CLIENT, KEY).refused).toBeUndefined();
  });

  it('refuses a key that is the right prefix but the wrong length', () => {
    // Pins the length check in secretsMatch: a truncated key must not match,
    // and must not match "partially" either.
    const h = harness();
    expect(h.service.listRestorePoints(CLIENT, KEY.slice(0, -1)).refused).toBe('badKey');
  });

  it('throttles a connection after enough wrong keys, then lets it back in', () => {
    const h = harness();
    snapshot(h);
    for (let attempt = 1; attempt < ROLLBACK_MAX_FAILED_ATTEMPTS; attempt++) {
      expect(h.service.listRestorePoints(CLIENT, 'wrong').refused).toBe('badKey');
    }
    // The attempt that reaches the limit reports the lockout, not another badKey.
    expect(h.service.listRestorePoints(CLIENT, 'wrong').refused).toBe('throttled');
    // ...and while locked out, even the CORRECT key is refused. That is the
    // point of a lockout: it is about the connection, not about the guess.
    expect(h.service.listRestorePoints(CLIENT, KEY).refused).toBe('throttled');

    h.advance(ROLLBACK_LOCKOUT_MS + 1);
    expect(h.service.listRestorePoints(CLIENT, KEY).refused).toBeUndefined();
  });

  it('throttles per connection, not globally', () => {
    const h = harness();
    snapshot(h);
    for (let attempt = 0; attempt < ROLLBACK_MAX_FAILED_ATTEMPTS; attempt++) {
      h.service.listRestorePoints('attacker', 'wrong');
    }
    expect(h.service.listRestorePoints('attacker', KEY).refused).toBe('throttled');
    // A different connection is unaffected — one bad actor must not be able to
    // lock the operator out of their own world.
    expect(h.service.listRestorePoints(CLIENT, KEY).refused).toBeUndefined();
  });

  it('forgets a connection on leave, so a session id reuse starts clean', () => {
    const h = harness();
    for (let attempt = 0; attempt < ROLLBACK_MAX_FAILED_ATTEMPTS; attempt++) {
      h.service.listRestorePoints(CLIENT, 'wrong');
    }
    h.service.forgetClient(CLIENT);
    expect(h.service.listRestorePoints(CLIENT, KEY).refused).toBeUndefined();
  });
});

describe('listing restore points', () => {
  it('reports how far the world moved to reach each point', () => {
    const h = harness();
    snapshot(h); // the baseline; nothing to measure it against
    h.world.map.cells[0] = MARKER_HEIGHT;
    h.world.map.cells[1] = MARKER_HEIGHT;
    snapshot(h);

    const list = h.service.listRestorePoints(CLIENT, KEY);
    expect(list.points).toHaveLength(2);
    // Newest first.
    expect(list.points[0].cellsChanged).toBe(2);
    expect(list.points[0].maxCellDelta).toBe(MARKER_HEIGHT);
    expect(list.points[0].isCurrent).toBe(true);
    // The oldest retained point has no predecessor: null, never zero.
    expect(list.points[1].cellsChanged).toBeNull();
    expect(list.points[1].isCurrent).toBe(false);
  });

  it('states the server own retention and cadence', () => {
    const h = harness();
    const list = h.service.listRestorePoints(CLIENT, KEY);
    expect(list.retention).toBe(10);
    expect(list.intervalS).toBe(INTERVAL_S);
  });
});

describe('rolling the world back', () => {
  it('restores terrain and plugin state, and saves an undo point first', () => {
    const h = harness();
    h.plugin.value = 1;
    const before = snapshot(h);

    // The "bad edit": terrain and plugin state both move on.
    h.world.map.cells[0] = MARKER_HEIGHT;
    h.plugin.value = 999;

    const result = h.service.rollback(CLIENT, KEY, before);
    expect(result).toMatchObject({ ok: true, toId: before });

    // Terrain came back...
    expect(h.world.map.cells[0]).toBe(0);
    // ...and so did the plugin's own state, which only happens because the
    // service replays load() AND worldCreate() (see rollback.ts's header).
    expect(h.plugin.value).toBe(1);

    // The world that was rolled AWAY from is a restore point of its own, and
    // rolling forward to it restores the bad edit — i.e. the undo is real.
    expect(result.undoId).toBeDefined();
    const forward = h.service.rollback(CLIENT, KEY, result.undoId as number);
    expect(forward.ok).toBe(true);
    expect(h.world.map.cells[0]).toBe(MARKER_HEIGHT);
    expect(h.plugin.value).toBe(999);
  });

  it('hands every connected player a fresh snapshot of the rewound world', () => {
    const h = harness();
    const target = snapshot(h);
    h.world.addPlayer({ id: 'player-1', token: 'token-1', name: 'Ada' });
    h.sink.clear();

    expect(h.service.rollback(CLIENT, KEY, target).ok).toBe(true);

    const snapshots = h.sink.ofType('snapshot');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].target).toBe('player-1');
    // Sent to the player, never broadcast: the chunks in it are that token's
    // territory alone (see net/join-snapshot.ts).
    expect(h.sink.messages.every((message) => message.target !== 'broadcast')).toBe(true);
  });

  it('leaves the world alone when the restore point does not exist', () => {
    const h = harness();
    h.world.map.cells[0] = MARKER_HEIGHT;
    const missingId = 99_999;

    expect(h.service.rollback(CLIENT, KEY, missingId)).toMatchObject({
      ok: false,
      refused: 'unknownRestorePoint',
    });
    expect(h.world.map.cells[0]).toBe(MARKER_HEIGHT);
    // And it did NOT write an undo point for a rollback that never happened.
    expect(store.countSnapshots()).toBe(0);
  });

  it('writes the rewound world to disk immediately', () => {
    const h = harness();
    const target = snapshot(h);
    h.world.map.cells[0] = MARKER_HEIGHT;

    expect(h.service.rollback(CLIENT, KEY, target).ok).toBe(true);

    // A crash right now must come back rolled back: the newest snapshot is the
    // rewound world, not the one it replaced.
    const latest = store.loadLatest();
    expect(latest?.cells[0]).toBe(0);
    expect(h.world.dirty).toBe(false);
  });
});

describe('World.rewindTo', () => {
  it('refuses a differently-sized world without touching this one', () => {
    const h = harness();
    h.world.map.cells[0] = MARKER_HEIGHT;
    const wrongSize = new Int16Array(h.world.map.cells.length + 1);

    expect(() => h.world.rewindTo(wrongSize, h.world.mask)).toThrow(RangeError);
    expect(h.world.map.cells[0]).toBe(MARKER_HEIGHT);
  });

  it('replaces per-token masks rather than merging them', () => {
    const h = harness();
    // A token that unlocked a chunk AFTER the restore point must not keep it:
    // the rollback is undoing exactly that grant.
    const emptyMasks = h.world.tokenMasks();
    expect(emptyMasks.size).toBe(0);
    h.world.unlockChunkForToken('token-1', 1, 1);
    expect(h.world.isChunkUnlockedForToken('token-1', 1, 1)).toBe(true);

    h.world.rewindTo(h.world.map.cells, h.world.mask, new Map());
    expect(h.world.isChunkUnlockedForToken('token-1', 1, 1)).toBe(false);
  });
});

describe('the empty-world regression (2026-08-21)', () => {
  it('re-seeds a connected player whose token predates nothing in the restore point', () => {
    // THE BUG, caught by looking at the screen and not by any assertion that
    // existed at the time: a token that first joined AFTER the restore point
    // is absent from its per-token masks, so the rewind left that player with
    // an empty mask, its fresh snapshot carried zero chunks, and the client
    // rendered open sea.
    const h = harness();
    const target = snapshot(h); // written before this token has ever been seen
    h.world.addPlayer({ id: 'player-1', token: 'newcomer', name: 'Ada' });
    h.sink.clear();

    expect(h.service.rollback(CLIENT, KEY, target).ok).toBe(true);

    const sent = h.sink.ofType('snapshot');
    expect(sent).toHaveLength(1);
    const payload = sent[0].payload as { chunks: unknown[] };
    // The assertion that would have caught it: a player is never handed a
    // world with nothing in it.
    expect(payload.chunks.length).toBeGreaterThan(0);
  });
});
