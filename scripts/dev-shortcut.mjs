// Registers the Start Menu shortcut and interactive Scheduled Task for this repo on Windows.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = {
  name: "Terrace",
  displayName: "Terrace",
  startMenuFolder: 'Dev',
  icon: "client/build/icon.ico",
  tileManifest: "client/build/Terrace.VisualElementsManifest.xml",
  runArgs: ["electron:dev"],
  defaultEnv: [],
  singleInstance: false,
};

if (process.platform !== 'win32') throw new Error('dev:shortcut currently supports Windows only');
if (!process.env.APPDATA || !process.env.SystemRoot) throw new Error('APPDATA and SystemRoot must be set');

const folder = CONFIG.startMenuFolder
  ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', CONFIG.startMenuFolder)
  : path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const shortcutFile = path.join(folder, `${CONFIG.displayName}.lnk`);
const target = path.join(process.env.SystemRoot, 'System32', 'conhost.exe');
const launchScript = path.join(root, 'scripts', 'dev-launch.ps1');
const taskName = `DevApp-${CONFIG.name}`;
const launchParts = [
  '--headless powershell.exe -NoProfile -ExecutionPolicy Bypass',
  `-File "${launchScript}"`,
  `-Name ${CONFIG.name}`,
  `-TaskName ${taskName}`,
  `-RunArgs ${CONFIG.runArgs.join(',')}`,
  ...(CONFIG.defaultEnv.length ? [`-DefaultEnv ${CONFIG.defaultEnv.join(',')}`] : []),
  ...(CONFIG.singleInstance ? ['-SingleInstance'] : []),
];
const tilePath = CONFIG.tileManifest ? path.join(root, CONFIG.tileManifest) : '';
const psArgs = [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(root, 'scripts', 'dev-shortcut.ps1'),
  '-Path', shortcutFile,
  '-Target', target,
  '-Arguments', launchParts.join(' '),
  '-WorkingDirectory', root,
  '-Icon', path.join(root, CONFIG.icon),
  '-AppId', `DevLauncher.${CONFIG.name}`,
  '-Description', `${CONFIG.displayName} (dev)`,
  '-TaskName', taskName,
  ...(tilePath && existsSync(tilePath) ? ['-TileManifest', tilePath] : []),
];
execFileSync('powershell.exe', psArgs, { stdio: 'inherit' });
console.log(`dev:shortcut: wrote ${shortcutFile} and registered task ${taskName}`);
