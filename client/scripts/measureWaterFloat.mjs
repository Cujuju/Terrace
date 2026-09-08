import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChromeHeadlessShell } from './chromeHeadlessShell.mjs';

const CHROME = resolveChromeHeadlessShell();

const DEFAULT_URL_BASE = 'http://localhost:5173';
const DEFAULT_SCENES = ['fork', 'meander', 'terrace', 'basin', 'stairpools'];

const BUCKET_BANDS = 1 / 8;
const RIVER_SURFACE_LIFT_WORLD_UNITS = 1 / 64;
const FAIL_GAP_WORLD_UNITS = RIVER_SURFACE_LIFT_WORLD_UNITS * 2;

const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 60_000;
const CHROME_ENDPOINT_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  let urlBase = DEFAULT_URL_BASE;
  const scenes = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url-base') {
      urlBase = argv[++i];
      if (!urlBase) throw new Error('--url-base needs a value');
    } else {
      scenes.push(argv[i]);
    }
  }
  return { urlBase, scenes: scenes.length > 0 ? scenes : DEFAULT_SCENES };
}

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
  const profile = mkdtempSync(join(tmpdir(), 'water-float-'));
  const child = spawn(
    CHROME,
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
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

function buildProbe(bandWorldHeight, bucketBands) {
  const bucketWorld = bandWorldHeight * bucketBands;
  return `(() => {
  const BUCKET_WORLD = ${bucketWorld};
  const scene = window.__previewScene;
  const terrain = window.__previewTerrain;
  const pickY = window.__previewPickY;
  if (!scene || !terrain || !pickY) return { error: 'preview globals missing' };

  // THREE is module-scoped in the bundle (no window.THREE), so transform
  // local->world manually from the mesh's matrixWorld elements.

  // Every mesh outside the terrain group: the water ribbons and rig geometry.
  const meshes = [];
  const walk = (obj, insideTerrain) => {
    for (const child of obj.children) {
      const inT = insideTerrain || child === terrain;
      if (!inT && child.isMesh && child.geometry && child.geometry.attributes.position) meshes.push(child);
      walk(child, inT);
    }
  };
  walk(scene, false);

  const gaps = [];
  let noGround = 0;
  const xform = (mesh, x, y, z) => {
    const e = mesh.matrixWorld.elements;
    return [
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
    ];
  };
  for (const mesh of meshes) {
    const attr = mesh.geometry.attributes.position;
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < attr.count; i++) {
      const [wx, wy, wz] = xform(mesh, attr.getX(i), attr.getY(i), attr.getZ(i));
      const gy = pickY(wx, wz);
      if (gy === null || gy === undefined) { noGround++; continue; }
      gaps.push(wy - gy);
    }
  }

  // Histogram in buckets of BUCKET_WORLD units, keyed by bucket index.
  const hist = new Map();
  let maxAbove = 0, maxBelow = 0, worst = 0;
  for (const g of gaps) {
    const key = Math.floor(g / BUCKET_WORLD);
    hist.set(key, (hist.get(key) || 0) + 1);
    if (g > maxAbove) maxAbove = g;
    if (g < maxBelow) maxBelow = g;
    if (Math.abs(g) > Math.abs(worst)) worst = g;
  }
  const sorted = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  return {
    vertices: gaps.length + noGround,
    counted: gaps.length,
    noGround,
    maxAbove,
    maxBelow,
    worst,
    histogram: sorted.map(([k, n]) => ({
      lowBand: +(k * BUCKET_WORLD / ${bandWorldHeight}).toFixed(3),
      highBand: +((k + 1) * BUCKET_WORLD / ${bandWorldHeight}).toFixed(3),
      count: n,
    })),
  };
})()`;
}

async function measureScene(ws, urlBase, scene) {
  const url = `${urlBase}/preview-rivers.html?scene=${scene}&view=iso`;
  const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await rpc(ws, 'Page.enable', {}, sessionId);
  await rpc(ws, 'Runtime.enable', {}, sessionId);
  await rpc(ws, 'Page.navigate', { url }, sessionId);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(READY_POLL_INTERVAL_MS);
    try {
      const res = await rpc(
        ws,
        'Runtime.evaluate',
        { expression: 'window.__previewReady === true', returnByValue: true },
        sessionId,
      );
      if (res.result?.value === true) {
        ready = true;
        break;
      }
    } catch {
    }
  }
  if (!ready) {
    await rpc(ws, 'Target.closeTarget', { targetId }).catch(() => {});
    throw new Error(`${scene}: __previewReady not set within ${(READY_TIMEOUT_MS / 1000) | 0}s`);
  }

  const bandRes = await rpc(
    ws,
    'Runtime.evaluate',
    {
      expression:
        '(async () => (await import("/src/config.ts")).BAND_WORLD_HEIGHT)()',
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  if (bandRes.result?.value == null) {
    throw new Error(
      `could not read BAND_WORLD_HEIGHT: ${JSON.stringify(bandRes.exceptionDetails ?? bandRes)}`,
    );
  }
  const result = await rpc(
    ws,
    'Runtime.evaluate',
    { expression: buildProbe(bandRes.result.value, BUCKET_BANDS), returnByValue: true },
    sessionId,
  );
  await rpc(ws, 'Target.closeTarget', { targetId }).catch(() => {});
  if (result.exceptionDetails) {
    throw new Error(`${scene}: probe threw: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}

function report(scene, m) {
  console.log(`\n=== ${scene} ===`);
  if (m.error) {
    console.log(`ERROR: ${m.error}`);
    return false;
  }
  console.log(`vertices measured: ${m.vertices} (${m.noGround} with no terrain under them)`);
  console.log('gap histogram (bands above drawn ground):');
  for (const row of m.histogram) {
    const bar = '#'.repeat(Math.min(60, Math.ceil((row.count / m.counted) * 60)));
    console.log(
      `  ${row.lowBand >= 0 ? '+' : ''}${row.lowBand.toFixed(3)} … ${
        row.highBand >= 0 ? '+' : ''
      }${row.highBand.toFixed(3)}: ${String(row.count).padStart(6)}  ${bar}`,
    );
  }
  console.log(`max above ground: ${m.maxAbove.toFixed(4)} wu`);
  console.log(`max below ground: ${m.maxBelow.toFixed(4)} wu`);
  const pass = Math.abs(m.worst) <= FAIL_GAP_WORLD_UNITS;
  console.log(pass ? 'PASS' : 'FAIL');
  return pass;
}

const { urlBase, scenes } = parseArgs(process.argv.slice(2));

try {
  await fetch(urlBase, { method: 'HEAD' });
} catch {
  console.error(`No dev server reachable at ${urlBase}.`);
  console.error('Start it first (e.g. `pnpm --dir client dev`) and re-run this script.');
  process.exit(2);
}

const { ws, cleanup } = await startChrome();
let allPass = true;
try {
  for (const scene of scenes) {
    const m = await measureScene(ws, urlBase, scene);
    allPass = report(scene, m) && allPass;
  }
} finally {
  ws.close();
  cleanup();
}
console.log(allPass ? '\nALL SCENES PASS' : '\nSOME SCENES FAIL');
process.exit(allPass ? 0 : 1);
