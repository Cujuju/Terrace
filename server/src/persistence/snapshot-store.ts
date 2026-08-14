// World persistence: SQLite via better-sqlite3 (design §3.6 — zero-config for
// self-hosters, no server to run alongside).
//
// CRITICAL CODE (persistence path). Acceptance criterion 6 is "kill the server
// process; restart; the world comes back from SQLite intact", so the guarantees
// here are: a snapshot is written atomically (one transaction covering the
// heightmap, the mask and every plugin slice), it is versioned, and a snapshot
// this build cannot read is refused loudly instead of being partially applied.
//
// Cadence and retention are decided (open question 4, 2026-08-13): every
// SNAPSHOT_INTERVAL_S but only if the world changed, keep the last 10, plus one
// on clean shutdown. This file owns the retention half; the scheduler in
// index.ts owns the cadence half.

import DatabaseConstructor, { type Database, type Statement } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeHeights, encodeHeights } from './codec.ts';

/**
 * Bumped whenever the stored layout changes in a way this reader cannot
 * interpret. There are no migrations yet: a snapshot from a future (or
 * incompatible past) version is refused rather than guessed at.
 *
 * DELIBERATELY NOT BUMPED for the `world_name` column added 2026-08-14. The
 * version guard exists to stop a reader from misinterpreting a row it cannot
 * understand, and this column is compatible in BOTH directions: this build
 * reads a row without one as an unnamed world (and names it), and an older
 * build's `SELECT *` simply ignores a column it never asks for. Bumping would
 * turn a purely additive column into a refusal to boot — i.e. into a
 * self-hoster losing their world over a string.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Rolling history depth. 10 at the default 60 s cadence is ten minutes of
 * undo-by-hand for a self-hoster whose world was wrecked, at ~512 KB each for a
 * 512² world (~5 MB total) — cheap enough to keep, deep enough to be useful.
 */
export const SNAPSHOT_RETENTION = 10;

/** better-sqlite3's in-memory database path; used by tests. */
export const IN_MEMORY_DB_PATH = ':memory:';

export interface SnapshotInput {
  readonly worldSize: number;
  /** The world's name. A writer always knows it — see World.name. */
  readonly name: string;
  readonly cells: Int16Array;
  readonly mask: Uint8Array;
  readonly pluginSlices: Record<string, unknown>;
}

export interface WorldSnapshot extends Omit<SnapshotInput, 'name'> {
  readonly id: number;
  readonly createdAt: number;
  /**
   * The stored name, or null for a row written before worlds had names. The
   * asymmetry against SnapshotInput is the point: only a READER can encounter
   * a nameless world, and World.restore is what names it.
   */
  readonly name: string | null;
}

interface SnapshotRow {
  id: number;
  schema_version: number;
  created_at: number;
  world_size: number;
  world_name: string | null;
  heightmap: Uint8Array;
  mask: Uint8Array;
}

interface SliceRow {
  plugin: string;
  data: string;
}

/**
 * Name of the additive column introduced with world names (2026-08-14).
 * NULLABLE, and it has to be: SQLite cannot add a NOT NULL column without a
 * default to a table that already has rows, and there is no honest default for
 * "what was this world called" — null means "nobody has named it yet".
 */
const WORLD_NAME_COLUMN = 'world_name';

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    world_size     INTEGER NOT NULL,
    ${WORLD_NAME_COLUMN} TEXT,
    heightmap      BLOB    NOT NULL,
    mask           BLOB    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugin_slices (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    plugin      TEXT    NOT NULL,
    data        TEXT    NOT NULL,
    PRIMARY KEY (snapshot_id, plugin)
  );
`;

/**
 * Adds the world-name column to a database created before it existed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so the DDL
 * above only names the column on FRESH databases — every self-hoster who
 * already has a `world.db` needs this. Idempotent by inspection
 * (`PRAGMA table_info`) rather than by catching the duplicate-column error,
 * because a swallowed exception here would hide a real schema problem behind
 * the same silence.
 */
function addWorldNameColumnIfMissing(db: Database): void {
  const columns = db.pragma('table_info(snapshots)') as { name: string }[];
  if (columns.some((column) => column.name === WORLD_NAME_COLUMN)) return;
  db.exec(`ALTER TABLE snapshots ADD COLUMN ${WORLD_NAME_COLUMN} TEXT`);
}

export class SnapshotStore {
  private readonly db: Database;
  private readonly insertSnapshot: Statement;
  private readonly insertSlice: Statement;
  private readonly selectLatest: Statement;
  private readonly selectSlices: Statement;
  private readonly pruneOld: Statement;
  private readonly countAll: Statement;

  private constructor(db: Database) {
    this.db = db;
    this.insertSnapshot = db.prepare(
      `INSERT INTO snapshots
         (schema_version, created_at, world_size, ${WORLD_NAME_COLUMN}, heightmap, mask)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.insertSlice = db.prepare(
      'INSERT INTO plugin_slices (snapshot_id, plugin, data) VALUES (?, ?, ?)',
    );
    this.selectLatest = db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1');
    this.selectSlices = db.prepare(
      'SELECT plugin, data FROM plugin_slices WHERE snapshot_id = ?',
    );
    // Keep the newest N rows; ON DELETE CASCADE removes their slices.
    this.pruneOld = db.prepare(
      'DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)',
    );
    this.countAll = db.prepare('SELECT COUNT(*) AS n FROM snapshots');
  }

  /**
   * Opens (creating if needed) the world database. The parent directory is
   * created too: `DB_PATH=./data/world.db` must work on a fresh clone where
   * `data/` is gitignored and therefore absent.
   */
  static open(dbPath: string): SnapshotStore {
    if (dbPath !== IN_MEMORY_DB_PATH) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseConstructor(dbPath);
    // WAL keeps the periodic snapshot write from blocking readers, and survives
    // an unclean kill better than the rollback journal.
    db.pragma('journal_mode = WAL');
    // Required for the plugin_slices cascade — SQLite defaults it off.
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_DDL);
    addWorldNameColumnIfMissing(db);
    return new SnapshotStore(db);
  }

  /**
   * Writes one snapshot and prunes the history, in a single transaction: a
   * crash mid-write leaves the previous snapshot as the newest, never a half
   * world. Returns the new snapshot's id.
   */
  saveSnapshot(input: SnapshotInput): number {
    const heightmap = encodeHeights(input.cells);
    const mask = Buffer.copyBytesFrom(input.mask);
    const entries = Object.entries(input.pluginSlices);

    const write = this.db.transaction((): number => {
      const result = this.insertSnapshot.run(
        SNAPSHOT_SCHEMA_VERSION,
        Date.now(),
        input.worldSize,
        input.name,
        heightmap,
        mask,
      );
      const snapshotId = Number(result.lastInsertRowid);
      for (const [plugin, data] of entries) {
        // JSON, not a binary encoding: plugin slices are small, and a
        // human-readable column is worth a lot when debugging someone else's
        // plugin from a self-hoster's database.
        this.insertSlice.run(snapshotId, plugin, JSON.stringify(data));
      }
      this.pruneOld.run(SNAPSHOT_RETENTION);
      return snapshotId;
    });

    return write();
  }

  /**
   * Loads the most recent snapshot, or null on a fresh database.
   *
   * Refuses (throws) a snapshot written by an incompatible schema version. The
   * alternative — starting a fresh world — would silently destroy a
   * self-hoster's map, so an unreadable database must stop the boot and say so.
   */
  loadLatest(): WorldSnapshot | null {
    const row = this.selectLatest.get() as SnapshotRow | undefined;
    if (row === undefined) return null;

    if (row.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `snapshot #${row.id} has schema version ${row.schema_version}, this server reads ` +
          `version ${SNAPSHOT_SCHEMA_VERSION}; refusing to start rather than overwrite the world`,
      );
    }

    const cells = decodeHeights(row.heightmap, row.world_size * row.world_size);
    const mask = new Uint8Array(row.mask.byteLength);
    mask.set(row.mask);

    const pluginSlices: Record<string, unknown> = {};
    for (const slice of this.selectSlices.all(row.id) as SliceRow[]) {
      pluginSlices[slice.plugin] = JSON.parse(slice.data);
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      worldSize: row.world_size,
      // `?? null` covers a row written before the column existed AND a row
      // written by a build that stored nothing in it; both mean "unnamed".
      name: row.world_name ?? null,
      cells,
      mask,
      pluginSlices,
    };
  }

  /** Number of retained snapshots; used by the retention test. */
  countSnapshots(): number {
    return (this.countAll.get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
