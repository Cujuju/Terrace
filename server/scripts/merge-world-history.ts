import DatabaseConstructor from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logError, logInfo, logWarn } from '../src/log.ts';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';

function usage(): never {
  logError('usage: pnpm --dir server merge-world-history <from.db> <into.db> [--pin]');
  process.exit(1);
}

const args = process.argv.slice(2);
const pin = args.includes('--pin');
const [fromArg, intoArg] = args.filter((arg) => !arg.startsWith('--'));
if (fromArg === undefined || intoArg === undefined) usage();

const from = resolve(fromArg);
const into = resolve(intoArg);
for (const path of [from, into]) {
  if (!existsSync(path)) {
    logError(`no such file: ${path}`);
    process.exit(1);
  }
}
if (from === into) {
  logError('refusing to merge a file into itself');
  process.exit(1);
}

function identify(path: string): { name: string | null; size: number; count: number } {
  const db = new DatabaseConstructor(path, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT world_name, world_size FROM snapshots ORDER BY id DESC LIMIT 1')
      .get() as { world_name: string | null; world_size: number } | undefined;
    const count = (db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
    if (row === undefined) throw new Error(`${path} holds no snapshots`);
    return { name: row.world_name, size: row.world_size, count };
  } finally {
    db.close();
  }
}

const a = identify(from);
const b = identify(into);

if (a.size !== b.size) {
  logError(
    `refusing: ${from} holds a ${a.size}² world and ${into} holds a ${b.size}² one. ` +
      'These are not two copies of the same world.',
  );
  process.exit(1);
}
if (a.name !== b.name) {
  logWarn(
    `the two files disagree about the world's name ("${a.name}" vs "${b.name}"). ` +
      'Continuing on the assumption that one of them was renamed.',
  );
}

function sharedLineage(db: DatabaseConstructor.Database): number | null {
  const both = (
    db
      .prepare(
        'SELECT id FROM main.snapshots WHERE id IN (SELECT id FROM source.snapshots) ORDER BY id DESC',
      )
      .all() as { id: number }[]
  ).map((row) => row.id);

  for (const id of both) {
    const mine = db
      .prepare('SELECT created_at, heightmap FROM main.snapshots WHERE id = ?')
      .get(id) as { created_at: number; heightmap: Buffer };
    const theirs = db
      .prepare('SELECT created_at, heightmap FROM source.snapshots WHERE id = ?')
      .get(id) as { created_at: number; heightmap: Buffer };
    if (
      mine.created_at === theirs.created_at &&
      Buffer.compare(mine.heightmap, theirs.heightmap) === 0
    ) {
      return id;
    }
  }
  return null;
}

const store = SnapshotStore.open(into);
store.close();

const db = new DatabaseConstructor(into);
db.pragma('foreign_keys = ON');
db.exec(`ATTACH DATABASE '${from.replace(/'/g, "''")}' AS source`);

const proof = sharedLineage(db);
if (proof === null) {
  const overlap = (
    db
      .prepare('SELECT COUNT(*) AS n FROM main.snapshots WHERE id IN (SELECT id FROM source.snapshots)')
      .get() as { n: number }
  ).n;
  db.exec('DETACH DATABASE source');
  db.close();
  logError(
    overlap === 0
      ? 'refusing: these two files share no snapshot id at all, so there is nothing to ' +
          'prove they are the same world. Merging them would interleave two unrelated ' +
          'histories under one name.'
      : `refusing: the ${overlap} snapshot id(s) these files share hold DIFFERENT terrain, ` +
          'so they are two different worlds that happen to look alike — not two copies of ' +
          'one world. Nothing was written.',
  );
  process.exit(1);
}
logInfo(`same world confirmed: snapshot #${proof} is identical in both files`);

const missing = (
  db
    .prepare('SELECT id FROM source.snapshots WHERE id NOT IN (SELECT id FROM main.snapshots) ORDER BY id')
    .all() as { id: number }[]
).map((row) => row.id);

if (missing.length === 0) {
  logInfo(`${into} already holds every snapshot in ${from} — nothing to do`);
  db.exec('DETACH DATABASE source');
  db.close();
  process.exit(0);
}

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  snapshots: ['id', 'schema_version', 'created_at', 'world_size', 'heightmap', 'mask'],
  plugin_slices: ['snapshot_id', 'plugin', 'data'],
  token_masks: ['snapshot_id', 'token', 'mask'],
};

function sharedColumns(table: string): string[] {
  const columnsOf = (schema: string): string[] =>
    (db.pragma(`${schema}.table_info(${table})`) as { name: string }[]).map((c) => c.name);
  const target = new Set(columnsOf('main'));
  const shared = columnsOf('source').filter((name) => target.has(name));

  const missing = (REQUIRED_COLUMNS[table] ?? []).filter((name) => !shared.includes(name));
  if (missing.length > 0) {
    logError(
      `refusing: the two files do not share the column(s) ${missing.join(', ')} on ` +
        `${table}, so a merged row would be missing something essential.`,
    );
    process.exit(1);
  }
  return shared;
}

function copyStatement(table: string, key: string): DatabaseConstructor.Statement {
  const columns = sharedColumns(table).join(', ');
  return db.prepare(
    `INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM source.${table} WHERE ${key} = ?`,
  );
}

const insertSnapshot = copyStatement('snapshots', 'id');
const insertSlices = copyStatement('plugin_slices', 'snapshot_id');
const insertMasks = copyStatement('token_masks', 'snapshot_id');

const merge = db.transaction((): void => {
  for (const id of missing) {
    insertSnapshot.run(id);
    insertSlices.run(id);
    insertMasks.run(id);
  }
});
merge();
db.exec('DETACH DATABASE source');
db.close();

if (pin) {
  const pinning = SnapshotStore.open(into);
  try {
    for (const id of missing) pinning.setPinned(id, true);
    logInfo(`pinned ${missing.length} recovered restore point(s) against retention`);
  } finally {
    pinning.close();
  }
} else {
  logWarn(
    'recovered points were NOT pinned. Retention keeps the newest points, so the next ' +
      'write may prune exactly what was just recovered — re-run with --pin to keep them.',
  );
}

const after = identify(into);
logInfo(
  `merged ${missing.length} snapshot(s) into ${into}: ${b.count} → ${after.count} restore points`,
);
logInfo(`recovered ids: ${missing.join(', ')}`);
logInfo(`${from} was not modified`);
