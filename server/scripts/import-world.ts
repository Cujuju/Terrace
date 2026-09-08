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
