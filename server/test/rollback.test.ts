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
const INTERVAL_S = 60;

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

function counterPlugin(): TerracePlugin & { value: number } {
  const plugin = {
    name: 'counter',
    value: 0,
    persistence: {
      version: 1,
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
  it('asks for nothing when no key is configured', () => {
    const h = harness(null);
    snapshot(h);
    expect(h.service.keyed).toBe(false);
    expect(h.service.listRestorePoints(CLIENT, '').refused).toBeUndefined();
  });

  it('refuses a wrong key and accepts the right one', () => {
    const h = harness();
    snapshot(h);
    expect(h.service.listRestorePoints(CLIENT, 'wrong').refused).toBe('badKey');
    expect(h.service.listRestorePoints(CLIENT, KEY).refused).toBeUndefined();
  });

  it('refuses a key that is the right prefix but the wrong length', () => {
    const h = harness();
    expect(h.service.listRestorePoints(CLIENT, KEY.slice(0, -1)).refused).toBe('badKey');
  });

  it('throttles a connection after enough wrong keys, then lets it back in', () => {
    const h = harness();
    snapshot(h);
    for (let attempt = 1; attempt < ROLLBACK_MAX_FAILED_ATTEMPTS; attempt++) {
      expect(h.service.listRestorePoints(CLIENT, 'wrong').refused).toBe('badKey');
    }
    expect(h.service.listRestorePoints(CLIENT, 'wrong').refused).toBe('throttled');
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
    snapshot(h);
    h.world.map.cells[0] = MARKER_HEIGHT;
    h.world.map.cells[1] = MARKER_HEIGHT;
    snapshot(h);

    const list = h.service.listRestorePoints(CLIENT, KEY);
    expect(list.points).toHaveLength(2);
    expect(list.points[0].cellsChanged).toBe(2);
    expect(list.points[0].maxCellDelta).toBe(MARKER_HEIGHT);
    expect(list.points[0].isCurrent).toBe(true);
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

    h.world.map.cells[0] = MARKER_HEIGHT;
    h.plugin.value = 999;

    const result = h.service.rollback(CLIENT, KEY, before);
    expect(result).toMatchObject({ ok: true, toId: before });

    expect(h.world.map.cells[0]).toBe(0);
    expect(h.plugin.value).toBe(1);

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
    expect(store.countSnapshots()).toBe(0);
  });

  it('writes the rewound world to disk immediately', () => {
    const h = harness();
    const target = snapshot(h);
    h.world.map.cells[0] = MARKER_HEIGHT;

    expect(h.service.rollback(CLIENT, KEY, target).ok).toBe(true);

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
    const emptyMasks = h.world.tokenMasks();
    expect(emptyMasks.size).toBe(0);
    h.world.unlockChunkForToken('token-1', 1, 1);
    expect(h.world.isChunkUnlockedForToken('token-1', 1, 1)).toBe(true);

    h.world.rewindTo(h.world.map.cells, h.world.mask, new Map());
    expect(h.world.isChunkUnlockedForToken('token-1', 1, 1)).toBe(false);
  });
});
