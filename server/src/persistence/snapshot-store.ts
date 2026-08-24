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
 * DEFAULT rolling history depth. 10 at the default 60 s cadence is ten minutes
 * of undo-by-hand for a self-hoster whose world was wrecked, at ~512 KB each
 * for a 512² world (~5 MB total) — cheap enough to keep, deep enough to be
 * useful.
 *
 * NOW A DEFAULT RATHER THAN THE POLICY (2026-08-21, world rollback). The
 * original decision (open question 4, 2026-08-13) is unchanged and still the
 * default; what changed is that a self-hoster can now SEE this history in the
 * game and restore from it, which makes its depth something they have an
 * opinion about. SNAPSHOT_RETENTION in the environment moves it — see
 * config.ts, and MAX_SNAPSHOT_RETENTION for the ceiling and why there is one.
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
  /**
   * Per-player unlock masks, keyed by token (issue #17 — see the TOKEN_MASKS
   * TABLE comment below for the format and why it is its own table). OPTIONAL
   * and additive, following the same pattern as `world_name` before it: a
   * caller that has never touched per-token unlocks (most of this file's
   * existing tests) simply omits it, and an omitted map persists as "nothing
   * to write" rather than as a type error every pre-existing call site would
   * otherwise need fixing for.
   */
  readonly tokenMasks?: ReadonlyMap<string, Uint8Array>;
  /**
   * The world clock at write time, in milliseconds (World.simMillis).
   *
   * OPTIONAL and additive, following tokenMasks: a caller that does not track
   * it (every existing test) omits it and the column stores 0, which reads
   * back as a world whose calendar starts at its next boot.
   */
  readonly simMillis?: number;
  /**
   * The world clock at this world's GENESIS, in milliseconds
   * (World.genesisMillis) — the world's birthday, not its age.
   *
   * OPTIONAL and additive like `simMillis` above, and NULLABLE unlike it:
   * since the clock became a function of real time, 0 is a legitimate genesis
   * (a world born at the epoch) and so cannot also mean "unknown". An omitted
   * genesis stores NULL, and World.anchorClockToRealTime reconstructs one from
   * the row's `simMillis`, which on any pre-genesis row is the world's age.
   */
  readonly genesisMillis?: number;
  /**
   * A top-down picture of this world for the worlds panel — see
   * persistence/thumbnail.ts. OPTIONAL and additive, following tokenMasks:
   * a caller that does not produce one (every existing test) simply omits it,
   * and the column stays null.
   */
  readonly thumbnail?: Uint8Array;
}

// `genesisMillis` is omitted and redeclared below for the same reason `name`
// is: the writer's field is optional (`number | undefined`), the reader's is
// `number | null`, and only a reader can meet a row that predates the column.
export interface WorldSnapshot
  extends Omit<SnapshotInput, 'name' | 'tokenMasks' | 'genesisMillis'> {
  readonly id: number;
  readonly createdAt: number;
  /**
   * The stored name, or null for a row written before worlds had names. The
   * asymmetry against SnapshotInput is the point: only a READER can encounter
   * a nameless world, and World.restore is what names it.
   */
  readonly name: string | null;
  /**
   * Per-token unlock masks recorded against this snapshot. ALWAYS PRESENT on
   * a read (unlike SnapshotInput's optional field) — a legacy snapshot or one
   * that simply had no per-token state yet reads back as an EMPTY map, never
   * undefined, so World.restore's own default parameter is the only place
   * "no per-token history" has to be spelled out.
   */
  readonly tokenMasks: ReadonlyMap<string, Uint8Array>;
  /** The world clock this snapshot recorded, ms; 0 for a pre-clock row. */
  readonly simMillis: number;
  /**
   * The genesis this snapshot recorded, ms, or null for a row written before
   * the world clock was anchored to real time. NULL SURVIVES TO THE READER
   * rather than being defaulted here, because only World.anchorClockToRealTime
   * has the second half of the answer (the row's `simMillis`, i.e. the age) —
   * defaulting it to 0 here would silently date every legacy world to the
   * epoch and restart its saga's day numbering.
   */
  readonly genesisMillis: number | null;
}

interface SnapshotRow {
  id: number;
  schema_version: number;
  created_at: number;
  world_size: number;
  world_name: string | null;
  /** SQLite has no boolean: 0 or 1. See PINNED_COLUMN. */
  pinned: number;
  /** World clock at write time, ms. 0 in a row written before the column. */
  sim_millis: number;
  /** World clock at genesis, ms. NULL in a row written before the column. */
  genesis_millis: number | null;
  heightmap: Uint8Array;
  mask: Uint8Array;
}

interface SliceRow {
  plugin: string;
  data: string;
}

/** The columns listRestorePoints needs — deliberately not `SELECT *`: the mask
 * and the plugin slices are megabytes it never reads. */
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

/**
 * Name of the additive column introduced with world names (2026-08-14).
 * NULLABLE, and it has to be: SQLite cannot add a NOT NULL column without a
 * default to a table that already has rows, and there is no honest default for
 * "what was this world called" — null means "nobody has named it yet".
 */
const WORLD_NAME_COLUMN = 'world_name';

/**
 * Name of the additive column introduced with PINNED RESTORE POINTS
 * (2026-08-22). 0 = ordinary, prunable; 1 = pinned, and therefore exempt from
 * retention forever.
 *
 * WHY PINNING EXISTS. Retention is a rolling window, which means every restore
 * point is on its way to being deleted — the newest ten are simply the ones
 * that have not got there yet. That is right for an undo buffer and wrong for
 * a moment you want to keep, so a pinned point is removed from the window
 * entirely: it survives however much play happens after it, until a human
 * unpins it. Retention then counts only UNPINNED rows, so pinning something
 * never costs you undo depth (see the pruneOld statement).
 *
 * NOT NULL DEFAULT 0 is safe on an ALTER for an existing table — unlike
 * world_name, a boolean HAS an honest default: a restore point written before
 * pinning existed was, in fact, not pinned.
 */
const PINNED_COLUMN = 'pinned';

/**
 * Name of the additive column holding the world's THUMBNAIL (2026-08-22): a
 * 64² grid of band bytes, ~4 KB, so the worlds panel can show what each world
 * looks like without decoding a megabyte of heightmap per row.
 *
 * NULLABLE, like world_name and unlike pinned: there is no honest default
 * picture of a world nobody has rendered yet, and "not drawn" has to be
 * distinguishable from "drawn, and empty". See persistence/thumbnail.ts.
 */
const THUMBNAIL_COLUMN = 'thumbnail';

/**
 * How much simulated time the world had lived when this snapshot was written,
 * in milliseconds — the world CLOCK (World.simMillis, 2026-08-23).
 *
 * ADDITIVE, like world_name/pinned/thumbnail before it, and for the same
 * reason SNAPSHOT_SCHEMA_VERSION does not move: `addColumnIfMissing` gives an
 * existing database the column on open, an older build's queries never name
 * it, and a row written before it existed reads as 0 — "this world's calendar
 * starts at its next boot", which costs at most one extra Monday and never a
 * refused start.
 *
 * DEFAULT 0 AND NOT NULL, unlike the nullable columns above: absent and zero
 * mean exactly the same thing for a clock, so there is nothing for a NULL to
 * express that 0 does not.
 */
const SIM_MILLIS_COLUMN = 'sim_millis';

/**
 * The world clock at the world's GENESIS, in milliseconds
 * (World.genesisMillis, 2026-08-23) — its birthday, written once and read back
 * forever.
 *
 * ADDITIVE exactly like sim_millis above, and SNAPSHOT_SCHEMA_VERSION does not
 * move for the same reasons. NULLABLE, unlike sim_millis, and that is the one
 * real difference: a clock's "absent" and "zero" mean the same thing, but a
 * genesis's do not — since the clock was anchored to real time, 0 is a world
 * born at WORLD_EPOCH_REAL_MILLIS, so NULL is what "written before this column
 * existed" has to say. World.anchorClockToRealTime turns that NULL into a real
 * birthday using the row's sim_millis, which on such a row is the world's age.
 */
const GENESIS_MILLIS_COLUMN = 'genesis_millis';

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN_MASKS TABLE (issue #17, 2026-08-19). Per-player unlock masks — one row
// per (snapshot, token) — persisted BESIDE the union `mask` on `snapshots`,
// not inside a plugin's `plugin_slices` JSON blob. CORE'S OWN TABLE, chosen
// over a reveal-plugin slice, for one reason: unlockChunkForToken lives on
// WorldApi, not inside the reveal plugin (issue #17's "minimal API addition"
// — see world.ts), so the state it produces belongs with the OTHER core mask
// it is a per-player refinement of, in the same binary BLOB shape `mask`
// already uses, rather than smuggled through a JSON column meant for
// plugin-private data a plugin no longer even keeps (reveal is stateless
// after this change — see plugins/reveal/server/index.ts).
//
// A WHOLE NEW TABLE, not a column, mirrors how `world_name` was added: a
// second `CREATE TABLE IF NOT EXISTS` picks it up for free on every open(),
// fresh database or years-old one, with no ALTER-style migration function
// needed (unlike a column, a missing table costs nothing to add later).
// SNAPSHOT_SCHEMA_VERSION does NOT move for the same reason it didn't for
// world_name: the table is invisible to an older build's `SELECT *` (which
// never names it), and THIS build reads a snapshot with no matching rows —
// exactly what a pre-#17 snapshot has — as "no per-token masks recorded",
// which is precisely the legacy-restore behaviour issue #17 decision 4 asks
// for (union mask preserved, every per-token mask starts empty). See
// World.restore's doc comment for what that means for a returning player.
const TOKEN_MASKS_DDL = `
  CREATE TABLE IF NOT EXISTS token_masks (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    token       TEXT    NOT NULL,
    mask        BLOB    NOT NULL,
    PRIMARY KEY (snapshot_id, token)
  )
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
`;

/**
 * Adds one column to a database created before that column existed.
 *
 * GENERIC BECAUSE THERE ARE NOW TWO (world_name in 2026-08-14, pinned in
 * 2026-08-22) AND THERE WILL BE MORE. `CREATE TABLE IF NOT EXISTS` is a no-op
 * on an existing table, so the DDL above only names a column on FRESH
 * databases; every self-hoster who already has a world file needs this for
 * each additive column. Writing it once means the second column cannot be
 * added with a subtly different idempotence check than the first.
 *
 * Idempotent by inspection (`PRAGMA table_info`) rather than by catching the
 * duplicate-column error, because a swallowed exception here would hide a real
 * schema problem behind the same silence.
 *
 * `definition` is the column's type and constraints — everything that follows
 * its name in an ALTER. SQLite can only add a column with a default (or a
 * nullable one), which is why every caller either passes a DEFAULT or a
 * nullable type.
 */
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

export class SnapshotStore {
  private readonly db: Database;
  private readonly insertSnapshot: Statement;
  private readonly insertSlice: Statement;
  private readonly insertTokenMask: Statement;
  private readonly selectLatest: Statement;
  private readonly selectSlices: Statement;
  private readonly selectTokenMasks: Statement;
  private readonly pruneOld: Statement;
  private readonly countAll: Statement;
  private readonly selectById: Statement;
  private readonly selectHistory: Statement;
  private readonly setPinnedStatement: Statement;
  private readonly setWorldNameStatement: Statement;
  private readonly selectLatestThumbnail: Statement;
  private readonly setLatestThumbnailStatement: Statement;
  private readonly countPinnedStatement: Statement;

  /**
   * How many snapshots survive a write. Held per-store rather than read from
   * the module constant at each prune, so a test (and a self-hoster's
   * SNAPSHOT_RETENTION) changes retention in ONE place instead of at every
   * call site that could forget to pass it.
   */
  private readonly retention: number;

  private constructor(db: Database, retention: number) {
    this.db = db;
    this.retention = retention;
    this.insertSnapshot = db.prepare(
      `INSERT INTO snapshots
         (schema_version, created_at, world_size, ${WORLD_NAME_COLUMN}, heightmap, mask,
          ${THUMBNAIL_COLUMN}, ${SIM_MILLIS_COLUMN}, ${GENESIS_MILLIS_COLUMN})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertSlice = db.prepare(
      'INSERT INTO plugin_slices (snapshot_id, plugin, data) VALUES (?, ?, ?)',
    );
    this.insertTokenMask = db.prepare(
      'INSERT INTO token_masks (snapshot_id, token, mask) VALUES (?, ?, ?)',
    );
    this.selectLatest = db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1');
    this.selectById = db.prepare('SELECT * FROM snapshots WHERE id = ?');
    // OLDEST FIRST, and that ordering is load-bearing: listRestorePoints
    // measures each row against the one before it, so it must walk history
    // forwards even though it hands the result back newest-first.
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
    // Keep the newest N rows; ON DELETE CASCADE removes their slices and
    // token_masks rows too — both reference snapshots(id) the same way.
    // PINNED ROWS ARE NOT IN THE WINDOW AT ALL — note `pinned = 0` appears
    // TWICE, and both are load-bearing. The outer one stops a pinned row from
    // ever being deleted. The inner one keeps pinned rows from consuming the
    // LIMIT, so pinning a moment does not silently shorten the undo history:
    // retention means "the newest N unprotected points", plus everything a
    // human asked to keep.
    this.pruneOld = db.prepare(
      `DELETE FROM snapshots
         WHERE ${PINNED_COLUMN} = 0
           AND id NOT IN (
             SELECT id FROM snapshots WHERE ${PINNED_COLUMN} = 0 ORDER BY id DESC LIMIT ?
           )`,
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
  }

  /**
   * Opens (creating if needed) the world database. The parent directory is
   * created too: `DB_PATH=./data/world.db` must work on a fresh clone where
   * `data/` is gitignored and therefore absent.
   */
  static open(dbPath: string, retention: number = SNAPSHOT_RETENTION): SnapshotStore {
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
    addColumnIfMissing(db, 'snapshots', WORLD_NAME_COLUMN, 'TEXT');
    addColumnIfMissing(db, 'snapshots', PINNED_COLUMN, 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'snapshots', THUMBNAIL_COLUMN, 'BLOB');
    addColumnIfMissing(db, 'snapshots', SIM_MILLIS_COLUMN, 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'snapshots', GENESIS_MILLIS_COLUMN, 'INTEGER');
    return new SnapshotStore(db, retention);
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
    // `?? []`: an omitted tokenMasks means "this caller never touched
    // per-token unlocks" (see SnapshotInput's doc comment) — nothing to write,
    // not an error.
    const tokenMaskEntries = input.tokenMasks ?? [];

    const write = this.db.transaction((): number => {
      const result = this.insertSnapshot.run(
        SNAPSHOT_SCHEMA_VERSION,
        Date.now(),
        input.worldSize,
        input.name,
        heightmap,
        mask,
        // `?? null` rather than undefined: better-sqlite3 refuses undefined as
        // a bound value, and a caller that produced no thumbnail means NULL.
        input.thumbnail === undefined ? null : Buffer.copyBytesFrom(input.thumbnail),
        input.simMillis ?? 0,
        // `?? null` for the same better-sqlite3 reason as the thumbnail above;
        // here NULL is also the meaningful value — see GENESIS_MILLIS_COLUMN.
        input.genesisMillis ?? null,
      );
      const snapshotId = Number(result.lastInsertRowid);
      for (const [plugin, data] of entries) {
        // JSON, not a binary encoding: plugin slices are small, and a
        // human-readable column is worth a lot when debugging someone else's
        // plugin from a self-hoster's database.
        this.insertSlice.run(snapshotId, plugin, JSON.stringify(data));
      }
      for (const [token, tokenMask] of tokenMaskEntries) {
        // BINARY, like `mask` above and unlike plugin_slices: a per-token
        // mask is the same bitset shape as the union mask, not small JSON a
        // human would want to eyeball.
        this.insertTokenMask.run(snapshotId, token, Buffer.copyBytesFrom(tokenMask));
      }
      this.pruneOld.run(this.retention);
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
    return this.hydrate(this.selectLatest.get() as SnapshotRow | undefined);
  }

  /**
   * Loads ONE snapshot by id — the restore-point path (world rollback,
   * 2026-08-21) — or null when no such row exists (it was pruned, or the id
   * was never real).
   *
   * Shares every check with loadLatest by construction rather than by
   * discipline: both are one line over `hydrate`, so the schema-version
   * refusal and the per-cell height validation below cannot be present on one
   * path and missing on the other. That mattered enough to refactor for — a
   * rollback is the one operation that takes an OLD row, i.e. the row most
   * likely to be the corrupt or foreign one those checks exist to catch.
   */
  loadSnapshot(id: number): WorldSnapshot | null {
    return this.hydrate(this.selectById.get(id) as SnapshotRow | undefined);
  }

  /**
   * The one place a stored row becomes values the rest of the process trusts.
   * See loadSnapshot for why both public readers go through it.
   */
  private hydrate(row: SnapshotRow | undefined): WorldSnapshot | null {
    if (row === undefined) return null;

    if (row.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `snapshot #${row.id} has schema version ${row.schema_version}, this server reads ` +
          `version ${SNAPSHOT_SCHEMA_VERSION}; refusing to start rather than overwrite the world`,
      );
    }

    const cells = decodeHeights(row.heightmap, row.world_size * row.world_size);
    // Per-cell validity (isValidHeight, issue #13) is checked HERE — at decode,
    // not in World.restore — for the same reason the schema-version and
    // byte-length checks already live at this boundary rather than in the
    // caller: this is the one place raw DB bytes turn into values the rest of
    // the process trusts, so every future reader of a snapshot (not just
    // World.restore) gets the guarantee for free, and a corrupt row is named
    // by the snapshot id this function already has in scope. World.restore's
    // own checks stay scoped to size-compatibility with the CONFIGURED world
    // (a concern only it has); a Uint16Array wraps and NaN coerces to 0 on
    // assignment into the Int16Array-backed heightmap (see codec.ts's header
    // comment), so an out-of-range or non-integer value must be caught before
    // it is ever assigned, not clamped or repaired after the fact — the whole
    // point of failing at boot is that this is the one moment a self-hoster is
    // watching (config.ts).
    //
    // Cost: one pass over up to 512² = 262,144 cells, each check an
    // Number.isInteger plus two comparisons. Measured on this machine
    // (Node 24, `isValidHeight` inlined): ~2.7 ms for the worst case, once per
    // boot — negligible next to the SQLite read that produced the blob.
    //
    // THE ONE EXCEPTION IS A WORLD SAVED AGAINST A DEEPER FLOOR (2026-08-24).
    // See LEGACY_MIN_HEIGHT: a snapshot records no floor of its own, so a cell
    // at −1152 is indistinguishable from corruption by range alone even though
    // it is honest terrain a player dug when the floor was −1536. Such cells
    // are RAISED to today's floor here — the only repair this boundary does,
    // and it is a migration, not a repair of damage: the world model got
    // shallower and the stored terrain follows it up. Everything outside the
    // migration window still throws, which is the case the paragraph above is
    // about. The clamp cannot manufacture an illegal SLOPE either: it only
    // ever raises a cell toward its neighbours' floor, so every gradient it
    // touches gets shallower or stays put. Nothing is written back — the next
    // ordinary snapshot persists the migrated heights.
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
      // Said once per load, not once per cell, and said at all because this is
      // the one moment a self-hoster's terrain silently changes shape.
      logWarn(
        `snapshot #${row.id}: raised ${migrated} cell(s) from as deep as ${deepestMigrated} ` +
          `to the world floor ${MIN_HEIGHT} (saved against the older ${LEGACY_MIN_HEIGHT} floor)`,
      );
    }
    const mask = new Uint8Array(row.mask.byteLength);
    mask.set(row.mask);

    const pluginSlices: Record<string, unknown> = {};
    for (const slice of this.selectSlices.all(row.id) as SliceRow[]) {
      pluginSlices[slice.plugin] = JSON.parse(slice.data);
    }

    // A legacy (pre-#17) snapshot has NO rows here at all — the table exists
    // (added by SCHEMA_DDL on open()) but nothing was ever written against
    // this snapshot_id — so this loop simply never runs and tokenMasks stays
    // the empty map. That IS the legacy-restore contract (see World.restore's
    // doc comment): no special-casing needed here, only in what an empty map
    // means downstream.
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
      // `?? null` covers a row written before the column existed AND a row
      // written by a build that stored nothing in it; both mean "unnamed".
      name: row.world_name ?? null,
      // `?? 0` covers a row written before the column existed: an unaged world.
      simMillis: row.sim_millis ?? 0,
      // `?? null` covers a row written before the column existed; unlike the
      // clock it is NOT defaulted to 0 — see WorldSnapshot.genesisMillis.
      genesisMillis: row.genesis_millis ?? null,
      tokenMasks,
      cells,
      mask,
      pluginSlices,
    };
  }

  /**
   * Every retained snapshot as a RESTORE POINT, newest first — the list the
   * rollback panel shows (world rollback, 2026-08-21).
   *
   * WHY IT DECODES EVERY HEIGHTMAP. A list of bare timestamps is useless for
   * the job this feature exists for: the self-hoster is looking for the moment
   * something went wrong, and "19:16" and "19:17" look identical while one of
   * them moved 108 cells and the other moved 11,673. So each point carries how
   * far the world moved to REACH it, measured against the point before it, and
   * that measurement can only come from the heights themselves.
   *
   * COST, stated because it is the expensive call on this class: one decode
   * plus one full compare per retained snapshot — at the default retention of
   * 10 and a 512² world, ~5 MB read and ~2.6 M Int16 comparisons, measured at
   * ~40 ms on this machine. Bounded by MAX_SNAPSHOT_RETENTION and paid only
   * when an operator opens the panel, never on a tick or a snapshot write.
   *
   * A row whose heightmap does not decode to its own world_size is listed with
   * NULL deltas rather than dropped or thrown on: it is still a real restore
   * point (loadSnapshot re-validates it properly before anything is applied),
   * and hiding it would hide the very row an operator most needs to see.
   */
  listRestorePoints(): RestorePoint[] {
    const rows = this.selectHistory.all() as HistoryRow[];
    const points: RestorePoint[] = [];
    let previous: Int16Array | null = null;

    for (const row of rows) {
      const expectedCells = row.world_size * row.world_size;
      let current: Int16Array | null = null;
      try {
        current = decodeHeights(row.heightmap, expectedCells);
      } catch {
        current = null; // see doc comment: listed, un-measured, never hidden
      }

      // Comparable only when BOTH sides decoded AND describe the same grid.
      // A world-size change mid-history makes cell i of one row a different
      // place from cell i of the other, so there is no honest delta to report.
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
        // SQLite integer → boolean at the one boundary that reads the column,
        // so nothing downstream has to know the storage is 0/1.
        pinned: row.pinned !== 0,
        // Overwritten below for the genuinely newest row; `false` here keeps
        // the flag a fact about position in the list rather than something
        // each iteration has to know the list's length to compute.
        isCurrent: false,
      });
      if (current !== null) previous = current;
    }

    if (points.length > 0) points[points.length - 1].isCurrent = true;
    // Newest first: an operator rolling back is looking for something that
    // just happened, so the rows they want are the ones they see without
    // scrolling.
    return points.reverse();
  }

  /** The newest snapshot's thumbnail, or null when it has none. */
  latestThumbnail(): Buffer | null {
    const row = this.selectLatestThumbnail.get() as { thumbnail: Buffer | null } | undefined;
    return row?.thumbnail ?? null;
  }

  /**
   * Attaches a thumbnail to the newest snapshot — the LAZY BACKFILL path, for
   * a world whose newest snapshot predates thumbnails existing.
   *
   * Targets the newest row specifically rather than every row: a thumbnail is
   * a picture of one moment, and painting an old restore point with the
   * current world's outline would be a small lie in the one place whose
   * purpose is showing what a world looks like.
   */
  setLatestThumbnail(thumbnail: Uint8Array): boolean {
    return this.setLatestThumbnailStatement.run(Buffer.copyBytesFrom(thumbnail)).changes > 0;
  }

  /**
   * Renames the world this file holds, across its WHOLE history.
   *
   * EVERY ROW, not just the newest, because a name is the world's IDENTITY
   * rather than per-snapshot state: the same world was called this all along
   * as far as anyone looking at it is concerned. Leaving older rows on the old
   * name would mean a rollback to one of them silently renamed the world back,
   * which is precisely the identity wobble the boot snapshot in index.ts
   * already exists to prevent.
   *
   * Used for renaming a world that is NOT loaded. The LIVE world is renamed
   * through World.rename, which marks it dirty so the next snapshot carries
   * the new name; this then aligns its history the next time the file is
   * opened for a rename. Returns how many rows were relabelled.
   */
  setWorldName(name: string): number {
    return this.setWorldNameStatement.run(name).changes;
  }

  /**
   * Pins or unpins one restore point. Returns false when no such row exists —
   * it was pruned before the click landed, or the id was never real.
   *
   * SAFE TO CALL ON AN ALREADY-PINNED ROW: the UPDATE is idempotent, so a
   * double-click cannot toggle something the operator did not see.
   */
  setPinned(id: number, pinned: boolean): boolean {
    const result = this.setPinnedStatement.run(pinned ? 1 : 0, id);
    return result.changes > 0;
  }

  /** How many restore points are pinned, i.e. exempt from retention. */
  countPinned(): number {
    return (this.countPinnedStatement.get() as { n: number }).n;
  }

  /** Number of retained snapshots; used by the retention test. */
  countSnapshots(): number {
    return (this.countAll.get() as { n: number }).n;
  }

  /**
   * Folds this world's write-ahead log back into its database file.
   *
   * EXISTS FOR COPYING A LIVE WORLD (multi-world, 2026-08-22). In WAL mode the
   * newest committed snapshots can live entirely in `<file>-wal`, so copying
   * the `.db` alone can silently produce a duplicate that is missing the very
   * rows the operator just made. The registry checkpoints through its OWN
   * connection for worlds that are not loaded; a world that IS loaded must be
   * checkpointed through THIS one, because a TRUNCATE checkpoint from a second
   * connection cannot complete while this one holds the file open.
   */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }
}
