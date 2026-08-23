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

// Opened through SnapshotStore so the target gains any additive column this
// build expects (notably `pinned`) before rows are written into it.
const store = SnapshotStore.open(into);
store.close();

const db = new DatabaseConstructor(into);
db.pragma('foreign_keys = ON');
db.exec(`ATTACH DATABASE '${from.replace(/'/g, "''")}' AS source`);

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

const insertSnapshot = db.prepare(
  'INSERT INTO main.snapshots SELECT * FROM source.snapshots WHERE id = ?',
);
const insertSlices = db.prepare(
  'INSERT INTO main.plugin_slices SELECT * FROM source.plugin_slices WHERE snapshot_id = ?',
);
const insertMasks = db.prepare(
  'INSERT INTO main.token_masks SELECT * FROM source.token_masks WHERE snapshot_id = ?',
);

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
