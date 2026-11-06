// Headless Chrome over the DevTools Protocol, for scripts that drive or shoot pages.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChromeHeadlessShell } from './chromeHeadlessShell.mjs';

/** Software WebGL via SwiftShader: renders on any machine, GPU or not. */
export const SOFTWARE_GL_FLAGS = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];

/** The machine's GPU, WebGPU included; Chrome otherwise blocklists GPUs in headless mode. */
export const GPU_FLAGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'];

const ENDPOINT_TIMEOUT_MS = 30_000;
const ENDPOINT_POLL_MS = 250;
// Chrome writes its chosen port here when started with --remote-debugging-port=0.
const ACTIVE_PORT_FILE = 'DevToolsActivePort';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(profile) {
  const file = join(profile, ACTIVE_PORT_FILE);
  const deadline = Date.now() + ENDPOINT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await sleep(ENDPOINT_POLL_MS);
  }
  throw new Error(`Chrome DevTools endpoint did not come up within ${ENDPOINT_TIMEOUT_MS}ms`);
}

/** Starts headless Chrome on a free port; `close()` kills it and deletes its profile. */
export async function startChrome({ width, height, flags = SOFTWARE_GL_FLAGS }) {
  const profile = mkdtempSync(join(tmpdir(), 'terrace-cdp-'));
  const child = spawn(
    resolveChromeHeadlessShell(),
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...flags,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.stderr.resume();
  const exited = new Promise((r) => child.once('exit', r));
  const removeProfile = () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  };
  // Last resort on an unexpected exit: Windows may still lock the profile here.
  const killNow = () => {
    child.kill('SIGKILL');
    removeProfile();
  };
  process.on('exit', killNow);
  // Windows holds the profile's files until Chrome has fully exited.
  const close = async () => {
    process.off('exit', killNow);
    child.kill('SIGKILL');
    await exited;
    removeProfile();
  };
  const ws = new WebSocket(await waitForEndpoint(profile));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let nextId = 1;
  const send = (method, params = {}, sessionId) => {
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
  };
  return {
    send,
    /** Kills Chrome and deletes its profile once it has exited. */
    close: () => {
      ws.close();
      return close();
    },
    /** A fresh tab at 1x scale; returns helpers bound to its session. */
    async openTab() {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank', width, height });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const tab = {
        send: (method, params) => send(method, params, sessionId),
        async evaluate(expression) {
          const res = await tab.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
          return res.result?.value;
        },
        close: () => send('Target.closeTarget', { targetId }).catch(() => {}),
      };
      await tab.send('Page.enable');
      await tab.send('Runtime.enable');
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      return tab;
    },
  };
}
