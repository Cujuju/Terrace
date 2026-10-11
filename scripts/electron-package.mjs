// Stages what the desktop package ships beside the app: the built client, and the server as real files.
// The staged tree is server/, shared/, plugins/ and one flat node_modules/, with no symlinks:
// installers do not carry them (server/src/boot/packaged-entry.ts maps the workspace import instead).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(repoRoot, '.electron-stage');
const deployed = path.join(stage, 'deploy');
const stagedServer = path.join(stage, 'server');

/** A plugin's server half needs none of these: client code and its assets are already in the built client. */
const PLUGIN_SKIPPED = new Set(['node_modules', 'client', 'test', 'tsconfig.json', 'vitest.config.ts']);
/** Workspace packages are staged as sources, never as copies under node_modules. */
const WORKSPACE_SCOPE = '@terrace';
/** @colyseus/schema's optional peer: only its codegen CLI loads the compiler, the running server never does. */
const BUILD_ONLY_PACKAGES = ['typescript', '@typescript'];

function run(cmd) {
  console.log(`\n› ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
}

function copySources(packageDir) {
  const to = path.join(stagedServer, packageDir);
  mkdirSync(to, { recursive: true });
  cpSync(path.join(repoRoot, packageDir, 'package.json'), path.join(to, 'package.json'));
  cpSync(path.join(repoRoot, packageDir, 'src'), path.join(to, 'src'), { recursive: true });
}

console.log('[stage] clean');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stagedServer, { recursive: true });

console.log('[stage] build the client and the desktop main process');
run('pnpm --filter @terrace/client electron:build');

// A hoisted deploy is the server's production dependencies as plain directories.
console.log('[stage] deploy the server dependencies');
run(
  `pnpm --filter @terrace/server deploy --prod --ignore-scripts --node-linker=hoisted --config.inject-workspace-packages=true "${deployed}"`,
);
cpSync(path.join(deployed, 'node_modules'), path.join(stagedServer, 'node_modules'), {
  recursive: true,
  dereference: true,
});
for (const name of [WORKSPACE_SCOPE, ...BUILD_ONLY_PACKAGES]) {
  rmSync(path.join(stagedServer, 'node_modules', name), { recursive: true, force: true });
}
rmSync(path.join(stagedServer, 'node_modules', '.bin'), { recursive: true, force: true });
rmSync(path.join(stagedServer, 'node_modules', '.modules.yaml'), { force: true });
rmSync(deployed, { recursive: true, force: true });

console.log('[stage] copy server, shared and plugin sources');
copySources('server');
copySources('shared');
for (const plugin of readdirSync(path.join(repoRoot, 'plugins'), { withFileTypes: true })) {
  if (!plugin.isDirectory()) continue;
  cpSync(path.join(repoRoot, 'plugins', plugin.name), path.join(stagedServer, 'plugins', plugin.name), {
    recursive: true,
    filter: (source) => !PLUGIN_SKIPPED.has(path.basename(source)),
  });
}

const mustExist = [
  path.join(stagedServer, 'server', 'src', 'boot', 'packaged-entry.ts'),
  path.join(stagedServer, 'shared', 'src', 'index.ts'),
  path.join(stagedServer, 'node_modules', '@colyseus', 'core'),
  // Node-API prebuild: ABI-stable, so no rebuild against Electron.
  path.join(stagedServer, 'node_modules', 'better-sqlite3', 'prebuilds', `${process.platform}-${process.arch}.node`),
  path.join(repoRoot, 'client', 'dist', 'index.html'),
  path.join(repoRoot, 'client', 'dist-electron', 'main.js'),
];
for (const p of mustExist) {
  if (!existsSync(p)) {
    console.error(`[stage] MISSING required artifact: ${p}`);
    process.exit(1);
  }
}
console.log(`\n[stage] OK → ${stagedServer}`);
