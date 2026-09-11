// Shared stack for the two GPU-mesher harnesses (mesherParity.mjs,
// mesherBench.mjs): private ports, fresh world + server per capture, one Vite,
// real Chrome over CDP under the machine-wide GPU lock.
//
// Recipe: .claude/orchestration/bench-rules-parallel-agents.md.
import { spawn } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKTREE = resolve(HERE, '..', '..');
export const REPO_ROOT = 'E:/Development/Projects/Terrace';

// Agent H's private resources. Never the owner's 2567 / 5173.
export const SERVER_PORT = 2611;
export const VITE_PORT = 5211;
export const RUN_DIR = join(REPO_ROOT, '.gpu-bench-run', 'gpu-mesher');
export const WORLDS_DIR = join(RUN_DIR, 'worlds');
export const RESULTS_DIR = join(REPO_ROOT, '.gpu-perf', 'results', '2026-09-10-gpu-mesher');

export const GPU_LOCK_DIR = join(REPO_ROOT, '.gpu-bench-run', 'gpu-lock');
export const AGENT_NAME = 'agent-H';

// The world both meshers must see: a Frostwick Hollows snapshot, copied fresh
// for every capture because the server simulates and mutates terrain.
const WORLD_SOURCE_DB = join(WORKTREE, 'bench', 'webgpu-mesher', 'frostwick-gate.db');
const WORLD_ID = 'frostwick-hollows';
const ACTIVE_POINTER_FILE = '.active';
const SQLITE_SIDECAR_SUFFIXES = ['', '-wal', '-shm'];

export const SINK_PATH = join(RUN_DIR, 'sink.jsonl');
const VITE_PID_FILE = join(RUN_DIR, 'vite.pid');
const SERVER_PID_FILE = join(RUN_DIR, 'server.pid');

const CHROME_EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Exactly probe-run-win.mjs's flags and window, so bench numbers stay
// comparable to the 2026-09-09 worker-mesher baseline.
export const CHROME_WINDOW = '1420,1300';
const CHROME_FLAGS = [
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-angle=d3d11', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
];
const CDP_PORT_BASE = 9500;
const CDP_PORT_SPAN = 400;
const CHROME_EXIT_WAIT_MS = 5000;
const CHROME_PROFILE_RM_RETRIES = 3;

const GPU_LOCK_POLL_MS = 10_000;
const GPU_LOCK_STALE_MS = 20 * 60 * 1000;
const CDP_ENDPOINT_POLL_MS = 200;
const CDP_ENDPOINT_POLL_LIMIT = 150;
const SINK_POLL_MS = 100;
const SERVER_BOOT_WAIT_MS = 5000;
const VITE_BOOT_POLL_MS = 250;
const VITE_BOOT_POLL_LIMIT = 120;
const PROCESS_STOP_SETTLE_MS = 2000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ensureDirs = () => {
  for (const dir of [RUN_DIR, WORLDS_DIR, RESULTS_DIR]) mkdirSync(dir, { recursive: true });
};

// --------------------------------------------------------------- GPU lock
export async function acquireGpuLock(log) {
  for (;;) {
    try {
      mkdirSync(GPU_LOCK_DIR);
      writeFileSync(join(GPU_LOCK_DIR, 'owner'), `${AGENT_NAME} ${new Date().toISOString()}`);
      return;
    } catch {
      const heldMs = Date.now() - statCreationMs(GPU_LOCK_DIR);
      if (heldMs > GPU_LOCK_STALE_MS) {
        log(`gpu lock held ${Math.round(heldMs / 1000)} s (> stale limit): removing it`);
        releaseGpuLock();
        continue;
      }
      await sleep(GPU_LOCK_POLL_MS);
    }
  }
}

const statCreationMs = (path) => {
  try {
    return statSync(path).birthtimeMs;
  } catch {
    return Date.now();
  }
};

export const releaseGpuLock = () => {
  rmSync(GPU_LOCK_DIR, { recursive: true, force: true });
};

export async function underGpuLock(log, body) {
  await acquireGpuLock(log);
  try {
    return await body();
  } finally {
    releaseGpuLock();
  }
}

// ------------------------------------------------------------------ world
/** Fresh copy of the snapshot, so every capture starts from identical terrain. */
export function freshWorld() {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    rmSync(join(WORLDS_DIR, `${WORLD_ID}.db${suffix}`), { force: true });
  }
  copyFileSync(WORLD_SOURCE_DB, join(WORLDS_DIR, `${WORLD_ID}.db`));
  writeFileSync(join(WORLDS_DIR, ACTIVE_POINTER_FILE), WORLD_ID);
}

// --------------------------------------------------------------- processes
const spawnDetached = (command, args, cwd, env, outLog, errLog) => {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', openAppend(outLog), openAppend(errLog)],
    windowsHide: true,
  });
  child.unref();
  return child;
};

const openAppend = (path) => openSync(path, 'a');

export function startServer(log) {
  freshWorld();
  const child = spawnDetached(
    process.execPath, ['src/index.ts'], join(WORKTREE, 'server'),
    {
      PORT: String(SERVER_PORT),
      WORLDS_DIR,
      // A DB_PATH that does not exist forces the worlds-dir pointer to decide.
      DB_PATH: join(WORLDS_DIR, 'nonexistent.db'),
    },
    join(RUN_DIR, 'server.log'), join(RUN_DIR, 'server.err.log'),
  );
  writeFileSync(SERVER_PID_FILE, String(child.pid));
  log(`server pid ${child.pid} on :${SERVER_PORT}`);
  return child;
}

export async function startVite(log) {
  const child = spawnDetached(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--port', String(VITE_PORT), '--strictPort', '--host'],
    join(WORKTREE, 'client'),
    { TERRACE_PERF_SINK: SINK_PATH, VITE_SERVER_URL: `ws://localhost:${SERVER_PORT}` },
    join(RUN_DIR, 'vite.log'), join(RUN_DIR, 'vite.err.log'),
  );
  writeFileSync(VITE_PID_FILE, String(child.pid));
  for (let i = 0; i < VITE_BOOT_POLL_LIMIT; i++) {
    try {
      const response = await fetch(`http://localhost:${VITE_PORT}/`);
      if (response.ok) {
        log(`vite pid ${child.pid} serving :${VITE_PORT}`);
        return child;
      }
    } catch { /* not listening yet */ }
    await sleep(VITE_BOOT_POLL_MS);
  }
  throw new Error(`vite never served on :${VITE_PORT}; see ${join(RUN_DIR, 'vite.err.log')}`);
}

export function stopProcess(child, log, what) {
  if (child === null || child.killed) return;
  try {
    process.kill(child.pid);
    log(`stopped ${what} pid ${child.pid}`);
  } catch { /* already gone */ }
}

export const serverSettleWaitMs = SERVER_BOOT_WAIT_MS;
export const processStopSettleMs = PROCESS_STOP_SETTLE_MS;

// ------------------------------------------------------------------- sink
// A character offset, not a line count: the sink ends in a newline, so a line
// count is one too many and silently swallows the first line of the next run.
export const sinkOffset = () =>
  (existsSync(SINK_PATH) ? readFileSync(SINK_PATH, 'utf8').length : 0);

export const sinkLinesSince = (offset) =>
  (existsSync(SINK_PATH) ? readFileSync(SINK_PATH, 'utf8').slice(offset).split('\n') : []);

/**
 * Waits until a sink line matches, or the probe posts an error, or the deadline
 * passes. Resolves `{ line, error }`; `line` is the parsed JSON of the match.
 */
export async function waitForSinkLine(offset, matches, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const raw of sinkLinesSince(offset)) {
      if (raw.trim() === '') continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (parsed.error !== undefined) return { line: null, error: parsed };
      if (matches(parsed)) return { line: parsed, error: null };
    }
    await sleep(SINK_POLL_MS);
  }
  return { line: null, error: { timeout: true, waitedMs: deadlineMs } };
}

// -------------------------------------------------------------------- CDP
export async function launchChrome() {
  const port = CDP_PORT_BASE + Math.floor(Math.random() * CDP_PORT_SPAN);
  const profile = mkdtempSync(join(tmpdir(), 'terrace-mesher-'));
  const chrome = spawn(CHROME_EXE, [
    ...CHROME_FLAGS,
    `--user-data-dir=${profile}`,
    `--window-size=${CHROME_WINDOW}`, '--window-position=0,0',
    `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < CDP_ENDPOINT_POLL_LIMIT && version === null; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(CDP_ENDPOINT_POLL_MS);
    }
  }
  if (version === null) {
    chrome.kill();
    throw new Error('chrome devtools endpoint never came up');
  }

  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  let nextId = 0;
  const waiting = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  });
  const call = (method, params = {}, sessionId) => new Promise((r) => {
    const id = ++nextId;
    waiting.set(id, r);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const { result: { targetId } } = await call('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Page.enable', {}, sessionId);
  await call('Page.bringToFront', {}, sessionId);

  return {
    call: (method, params) => call(method, params, sessionId),
    screenshot: async () => {
      const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
      return Buffer.from(shot.result.data, 'base64');
    },
    // Chrome unlinks its profile lazily, so the directory is removed
    // best-effort after it exits; a leftover temp dir must not fail a run.
    close: async () => {
      try { socket.close(); } catch { /* already closed */ }
      const exited = new Promise((r) => chrome.once('exit', r));
      chrome.kill();
      await Promise.race([exited, sleep(CHROME_EXIT_WAIT_MS)]);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: CHROME_PROFILE_RM_RETRIES });
      } catch { /* Chrome still holds a handle; the OS reclaims %TEMP% */ }
    },
  };
}

export const devUrl = (query) => `http://localhost:${VITE_PORT}/?${query}`;

// ------------------------------------------------------------------- misc
export const argValue = (argv, flag, fallback) => {
  const at = argv.indexOf(flag);
  return at === -1 || at + 1 >= argv.length ? fallback : argv[at + 1];
};

export const makeLogger = (logPath) => {
  mkdirSync(dirname(logPath), { recursive: true });
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };
};
