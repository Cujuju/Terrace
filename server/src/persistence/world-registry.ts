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
import { buildThumbnail } from './thumbnail.ts';

export const WORLD_FILE_EXTENSION = '.db';

export const TRASH_DIR_NAME = '.trash';

export const ACTIVE_POINTER_FILE = '.active';

const FIRST_UNIQUE_SUFFIX = 2;

const MAX_UNIQUE_SUFFIX = 999;

function archiveStamp(now: number): string {
  return String(now);
}

interface WorldFile {
  readonly id: string;
  readonly path: string;
}

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

    const hasSnapshots = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'`)
      .get();
    if (hasSnapshots === undefined) {
      return { ...base, unreadable: 'not a Terrace world (no snapshots table)' };
    }

    const columns = db.pragma('table_info(snapshots)') as { name: string }[];
    const hasPinned = columns.some((column) => column.name === 'pinned');
    const hasThumbnail = columns.some((column) => column.name === 'thumbnail');

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
    const thumbnail = hasThumbnail
      ? ((db.prepare(
          `SELECT thumbnail FROM snapshots ORDER BY id DESC LIMIT 1`,
        ).get() as { thumbnail: Buffer | null } | undefined)?.thumbnail ?? null)
      : null;
    const pinned = hasPinned
      ? (db.prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE pinned = 1`).get() as {
          n: number;
        }).n
      : 0;

    return {
      ...base,
      name: newest?.world_name ?? file.id,
      worldSize: newest?.world_size ?? 0,
      restorePoints: row.points,
      pinnedPoints: pinned,
      newestAt: row.newest,
      ...(thumbnail === null ? {} : { thumbnail: thumbnail.toString('base64') }),
    };
  } catch (error) {
    return { ...base, unreadable: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function fileBytes(path: string): number {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += statSync(path + suffix).size;
    } catch {
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
    mkdirSync(this.worldsDir, { recursive: true });
    mkdirSync(this.trashDir, { recursive: true });
  }

  pathFor(id: string, archived = false): string {
    if (validateWorldId(id) === null) {
      throw new Error(`"${id}" is not a valid world id`);
    }
    return join(archived ? this.trashDir : this.worldsDir, id + WORLD_FILE_EXTENSION);
  }

  has(id: string): boolean {
    return existsSync(this.pathFor(id));
  }

  hasArchived(id: string): boolean {
    return existsSync(this.pathFor(id, true));
  }

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

  list(activeId: string | null): WorldSummary[] {
    for (const file of this.scan(this.worldsDir)) {
      this.ensureThumbnail(file.id, activeId);
    }
    const summaries = this.scan(this.worldsDir).map((file) => ({
      ...readSummary(file),
      isActive: file.id === activeId,
      isArchived: false,
    }));
    return summaries.sort((a, b) => (b.newestAt ?? 0) - (a.newestAt ?? 0));
  }

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

  ensureThumbnail(id: string, activeId: string | null): boolean {
    if (id === activeId) return false;
    if (!this.has(id)) return false;

    let store: SnapshotStore | null = null;
    try {
      store = SnapshotStore.open(this.pathFor(id));
      if (store.latestThumbnail() !== null) return false;

      const snapshot = store.loadLatest();
      if (snapshot === null) return false;

      const drawn = store.setLatestThumbnail(
        buildThumbnail(snapshot.cells, snapshot.worldSize),
      );
      if (drawn) logInfo(`drew a thumbnail for world "${id}"`);
      return drawn;
    } catch (error) {
      logWarn(`could not draw a thumbnail for world "${id}": ${String(error)}`);
      return false;
    } finally {
      store?.close();
    }
  }

  summaryFor(id: string, activeId: string | null): WorldSummary | null {
    if (!this.has(id)) return null;
    return {
      ...readSummary({ id, path: this.pathFor(id) }),
      isActive: id === activeId,
      isArchived: false,
    };
  }

  uniqueIdFor(name: string): string | null {
    const base = slugifyWorldName(name);
    if (base.length === 0) return null;
    if (!this.has(base) && !this.hasArchived(base)) return base;

    for (let suffix = FIRST_UNIQUE_SUFFIX; suffix <= MAX_UNIQUE_SUFFIX; suffix++) {
      const tail = `-${suffix}`;
      const candidate = base.slice(0, MAX_WORLD_ID_LENGTH - tail.length) + tail;
      if (!this.has(candidate) && !this.hasArchived(candidate)) return candidate;
    }
    return null;
  }

  openStore(id: string, retention: number): SnapshotStore {
    const path = this.pathFor(id);
    if (!existsSync(path)) {
      throw new Error(`world "${id}" has no file at ${path}`);
    }
    return SnapshotStore.open(path, retention);
  }

  createStore(id: string, retention: number): SnapshotStore {
    const path = this.pathFor(id);
    if (existsSync(path)) {
      throw new Error(`refusing to create world "${id}": ${path} already exists`);
    }
    return SnapshotStore.open(path, retention);
  }

  duplicate(fromId: string, toId: string): void {
    const source = this.pathFor(fromId);
    const target = this.pathFor(toId);
    if (!existsSync(source)) throw new Error(`world "${fromId}" has no file`);
    if (existsSync(target)) throw new Error(`world "${toId}" already exists`);

    this.checkpoint(source);
    copyFileSync(source, target);
  }

  private checkpoint(path: string): void {
    if (!existsSync(path)) return;
    let db: DatabaseConstructor.Database | null = null;
    try {
      db = new DatabaseConstructor(path);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      logWarn(`could not checkpoint ${path} before moving it: ${String(error)}`);
    } finally {
      db?.close();
    }
  }

  archive(id: string, now: number): { archivedId: string; path: string } {
    const source = this.pathFor(id);
    if (!existsSync(source)) throw new Error(`world "${id}" has no file`);

    this.checkpoint(source);

    const stamp = archiveStamp(now);
    const tail = `-${stamp}`;
    let archivedId = id.slice(0, MAX_WORLD_ID_LENGTH - tail.length) + tail;
    if (existsSync(this.pathFor(archivedId, true))) archivedId = `${archivedId}-1`;

    const target = this.pathFor(archivedId, true);
    renameSync(source, target);
    this.moveSidecars(source, target);
    logInfo(`world "${id}" archived to ${target}`);
    return { archivedId, path: target };
  }

  unarchive(archivedId: string): string {
    const source = this.pathFor(archivedId, true);
    if (!existsSync(source)) throw new Error(`no archived world "${archivedId}"`);

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

  purge(archivedId: string): void {
    const path = this.pathFor(archivedId, true);
    if (!existsSync(path)) throw new Error(`no archived world "${archivedId}"`);
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(path + suffix, { force: true });
    }
    logWarn(`archived world "${archivedId}" was PURGED — ${path} no longer exists`);
  }

  private moveSidecars(source: string, target: string): void {
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(source + suffix)) renameSync(source + suffix, target + suffix);
    }
  }

  adopt(sourcePath: string, preferredName: string | null): string | null {
    const absolute = resolve(sourcePath);
    if (!existsSync(absolute)) return null;

    const stored = readSummary({ id: 'adopted', path: absolute });
    const name = stored.unreadable === undefined ? stored.name : (preferredName ?? 'adopted');

    const base = slugifyWorldName(name);
    if (base.length > 0 && (this.has(base) || this.hasArchived(base))) {
      return null;
    }

    const id = this.uniqueIdFor(name);
    if (id === null) return null;

    this.checkpoint(absolute);
    copyFileSync(absolute, this.pathFor(id));
    logInfo(`adopted "${absolute}" as world "${id}" ("${name}")`);
    return id;
  }

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
    if (!this.has(raw)) {
      logWarn(`${path} names world "${raw}", which has no file; no world will be loaded`);
      return null;
    }
    return raw;
  }

  writeActive(id: string | null): void {
    const path = join(this.worldsDir, ACTIVE_POINTER_FILE);
    writeFileSync(path, id === null ? '' : id, 'utf8');
  }
}
