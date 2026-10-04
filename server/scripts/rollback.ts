import { cellX, cellY, createHeightmap, setColumn } from '@terrace/shared';
import { loadConfig } from '../src/config.ts';
import type { SnapshotStore } from '../src/persistence/snapshot-store.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';

const EXIT_USAGE = 2;

function usage(): void {
  console.error(
    [
      'Usage:',
      '  node scripts/rollback.ts list [--world <id>]       list the restore points, newest first',
      '  node scripts/rollback.ts to <id> [--world <id>]    roll the world back to that restore point',
      '',
      'The world is the one the server loads (its active world in $WORLDS_DIR) unless --world names another.',
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

  // Repack the decoded columns exactly as a live world does, so caves and arches survive.
  const map = createHeightmap(target.worldSize);
  map.cells.set(target.cells);
  for (const [i, spans] of target.columnSpans) {
    setColumn(map, cellX(target.worldSize, i), cellY(target.worldSize, i), spans);
  }

  const newId = store.saveSnapshot({
    worldSize: target.worldSize,
    name: target.name ?? '',
    cells: target.cells,
    columnSpans: map.columnSpans,
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
  const args = process.argv.slice(2);
  const worldFlag = args.indexOf('--world');
  const named = worldFlag === -1 ? undefined : args[worldFlag + 1];
  const [command, argument] = worldFlag === -1 ? args : args.filter((_, i) => i < worldFlag || i > worldFlag + 1);
  if ((command !== 'list' && command !== 'to') || (worldFlag !== -1 && named === undefined)) {
    usage();
    return EXIT_USAGE;
  }

  const config = loadConfig();
  const registry = new WorldRegistry(config.worldsDir);
  const worldId = named ?? registry.readActive();
  if (worldId === null) {
    console.error(`no active world in ${registry.worldsDir} — name one with --world <id>`);
    return EXIT_USAGE;
  }
  if (!registry.has(worldId)) {
    console.error(`no world "${worldId}" in ${registry.worldsDir}`);
    return EXIT_USAGE;
  }
  console.log(`world "${worldId}" (${registry.pathFor(worldId)})`);
  const store = registry.openStore(worldId, config.snapshotRetention);
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
