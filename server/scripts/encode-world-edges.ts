// One-time migration for worlds saved before edge-aware terrain: re-encodes
// every one-span cell's in-band height from its band layout. Bands never change.
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { cellX, cellY, createHeightmap, encodeSmoothedEdges, setColumn } from '@terrace/shared';
import { loadConfig } from '../src/config.ts';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';
import { buildThumbnail } from '../src/persistence/thumbnail.ts';
import { WORLD_FILE_EXTENSION, WorldRegistry } from '../src/persistence/world-registry.ts';

const EXIT_USAGE = 2;

function usage(): void {
  console.error(
    [
      'Usage:',
      '  node scripts/encode-world-edges.ts [--dry-run] [--archived] [world-id ...]',
      '',
      'Re-encodes the newest snapshot of every world in $WORLDS_DIR (or only the ids',
      'given) as a new restore point. --archived also takes worlds in the trash.',
      'Nothing is deleted: the previous snapshot stays a restore point.',
      'STOP THE SERVER FIRST — a running one overwrites its world within the minute.',
    ].join('\n'),
  );
}

interface Outcome {
  readonly id: string;
  readonly cells: number;
  readonly written: number | null;
}

function encodeWorld(store: SnapshotStore, id: string, dryRun: boolean): Outcome | null {
  const latest = store.loadLatest();
  if (latest === null) return null;
  const map = createHeightmap(latest.worldSize);
  map.cells.set(latest.cells);
  for (const [i, spans] of latest.columnSpans) {
    setColumn(map, cellX(map.size, i), cellY(map.size, i), spans);
  }
  const changed = new Set<number>();
  encodeSmoothedEdges(map, 0, 0, map.size - 1, map.size - 1, changed);
  if (dryRun || changed.size === 0) return { id, cells: changed.size, written: null };
  const written = store.saveSnapshot({
    worldSize: latest.worldSize,
    name: latest.name ?? '',
    cells: map.cells,
    mask: latest.mask,
    pluginSlices: latest.pluginSlices,
    tokenMasks: latest.tokenMasks,
    simMillis: latest.simMillis,
    ...(latest.genesisMillis !== null ? { genesisMillis: latest.genesisMillis } : {}),
    columnSpans: map.columnSpans,
    thumbnail: buildThumbnail(map.cells, latest.worldSize),
  });
  return { id, cells: changed.size, written };
}

function main(): number {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const archived = args.includes('--archived');
  const named = args.filter((arg) => !arg.startsWith('--'));
  if (args.some((arg) => arg.startsWith('--') && arg !== '--dry-run' && arg !== '--archived')) {
    usage();
    return EXIT_USAGE;
  }

  const config = loadConfig();
  const registry = new WorldRegistry(config.worldsDir);
  // Read the directories directly: listing through the registry writes thumbnails.
  const idsIn = (dir: string, inTrash: boolean): { id: string; archived: boolean }[] =>
    readdirSync(dir)
      .filter((name) => !name.startsWith('.') && name.endsWith(WORLD_FILE_EXTENSION))
      .map((name) => basename(name, WORLD_FILE_EXTENSION))
      .filter((id) => {
        try {
          return inTrash ? registry.hasArchived(id) : registry.has(id);
        } catch (error) {
          console.warn(`skipping "${id}": ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      })
      .map((id) => ({ id, archived: inTrash }));
  const worlds = [
    ...idsIn(registry.worldsDir, false),
    ...(archived ? idsIn(registry.trashDir, true) : []),
  ].filter((world) => named.length === 0 || named.includes(world.id));
  if (worlds.length === 0) {
    console.error(`no worlds to encode in ${registry.worldsDir}`);
    return named.length === 0 ? 0 : EXIT_USAGE;
  }

  for (const world of worlds) {
    const store = SnapshotStore.open(registry.pathFor(world.id, world.archived), config.snapshotRetention);
    try {
      const outcome = encodeWorld(store, world.id, dryRun);
      if (outcome === null) {
        console.log(`${world.id}: no snapshot yet, nothing to encode`);
      } else if (outcome.written === null) {
        console.log(`${world.id}: ${outcome.cells.toLocaleString()} cells ${dryRun ? 'would change' : 'already encoded'}`);
      } else {
        console.log(`${world.id}: ${outcome.cells.toLocaleString()} cells re-encoded as restore point #${outcome.written}`);
      }
    } finally {
      store.close();
    }
  }
  return 0;
}

process.exitCode = main();
