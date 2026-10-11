// Terrace desktop packages. The app is client/; the server child ships as extraResources, staged by scripts/electron-package.mjs.
import type { Configuration } from 'electron-builder';
import { appVersion } from '../server/src/app-version.ts';

const config: Configuration = {
  // Also the Windows AUMID main sets (electron/appEnv.ts APP_ID).
  appId: 'com.cujuju.terrace',
  productName: 'Terrace',
  copyright: 'Cujuju',
  // package.json carries no version; the packaged app, installer and Windows file version take git's.
  extraMetadata: { version: appVersion(import.meta.dirname) },
  // No electronVersion: electron-builder reads the installed `electron`, so it cannot drift.
  directories: { output: '../release', buildResources: 'build' },
  // The asar holds the built main process and the preload it loads by path. An unlisted file is silently absent.
  files: ['dist-electron/**/*', 'electron/preload.cjs', 'package.json', '!node_modules/**/*'],
  // Real files under resources/: the server runs TypeScript sources and a native module, neither loadable from asar.
  extraResources: [
    { from: 'dist', to: 'renderer', filter: ['**/*'] },
    { from: '../.electron-stage/server', to: 'server', filter: ['**/*'] },
  ],
  asar: true,
  // The asar ships no node_modules, and the server's native module is a Node-API prebuild.
  npmRebuild: false,
  // electron-builder strips node_modules from extraResources; this copies the staged server's back.
  afterPack: 'scripts/afterPack.cjs',
  // Installers and latest*.yml go to public releases, which the app reads without a token.
  publish: { provider: 'github', owner: 'Cujuju', repo: 'Terrace', releaseType: 'release' },
  win: {
    target: 'nsis',
    // build/icon.* is build/icons/monogram.png; terraces and island there are the owner's alternates.
    icon: 'build/icon.ico',
    // The tray icon loads from disk, which needs an unpacked file.
    extraResources: [{ from: 'build/icon.ico', to: 'icon.ico' }],
    // Start tile: Windows reads <exe name>.VisualElementsManifest.xml beside the exe; its logo paths are relative to it.
    extraFiles: [
      { from: 'build/Terrace.VisualElementsManifest.xml', to: 'Terrace.VisualElementsManifest.xml' },
      { from: 'build/tiles', to: 'tiles' },
    ],
  },
  mac: {
    // The disk image is the first install; the zip is what the app's own updater downloads (electron/macUpdate.ts).
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    // Converted to .icns by electron-builder.
    icon: 'build/icon.png',
    category: 'public.app-category.simulation-games',
    // Ad-hoc: Apple silicon runs no unsigned code, and no developer certificate is used.
    identity: '-',
    // Library validation refuses the app's own frameworks under an ad-hoc signature.
    hardenedRuntime: false,
    // The updater picks its zip by the architecture in the name.
    artifactName: '${productName}-${version}-${arch}-mac.${ext}',
    extraResources: [{ from: 'build/icon.png', to: 'icon.png' }],
  },
  dmg: { artifactName: '${productName}-${version}-${arch}.${ext}' },
  // Per-user install (no admin prompt) with a choice of folder.
  nsis: {
    // No spaces: the release uploads it under this name, which latest.yml's url must match.
    artifactName: '${productName}-Setup-${version}.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Terrace',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    include: 'build/installer.nsh',
  },
};

export default config;
