// `pnpm screenshots`: shoots the showcase world into docs/images/<shot>.png.
// `pnpm screenshots --serve`: boots the showcase world and waits, to frame new shots.
// Options: --world <file.db> (default: showcase.db here), --no-build.
//
// Showcase world: sculpt it in any Terrace server, stop the server, copy its
// worlds/<name>.db here as showcase.db. Save it in daylight (the clock resumes
// from the save) and turn `reveal` off for it, or fresh viewers see locked land.
// Shots: shots.json holds { name, alt, target, position }; --serve prints how
// to copy a framed camera pose from the browser.
//
// Needs a GPU: SwiftShader draws water but no terrain here.
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GPU_FLAGS, sleep, startChrome } from '../../client/scripts/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const IMAGES_DIR = join(ROOT, 'docs', 'images');
const SHOTS_FILE = join(HERE, 'shots.json');
const DEFAULT_WORLD = join(HERE, 'showcase.db');
const CLIENT_DIST = join(ROOT, 'client', 'dist');
const WORLD_ID = 'showcase';
/** README images: 16:9 at 1x so the PNGs stay small in git history. */
const VIEWPORT = { width: 1600, height: 900 };
/** The HUD's connection badge once the room is joined (client/src/ui/HudSettings.tsx). */
const CONNECTED_SELECTOR = '[aria-label="Connection: Connected"]';
const SERVER_READY_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 120_000;
const CONNECT_POLL_MS = 500;
/** Margin after joining for terrain meshes and plugin models to stream in; not measured, generous by choice. */
const SETTLE_MS = 20_000;
/** The always-on version/frame-rate watermark (client/src/ui/VersionWatermark.tsx) is developer telemetry, not game UI. */
const HIDE_CSS = '.hud-version { display: none !important; }';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const serveOnly = flag('--serve');
const worldFile = resolve(option('--world') ?? DEFAULT_WORLD);

if (!existsSync(worldFile)) {
  console.error(`No showcase world at ${worldFile}. See the header of scripts/screenshots/capture.mjs.`);
  process.exit(1);
}

const serverRequire = createRequire(join(ROOT, 'server', 'package.json'));
const Database = serverRequire('better-sqlite3');
const { WorldRegistry } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'persistence', 'world-registry.ts')).href);
const { CAMERA_POSE_KEY_PREFIX, cameraPoseStorageKey, parseCameraPose, serialiseCameraPose } = await import(
  pathToFileURL(join(ROOT, 'client', 'src', 'render', 'cameraPose.ts')).href
);

function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

/** Copies the world through SQLite's backup API, so un-checkpointed WAL pages come along. */
async function stageWorld(worldsDir) {
  mkdirSync(worldsDir, { recursive: true });
  const source = new Database(worldFile, { readonly: true, fileMustExist: true });
  try {
    await source.backup(join(worldsDir, `${WORLD_ID}.db`));
  } finally {
    source.close();
  }
  const registry = new WorldRegistry(worldsDir);
  writeFileSync(join(worldsDir, '.active'), WORLD_ID);
  const summary = registry.list(WORLD_ID).find((w) => w.id === WORLD_ID);
  if (!summary || summary.unreadable) throw new Error(`Showcase world unreadable: ${summary?.unreadable ?? 'missing'}`);
  return summary.worldSize;
}

function startServer(port, stageDir) {
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(port),
      WORLDS_DIR: join(stageDir, 'worlds'),
      // Points away from any legacy world.db so boot adopts nothing.
      DB_PATH: join(stageDir, 'no-legacy-world.db'),
      CLIENT_DIST_PATH: CLIENT_DIST,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  const ready = new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`Server not listening after ${SERVER_READY_TIMEOUT_MS}ms:\n${log.join('')}`)), SERVER_READY_TIMEOUT_MS);
    const onData = (chunk) => {
      log.push(chunk.toString());
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer);
        ok();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`Server exited (${code}) before listening:\n${log.join('')}`));
    });
  });
  return { child, ready };
}

function loadShots(worldSize) {
  const { shots } = JSON.parse(readFileSync(SHOTS_FILE, 'utf8'));
  for (const shot of shots) {
    // The client silently ignores a pose it rejects, so check with its own parser first.
    if (parseCameraPose(serialiseCameraPose(shot), worldSize) === null) {
      throw new Error(`Shot "${shot.name}": pose rejected by the client (distance or target out of range).`);
    }
  }
  return shots;
}

async function shoot(chrome, url, poseKey, shot) {
  const tab = await chrome.openTab();
  try {
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem(${JSON.stringify(poseKey)}, ${JSON.stringify(serialiseCameraPose(shot))});`,
    });
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(HIDE_CSS)}; document.head.append(s); });`,
    });
    await tab.send('Page.navigate', { url });
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (!(await tab.evaluate(`document.querySelector(${JSON.stringify(CONNECTED_SELECTOR)}) !== null`).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Shot "${shot.name}": not connected after ${CONNECT_TIMEOUT_MS}ms`);
      await sleep(CONNECT_POLL_MS);
    }
    await sleep(SETTLE_MS);
    const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
    const file = join(IMAGES_DIR, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`wrote ${file}`);
  } finally {
    await tab.close();
  }
}

if (!flag('--no-build')) {
  // A command string, not argv: Windows runs pnpm through a .cmd shim, which needs a shell.
  execSync('pnpm --filter @terrace/client build', { cwd: ROOT, stdio: 'inherit' });
}

const stageDir = mkdtempSync(join(tmpdir(), 'terrace-screenshots-'));
let server;
let chrome;
// Waits for both processes to exit: Windows keeps their files locked until then.
const cleanup = async () => {
  await chrome?.close();
  if (server && server.child.exitCode === null) {
    const exited = new Promise((r) => server.child.once('exit', r));
    server.child.kill();
    await exited;
  }
  try {
    rmSync(stageDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {}
};
process.on('SIGINT', () => {
  void cleanup().then(() => process.exit(130));
});

try {
  const worldSize = await stageWorld(join(stageDir, 'worlds'));
  const shots = serveOnly ? [] : loadShots(worldSize);
  const port = await freePort();
  // The built client dials ws://<page host>, which is also its camera-pose storage key.
  const host = `localhost:${port}`;
  server = startServer(port, stageDir);
  await server.ready;
  if (serveOnly) {
    console.log(`\nShowcase world at http://${host} (a copy; edits are thrown away). Ctrl-C stops it.`);
    console.log(`Frame a shot, then copy its pose from the browser console:`);
    console.log(`  copy(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('${CAMERA_POSE_KEY_PREFIX}'))))\n`);
    await new Promise(() => {});
  }
  mkdirSync(IMAGES_DIR, { recursive: true });
  chrome = await startChrome({ ...VIEWPORT, flags: GPU_FLAGS });
  const poseKey = cameraPoseStorageKey(`ws://${host}`, worldSize);
  for (const shot of shots) await shoot(chrome, `http://${host}`, poseKey, shot);
} finally {
  await cleanup();
}
process.exit(0);
