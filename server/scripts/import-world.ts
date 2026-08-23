// Import an existing Terrace world database into the worlds folder.
//
//   pnpm --dir server import-world <path-to-world.db> [name]
//
// FOR THE WORLDS THAT ARE NOT WHERE THE SERVER LOOKS. The boot path already
// adopts the legacy `DB_PATH` file automatically; this is for everything else —
// a world from a git worktree, a copy off a backup drive, a `perf-2048.db` that
// turned out to hold a world somebody cared about.
//
// IT COPIES. The file you point it at is never moved, never modified and never
// deleted, so running this against a world you are unsure about costs a copy
// and nothing else. That is the same rule the automatic migration follows, for
// the same reason: a migration that moves has to be right the first time.
//
// Refuses rather than overwrites: if a world of that name is already in the
// folder, it says so and stops. Pass an explicit name to import a second copy
// under a different one.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { logError, logInfo } from '../src/log.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';

function usage(): never {
  logError('usage: pnpm --dir server import-world <path-to-world.db> [name]');
  process.exit(1);
}

const [sourceArg, nameArg] = process.argv.slice(2);
if (sourceArg === undefined) usage();

const source = resolve(sourceArg);
if (!existsSync(source)) {
  logError(`no such file: ${source}`);
  process.exit(1);
}

const config = loadConfig();
const registry = new WorldRegistry(config.worldsDir);

const imported = registry.adopt(source, nameArg ?? null);
if (imported === null) {
  logError(
    `${source} was not imported. Either it is not a readable Terrace world, or a world ` +
      'of its name is already here (pass a different name to import it anyway).',
  );
  process.exit(1);
}

const summary = registry.summaryFor(imported, null);
logInfo(
  `imported "${summary?.name ?? imported}" as ${imported} ` +
    `(${summary?.worldSize ?? '?'}², ${summary?.restorePoints ?? 0} restore points)`,
);
logInfo(`the original at ${source} was NOT modified`);
