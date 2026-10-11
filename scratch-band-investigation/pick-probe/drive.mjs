// Private-stack probe for #504 / band smoothing.
// Usage: node scratch-band-investigation/pick-probe/drive.mjs <label> [mesher,...] [mode,...]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.TERRACE_MESHER_SERVER_PORT = '2641';
process.env.TERRACE_MESHER_VITE_PORT = '5241';
process.env.TERRACE_MESHER_RUN_DIR = join(HERE, 'run');
process.env.TERRACE_MESHER_RESULTS_DIR = join(HERE, 'results');
process.env.TERRACE_MESHER_AGENT = 'band-504';
const H = await import('../../client/scripts/mesherHarness.mjs');

const label = process.argv[2] ?? 'run';
const meshers = (process.argv[3] ?? 'gpu,cpu').split(',');
const modes = (process.argv[4] ?? 'raw,binomial').split(',');
const STROKE_PRESSES = 12;
const LOCAL_OFFSET = 8;
// Sites are cut into the flat band-63 plateau, then lowered to leave raise headroom.
const MIN_SITE_BAND = 63;
const MAX_SITE_BAND = 63;
const BASIN_DEPTH_BANDS = 20;
// Steep enough that the basin wall never occludes the aimed floor.
const AIM_ELEVATION_DEG = 85;
const READY_POLL_MS = 500;
const READY_POLL_LIMIT = 240;
const EVAL_TIMEOUT_MS = 600_000;

H.ensureDirs();
const log = H.makeLogger(join(H.RUN_DIR, 'driver.log'));
const pageSrc = readFileSync(join(HERE, 'page.js'), 'utf8').replace(/^\/\/.*\n/, '');
const vite = await H.startVite(log);
const results = [];
try {
  for (const mesher of meshers) for (const mode of modes) {
    const server = H.startServer(log);
    await H.sleep(H.serverSettleWaitMs);
    const result = await H.underGpuLock(log, async () => {
      const chrome = await H.launchChrome();
      try {
        await chrome.call('Page.navigate', { url: H.devUrl(`mesher=${mesher}&surface=${mode}`) });
        let ready = false;
        for (let i = 0; i < READY_POLL_LIMIT && !ready; i++) {
          const r = await chrome.call('Runtime.evaluate', {
            expression: '!!(window.__terrace && window.__terrace.world.worldSize() > 0)', returnByValue: true,
          });
          ready = r.result?.result?.value === true;
          if (!ready) await H.sleep(READY_POLL_MS);
        }
        if (!ready) return { mesher, mode, error: 'page never ready', logs: chrome.pageLogs().slice(-20) };
        const r = await chrome.call('Runtime.evaluate', {
          expression: `(${pageSrc})(${JSON.stringify({ mode, strokePresses: STROKE_PRESSES, localOffset: LOCAL_OFFSET, minBand: MIN_SITE_BAND, maxBand: MAX_SITE_BAND, basinDepth: BASIN_DEPTH_BANDS, aimElevation: AIM_ELEVATION_DEG })})`,
          awaitPromise: true, returnByValue: true, timeout: EVAL_TIMEOUT_MS,
        });
        const value = r.result?.result?.value ?? { error: r.result?.exceptionDetails ?? r };
        return { mesherRequested: mesher, ...value, logErrors: chrome.pageLogs().filter((l) => /EXCEPTION|error/i.test(l)).slice(-10) };
      } finally {
        await chrome.close();
      }
    });
    log(`${mesher}/${mode}: ${JSON.stringify(result).slice(0, 400)}`);
    results.push(result);
    H.stopProcess(server, log, 'server');
    await H.sleep(H.processStopSettleMs);
  }
} finally {
  H.stopProcess(vite, log, 'vite');
  writeFileSync(join(H.RESULTS_DIR, `${label}.json`), JSON.stringify(results, null, 2));
}
