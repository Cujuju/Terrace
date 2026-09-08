// Renders the GPU terrain height field into an integer target and compares every
// texel to shared/src/drawnGround.ts. Zero mismatches is the bar.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { resolveChromeHeadlessShell } from './chromeHeadlessShell.mjs';
import {
  CHUNK_SIZE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  TERRAIN_LOD_FAR_N,
  TERRAIN_LOD_NEAR_N,
} from '../../shared/src/constants.ts';
import { createHeightmap } from '../../shared/src/grid.ts';
import { drawnGroundHeight } from '../../shared/src/drawnGround.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CLIENT_ROOT = resolve(HERE, '..');
const PATCH_ENV_VAR = 'TERRACE_PATCH_JSON';
const PATCH_RELATIVE_PATH = '.terrain-options/patch.json';

// .terrain-options is untracked, so a worktree has to reach the main checkout.
function resolvePatchFile() {
  const override = process.env[PATCH_ENV_VAR];
  if (override !== undefined && override !== '') return override;
  const here = resolve(REPO_ROOT, PATCH_RELATIVE_PATH);
  if (existsSync(here)) return here;
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const main = resolve(dirname(commonDir), PATCH_RELATIVE_PATH);
  if (existsSync(main)) return main;
  throw new Error(`no ${PATCH_RELATIVE_PATH} at ${here} or ${main}; set ${PATCH_ENV_VAR}`);
}

const PATCH_FILE = resolvePatchFile();

const CHROME_ENDPOINT_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 250;
const CDP_PORT_BASE = 9700;
const CDP_PORT_SPREAD = 200;

const SUBDIVISIONS = [TERRAIN_LOD_NEAR_N, TERRAIN_LOD_FAR_N];

/** Shifts that drag the frostwick patch below sea level, where floor != trunc. */
const PATCH_SHIFTS = [0, -400, -1400];

const SWEEP_SEED = 0x2545f491;
const SWEEP_MULTIPLIER = 1664525;
const SWEEP_INCREMENT = 1013904223;
const SWEEP_MODULUS = 2 ** 32;

/** The cell the sculpt-path check rewrites, and the band it moves by. */
const SCULPT_CHUNK = { cx: 1, cy: 1 };
const SCULPT_DELTA = -777;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampHeight(h) {
  return h < MIN_HEIGHT ? MIN_HEIGHT : h > MAX_HEIGHT ? MAX_HEIGHT : h;
}

function patchMaps() {
  const patch = JSON.parse(readFileSync(PATCH_FILE, 'utf8'));
  const size = patch.patch;
  const maps = [];
  for (const shift of PATCH_SHIFTS) {
    const map = createHeightmap(size);
    for (let i = 0; i < size * size; i++) map.cells[i] = clampHeight(patch.cells[i] + shift);
    maps.push({ name: `frostwick${shift === 0 ? '' : shift}`, map });
  }
  const sweep = createHeightmap(size);
  let state = SWEEP_SEED;
  for (let i = 0; i < size * size; i++) {
    state = (state * SWEEP_MULTIPLIER + SWEEP_INCREMENT) % SWEEP_MODULUS;
    sweep.cells[i] = MIN_HEIGHT + (state % (MAX_HEIGHT - MIN_HEIGHT + 1));
  }
  maps.push({ name: 'sweep', map: sweep });
  return maps;
}

function expectedHeights(map, subdivision) {
  const span = CHUNK_SIZE * subdivision;
  const side = map.size * subdivision;
  const out = new Int32Array(side * side);
  for (let py = 0; py < side; py++) {
    const cy = Math.floor(py / span);
    const y = cy * CHUNK_SIZE + (py - cy * span + 0.5) / subdivision;
    for (let px = 0; px < side; px++) {
      const cx = Math.floor(px / span);
      const x = cx * CHUNK_SIZE + (px - cx * span + 0.5) / subdivision;
      out[py * side + px] = drawnGroundHeight(map, x, y);
    }
  }
  return out;
}

const PROBE_PAGE = `<!doctype html><meta charset="utf-8"><title>gpu terrain parity</title>
<script type="module" src="/probe.js"></script>`;

const PROBE_SCRIPT = `
import * as THREE from 'three';
import { GPU_TERRAIN_FIELD_GLSL } from 'gpuTerrainField';
import { createHeightTexture } from 'gpuTerrainTextures';

const VERTEX = \`in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }\`;

const FRAGMENT = \`precision highp float;
precision highp int;
uniform float uSubdiv;
uniform float uChunkCells;
\${GPU_TERRAIN_FIELD_GLSL}
layout(location = 0) out ivec4 outHeight;
void main() {
  int span = int(uChunkCells * uSubdiv);
  ivec2 px = ivec2(gl_FragCoord.xy);
  int cx = px.x / span;
  int cy = px.y / span;
  vec2 chunkOrigin = vec2(float(cx), float(cy)) * uChunkCells;
  vec2 sub = vec2(float(px.x - cx * span), float(px.y - cy * span));
  outHeight = ivec4(drawnGroundHeight(chunkOrigin + (sub + 0.5) / uSubdiv), 0, 0, 0);
}\`;

const canvas = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.autoClear = false;
const scene = new THREE.Scene();
const camera = new THREE.Camera();
const uniforms = {
  uSubdiv: { value: 1 },
  uChunkCells: { value: 0 },
  uSizeCells: { value: 0 },
  uHeight: { value: null },
};
const material = new THREE.RawShaderMaterial({
  vertexShader: VERTEX,
  fragmentShader: FRAGMENT,
  glslVersion: THREE.GLSL3,
  blending: THREE.NoBlending,
  depthTest: false,
  depthWrite: false,
  uniforms,
});
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

let state = null;

window.__load = (cells, size, chunkCells) => {
  if (state !== null) state.height.dispose();
  const map = { size, cells: Int16Array.from(cells) };
  const height = createHeightTexture(map);
  state = { map, height, chunkCells };
  uniforms.uHeight.value = height.texture;
  uniforms.uSizeCells.value = size;
  uniforms.uChunkCells.value = chunkCells;
  return true;
};

window.__writeRect = (x, y, w, h, cells) => {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      state.map.cells[(y + j) * state.map.size + x + i] = cells[j * w + i];
    }
  }
  state.height.uploadRect(renderer, x, y, w, h);
  return true;
};

window.__probe = (subdiv) => {
  const side = state.map.size * subdiv;
  const target = new THREE.WebGLRenderTarget(side, side, {
    format: THREE.RGBAIntegerFormat,
    type: THREE.IntType,
    internalFormat: 'RGBA32I',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  uniforms.uSubdiv.value = subdiv;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const raw = new Int32Array(side * side * 4);
  renderer.readRenderTargetPixels(target, 0, 0, side, side, raw);
  renderer.setRenderTarget(null);
  target.dispose();
  const out = new Int32Array(side * side);
  for (let i = 0; i < out.length; i++) out[i] = raw[i * 4];
  return Array.from(out);
};

window.__renderer = () => {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

window.__ready = true;
`;

async function startVite(scratch) {
  writeFileSync(join(scratch, 'index.html'), PROBE_PAGE);
  writeFileSync(join(scratch, 'probe.js'), PROBE_SCRIPT);
  const server = await createViteServer({
    configFile: false,
    root: scratch,
    logLevel: 'error',
    appType: 'mpa',
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: {
        three: join(CLIENT_ROOT, 'node_modules/three/build/three.module.js'),
        '@terrace/shared': join(REPO_ROOT, 'shared/src/index.ts'),
        gpuTerrainField: join(CLIENT_ROOT, 'src/render/gpuTerrainField.ts'),
        gpuTerrainTextures: join(CLIENT_ROOT, 'src/render/gpuTerrainTextures.ts'),
      },
    },
    server: { port: 0, strictPort: false, host: '127.0.0.1', fs: { allow: [REPO_ROOT] } },
  });
  await server.listen();
  return { server, port: server.config.server.port ?? server.httpServer.address().port };
}

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(READY_POLL_INTERVAL_MS);
    }
  }
  throw new Error(`chrome devtools endpoint did not come up within ${timeoutMs}ms`);
}

let nextId = 1;
function rpc(ws, method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
      else res(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function startChrome() {
  const port = CDP_PORT_BASE + Math.floor(Math.random() * CDP_PORT_SPREAD);
  const profile = mkdtempSync(join(tmpdir(), 'gpu-parity-'));
  const child = spawn(
    resolveChromeHeadlessShell(),
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `--user-data-dir=${profile}`,
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
  const ws = new WebSocket(await waitForEndpoint(port, CHROME_ENDPOINT_TIMEOUT_MS));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  return { ws, cleanup };
}

function compare(label, gpu, expected) {
  let mismatches = 0;
  let worst = null;
  for (let i = 0; i < expected.length; i++) {
    if (gpu[i] === expected[i]) continue;
    mismatches++;
    const delta = Math.abs(gpu[i] - expected[i]);
    if (worst === null || delta > worst.delta) {
      worst = { index: i, gpu: gpu[i], expected: expected[i], delta };
    }
  }
  return { label, samples: expected.length, mismatches, worst };
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'gpu-parity-page-'));
  mkdirSync(scratch, { recursive: true });
  const { server, port } = await startVite(scratch);
  const { ws, cleanup } = await startChrome();
  const shutdown = () => {
    cleanup();
    server.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  };

  const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await rpc(ws, 'Page.enable', {}, sessionId);
  await rpc(ws, 'Runtime.enable', {}, sessionId);
  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
  });
  await rpc(ws, 'Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);

  const evaluate = async (expression) => {
    const r = await rpc(
      ws,
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate('window.__ready === true')) break;
    await sleep(READY_POLL_INTERVAL_MS);
  }
  if ((await evaluate('window.__ready === true')) !== true) {
    shutdown();
    throw new Error(`probe page never became ready: ${pageErrors.join(' | ')}`);
  }

  console.log(`renderer: ${await evaluate('window.__renderer()')}`);

  const results = [];
  for (const { name, map } of patchMaps()) {
    await evaluate(
      `window.__load(${JSON.stringify(Array.from(map.cells))}, ${map.size}, ${CHUNK_SIZE})`,
    );
    for (const subdiv of SUBDIVISIONS) {
      const gpu = await evaluate(`window.__probe(${subdiv})`);
      results.push(compare(`${name} N=${subdiv}`, gpu, expectedHeights(map, subdiv)));
    }
  }

  const { map } = patchMaps()[0];
  await evaluate(
    `window.__load(${JSON.stringify(Array.from(map.cells))}, ${map.size}, ${CHUNK_SIZE})`,
  );
  await evaluate(`window.__probe(${TERRAIN_LOD_NEAR_N})`);
  const rect = { x: SCULPT_CHUNK.cx * CHUNK_SIZE, y: SCULPT_CHUNK.cy * CHUNK_SIZE };
  const patchCells = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const cell = map.cells[(rect.y + j) * map.size + rect.x + i] + SCULPT_DELTA;
      patchCells[j * CHUNK_SIZE + i] = clampHeight(cell);
      map.cells[(rect.y + j) * map.size + rect.x + i] = clampHeight(cell);
    }
  }
  await evaluate(
    `window.__writeRect(${rect.x}, ${rect.y}, ${CHUNK_SIZE}, ${CHUNK_SIZE}, ${JSON.stringify(Array.from(patchCells))})`,
  );
  const sculpted = await evaluate(`window.__probe(${TERRAIN_LOD_NEAR_N})`);
  results.push(
    compare('frostwick after rect upload N=4', sculpted, expectedHeights(map, TERRAIN_LOD_NEAR_N)),
  );

  shutdown();

  let samples = 0;
  let mismatches = 0;
  let worst = null;
  for (const r of results) {
    samples += r.samples;
    mismatches += r.mismatches;
    if (r.worst !== null && (worst === null || r.worst.delta > worst.delta)) {
      worst = { ...r.worst, label: r.label };
    }
    console.log(
      `${r.label.padEnd(34)} samples ${String(r.samples).padStart(6)}  mismatches ${r.mismatches}`,
    );
  }
  console.log(`\ntotal samples ${samples}, mismatches ${mismatches}`);
  if (worst !== null) {
    console.log(
      `worst: ${worst.label} texel ${worst.index} gpu ${worst.gpu} expected ${worst.expected} (delta ${worst.delta})`,
    );
  }
  if (pageErrors.length > 0) console.log(`page errors: ${pageErrors.join(' | ')}`);
  console.log(mismatches === 0 ? 'PASS' : 'FAIL');
  process.exit(mismatches === 0 ? 0 : 1);
}

await main();
