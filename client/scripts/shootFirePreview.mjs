// shootFirePreview.mjs — screenshot driver for preview-fire.html.
//
// Drives chrome-headless-shell over raw CDP, exactly as measureWaterFloat.mjs
// does and for the same reason: Chrome's --screenshot one-shot flag and
// --virtual-time-budget both HANG on these WebGL harnesses (they never wait for
// the requestAnimationFrame loop), and Chrome DevTools MCP cannot get a GL
// context here at all. Raw CDP plus polling window.__previewReady is the only
// thing that works.
//
// Every shot also reports the frame's DRAW-CALL COUNT, read off the renderer
// through window.__previewDrawCalls: the flame's budget rule is a fixed small
// number of calls whatever is burning, and a claim about that which is not read
// off the renderer is a guess.
//
// Usage:
//   node client/scripts/shootFirePreview.mjs <outDir> [--url-base http://localhost:5477] \
//        <name>=<preview-fire query string> ...
//
// Requires a Vite dev server already serving the client at <url-base>; this
// script never starts or stops one.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Resolved, never written down — see that module's header for why.
import { resolveChromeHeadlessShell } from './chromeHeadlessShell.mjs';

const CHROME = resolveChromeHeadlessShell();

const DEFAULT_URL_BASE = 'http://localhost:5477';
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 120_000;
const CHROME_ENDPOINT_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`chrome devtools endpoint did not come up within ${timeoutMs}ms`);
}

let nextId = 1;
function rpc(ws, method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function startChrome() {
  const port = 9333 + Math.floor(Math.random() * 300);
  const profile = mkdtempSync(join(tmpdir(), 'fire-shot-'));
  const child = spawn(
    CHROME,
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Software GL is required in this environment (no real GPU).
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `--user-data-dir=${profile}`,
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.stderr.resume();
  const cleanup = () => {
    try {
      child.kill('SIGKILL');
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  };
  process.on('exit', cleanup);
  const wsUrl = await waitForEndpoint(port, CHROME_ENDPOINT_TIMEOUT_MS);
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  return { ws, cleanup };
}

async function shoot(ws, urlBase, name, query, outDir) {
  const url = `${urlBase}/preview-fire.html?${query}`;
  const { targetId } = await rpc(ws, 'Target.createTarget', {
    url: 'about:blank',
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
  });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await rpc(ws, 'Page.enable', {}, sessionId);
  await rpc(ws, 'Runtime.enable', {}, sessionId);
  await rpc(
    ws,
    'Emulation.setDeviceMetricsOverride',
    { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await rpc(ws, 'Page.navigate', { url }, sessionId);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let stats = null;
  while (Date.now() < deadline) {
    await sleep(READY_POLL_INTERVAL_MS);
    try {
      const res = await rpc(
        ws,
        'Runtime.evaluate',
        {
          expression:
            'window.__previewReady === true ? {calls: window.__previewDrawCalls, columns: window.__previewSmokeColumns, cameraDistance: window.__previewCameraDistance} : null',
          returnByValue: true,
        },
        sessionId,
      );
      if (res.result?.value) {
        stats = res.result.value;
        break;
      }
    } catch {
      // still navigating; keep polling
    }
  }
  if (stats === null) {
    await rpc(ws, 'Target.closeTarget', { targetId }).catch(() => {});
    throw new Error(`${name}: __previewReady not set within ${(READY_TIMEOUT_MS / 1000) | 0}s`);
  }

  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
  const path = join(outDir, `${name}.png`);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  await rpc(ws, 'Target.closeTarget', { targetId }).catch(() => {});
  // The camera distance is reported in WORLD UNITS because smoke's strength is
  // a function of exactly that, and ?dist is a multiplier of a fitted distance
  // nobody can read off a picture.
  console.log(
    `${path}  drawCalls=${stats.calls}  smokeColumns=${stats.columns}` +
      `  cameraDistance=${stats.cameraDistance?.toFixed(1)}  ${url}`,
  );
}

const argv = process.argv.slice(2);
let urlBase = DEFAULT_URL_BASE;
const shots = [];
let outDir = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url-base') {
    urlBase = argv[++i];
  } else if (outDir === null) {
    outDir = argv[i];
  } else {
    const eq = argv[i].indexOf('=');
    shots.push({ name: argv[i].slice(0, eq), query: argv[i].slice(eq + 1) });
  }
}
if (outDir === null || shots.length === 0) {
  console.error('usage: shootFirePreview.mjs <outDir> [--url-base URL] <name>=<query> ...');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

try {
  await fetch(urlBase, { method: 'HEAD' });
} catch {
  console.error(`No dev server reachable at ${urlBase}.`);
  process.exit(2);
}

const { ws, cleanup } = await startChrome();
try {
  for (const { name, query } of shots) await shoot(ws, urlBase, name, query, outDir);
} finally {
  ws.close();
  cleanup();
}
process.exit(0);
