// Renderer A/B: the same three.js scene on WebGLRenderer and WebGPURenderer,
// frame intervals at idle and under the stroke upload pattern, plus a pixel
// diff of the two images. Visible window only (headless pacing is not vsync).
//
//   node bench/webgpu-renderer-ab/run.mjs [--idle 600] [--stroke 600] [--only webgl|webgpu]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '../webgpu-mesher/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, '..');
const THREE_BUILD = resolve(HERE, '../../client/node_modules/three/build');
const CHROME = process.env.GATE1_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PLATFORM_CHROME_FLAGS = process.platform === 'win32' ? ['--use-angle=d3d11'] : [];
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const IDLE = Number(arg('--idle', 600));
const STROKE = Number(arg('--stroke', 600));
const ONLY = arg('--only', null);
const EXTRA = arg('--query', '');
const [VIEWPORT_WIDTH, VIEWPORT_HEIGHT] = [1200, 900];
const [CDP_PORT_BASE, CDP_PORT_SPAN] = [9500, 400];
const [READY_POLL_MS, READY_POLL_LIMIT] = [500, 600];
const [ENDPOINT_POLL_MS, ENDPOINT_POLL_LIMIT] = [250, 200];
const [CONTEXT_POLL_MS, CONTEXT_POLL_LIMIT] = [100, 300];
const [PIXEL_TOLERANCE, NEIGHBOURHOOD_RADIUS] = [8, 1];
const CHANNELS = 4;
const [DIFF_DIM_FACTOR, DIFF_MARK] = [0.35, [255, 32, 32]];
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ server
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
  const file = path.startsWith('/three/') ? join(THREE_BUILD, path.slice('/three/'.length)) : join(BENCH, path.slice(1));
  const root = path.startsWith('/three/') ? THREE_BUILD : BENCH;
  if (!resolve(file).startsWith(resolve(root)) || !existsSync(file)) { response.writeHead(404); response.end('no'); return; }
  const extension = file.slice(file.lastIndexOf('.'));
  response.writeHead(200, { 'content-type': MIME[extension] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ------------------------------------------------------------------ chrome
const cdpPort = CDP_PORT_BASE + Math.floor(Math.random() * CDP_PORT_SPAN);
const profile = mkdtempSync(join(tmpdir(), 'renderer-ab-'));
const chrome = spawn(CHROME, [
  '--window-position=0,0', '--enable-unsafe-webgpu', ...PLATFORM_CHROME_FLAGS,
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
  `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`, `--remote-debugging-port=${cdpPort}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.resume();
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  server.close();
};
process.on('exit', cleanup);
let wsUrl = null;
for (let i = 0; i < ENDPOINT_POLL_LIMIT && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(ENDPOINT_POLL_MS); }
}
if (!wsUrl) throw new Error('chrome devtools endpoint never came up');
const socket = new WebSocket(wsUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
let nextId = 1; const pending = new Map();
const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params, sessionId }));
});
const contexts = new Map(); const logs = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const p = pending.get(message.id); pending.delete(message.id);
    if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.executionContextCreated' && message.params.context.auxData?.isDefault) {
    contexts.set(message.sessionId, message.params.context.uniqueId);
  }
  if (message.method === 'Runtime.consoleAPICalled') logs.push(`${message.params.type} ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (message.method === 'Runtime.exceptionThrown') logs.push(`exception ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
};

const openPage = async (query) => {
  const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true });
  await rpc('Page.enable', {}, sessionId);
  await rpc('Runtime.enable', {}, sessionId);
  await rpc('Emulation.setDeviceMetricsOverride', { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
  contexts.delete(sessionId);
  await rpc('Page.navigate', { url: `http://127.0.0.1:${port}/webgpu-renderer-ab/ab.html?${query}` }, sessionId);
  for (let i = 0; i < CONTEXT_POLL_LIMIT && !contexts.has(sessionId); i++) await sleep(CONTEXT_POLL_MS);
  if (!contexts.has(sessionId)) throw new Error('no execution context');
  return { targetId, sessionId };
};
const evaluate = async (sessionId, expression) => {
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, uniqueContextId: contexts.get(sessionId) }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const awaitReady = async (sessionId) => {
  for (let i = 0; i < READY_POLL_LIMIT; i++) {
    const state = await evaluate(sessionId, 'JSON.stringify({ ready: window.__ready ?? null, error: window.__error ?? null })');
    const { ready, error } = JSON.parse(state);
    if (error) throw new Error(`page error: ${error}`);
    if (ready) return ready;
    await sleep(READY_POLL_MS);
  }
  throw new Error('page never became ready');
};
const screenshot = async (sessionId, name) => {
  await evaluate(sessionId, 'window.__present()');
  const shot = await rpc('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  const bytes = Buffer.from(shot.data, 'base64');
  writeFileSync(join(HERE, name), bytes);
  return decodePng(bytes);
};

// -------------------------------------------------------------------- runs
const results = { idleFrames: IDLE, strokeFrames: STROKE, viewport: [VIEWPORT_WIDTH, VIEWPORT_HEIGHT], runs: {}, pageLogs: logs };
const images = {};
for (const r of ['webgl', 'webgpu']) {
  if (ONLY && ONLY !== r) continue;
  const page = await openPage(`r=${r}&idle=${IDLE}&stroke=${STROKE}&${EXTRA}`);
  const ready = await awaitReady(page.sessionId);
  console.log(`${r}: ready`, JSON.stringify(ready));
  const result = JSON.parse(await evaluate(page.sessionId, 'window.__result()'));
  const error = await evaluate(page.sessionId, 'window.__error');
  if (error) throw new Error(`${r}: ${error}`);
  results.runs[r] = result;
  images[r] = await screenshot(page.sessionId, `${r}.png`);
  console.log(`${r}: idle p50/p95/p99/max ${result.idle.p50.toFixed(2)}/${result.idle.p95.toFixed(2)}/${result.idle.p99.toFixed(2)}/${result.idle.max.toFixed(1)} ms (${result.idle.fps.toFixed(1)} fps); stroke ${result.stroke.p50.toFixed(2)}/${result.stroke.p95.toFixed(2)}/${result.stroke.p99.toFixed(2)}/${result.stroke.max.toFixed(1)} ms (${result.stroke.fps.toFixed(1)} fps); ${result.drawCalls} draws, ${result.triangles} tris; render() JS idle p50 ${result.renderJsIdle.p50.toFixed(2)} stroke p50 ${result.renderJsStroke.p50.toFixed(2)} ms`);
  await rpc('Target.closeTarget', { targetId: page.targetId });
}

// -------------------------------------------------------------------- diff
if (images.webgl && images.webgpu) {
  const { width, height } = images.webgl;
  const A = images.webgl.rgba, B = images.webgpu.rgba;
  const out = new Uint8Array(A.length);
  let mismatched = 0;
  const near = (x, y, ax, ay, az) => {
    for (let dy = -NEIGHBOURHOOD_RADIUS; dy <= NEIGHBOURHOOD_RADIUS; dy++) for (let dx = -NEIGHBOURHOOD_RADIUS; dx <= NEIGHBOURHOOD_RADIUS; dx++) {
      const px = x + dx, py = y + dy; if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const o = (py * width + px) * CHANNELS;
      if (Math.abs(B[o] - ax) <= PIXEL_TOLERANCE && Math.abs(B[o + 1] - ay) <= PIXEL_TOLERANCE && Math.abs(B[o + 2] - az) <= PIXEL_TOLERANCE) return true;
    }
    return false;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * CHANNELS;
    const ok = near(x, y, A[o], A[o + 1], A[o + 2]);
    if (!ok) mismatched++;
    for (let c = 0; c < 3; c++) out[o + c] = ok ? A[o + c] * DIFF_DIM_FACTOR : DIFF_MARK[c];
    out[o + 3] = 255;
  }
  writeFileSync(join(HERE, 'diff.png'), encodePng(width, height, out));
  results.pixels = { width, height, mismatched, mismatchFraction: mismatched / (width * height), tolerance: PIXEL_TOLERANCE, neighbourhood: NEIGHBOURHOOD_RADIUS * 2 + 1 };
  console.log(`pixels: ${mismatched} / ${width * height} differ (${(100 * results.pixels.mismatchFraction).toFixed(3)} %)`);
}
writeFileSync(join(HERE, 'results.json'), JSON.stringify(results, null, 2));
console.log(`wrote ${join(HERE, 'results.json')}`);
process.exit(0);
