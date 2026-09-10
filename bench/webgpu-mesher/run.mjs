// Gate 1 driver. Serves this directory, drives headless Chrome over the
// DevTools protocol, and writes results.json, gpu.png, cpu.png, diff.png and
// report.md. Nothing here runs unless the owner runs it.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng } from './png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME_BY_PLATFORM = {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
};
const CHROME = process.env.GATE1_CHROME ?? CHROME_BY_PLATFORM[process.platform];
// D3D11 is the ANGLE backend the shipped bench recorded; only Windows has it.
const PLATFORM_CHROME_FLAGS = process.platform === 'win32' ? ['--use-angle=d3d11'] : [];
// `--serve [port]`: serve the page for a visible browser and stay up. No
// self-checks, no Chrome, no results. For the gate 2 battery run.
const SERVE_FLAG_INDEX = process.argv.indexOf('--serve');
const SERVE_PORT = SERVE_FLAG_INDEX === -1 ? null : Number(process.argv[SERVE_FLAG_INDEX + 1] ?? 9320);
const [VIEWPORT_WIDTH, VIEWPORT_HEIGHT] = [1200, 900];
const [CDP_PORT_BASE, CDP_PORT_SPAN] = [9500, 400];
const [READY_POLL_MS, READY_POLL_LIMIT, READY_SLICE_MS] = [500, 600, 5000];
const [ENDPOINT_POLL_MS, ENDPOINT_POLL_LIMIT] = [250, 200];
const [CONTEXT_POLL_MS, CONTEXT_POLL_LIMIT] = [100, 300];
const [PIXEL_TOLERANCE, MAX_MISMATCH_FRACTION, NEIGHBOURHOOD_RADIUS] = [8, 0.001, 1];
const CHANNELS = 4;
const [DIFF_DIM_FACTOR, DIFF_MARK] = [0.35, [255, 32, 32]];

// Pass numbers from the terrain handoff, owner's RTX 3090.
const [PASS_COMPUTE_PER_CHUNK_MS, PASS_REBUILD_MS, PASS_DRAW_P50_MS] = [0.1, 50, 1];
const PASS_RESIDENT_BYTES = 207 * 1e6;

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.json': 'application/json' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const node = (script) => {
  const result = spawnSync(process.execPath, [join(HERE, script)], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${script} exited ${result.status}`);
};

if (!existsSync(join(HERE, 'meta.json'))) node('dump.mjs');
if (SERVE_PORT === null) node('selfcheck.mjs');
const meta = JSON.parse(readFileSync(join(HERE, 'meta.json'), 'utf8'));

// ------------------------------------------------------------------- server
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
  const file = join(HERE, path === '/' ? 'mesher.html' : path.slice(1));
  // join() yields backslashes on Windows; compare both sides resolved.
  if (!resolve(file).startsWith(resolve(HERE)) || !existsSync(file)) {
    response.writeHead(404);
    response.end('no');
    return;
  }
  const extension = file.slice(file.lastIndexOf('.'));
  response.writeHead(200, { 'content-type': MIME[extension] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});
if (SERVE_PORT !== null) {
  await new Promise((resolve) => server.listen(SERVE_PORT, '127.0.0.1', resolve));
  console.log(`serving http://127.0.0.1:${SERVE_PORT}/mesher.html?src=gpu&loop=1&edit=100  (Ctrl-C to stop)`);
  await new Promise(() => {});
}
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// ------------------------------------------------------------------- chrome
const cdpPort = CDP_PORT_BASE + Math.floor(Math.random() * CDP_PORT_SPAN);
const profile = mkdtempSync(join(tmpdir(), 'gate1-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-webgpu', ...PLATFORM_CHROME_FLAGS,
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
  `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
  `--remote-debugging-port=${cdpPort}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.resume();

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* transient lock */ }
  try { server.close(); } catch { /* already closed */ }
};
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < ENDPOINT_POLL_LIMIT && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    await sleep(ENDPOINT_POLL_MS);
  }
}
if (!wsUrl) throw new Error('chrome devtools endpoint never came up');

const socket = new WebSocket(wsUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
let nextId = 1;
const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  const listener = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== id) return;
    socket.removeEventListener('message', listener);
    if (message.error) reject(new Error(`${method}: ${message.error.message}`));
    else resolve(message.result);
  };
  socket.addEventListener('message', listener);
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const logs = [];
// Runtime.evaluate with no context binds to whichever context the browser
// considers default, which after an about:blank -> http navigation can still be
// the discarded first document. Pin every evaluate to the context the page's
// own document announced instead.
const contexts = new Map();
const mainFrames = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  const { method, params, sessionId } = message;
  if (method === 'Runtime.executionContextCreated' && sessionId
    && params.context.auxData?.isDefault !== false
    && params.context.auxData?.frameId === mainFrames.get(sessionId)) {
    contexts.set(sessionId, params.context.uniqueId);
  }
  if (method === 'Runtime.executionContextsCleared' && sessionId) contexts.delete(sessionId);
  if (method === 'Log.entryAdded') logs.push(`${params.entry.level} ${params.entry.text}`);
  if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
    logs.push('CONSOLE ' + params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION ' + (params.exceptionDetails.exception?.description
      ?? params.exceptionDetails.text));
  }
});

const printLogs = () => {
  for (const line of logs) console.error('page log: ' + line);
  writeFileSync(join(HERE, 'page.log'), logs.join(EOL));
};
const fatal = (error) => {
  console.error('gate1 failed: ' + (error?.stack ?? error));
  printLogs();
  cleanup();
  process.exit(2);
};
process.on('unhandledRejection', fatal);
process.on('uncaughtException', fatal);

const openPage = async (query) => {
  // The blank first document exists so Page/Runtime/Log are enabled before the
  // real one loads and no early log entry is missed.
  const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true });
  await rpc('Page.enable', {}, sessionId);
  await rpc('Runtime.enable', {}, sessionId);
  await rpc('Log.enable', {}, sessionId).catch(() => {});
  await rpc('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  const { frameTree } = await rpc('Page.getFrameTree', {}, sessionId);
  mainFrames.set(sessionId, frameTree.frame.id);
  const url = `http://127.0.0.1:${port}/mesher.html?src=${query}`;
  // Forget the blank document's context, then take the next one announced:
  // that is the mesher document's own, and every evaluate is pinned to it.
  contexts.delete(sessionId);
  await rpc('Page.navigate', { url }, sessionId);
  for (let i = 0; i < CONTEXT_POLL_LIMIT && !contexts.has(sessionId); i++) {
    await sleep(CONTEXT_POLL_MS);
  }
  if (!contexts.has(sessionId)) throw new Error(`no execution context for ${url}`);
  return { targetId, sessionId, url };
};

const evaluate = async (sessionId, expression) => {
  const uniqueContextId = contexts.get(sessionId);
  if (uniqueContextId === undefined) throw new Error('page execution context is gone');
  const result = await rpc('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, uniqueContextId,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
};

// What the page thinks it is, for a failure message that names the document.
const pageState = (sessionId) => evaluate(sessionId, `JSON.stringify({
  href: location.href, readyState: document.readyState,
  hasReady: typeof window.__ready, error: window.__error ?? null,
})`).catch((error) => `unreadable: ${error.message}`);

const awaitReady = async (sessionId) => {
  for (let i = 0; i < READY_POLL_LIMIT; i++) {
    const error = await evaluate(sessionId, 'window.__error ?? null');
    if (error) {
      printLogs();
      throw new Error('page: ' + error);
    }
    // Await __ready in slices so a wedged page surfaces as a timeout here
    // rather than hanging the driver on one never-settling promise.
    const ready = await evaluate(sessionId, `window.__ready === undefined ? null : Promise.race([
      window.__ready.then(() => true, () => false),
      new Promise((r) => setTimeout(() => r('pending'), ${READY_SLICE_MS})),
    ])`);
    if (ready === true) return;
    if (ready === false) {
      printLogs();
      throw new Error(`page boot failed; state ${await pageState(sessionId)}`);
    }
    if (ready === null) await sleep(READY_POLL_MS);
  }
  printLogs();
  throw new Error(`page never became ready; state ${await pageState(sessionId)}`);
};

// A WebGPU validation error arrives after boot, so re-check before trusting
// any measurement taken from the page.
const assertNoPageError = async (sessionId, phase) => {
  const error = await evaluate(sessionId, 'window.__error ?? null');
  if (error) {
    printLogs();
    throw new Error(`page reported an error after ${phase}: ${error}`);
  }
};

const screenshot = async (sessionId, name) => {
  await evaluate(sessionId, 'window.__present()');
  const shot = await rpc('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  const bytes = Buffer.from(shot.data, 'base64');
  writeFileSync(join(HERE, name), bytes);
  return decodePng(bytes);
};

// --------------------------------------------------------------------- runs
const results = { world: meta, sources: {}, pageLogs: [] };

const gpu = await openPage('gpu');
await awaitReady(gpu.sessionId);
results.sources.gpu = await evaluate(gpu.sessionId, 'window.__timings()');
results.parity = await evaluate(gpu.sessionId, 'window.__bandPass()');
await assertNoPageError(gpu.sessionId, 'the gpu measurement');
if (results.sources.gpu.triangles === 0) throw new Error('gpu mesh is empty');
const gpuImage = await screenshot(gpu.sessionId, 'gpu.png');
await rpc('Target.closeTarget', { targetId: gpu.targetId });

const cpu = await openPage('cpu');
await awaitReady(cpu.sessionId);
results.sources.cpu = await evaluate(cpu.sessionId, 'window.__timings()');
// The shipped mesher measured against the very same oracle, so a residual
// mismatch can be attributed to the cell lattice rather than to this port.
results.parityCpu = await evaluate(cpu.sessionId, 'window.__bandPass()');
const cpuImage = await screenshot(cpu.sessionId, 'cpu.png');
await rpc('Target.closeTarget', { targetId: cpu.targetId });
const shifted = await openPage('cpu&shift=1');
await awaitReady(shifted.sessionId);
const shiftImage = await screenshot(shifted.sessionId, 'cpu-shift.png');
await rpc('Target.closeTarget', { targetId: shifted.targetId });
results.pageLogs = logs.slice(0, 40);

// ------------------------------------------------------------- pixel compare
// A pixel matches if ANY pixel in the other image's 3x3 neighbourhood is within
// PIXEL_TOLERANCE on every channel. The window absorbs one-pixel contour
// rasterization differences and nothing wider.
const matchesNear = (a, b, width, height, x, y) => {
  const base = (y * width + x) * CHANNELS;
  for (let dy = -NEIGHBOURHOOD_RADIUS; dy <= NEIGHBOURHOOD_RADIUS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -NEIGHBOURHOOD_RADIUS; dx <= NEIGHBOURHOOD_RADIUS; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const other = (ny * width + nx) * CHANNELS;
      if (Math.abs(a[base] - b[other]) <= PIXEL_TOLERANCE
        && Math.abs(a[base + 1] - b[other + 1]) <= PIXEL_TOLERANCE
        && Math.abs(a[base + 2] - b[other + 2]) <= PIXEL_TOLERANCE) { return true; }
    }
  }
  return false;
};

if (gpuImage.width !== cpuImage.width || gpuImage.height !== cpuImage.height) {
  throw new Error(`screenshot sizes differ: ${gpuImage.width}x${gpuImage.height} vs ${cpuImage.width}x${cpuImage.height}`);
}
const width = gpuImage.width;
const height = gpuImage.height;
const compare = (a, b, paint) => {
  let mismatched = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * CHANNELS;
      const ok = matchesNear(a.rgba, b.rgba, width, height, x, y)
        && matchesNear(b.rgba, a.rgba, width, height, x, y);
      if (!ok) mismatched++;
      if (paint === undefined) continue;
      for (let c = 0; c < 3; c++) {
        paint[at + c] = ok ? a.rgba[at + c] * DIFF_DIM_FACTOR : DIFF_MARK[c];
      }
      paint[at + 3] = 255;
    }
  }
  return mismatched;
};
const diff = new Uint8Array(width * height * CHANNELS);
const mismatched = compare(gpuImage, cpuImage, diff);
// The same metric applied to the shipped mesher against itself, moved by half a
// position-quantization step: whatever it reports is phase, not disagreement.
const metricFloor = compare(cpuImage, shiftImage);
writeFileSync(join(HERE, 'diff.png'), encodePng(width, height, diff));

results.pixels = {
  width, height, pixels: width * height, mismatched,
  mismatchFraction: mismatched / (width * height),
  tolerance: PIXEL_TOLERANCE, neighbourhood: 2 * NEIGHBOURHOOD_RADIUS + 1,
  metricFloorMismatched: metricFloor,
  metricFloorFraction: metricFloor / (width * height),
};

// ------------------------------------------------------------------ verdict
const gpuOut = results.sources.gpu;
const criteria = [
  ['band parity mismatches', results.parity.mismatches, 0, (v, l) => v <= l],
  ['band parity holes', results.parity.holes, 0, (v, l) => v <= l],
  ['isoline port mismatches', gpuOut.isoline?.mismatches ?? 0, 0, (v, l) => v <= l],
  ['pixel mismatch fraction', results.pixels.mismatchFraction, MAX_MISMATCH_FRACTION, (v, l) => v <= l],
  ['compute per chunk p50 ms', gpuOut.computePerChunkMs?.p50 ?? Infinity, PASS_COMPUTE_PER_CHUNK_MS, (v, l) => v < l],
  ['full-world rebuild ms', gpuOut.rebuildWallMs, PASS_REBUILD_MS, (v, l) => v < l],
  ['draw p50 ms', gpuOut.drawMs.p50, PASS_DRAW_P50_MS, (v, l) => v <= l],
  ['resident GPU bytes', gpuOut.residentBytes.total, PASS_RESIDENT_BYTES, (v, l) => v <= l],
];
const failing = criteria.filter(([, value, limit, ok]) => !ok(value, limit));
results.criteria = criteria.map(([name, value, limit, ok]) => ({ name, value, limit, pass: ok(value, limit) }));
results.verdict = failing.length === 0 ? 'pass' : 'kill';
results.firstFailure = failing.length === 0 ? null : failing[0][0];
writeFileSync(join(HERE, 'results.json'), JSON.stringify(results, null, 2));

const mb = (bytes) => (bytes / 1e6).toFixed(1) + ' MB';
const rows = results.criteria
  .map((c) => `| ${c.name} | ${typeof c.value === 'number' ? c.value : String(c.value)} | ${c.limit} | ${c.pass ? 'pass' : 'KILL'} |`)
  .join('\n');
writeFileSync(join(HERE, 'report.md'), `# Gate 1 — WebGPU terrace mesher

Verdict: **${results.verdict}**${results.firstFailure ? ` — first failing criterion: ${results.firstFailure}` : ''}

Adapter: ${JSON.stringify(gpuOut.adapter)}
Timing method: ${gpuOut.timingMethod}

| criterion | measured | limit | |
|---|---|---|---|
${rows}

## Geometry

| | GPU | CPU (shipped) |
|---|---|---|
| triangles | ${gpuOut.triangles} | ${results.sources.cpu.triangles} |
| vertex bytes | ${mb(gpuOut.residentBytes.vertex)} | ${mb(results.sources.cpu.residentBytes.vertex)} |
| draw p50 ms | ${gpuOut.drawMs.p50} | ${results.sources.cpu.drawMs.p50} |
| build ms | ${gpuOut.rebuildWallMs} (GPU) | ${meta.cpuBuildMs} (Node, single-threaded) |

Resident GPU bytes, GPU mesher: ${JSON.stringify(gpuOut.residentBytes)}

## Parity

${JSON.stringify(results.parity, null, 2)}

## Pixels

${JSON.stringify(results.pixels, null, 2)}

The shipped CPU mesher fell back to its blocky per-cell path in
${meta.cpuFallbackChunkCount} of ${meta.chunksPerEdge * meta.chunksPerEdge} chunks
(${JSON.stringify(meta.cpuFallbackChunks)}). Those chunks are cell-quantized in
cpu.png and drawn at sample resolution in gpu.png, so they are expected to
contribute mismatched pixels.

## Page logs

${results.pageLogs.join('\n') || '(none)'}
`);

printLogs();
for (const line of [
  `verdict ${results.verdict}${results.firstFailure ? ' — ' + results.firstFailure : ''}`,
  `parity: ${results.parity.mismatches} mismatches, ${results.parity.holes} holes, ${results.parity.exempt} exempt of ${results.parity.samples}`,
  `pixels: ${mismatched} / ${width * height} = ${(results.pixels.mismatchFraction * 100).toFixed(4)}%`,
  `gpu: ${gpuOut.triangles} tris, draw p50 ${gpuOut.drawMs.p50} ms, rebuild ${gpuOut.rebuildWallMs} ms wall (gpu ${gpuOut.rebuildGpuMs} ms; serial per-chunk passes ${gpuOut.rebuildSerialWallMs} ms), resident ${mb(gpuOut.residentBytes.total)}`,
  ...Object.entries(gpuOut.edit ?? {}).map(([name, e]) =>
    `edit ${name}: ${e.chunks} chunks, ${e.windowVertices} verts, upload ${e.uploadBytes} B; gpu p50 ${e.gpuMs?.p50} p95 ${e.gpuMs?.p95} max ${e.gpuMs?.max} ms; wall p50 ${e.wallMs.p50} p95 ${e.wallMs.p95} max ${e.wallMs.max} ms`),
  `cpu: ${results.sources.cpu.triangles} tris, draw p50 ${results.sources.cpu.drawMs.p50} ms`,
]) console.log(line);
cleanup();
process.exit(results.verdict === 'pass' ? 0 : 1);
