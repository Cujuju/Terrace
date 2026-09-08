import { DEFAULT_DB_PATH, loadConfig } from '../src/config.ts';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';

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

  const newId = store.saveSnapshot({
    worldSize: target.worldSize,
    name: target.name ?? '',
    cells: target.cells,
    mask: target.mask,
    pluginSlices: target.pluginSlices,
    tokenMasks: target.tokenMasks,
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
    store.close();
  }
}

process.exitCode = main();
