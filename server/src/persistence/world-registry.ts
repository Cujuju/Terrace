// THE WORLD REGISTRY — every world this server has, as files on disk.
//
// CRITICAL CODE (it is the thing that stops worlds being lost). The rule this
// module exists to enforce is one sentence: A WORLD IS A FILE.
//
// WHY THAT SENTENCE IS THE WHOLE DESIGN. Before 2026-08-22 a world was a ROW.
// Every world a deployment had ever run shared one `snapshots` table and was
// told apart by a `world_name` column, while retention kept "the newest N
// rows" across the entire table. The consequence was not hypothetical: a world
// called Frostwick Hollows lost 298 of its 308 snapshots because later writes
// — some of them from an entirely different world — walked the window forward
// until its history fell off the end. Nothing was buggy. The contract was.
//
// With one SQLite file per world, retention runs INSIDE a file and physically
// cannot reach a row in another one. That is a structural guarantee: it holds
// because of what the code cannot express, not because every future caller
// remembers to scope a DELETE.
//
// THE SECOND RULE: NOTHING HERE DELETES A WORLD EXCEPT `purge`.
// `archive` MOVES a file into `.trash/`. `unarchive` moves it back. `purge` is
// the only function in this repo that calls `rm`, it is reachable only from an
// operator-keyed message that must echo the world's own name, and it refuses
// anything that is not already sitting in the trash. Everywhere else, the
// worst case is a world in the wrong folder — never a world that is gone.
//
// THE THIRD RULE: THE FILES ARE THE TRUTH. There is no index, manifest or
// table of contents that lists what worlds exist; `list()` reads the directory
// and opens each file. An index would be a second source of truth, and the
// failure mode of a second source of truth is a world that exists on disk but
// not in the list — which is indistinguishable, to the person looking at the
// list, from a world that was deleted. The one piece of state kept outside the
// world files is a pointer to which world was last loaded (`.active`), and it
// is advisory: losing it costs a boot with no world loaded, never a world.

import DatabaseConstructor from 'better-sqlite3';
import {
  MAX_WORLD_ID_LENGTH,
  slugifyWorldName,
  validateWorldId,
  type WorldSummary,
} from '@terrace/shared';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { logInfo, logWarn } from '../log.ts';
import { SnapshotStore } from './snapshot-store.ts';

/** Extension every world file carries. Also what `list()` scans for. */
export const WORLD_FILE_EXTENSION = '.db';

/**
 * Folder, inside the worlds directory, that archived worlds are moved to.
 *
 * DOT-PREFIXED so it is not itself scanned as a world (the scan skips names
 * beginning with a dot) and so it stays out of the way in a file manager.
 */
export const TRASH_DIR_NAME = '.trash';

/**
 * File holding the id of the world to load at boot.
 *
 * ADVISORY, NOT AUTHORITATIVE, and that distinction is deliberate: if this
 * file is missing, empty or names a world that no longer exists, the server
 * boots with NO WORLD LOADED and says so. It does NOT fall back to "make a
 * fresh world", because that fallback is precisely how a self-hoster ends up
 * looking at an empty map wondering where theirs went (the world-name mint at
 * `World.restore` did exactly this). A pointer that has lost its target is a
 * question for a human, not a licence to generate terrain.
 */
export const ACTIVE_POINTER_FILE = '.active';

/**
 * Suffix appended to make a slug unique when one is already taken: `-2`, `-3`,
 * and so on. Starts at 2 because the unsuffixed id is conceptually the first.
 */
const FIRST_UNIQUE_SUFFIX = 2;

/**
 * How many suffixes to try before giving up.
 *
 * A bound rather than a `while (true)`: this loop is driven by what is on
 * disk, and an unbounded search over a directory somebody else can write to is
 * a hang waiting to happen. Anyone with 999 worlds of the same name has a
 * naming problem this function cannot fix for them.
 */
const MAX_UNIQUE_SUFFIX = 999;

/** Milliseconds-since-epoch, as the archive timestamp suffix. */
function archiveStamp(now: number): string {
  return String(now);
}

/** One world file the registry knows about. */
interface WorldFile {
  readonly id: string;
  readonly path: string;
}

/**
 * Reads the metadata a listing shows, WITHOUT going through SnapshotStore.
 *
 * DELIBERATELY READ-ONLY AND DELIBERATELY NOT `SnapshotStore.open`. Opening a
 * store runs schema DDL and additive-column migrations — i.e. it WRITES. A
 * listing must never modify twelve world files just because somebody opened a
 * panel, and it must be able to describe a file this build cannot fully
 * understand rather than upgrading it behind the operator's back.
 *
 * Every failure is returned as `unreadable` text rather than thrown: a world
 * whose file is corrupt still appears in the list, with its problem stated.
 * Hiding it would be the one behaviour guaranteed to look like deletion.
 */
function readSummary(file: WorldFile): Omit<WorldSummary, 'isActive' | 'isArchived'> {
  const bytes = fileBytes(file.path);
  const base = {
    id: file.id,
    name: file.id,
    worldSize: 0,
    restorePoints: 0,
    pinnedPoints: 0,
    newestAt: null as number | null,
    bytes,
  };

  let db: DatabaseConstructor.Database | null = null;
  try {
    db = new DatabaseConstructor(file.path, { readonly: true, fileMustExist: true });

    // A file that is a database but not one of OURS (no snapshots table) is a
    // legitimate thing to find in a folder a human can drop files into.
    const hasSnapshots = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'`)
      .get();
    if (hasSnapshots === undefined) {
      return { ...base, unreadable: 'not a Terrace world (no snapshots table)' };
    }

    // The pinned column is additive (2026-08-22), so a world file written by
    // an older build simply does not have it. Ask the schema rather than
    // catching a query error: this listing must work against every vintage of
    // world file, and "column not found" is a normal answer here, not a fault.
    const columns = db.pragma('table_info(snapshots)') as { name: string }[];
    const hasPinned = columns.some((column) => column.name === 'pinned');

    const row = db
      .prepare(
        `SELECT COUNT(*) AS points, MAX(created_at) AS newest FROM snapshots`,
      )
      .get() as { points: number; newest: number | null };
    const newest = db
      .prepare(
        `SELECT world_name, world_size FROM snapshots ORDER BY id DESC LIMIT 1`,
      )
      .get() as { world_name: string | null; world_size: number } | undefined;
    const pinned = hasPinned
      ? (db.prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE pinned = 1`).get() as {
          n: number;
        }).n
      : 0;

    return {
      ...base,
      // A world whose newest row has no name (written before names existed)
      // shows its id, which is at least a true statement about the file.
      name: newest?.world_name ?? file.id,
      worldSize: newest?.world_size ?? 0,
      restorePoints: row.points,
      pinnedPoints: pinned,
      newestAt: row.newest,
    };
  } catch (error) {
    return { ...base, unreadable: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/**
 * Bytes a world occupies: the database plus its write-ahead log.
 *
 * The WAL counts because it can be a substantial fraction of the total between
 * checkpoints, and an operator deciding what to archive is asking about disk,
 * not about SQLite's internals.
 */
function fileBytes(path: string): number {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += statSync(path + suffix).size;
    } catch {
      // Missing WAL is the normal case for a cleanly-closed database.
    }
  }
  return total;
}

export class WorldRegistry {
  readonly worldsDir: string;
  readonly trashDir: string;

  constructor(worldsDir: string) {
    this.worldsDir = resolve(worldsDir);
    this.trashDir = join(this.worldsDir, TRASH_DIR_NAME);
    // Both created up front: every other method may then assume they exist,
    // and a self-hoster's first boot on a fresh clone works with no setup.
    mkdirSync(this.worldsDir, { recursive: true });
    mkdirSync(this.trashDir, { recursive: true });
  }

  /**
   * Absolute path of a world file.
   *
   * THE ONE PLACE AN ID BECOMES A PATH, and therefore the one place path
   * traversal has to be stopped. Every id is re-validated here against
   * WORLD_ID_PATTERN even when the caller has already validated it at the
   * protocol boundary: this function is called by boot code and migrations
   * that never saw a protocol message, and a check that lives only at the
   * network edge protects only the network edge.
   */
  pathFor(id: string, archived = false): string {
    if (validateWorldId(id) === null) {
      throw new Error(`"${id}" is not a valid world id`);
    }
    return join(archived ? this.trashDir : this.worldsDir, id + WORLD_FILE_EXTENSION);
  }

  /** True when a live (non-archived) world file with this id exists. */
  has(id: string): boolean {
    return existsSync(this.pathFor(id));
  }

  /** True when an archived world file with this id exists. */
  hasArchived(id: string): boolean {
    return existsSync(this.pathFor(id, true));
  }

  /**
   * Every world file in a directory, as {id, path}.
   *
   * Skips dot-files (which is how `.trash` and `.active` stay out of the
   * listing) and anything whose basename is not a legal world id — a file a
   * human dropped in with spaces or capitals in its name is reported once as a
   * warning rather than being silently renamed or silently ignored.
   */
  private scan(dir: string): WorldFile[] {
    const files: WorldFile[] = [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return files;
    }

    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (!name.endsWith(WORLD_FILE_EXTENSION)) continue;
      const id = basename(name, WORLD_FILE_EXTENSION);
      if (validateWorldId(id) === null) {
        logWarn(
          `ignoring "${join(dir, name)}": "${id}" is not a usable world id ` +
            '(lowercase letters, digits and hyphens only)',
        );
        continue;
      }
      files.push({ id, path: join(dir, name) });
    }
    return files;
  }

  /**
   * Every live world, most-recently-played first.
   *
   * `activeId` is passed in rather than read from the pointer file because the
   * LOADED world is a fact about the running process, and the pointer is only
   * a record of intent for the next boot. During a switch those two disagree
   * for a moment, and the listing must show what is actually loaded.
   */
  list(activeId: string | null): WorldSummary[] {
    const summaries = this.scan(this.worldsDir).map((file) => ({
      ...readSummary(file),
      isActive: file.id === activeId,
      isArchived: false,
    }));
    // Newest play first, with never-snapshotted worlds last: the world you
    // were just in is the one you are most likely to want again.
    return summaries.sort((a, b) => (b.newestAt ?? 0) - (a.newestAt ?? 0));
  }

  /** Every archived world, most-recently-archived first. */
  listArchived(): WorldSummary[] {
    const summaries = this.scan(this.trashDir).map((file) => {
      let archivedAt: number | undefined;
      try {
        archivedAt = statSync(file.path).mtimeMs;
      } catch {
        archivedAt = undefined;
      }
      return {
        ...readSummary(file),
        isActive: false,
        isArchived: true,
        ...(archivedAt !== undefined ? { archivedAt } : {}),
      };
    });
    return summaries.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  }

  /** One live world's summary, or null when there is no such file. */
  summaryFor(id: string, activeId: string | null): WorldSummary | null {
    if (!this.has(id)) return null;
    return {
      ...readSummary({ id, path: this.pathFor(id) }),
      isActive: id === activeId,
      isArchived: false,
    };
  }

  /**
   * An id derived from a name that no existing world — live OR archived — is
   * already using.
   *
   * ARCHIVED WORLDS RESERVE THEIR IDS. Two worlds could otherwise share a file
   * name the moment one of them is restored from the trash, and the loser of
   * that collision would be overwritten. Reserving is cheap; the alternative
   * destroys a world.
   *
   * Returns null when the name has nothing slug-able in it, or when every
   * suffix up to MAX_UNIQUE_SUFFIX is taken.
   */
  uniqueIdFor(name: string): string | null {
    const base = slugifyWorldName(name);
    if (base.length === 0) return null;
    if (!this.has(base) && !this.hasArchived(base)) return base;

    for (let suffix = FIRST_UNIQUE_SUFFIX; suffix <= MAX_UNIQUE_SUFFIX; suffix++) {
      // Trim the base so the suffix cannot push the id past the length bound.
      const tail = `-${suffix}`;
      const candidate = base.slice(0, MAX_WORLD_ID_LENGTH - tail.length) + tail;
      if (!this.has(candidate) && !this.hasArchived(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Opens a world's store for reading and writing. The file must already
   * exist: creating a world is the manager's job, because a world file is only
   * meaningful once it holds a genesis snapshot (see WorldManager.createWorld).
   */
  openStore(id: string, retention: number): SnapshotStore {
    const path = this.pathFor(id);
    if (!existsSync(path)) {
      throw new Error(`world "${id}" has no file at ${path}`);
    }
    return SnapshotStore.open(path, retention);
  }

  /**
   * Creates the FILE for a new world and opens it. Fails rather than
   * overwriting if anything is already there.
   */
  createStore(id: string, retention: number): SnapshotStore {
    const path = this.pathFor(id);
    if (existsSync(path)) {
      throw new Error(`refusing to create world "${id}": ${path} already exists`);
    }
    return SnapshotStore.open(path, retention);
  }

  /**
   * Copies a world, byte for byte, to a new id.
   *
   * COPIES THE FILE RATHER THAN RE-EXPORTING ITS CONTENT, so the duplicate has
   * the original's ENTIRE history — every restore point, every pin, every
   * per-token mask — not just its current state. "Duplicate this world" most
   * often means "let me experiment without risking the real one", and a copy
   * that quietly dropped the safety net would be the exact opposite of that.
   *
   * The WAL is checkpointed into the source first; without that, a copy taken
   * between checkpoints can be missing the most recent snapshots.
   */
  duplicate(fromId: string, toId: string): void {
    const source = this.pathFor(fromId);
    const target = this.pathFor(toId);
    if (!existsSync(source)) throw new Error(`world "${fromId}" has no file`);
    if (existsSync(target)) throw new Error(`world "${toId}" already exists`);

    this.checkpoint(source);
    copyFileSync(source, target);
  }

  /**
   * Folds a world's write-ahead log back into its main database file.
   *
   * Needed before any operation that treats the `.db` file as the whole world
   * — copy, archive, purge. In WAL mode the newest committed data can live
   * entirely in `<file>-wal`, so moving or copying the `.db` alone can silently
   * lose the most recent snapshots. TRUNCATE (rather than PASSIVE) is used
   * because it also empties the log, leaving nothing behind to strand.
   */
  private checkpoint(path: string): void {
    if (!existsSync(path)) return;
    let db: DatabaseConstructor.Database | null = null;
    try {
      db = new DatabaseConstructor(path);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      // Not fatal on its own: a file that cannot be checkpointed can still be
      // copied or moved, it just might be missing its newest rows. Say so
      // loudly rather than failing the operator's whole request.
      logWarn(`could not checkpoint ${path} before moving it: ${String(error)}`);
    } finally {
      db?.close();
    }
  }

  /**
   * Moves a world into the trash and returns its new path.
   *
   * NOT A DELETE, AND THE RETURN VALUE IS THE PROOF: the operator is handed
   * the path their world now lives at, so "where did it go" has an answer on
   * screen. The archived id gains a timestamp suffix, which both prevents
   * collisions with an earlier archive of the same world and records when it
   * happened in the name itself.
   */
  archive(id: string, now: number): { archivedId: string; path: string } {
    const source = this.pathFor(id);
    if (!existsSync(source)) throw new Error(`world "${id}" has no file`);

    this.checkpoint(source);

    const stamp = archiveStamp(now);
    const tail = `-${stamp}`;
    let archivedId = id.slice(0, MAX_WORLD_ID_LENGTH - tail.length) + tail;
    // Two archives of the same world inside one millisecond is not a scenario
    // worth a loop; one extra suffix covers it and cannot spin.
    if (existsSync(this.pathFor(archivedId, true))) archivedId = `${archivedId}-1`;

    const target = this.pathFor(archivedId, true);
    renameSync(source, target);
    // The sidecar files belong to the world, not to the folder. Moving the
    // database and leaving its WAL behind would strand bytes that a later
    // world of the same name could then be confused by.
    this.moveSidecars(source, target);
    logInfo(`world "${id}" archived to ${target}`);
    return { archivedId, path: target };
  }

  /** Moves a world back out of the trash. Returns the id it came back as. */
  unarchive(archivedId: string): string {
    const source = this.pathFor(archivedId, true);
    if (!existsSync(source)) throw new Error(`no archived world "${archivedId}"`);

    // Strip the archive timestamp to recover the world's original id, then
    // make sure it is free — something else may have taken the name while this
    // world sat in the trash, and restoring must never overwrite that.
    const restoredBase = archivedId.replace(/-\d{10,}(-\d+)?$/, '') || archivedId;
    let restoredId = restoredBase;
    if (this.has(restoredId)) {
      const unique = this.uniqueIdFor(restoredBase);
      if (unique === null) throw new Error(`no free id for "${restoredBase}"`);
      restoredId = unique;
    }

    const target = this.pathFor(restoredId);
    renameSync(source, target);
    this.moveSidecars(source, target);
    logInfo(`archived world "${archivedId}" restored as "${restoredId}"`);
    return restoredId;
  }

  /**
   * PERMANENTLY DESTROYS an archived world. The only function in this repo
   * that unlinks a world file.
   *
   * Refuses anything that is not in the trash, so a purge can never be aimed
   * at a live world by id alone: archiving is a mandatory first step, which
   * means destroying a world is always a two-decision act separated by however
   * long the operator takes to come back to it.
   *
   * The caller (WorldAdminService) is responsible for the name confirmation;
   * this function is the mechanism, not the gate.
   */
  purge(archivedId: string): void {
    const path = this.pathFor(archivedId, true);
    if (!existsSync(path)) throw new Error(`no archived world "${archivedId}"`);
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(path + suffix, { force: true });
    }
    logWarn(`archived world "${archivedId}" was PURGED — ${path} no longer exists`);
  }

  /** Moves a world's `-wal`/`-shm` sidecars alongside its database file. */
  private moveSidecars(source: string, target: string): void {
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(source + suffix)) renameSync(source + suffix, target + suffix);
    }
  }

  /**
   * Adopts an existing world database that lives outside the worlds folder —
   * the legacy `DB_PATH` file, or one a self-hoster points at by hand.
   *
   * COPIES, NEVER MOVES, and that is the whole point of the design. Migration
   * must be incapable of losing the original: if the copy is wrong, or this
   * build turns out to have a bug, the file the operator started with is
   * exactly where they left it. A migration that moves is a migration that has
   * to be right the first time.
   *
   * Idempotent by id: a second run finds the id taken and skips, rather than
   * making `world-2`, `world-3`, ... on every boot. Returns the id it was
   * adopted as, or null when it was already there.
   */
  adopt(sourcePath: string, preferredName: string | null): string | null {
    const absolute = resolve(sourcePath);
    if (!existsSync(absolute)) return null;

    // The name inside the file beats any name the caller guessed: this is the
    // world's own identity, and the whole reason it is being preserved.
    const stored = readSummary({ id: 'adopted', path: absolute });
    const name = stored.unreadable === undefined ? stored.name : (preferredName ?? 'adopted');

    const base = slugifyWorldName(name);
    if (base.length > 0 && (this.has(base) || this.hasArchived(base))) {
      // Already adopted (or a name clash with a world that is already here).
      // Either way, do nothing: this function must be safe to run on every
      // boot forever.
      return null;
    }

    const id = this.uniqueIdFor(name);
    if (id === null) return null;

    this.checkpoint(absolute);
    copyFileSync(absolute, this.pathFor(id));
    logInfo(`adopted "${absolute}" as world "${id}" ("${name}")`);
    return id;
  }

  /** The world to load at boot, or null when the pointer is absent/stale. */
  readActive(): string | null {
    const path = join(this.worldsDir, ACTIVE_POINTER_FILE);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8').trim();
    } catch {
      return null;
    }
    if (raw.length === 0) return null;
    if (validateWorldId(raw) === null) {
      logWarn(`${path} does not name a valid world id ("${raw}"); ignoring it`);
      return null;
    }
    // A pointer at a world that no longer exists is reported, not repaired:
    // see ACTIVE_POINTER_FILE for why the server refuses to invent a world.
    if (!this.has(raw)) {
      logWarn(`${path} names world "${raw}", which has no file; no world will be loaded`);
      return null;
    }
    return raw;
  }

  /** Records which world to load next boot. `null` clears it (unloaded). */
  writeActive(id: string | null): void {
    const path = join(this.worldsDir, ACTIVE_POINTER_FILE);
    writeFileSync(path, id === null ? '' : id, 'utf8');
  }
}
