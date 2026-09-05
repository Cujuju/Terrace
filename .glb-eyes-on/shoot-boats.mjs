// In-world screenshot driver for the GLB war boat, over raw CDP.
//
// Same shape as client/scripts/shootSpeciesPreview.mjs (Chrome's --screenshot
// and --virtual-time-budget both hang on these WebGL pages), but it drives the
// REAL app rather than a preview harness: the player token is planted in
// localStorage before any script runs, the driver waits for window.__terrace
// and for the boats plugin to have views, then parks the OrbitControls camera
// on a named world point and captures.
//
// Usage: node shoot-boats.mjs <outDir> <name>:<px>,<pz>,<dist>,<height>,<yaw> ...
//   The camera is placed RELATIVE TO A REAL HULL, never at a fixed point: the
//   boat nearest world point (px,pz) becomes the orbit target, and the camera
//   sits `dist` world units away on bearing `yaw` (radians) at `height` above
//   the sea. A boat is a moving thing — a hardcoded camera point frames empty
//   water as soon as the fleet re-berths.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChromeHeadlessShell } from '/mnt/e/Development/Projects/Terrace/.claude/worktrees/glb-accessors/client/scripts/chromeHeadlessShell.mjs';

const CHROME = resolveChromeHeadlessShell();
const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5299';
const TOKEN = process.env.TOKEN ?? '15e70de7-2f33-49b4-bf55-b02bd39f1c58';
const TOKEN_STORAGE_KEY = 'terrace.playerToken.v1';
const VIEWPORT_WIDTH = 1600;
const VIEWPORT_HEIGHT = 1000;
const READY_POLL_INTERVAL_MS = 2000;
const READY_TIMEOUT_MS = 420_000;
const CHROME_ENDPOINT_TIMEOUT_MS = 30_000;
/** Frames to let the swell/oars settle after the camera moves. */
const SETTLE_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
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
  const profile = mkdtempSync(join(tmpdir(), 'glb-boat-shot-'));
  const child = spawn(CHROME, [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    `--user-data-dir=${profile}`,
    `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
    `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume();
  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);
  const wsUrl = await waitForEndpoint(port, CHROME_ENDPOINT_TIMEOUT_MS);
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  return { ws, cleanup, pid: child.pid };
}

async function evaluate(ws, sessionId, expression) {
  const res = await rpc(ws, 'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? 'evaluate threw');
  return res.result?.value;
}

const argv = process.argv.slice(2);
const outDir = argv[0];
const shots = argv.slice(1).map((a) => {
  const [name, rest] = a.split(':');
  const [px, pz, dist, height, yaw] = rest.split(',').map(Number);
  return { name, px, pz, dist, height, yaw };
});
if (!outDir || shots.length === 0) {
  console.error('usage: shoot-boats.mjs <outDir> <name>:<px>,<pz>,<dist>,<height>,<yaw> ...');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const { ws, cleanup } = await startChrome();
try {
  const { targetId } = await rpc(ws, 'Target.createTarget',
    { url: 'about:blank', width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await rpc(ws, 'Page.enable', {}, sessionId);
  await rpc(ws, 'Runtime.enable', {}, sessionId);
  await rpc(ws, 'Emulation.setDeviceMetricsOverride',
    { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
  // The token BEFORE any app script: the per-token chunk mask decides whether
  // this browser is shown any boats at all.
  await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument',
    { source: `try{localStorage.setItem(${JSON.stringify(TOKEN_STORAGE_KEY)},${JSON.stringify(TOKEN)})}catch(e){}` },
    sessionId);
  await rpc(ws, 'Page.navigate', { url: URL_BASE }, sessionId);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = null;
  while (Date.now() < deadline) {
    await sleep(READY_POLL_INTERVAL_MS);
    try {
      ready = await evaluate(ws, sessionId, `(() => {
        const t = window.__terrace; if (!t) return null;
        const layer = t.viewport.scene.getObjectByName('plugin:boats');
        const afloat = layer && layer.getObjectByName('boats:afloat');
        const n = afloat ? afloat.children.length : 0;
        return n > 0 ? { boats: n } : null;
      })()`);
      if (ready) break;
    } catch {}
  }
  if (!ready) throw new Error('no boats in the scene within the ready timeout');
  console.log('boats in scene:', ready.boats);
  // The camera-clearance floor (client/src/render/cameraClearance.ts) holds the
  // camera above the terrain and pushed every close-up back to ~6 world units.
  // A screenshot rig wants the eye where it asked for it, so the floor comes
  // off for the shoot — this is the driver's own page, not the shipped app.
  await evaluate(ws, sessionId, 'window.__terrace.viewport.setGroundHeightSampler(null), true');
  // RIG OVERRIDE, stated plainly: the shipped orbit cannot come closer than
  // CAMERA_MIN_DISTANCE (~6 world units, client/src/config.ts) and a war boat
  // is one world unit long, so no in-game camera pose can show hull texture.
  // The close-ups below are the game's own scene and materials seen through a
  // relaxed dolly limit — nothing about the boats is changed.
  await evaluate(ws, sessionId, `(() => {
    const c = window.__terrace.viewport.controls;
    c.minDistance = ${Number(process.env.MIN_DISTANCE ?? 0.05)};
    c.maxPolarAngle = Math.PI;
    return true;
  })()`);

  for (const shot of shots) {
    const framed = await evaluate(ws, sessionId, `(() => {
      const v = window.__terrace.viewport;
      const afloat = v.scene.getObjectByName('plugin:boats').getObjectByName('boats:afloat');
      let best = null;
      for (const b of afloat.children) {
        const d = Math.hypot(b.position.x - ${shot.px}, b.position.z - ${shot.pz});
        if (!best || d < best.d) best = { d, x: b.position.x, y: b.position.y, z: b.position.z };
      }
      if (!best) return null;
      v.controls.target.set(best.x, best.y, best.z);
      v.camera.position.set(
        best.x + Math.cos(${shot.yaw}) * ${shot.dist},
        best.y + ${shot.height},
        best.z + Math.sin(${shot.yaw}) * ${shot.dist});
      v.camera.near = 0.01; v.camera.updateProjectionMatrix();
      v.controls.update();
      return { targetX: +best.x.toFixed(3), targetZ: +best.z.toFixed(3), targetY: +best.y.toFixed(4) };
    })()`);
    if (framed === null) throw new Error(`${shot.name}: no boat to frame`);
    await sleep(SETTLE_MS);
    const info = await evaluate(ws, sessionId, `(() => {
      const v = window.__terrace.viewport;
      const afloat = v.scene.getObjectByName('plugin:boats').getObjectByName('boats:afloat');
      const cam = v.camera.position;
      let nearest = null;
      for (const b of afloat.children) {
        const d = Math.hypot(b.position.x - cam.x, b.position.y - cam.y, b.position.z - cam.z);
        if (!nearest || d < nearest.d) nearest = { d, y: b.position.y };
      }
      // WHAT ELSE IS IN FRAME, by owning layer — a flat slab on the water next
      // to a war boat is either a boats defect or another plugin's scenery,
      // and only the scene graph can say which.
      const near = [];
      for (const layer of v.scene.children) {
        if (!layer.name || !layer.name.startsWith('plugin:')) continue;
        layer.traverse((o) => {
          if (!o.isMesh && !o.isSkinnedMesh) return;
          const p = o.getWorldPosition(new (o.position.constructor)());
          const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
          if (d < 3) near.push(layer.name);
        });
      }
      const byLayer = {};
      for (const n of near) byLayer[n] = (byLayer[n] ?? 0) + 1;
      return { byLayer, boats: afloat.children.length, nearestDistance: nearest && +nearest.d.toFixed(2),
               nearestRootY: nearest && +nearest.y.toFixed(4),
               outputColorSpace: v.renderer.outputColorSpace, calls: v.renderer.info.render.calls };
    })()`);
    const png = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
    const path = join(outDir, `${shot.name}.png`);
    writeFileSync(path, Buffer.from(png.data, 'base64'));
    console.log(path, JSON.stringify({ ...framed, ...info }));
  }
  await rpc(ws, 'Target.closeTarget', { targetId }).catch(() => {});
} finally {
  ws.close();
  cleanup();
}
process.exit(0);
