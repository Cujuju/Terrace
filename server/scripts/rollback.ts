// Offline world rollback — the same restore points as the in-game panel, from
// a terminal (world rollback, 2026-08-21).
//
// WHY IT EXISTS ALONGSIDE THE PANEL. The panel needs a server that boots, a
// client that renders and a socket between them. The cases that most need a
// rollback are exactly the ones where one of those is missing: a snapshot that
// makes a plugin throw on restore, a world so mangled the client is unusable,
// or an operator who cannot reach the machine's browser. This path needs none
// of it — just the database file.
//
// NO TERRAIN MATH AND NO SECOND FORMAT. It reuses SnapshotStore, so the
// listing an operator sees here is produced by the same code the panel's is,
// and a restore is written by the same transaction. Rolling back is one
// operation on this file: append the chosen snapshot's state as the NEWEST
// snapshot. The server's ordinary boot then restores it, which is the most
// exercised path in the codebase — nothing here has to teach a running world
// how to rewind.
//
// NOTHING IS DELETED, EVER. The restore appends; the snapshot being rolled
// away from stays in the history until it ages out under SNAPSHOT_RETENTION
// like any other. A mis-aimed rollback is undone by rolling back again.
//
// Usage (from the repo's server/ directory):
//   node scripts/rollback.ts list
//   node scripts/rollback.ts to <restore-point-id>
//   DB_PATH=/data/world.db node scripts/rollback.ts list
//
// STOP THE SERVER FIRST. A running server holds the world in memory and writes
// it back every SNAPSHOT_INTERVAL_S, so a restore appended underneath one is
// overwritten within the minute. This script cannot detect that for you — see
// the warning it prints.

import { DEFAULT_DB_PATH, loadConfig } from '../src/config.ts';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';

/** Process exit code for a usage error, per the shell convention. */
const EXIT_USAGE = 2;

function usage(): void {
  console.error(
    [
      'Usage:',
      '  node scripts/rollback.ts list          list the restore points, newest first',
      '  node scripts/rollback.ts to <id>       roll the world back to that restore point',
      '',
      'The database is $DB_PATH, or ' + DEFAULT_DB_PATH + ' relative to the current directory.',
      'STOP THE SERVER FIRST — a running one overwrites this within the minute.',
    ].join('\n'),
  );
}

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

function list(store: SnapshotStore): void {
  const points = store.listRestorePoints();
  if (points.length === 0) {
    console.log('no restore points yet — this world has never been snapshotted');
    return;
  }
  console.log('  id  written (UTC)         cells changed   largest cell move');
  for (const point of points) {
    // The oldest retained point has no predecessor to be measured against, so
    // its deltas are null — printed as a dash rather than as a zero, which
    // would read as "nothing happened".
    const changed = point.cellsChanged === null ? '—' : point.cellsChanged.toLocaleString();
    const maxDelta = point.maxCellDelta === null ? '—' : String(point.maxCellDelta);
    const marker = point.isCurrent ? '  <- current' : '';
    console.log(
      `${String(point.id).padStart(4)}  ${formatWhen(point.createdAt)}  ` +
        `${changed.padStart(13)}   ${maxDelta.padStart(17)}${marker}`,
    );
  }
}

function rollbackTo(store: SnapshotStore, id: number): number {
  const target = store.loadSnapshot(id);
  if (target === null) {
    console.error(`no restore point #${id} in this database — run 'list' to see what there is`);
    return EXIT_USAGE;
  }

  // Appended as the newest snapshot; see this file's header for why that IS
  // the rollback. `name` falls back to the target's own stored name, and a
  // legacy row without one is left for World.restore to mint at boot exactly
  // as it would have.
  const newId = store.saveSnapshot({
    worldSize: target.worldSize,
    name: target.name ?? '',
    cells: target.cells,
    mask: target.mask,
    pluginSlices: target.pluginSlices,
    tokenMasks: target.tokenMasks,
    // CARRIED FORWARD, not dropped: the clock and the birthday belong to the
    // world, not to the terrain being rewound (RollbackService.saveCurrent
    // makes the same call for the live path). Omitting the birthday would
    // leave the new row's genesis NULL, and the next boot would reconstruct
    // one from `now` — restarting the saga's day numbering at 1 on a world
    // that only moved its hills.
    simMillis: target.simMillis,
    genesisMillis: target.genesisMillis ?? undefined,
  });
  console.log(
    `restore point #${id} (${formatWhen(target.createdAt)}) is now the newest world, as #${newId}.`,
  );
  console.log('Start the server; it will restore it. Nothing was deleted.');
  return 0;
}

function main(): number {
  const [command, argument] = process.argv.slice(2);
  if (command !== 'list' && command !== 'to') {
    usage();
    return EXIT_USAGE;
  }

  // The SERVER'S OWN configuration, not a second reading of the environment.
  // Retention matters here and not only DB_PATH: `saveSnapshot` prunes to the
  // store's retention, so a script that opened with the built-in default would
  // silently delete history on a server configured to keep more than that.
  const config = loadConfig();
  const store = SnapshotStore.open(config.dbPath, config.snapshotRetention);
  try {
    if (command === 'list') {
      list(store);
      return 0;
    }
    const id = Number(argument);
    if (!Number.isSafeInteger(id) || id <= 0) {
      console.error(`'to' needs a restore point id; got "${argument ?? ''}"`);
      usage();
      return EXIT_USAGE;
    }
    return rollbackTo(store, id);
  } finally {
    // Closed on every path, including the error ones: leaving the handle open
    // leaves the WAL sidecars behind, which is exactly the state an operator
    // does not want to find their database in after a failed recovery.
    store.close();
  }
}

process.exitCode = main();
