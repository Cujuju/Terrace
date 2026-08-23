// Merge one copy of a world's history into another.
//
//   pnpm --dir server merge-world-history <from.db> <into.db> [--pin]
//
// FOR WHEN YOU HAVE TWO COPIES OF THE SAME WORLD and each holds restore points
// the other has lost. That is not a rare accident — it is what a rolling
// retention window guarantees over time: a backup taken on Tuesday holds
// points that Wednesday's play has since pruned, and the live file holds
// everything since. Neither is a superset. This makes the union.
//
// WHAT IT DOES. Copies every snapshot in `from` whose id is not already in
// `into` — with its plugin slices and its per-token masks — inside one
// transaction. `into` is the only file written; `from` is opened read-only and
// is never modified.
//
// WHY IT MATCHES ON ID. Snapshot ids are AUTOINCREMENT rowids from the SAME
// world's history, so two copies of one world agree on what id 307 is. That
// makes this safe and idempotent for copies of one world, and MEANINGLESS for
// two different worlds — merging unrelated worlds would interleave two
// unrelated heightmaps under one name. The script therefore refuses when the
// two files disagree about the world's size, and warns when they disagree
// about its name.
//
// --pin MARKS EVERY RECOVERED SNAPSHOT AS PINNED, and you almost always want
// it. Retention keeps the newest N unpinned points; recovered points are by
// definition old, so without a pin the first write after the merge prunes
// exactly what you just went to the trouble of recovering.

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

/** Reads the identity both files must agree on before anything is written. */
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

// A SIZE MISMATCH IS FATAL. Cell i of one file is a different place from cell i
// of the other, so these are not two copies of one world whatever their names
// say, and interleaving their snapshots would produce a history that jumps
// between two different maps.
if (a.size !== b.size) {
  logError(
    `refusing: ${from} holds a ${a.size}² world and ${into} holds a ${b.size}² one. ` +
      'These are not two copies of the same world.',
  );
  process.exit(1);
}
// A NAME MISMATCH IS ONLY A WARNING: a world can legitimately have been renamed
// in one copy and not the other, and the ids still line up.
if (a.name !== b.name) {
  logWarn(
    `the two files disagree about the world's name ("${a.name}" vs "${b.name}"). ` +
      'Continuing on the assumption that one of them was renamed.',
  );
}

/**
 * Proves the two files are the SAME WORLD, not merely two worlds that look
 * alike, by comparing a snapshot they both claim to hold.
 *
 * WHY A NAME AND A SIZE ARE NOT ENOUGH. This script matches snapshots by id,
 * and ids are AUTOINCREMENT rowids — every world's history starts at 1 and
 * counts up. So two DIFFERENT worlds of the same size both have a snapshot
 * #5, and merging them would interleave two unrelated heightmaps into one
 * history: restore points that teleport between two maps. Names do not save
 * you either, because `generateWorldName` draws from a finite table and can
 * mint the same name twice.
 *
 * WHAT IS DECISIVE is the CONTENT of a shared id. Two copies of one world
 * agree byte-for-byte about what snapshot #308 was — same heightmap, same
 * mask, same timestamp — because they are the same row copied. Two different
 * worlds' #308s are unrelated terrain. One matching shared snapshot is
 * therefore proof of common lineage, and no matching one is proof against it.
 *
 * Returns the id that proved it, or null when nothing could.
 */
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

// Opened through SnapshotStore so the target gains any additive column this
// build expects (notably `pinned`) before rows are written into it.
const store = SnapshotStore.open(into);
store.close();

const db = new DatabaseConstructor(into);
db.pragma('foreign_keys = ON');
db.exec(`ATTACH DATABASE '${from.replace(/'/g, "''")}' AS source`);

// LINEAGE CHECK — the gate that stops two different worlds being welded into
// one history. See sharedLineage for why the size and name checks above are
// not sufficient on their own.
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

/**
 * Columns every row of a table must carry for the copy to mean anything. A
 * source missing one of these is not a world file this script can merge.
 */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  snapshots: ['id', 'schema_version', 'created_at', 'world_size', 'heightmap', 'mask'],
  plugin_slices: ['snapshot_id', 'plugin', 'data'],
  token_masks: ['snapshot_id', 'token', 'mask'],
};

/**
 * The columns to copy for one table: those present in BOTH files.
 *
 * NAMED EXPLICITLY, NEVER `SELECT *`. Two copies of a world can genuinely have
 * different schemas — one has been opened by a build with an additive column
 * (`pinned`, `world_name`) and the other has not — and `SELECT *` is
 * POSITIONAL. It fails loudly when the column counts differ, which is how this
 * was found; it would fail SILENTLY, writing each value into the wrong column,
 * if the counts ever matched in a different order. Naming the intersection
 * makes both impossible: a column the target has and the source lacks simply
 * takes its default (which is what `pinned` wants), and a column the source
 * has and the target lacks is dropped rather than shifting everything after it.
 */
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

/** `INSERT INTO main.<table> (cols) SELECT cols FROM source.<table> WHERE <key> = ?`. */
function copyStatement(table: string, key: string): DatabaseConstructor.Statement {
  const columns = sharedColumns(table).join(', ');
  return db.prepare(
    `INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM source.${table} WHERE ${key} = ?`,
  );
}

const insertSnapshot = copyStatement('snapshots', 'id');
const insertSlices = copyStatement('plugin_slices', 'snapshot_id');
const insertMasks = copyStatement('token_masks', 'snapshot_id');

// ONE TRANSACTION for the whole merge: a half-merged history is a world with
// restore points whose plugin state was never copied, which would restore a
// map with no forests on it.
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
