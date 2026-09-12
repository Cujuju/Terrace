import {
  isValidHeight,
  LEGACY_MIN_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  type RestorePoint,
} from '@terrace/shared';
import DatabaseConstructor, { type Database, type Statement } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logWarn } from '../log.ts';
import { buildThumbnail } from './thumbnail.ts';
import type { Span } from '@terrace/shared';
import {
  decodeColumnSpans,
  decodeHeights,
  encodeColumnSpans,
  encodeHeights,
} from './codec.ts';
import {
  copyColumnSpans,
  copyTokenMasks,
  snapshotWriterThread,
  type SnapshotSettledCallback,
  type SnapshotWriterThread,
} from './snapshot-writer.ts';
import { timePhase } from '../tick-timing.ts';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export const SNAPSHOT_RETENTION = 10;

export const IN_MEMORY_DB_PATH = ':memory:';

export interface SnapshotInput {
  readonly worldSize: number;
  readonly name: string;
  readonly cells: Int16Array;
  readonly mask: Uint8Array;
  readonly pluginSlices: Record<string, unknown>;
  readonly tokenMasks?: ReadonlyMap<string, Uint8Array>;
  readonly simMillis?: number;
  readonly genesisMillis?: number;
  readonly thumbnail?: Uint8Array;
  readonly columnSpans?: ReadonlyMap<number, Int16Array>;
}

export interface WorldSnapshot
  extends Omit<SnapshotInput, 'name' | 'tokenMasks' | 'genesisMillis' | 'columnSpans'> {
  readonly id: number;
  readonly createdAt: number;
  readonly name: string | null;
  readonly tokenMasks: ReadonlyMap<string, Uint8Array>;
  readonly simMillis: number;
  readonly genesisMillis: number | null;
  readonly columnSpans: ReadonlyMap<number, Span[]>;
}

interface SnapshotRow {
  id: number;
  schema_version: number;
  created_at: number;
  world_size: number;
  world_name: string | null;
  pinned: number;
  sim_millis: number;
  genesis_millis: number | null;
  heightmap: Uint8Array;
  mask: Uint8Array;
  column_spans: Uint8Array | null;
}

interface SliceRow {
  plugin: string;
  data: string;
}

interface HistoryRow {
  id: number;
  created_at: number;
  world_size: number;
  pinned: number;
  heightmap: Uint8Array;
}

interface TokenMaskRow {
  token: string;
  mask: Uint8Array;
}

const WORLD_NAME_COLUMN = 'world_name';

const PINNED_COLUMN = 'pinned';

const THUMBNAIL_COLUMN = 'thumbnail';

const SIM_MILLIS_COLUMN = 'sim_millis';

const GENESIS_MILLIS_COLUMN = 'genesis_millis';

const COLUMN_SPANS_COLUMN = 'column_spans';

const TOKEN_MASKS_DDL = `
  CREATE TABLE IF NOT EXISTS token_masks (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    token       TEXT    NOT NULL,
    mask        BLOB    NOT NULL,
    PRIMARY KEY (snapshot_id, token)
  );
`;

const DISABLED_PLUGINS_DDL = `
  CREATE TABLE IF NOT EXISTS disabled_plugins (
    plugin TEXT NOT NULL PRIMARY KEY
  );
`;

export interface PluginSettingRow {
  readonly plugin: string;
  readonly key: string;
  readonly value: string;
}

const PLUGIN_SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS plugin_settings (
    plugin TEXT NOT NULL,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL,
    PRIMARY KEY (plugin, key)
  );
`;

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    world_size     INTEGER NOT NULL,
    ${WORLD_NAME_COLUMN} TEXT,
    ${PINNED_COLUMN}     INTEGER NOT NULL DEFAULT 0,
    ${THUMBNAIL_COLUMN}  BLOB,
    ${SIM_MILLIS_COLUMN} INTEGER NOT NULL DEFAULT 0,
    ${GENESIS_MILLIS_COLUMN} INTEGER,
    ${COLUMN_SPANS_COLUMN} BLOB,
    heightmap      BLOB    NOT NULL,
    mask           BLOB    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugin_slices (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    plugin      TEXT    NOT NULL,
    data        TEXT    NOT NULL,
    PRIMARY KEY (snapshot_id, plugin)
  );

  ${TOKEN_MASKS_DDL}

  ${DISABLED_PLUGINS_DDL}

  ${PLUGIN_SETTINGS_DDL}
`;

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (columns.some((existing) => existing.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export interface SnapshotWriteStatements {
  readonly insertSnapshot: Statement;
  readonly insertSlice: Statement;
  readonly insertTokenMask: Statement;
  readonly pruneOld: Statement;
}

export interface SnapshotWritePayload {
  readonly worldSize: number;
  readonly name: string;
  readonly cells: Int16Array;
  readonly mask: Uint8Array;
  readonly columnSpans?: ReadonlyMap<number, Int16Array> | undefined;
  readonly slicesJson: readonly (readonly [string, string])[];
  readonly tokenMasks?: ReadonlyMap<string, Uint8Array> | undefined;
  readonly simMillis?: number | undefined;
  readonly genesisMillis?: number | undefined;
  readonly thumbnail?: Uint8Array | undefined;
}

export function prepareSnapshotWriteStatements(db: Database): SnapshotWriteStatements {
  return {
    insertSnapshot: db.prepare(
      `INSERT INTO snapshots
         (schema_version, created_at, world_size, ${WORLD_NAME_COLUMN}, heightmap, mask,
          ${THUMBNAIL_COLUMN}, ${SIM_MILLIS_COLUMN}, ${GENESIS_MILLIS_COLUMN},
          ${COLUMN_SPANS_COLUMN})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertSlice: db.prepare(
      'INSERT INTO plugin_slices (snapshot_id, plugin, data) VALUES (?, ?, ?)',
    ),
    insertTokenMask: db.prepare(
      'INSERT INTO token_masks (snapshot_id, token, mask) VALUES (?, ?, ?)',
    ),
    pruneOld: db.prepare(
      `DELETE FROM snapshots
         WHERE ${PINNED_COLUMN} = 0
           AND id NOT IN (
             SELECT id FROM snapshots WHERE ${PINNED_COLUMN} = 0 ORDER BY id DESC LIMIT ?
           )`,
    ),
  };
}

export function writeSnapshot(
  db: Database,
  statements: SnapshotWriteStatements,
  retention: number,
  payload: SnapshotWritePayload,
): number {
  const heightmap = encodeHeights(payload.cells);
  const mask = Buffer.copyBytesFrom(payload.mask);
  const columnSpansBlob =
    payload.columnSpans === undefined ? null : encodeColumnSpans(payload.columnSpans);
  const tokenMaskEntries = payload.tokenMasks ?? [];

  const write = db.transaction((): number => {
    const result = statements.insertSnapshot.run(
      SNAPSHOT_SCHEMA_VERSION,
      Date.now(),
      payload.worldSize,
      payload.name,
      heightmap,
      mask,
      payload.thumbnail === undefined ? null : Buffer.copyBytesFrom(payload.thumbnail),
      payload.simMillis ?? 0,
      payload.genesisMillis ?? null,
      columnSpansBlob,
    );
    const snapshotId = Number(result.lastInsertRowid);
    for (const [plugin, json] of payload.slicesJson) {
      statements.insertSlice.run(snapshotId, plugin, json);
    }
    for (const [token, tokenMask] of tokenMaskEntries) {
      statements.insertTokenMask.run(snapshotId, token, Buffer.copyBytesFrom(tokenMask));
    }
    statements.pruneOld.run(retention);
    return snapshotId;
  });

  return write();
}

export function snapshotWritePayloadOf(input: SnapshotInput): SnapshotWritePayload {
  return {
    worldSize: input.worldSize,
    name: input.name,
    cells: input.cells,
    mask: input.mask,
    columnSpans: input.columnSpans,
    slicesJson: Object.entries(input.pluginSlices).map(
      ([plugin, data]) => [plugin, JSON.stringify(data)] as const,
    ),
    tokenMasks: input.tokenMasks,
    simMillis: input.simMillis,
    genesisMillis: input.genesisMillis,
    thumbnail: input.thumbnail,
  };
}

export class SnapshotStore {
  private readonly db: Database;
  private readonly dbPath: string;
  private deferredWriter: SnapshotWriterThread | null = null;
  private readonly writeStatements: SnapshotWriteStatements;
  private readonly selectLatest: Statement;
  private readonly selectSlices: Statement;
  private readonly selectTokenMasks: Statement;
  private readonly countAll: Statement;
  private readonly selectById: Statement;
  private readonly selectHistory: Statement;
  private readonly setPinnedStatement: Statement;
  private readonly setWorldNameStatement: Statement;
  private readonly selectLatestThumbnail: Statement;
  private readonly setLatestThumbnailStatement: Statement;
  private readonly countPinnedStatement: Statement;
  private readonly selectDisabledPlugins: Statement;
  private readonly insertDisabledPlugin: Statement;
  private readonly deleteDisabledPlugin: Statement;
  private readonly selectPluginSettings: Statement;
  private readonly selectPluginSetting: Statement;
  private readonly upsertPluginSetting: Statement;

  private readonly retention: number;

  private constructor(db: Database, retention: number, dbPath: string) {
    this.db = db;
    this.retention = retention;
    this.dbPath = dbPath;
    this.writeStatements = prepareSnapshotWriteStatements(db);
    this.selectLatest = db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1');
    this.selectById = db.prepare('SELECT * FROM snapshots WHERE id = ?');
    this.selectHistory = db.prepare(
      `SELECT id, created_at, world_size, ${PINNED_COLUMN}, heightmap
         FROM snapshots ORDER BY id ASC`,
    );
    this.selectSlices = db.prepare(
      'SELECT plugin, data FROM plugin_slices WHERE snapshot_id = ?',
    );
    this.selectTokenMasks = db.prepare(
      'SELECT token, mask FROM token_masks WHERE snapshot_id = ?',
    );
    this.selectLatestThumbnail = db.prepare(
      `SELECT ${THUMBNAIL_COLUMN} AS thumbnail FROM snapshots ORDER BY id DESC LIMIT 1`,
    );
    this.setLatestThumbnailStatement = db.prepare(
      `UPDATE snapshots SET ${THUMBNAIL_COLUMN} = ?
         WHERE id = (SELECT id FROM snapshots ORDER BY id DESC LIMIT 1)`,
    );
    this.setWorldNameStatement = db.prepare(
      `UPDATE snapshots SET ${WORLD_NAME_COLUMN} = ?`,
    );
    this.setPinnedStatement = db.prepare(
      `UPDATE snapshots SET ${PINNED_COLUMN} = ? WHERE id = ?`,
    );
    this.countPinnedStatement = db.prepare(
      `SELECT COUNT(*) AS n FROM snapshots WHERE ${PINNED_COLUMN} = 1`,
    );
    this.countAll = db.prepare('SELECT COUNT(*) AS n FROM snapshots');
    this.selectDisabledPlugins = db.prepare('SELECT plugin FROM disabled_plugins');
    this.insertDisabledPlugin = db.prepare(
      'INSERT OR IGNORE INTO disabled_plugins (plugin) VALUES (?)',
    );
    this.deleteDisabledPlugin = db.prepare('DELETE FROM disabled_plugins WHERE plugin = ?');
    this.selectPluginSettings = db.prepare(
      'SELECT plugin, key, value FROM plugin_settings ORDER BY plugin ASC, key ASC',
    );
    this.selectPluginSetting = db.prepare(
      'SELECT value FROM plugin_settings WHERE plugin = ? AND key = ?',
    );
    this.upsertPluginSetting = db.prepare(
      `INSERT INTO plugin_settings (plugin, key, value) VALUES (?, ?, ?)
         ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value`,
    );
  }

  static open(dbPath: string, retention: number = SNAPSHOT_RETENTION): SnapshotStore {
    if (dbPath !== IN_MEMORY_DB_PATH) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseConstructor(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_DDL);
    addColumnIfMissing(db, 'snapshots', WORLD_NAME_COLUMN, 'TEXT');
    addColumnIfMissing(db, 'snapshots', PINNED_COLUMN, 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'snapshots', THUMBNAIL_COLUMN, 'BLOB');
    addColumnIfMissing(db, 'snapshots', SIM_MILLIS_COLUMN, 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'snapshots', GENESIS_MILLIS_COLUMN, 'INTEGER');
    addColumnIfMissing(db, 'snapshots', COLUMN_SPANS_COLUMN, 'BLOB');
    return new SnapshotStore(db, retention, dbPath);
  }

  saveSnapshot(input: SnapshotInput): number {
    this.settle();
    return timePhase('store.write', () =>
      writeSnapshot(this.db, this.writeStatements, this.retention, snapshotWritePayloadOf(input)),
    );
  }

  saveSnapshotDeferred(
    input: Omit<SnapshotInput, 'thumbnail'>,
    onSettled?: SnapshotSettledCallback,
  ): void {
    const writer = this.writer();
    if (writer === null) {
      try {
        this.saveSnapshot({
          ...input,
          thumbnail: buildThumbnail(input.cells, input.worldSize),
        });
        onSettled?.(null);
      } catch (error) {
        onSettled?.(error instanceof Error ? error.message : String(error));
        throw error;
      }
      return;
    }
    const cells = writer.scratchHeights(input.cells.length);
    cells.set(input.cells);
    writer.enqueue(
      this.dbPath,
      this.retention,
      {
        worldSize: input.worldSize,
        name: input.name,
        cells,
        mask: input.mask.slice(),
        columnSpans: copyColumnSpans(input.columnSpans),
        slicesJson: snapshotWritePayloadOf(input).slicesJson,
        tokenMasks: copyTokenMasks(input.tokenMasks),
        simMillis: input.simMillis,
        genesisMillis: input.genesisMillis,
      },
      onSettled,
    );
  }

  loadLatest(): WorldSnapshot | null {
    this.settle();
    return this.hydrate(this.selectLatest.get() as SnapshotRow | undefined);
  }

  loadSnapshot(id: number): WorldSnapshot | null {
    this.settle();
    return this.hydrate(this.selectById.get(id) as SnapshotRow | undefined);
  }

  private hydrate(row: SnapshotRow | undefined): WorldSnapshot | null {
    if (row === undefined) return null;

    if (row.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `snapshot #${row.id} has schema version ${row.schema_version}, this server reads ` +
          `version ${SNAPSHOT_SCHEMA_VERSION}; refusing to start rather than overwrite the world`,
      );
    }

    const cells = decodeHeights(row.heightmap, row.world_size * row.world_size);
    let migrated = 0;
    let deepestMigrated = 0;
    for (let i = 0; i < cells.length; i++) {
      const h = cells[i];
      if (isValidHeight(h)) continue;
      if (Number.isInteger(h) && h >= LEGACY_MIN_HEIGHT && h < MIN_HEIGHT) {
        if (h < deepestMigrated) deepestMigrated = h;
        cells[i] = MIN_HEIGHT;
        migrated++;
        continue;
      }
      throw new Error(
        `snapshot #${row.id} heightmap cell ${i} has height ${h}, expected an ` +
          `integer in [${MIN_HEIGHT}, ${MAX_HEIGHT}]; refusing to restore a corrupt world`,
      );
    }
    if (migrated > 0) {
      logWarn(
        `snapshot #${row.id}: raised ${migrated} cell(s) from as deep as ${deepestMigrated} ` +
          `to the world floor ${MIN_HEIGHT} (saved against the older ${LEGACY_MIN_HEIGHT} floor)`,
      );
    }
    const mask = new Uint8Array(row.mask.byteLength);
    mask.set(row.mask);

    let columnSpans: Map<number, Span[]> = new Map();
    if (row.column_spans !== null) {
      columnSpans = decodeColumnSpans(
        row.column_spans,
        row.world_size * row.world_size,
        `snapshot #${row.id}`,
      );
      for (const [cellIndex, spans] of columnSpans) {
        const topCeiling = spans[spans.length - 1]!.ceiling;
        if (cells[cellIndex] !== topCeiling) {
          throw new Error(
            `snapshot #${row.id} span table says cell ${cellIndex}'s top ceiling is ` +
              `${topCeiling}, heightmap says ${cells[cellIndex]}; refusing to restore a corrupt world`,
          );
        }
      }
    }

    const pluginSlices: Record<string, unknown> = {};
    for (const slice of this.selectSlices.all(row.id) as SliceRow[]) {
      pluginSlices[slice.plugin] = JSON.parse(slice.data);
    }

    const tokenMasks = new Map<string, Uint8Array>();
    for (const maskRow of this.selectTokenMasks.all(row.id) as TokenMaskRow[]) {
      const copy = new Uint8Array(maskRow.mask.byteLength);
      copy.set(maskRow.mask);
      tokenMasks.set(maskRow.token, copy);
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      worldSize: row.world_size,
      name: row.world_name ?? null,
      simMillis: row.sim_millis ?? 0,
      genesisMillis: row.genesis_millis ?? null,
      tokenMasks,
      cells,
      mask,
      columnSpans,
      pluginSlices,
    };
  }

  listRestorePoints(): RestorePoint[] {
    this.settle();
    const rows = this.selectHistory.all() as HistoryRow[];
    const points: RestorePoint[] = [];
    let previous: Int16Array | null = null;

    for (const row of rows) {
      const expectedCells = row.world_size * row.world_size;
      let current: Int16Array | null = null;
      try {
        current = decodeHeights(row.heightmap, expectedCells);
      } catch {
        current = null;
      }

      const comparable =
        current !== null && previous !== null && current.length === previous.length;

      let cellsChanged: number | null = null;
      let maxCellDelta: number | null = null;
      if (comparable && current !== null && previous !== null) {
        let changed = 0;
        let maxDelta = 0;
        for (let i = 0; i < current.length; i++) {
          const delta = Math.abs(current[i] - previous[i]);
          if (delta === 0) continue;
          changed++;
          if (delta > maxDelta) maxDelta = delta;
        }
        cellsChanged = changed;
        maxCellDelta = maxDelta;
      }

      points.push({
        id: row.id,
        createdAt: row.created_at,
        cellsChanged,
        maxCellDelta,
        pinned: row.pinned !== 0,
        isCurrent: false,
      });
      if (current !== null) previous = current;
    }

    if (points.length > 0) points[points.length - 1].isCurrent = true;
    return points.reverse();
  }

  latestThumbnail(): Buffer | null {
    this.settle();
    const row = this.selectLatestThumbnail.get() as { thumbnail: Buffer | null } | undefined;
    return row?.thumbnail ?? null;
  }

  setLatestThumbnail(thumbnail: Uint8Array): boolean {
    this.settle();
    return this.setLatestThumbnailStatement.run(Buffer.copyBytesFrom(thumbnail)).changes > 0;
  }

  setWorldName(name: string): number {
    this.settle();
    return this.setWorldNameStatement.run(name).changes;
  }

  setPinned(id: number, pinned: boolean): boolean {
    this.settle();
    const result = this.setPinnedStatement.run(pinned ? 1 : 0, id);
    return result.changes > 0;
  }

  disabledPlugins(): string[] {
    this.settle();
    return (this.selectDisabledPlugins.all() as { plugin: string }[]).map((row) => row.plugin);
  }

  pluginSettings(): PluginSettingRow[] {
    this.settle();
    return this.selectPluginSettings.all() as PluginSettingRow[];
  }

  pluginSetting(plugin: string, key: string): string | undefined {
    this.settle();
    const row = this.selectPluginSetting.get(plugin, key) as { value: string } | undefined;
    return row?.value;
  }

  setPluginSetting(plugin: string, key: string, value: string): void {
    this.settle();
    this.upsertPluginSetting.run(plugin, key, value);
  }

  setPluginEnabled(plugin: string, enabled: boolean): void {
    this.settle();
    if (enabled) this.deleteDisabledPlugin.run(plugin);
    else this.insertDisabledPlugin.run(plugin);
  }

  countPinned(): number {
    this.settle();
    return (this.countPinnedStatement.get() as { n: number }).n;
  }

  countSnapshots(): number {
    this.settle();
    return (this.countAll.get() as { n: number }).n;
  }

  checkpoint(): void {
    this.settle();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.settle();
    if (this.deferredWriter !== null) this.deferredWriter.closeDatabase(this.dbPath);
    this.db.close();
  }

  private settle(): void {
    if (this.deferredWriter === null) return;
    const writer = this.deferredWriter;
    timePhase('store.settle', () => writer.settle());
  }

  private writer(): SnapshotWriterThread | null {
    if (this.dbPath === IN_MEMORY_DB_PATH) return null;
    if (this.deferredWriter !== null && !this.deferredWriter.alive) return null;
    this.deferredWriter ??= snapshotWriterThread();
    return this.deferredWriter;
  }
}
