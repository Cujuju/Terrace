import DatabaseConstructor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_WRITTEN_COLUMNS,
  SnapshotStore,
} from '../src/persistence/snapshot-store.ts';
import { carveArchFixture } from '../src/world/arch-fixture.ts';
import { worldWithUnlockedChunks } from './support/harness.ts';

const WORLD_SIZE = 64;
const SEEDED_SNAPSHOTS = 2;
const REFUSAL_EXIT_CODE = 1;

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(SERVER_DIR, 'scripts', 'merge-world-history.ts');

let dir: string;
let fromPath: string;
let intoPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'terrace-merge-'));
  fromPath = join(dir, 'from.db');
  intoPath = join(dir, 'into.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `into.db`: two snapshots of a world whose arch fixture leaves real layered columns. */
function seedInto(): number {
  const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
  const layered = carveArchFixture(world.map);
  const store = SnapshotStore.open(intoPath);
  for (let i = 0; i < SEEDED_SNAPSHOTS; i++) {
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
      columnSpans: world.spansForPersistence(),
    });
  }
  store.close();
  return layered;
}

/** A byte copy of `into.db` with one column dropped and a snapshot the target lacks. */
function seedFromWithout(column: string): void {
  copyFileSync(intoPath, fromPath);
  const raw = new DatabaseConstructor(fromPath);
  raw.exec(`ALTER TABLE snapshots DROP COLUMN ${column}`);
  const carried = SNAPSHOT_WRITTEN_COLUMNS.filter((name) => name !== column);
  raw
    .prepare(
      `INSERT INTO snapshots (${carried.join(', ')})
       SELECT ${carried.join(', ')} FROM snapshots ORDER BY id DESC LIMIT 1`,
    )
    .run();
  raw.close();
}

function snapshotIds(path: string): number[] {
  const raw = new DatabaseConstructor(path, { readonly: true });
  try {
    return (raw.prepare('SELECT id FROM snapshots ORDER BY id').all() as { id: number }[]).map(
      (row) => row.id,
    );
  } finally {
    raw.close();
  }
}

function runMerge(): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, fromPath, intoPath], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('merge-world-history', () => {
  it('refuses a source missing a column the target holds, and writes nothing', () => {
    const layered = seedInto();
    expect(layered).toBeGreaterThan(0);
    const before = snapshotIds(intoPath);
    expect(before).toHaveLength(SEEDED_SNAPSHOTS);

    seedFromWithout('column_spans');
    expect(snapshotIds(fromPath)).toHaveLength(SEEDED_SNAPSHOTS + 1);

    const { status, output } = runMerge();
    expect(status).toBe(REFUSAL_EXIT_CODE);
    expect(output).toContain('column_spans');
    expect(output).not.toContain('merged 1 snapshot');
    expect(snapshotIds(intoPath)).toEqual(before);

    const store = SnapshotStore.open(intoPath);
    expect(store.loadLatest()?.columnSpans.size).toBe(layered);
    store.close();
  });

  it('merges a snapshot the target lacks when both files hold the same columns', () => {
    seedInto();
    copyFileSync(intoPath, fromPath);
    const raw = new DatabaseConstructor(fromPath);
    const carried = SNAPSHOT_WRITTEN_COLUMNS.join(', ');
    raw
      .prepare(
        `INSERT INTO snapshots (${carried})
         SELECT ${carried} FROM snapshots ORDER BY id DESC LIMIT 1`,
      )
      .run();
    raw.close();

    const { status, output } = runMerge();
    expect(status).toBe(0);
    expect(output).toContain('merged 1 snapshot');
    expect(snapshotIds(intoPath)).toEqual([1, 2, 3]);

    const store = SnapshotStore.open(intoPath);
    const merged = store.loadSnapshot(3);
    expect(merged?.columnSpans.size).toBe(store.loadSnapshot(2)?.columnSpans.size);
    store.close();
  });

  it('writes every column the current schema fills', () => {
    seedInto();
    const raw = new DatabaseConstructor(intoPath, { readonly: true });
    const onDisk = (raw.pragma('table_info(snapshots)') as { name: string }[]).map((c) => c.name);
    const row = raw.prepare('SELECT * FROM snapshots ORDER BY id LIMIT 1').get() as Record<
      string,
      unknown
    >;
    raw.close();

    for (const column of SNAPSHOT_WRITTEN_COLUMNS) expect(onDisk).toContain(column);
    expect(row['schema_version']).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(row['column_spans']).not.toBeNull();
  });
});
