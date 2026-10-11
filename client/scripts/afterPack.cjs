// electron-builder strips node_modules out of extraResources; this copies the staged server's back and checks the package is whole.
const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');
const { Arch } = require('electron-builder');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName, arch } = context;
  const staged = path.join(packager.projectDir, '..', '.electron-stage', 'server', 'node_modules');
  if (!existsSync(staged)) {
    throw new Error(`[afterPack] staged node_modules missing: ${staged}. Run scripts/electron-package.mjs first.`);
  }
  // macOS keeps resources inside the bundle.
  const resources =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  const dest = path.join(resources, 'server', 'node_modules');
  if (!existsSync(dest)) cpSync(staged, dest, { recursive: true, dereference: true });

  const mustExist = [
    // The Node-API prebuild for the packaged platform and architecture.
    path.join(dest, 'better-sqlite3', 'prebuilds', `${electronPlatformName}-${Arch[arch]}.node`),
    path.join(dest, '@colyseus', 'core'),
    path.join(resources, 'server', 'server', 'src', 'boot', 'packaged-entry.ts'),
    path.join(resources, 'server', 'shared', 'src', 'index.ts'),
    path.join(resources, 'server', 'plugins'),
    path.join(resources, 'renderer', 'index.html'),
  ];
  for (const p of mustExist) {
    if (!existsSync(p)) throw new Error(`[afterPack] packaged app is missing a required artifact: ${p}`);
  }
  console.log('[afterPack] server node_modules restored and artifacts verified');
};
