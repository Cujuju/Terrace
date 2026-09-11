// Pixel-level parity of the WebGPU terrain mesher against the CPU mesher.
// Design: .claude/plans/gpu-mesher-production-design.md §11.2.
//
//   node client/scripts/mesherParity.mjs [--meshers cpu,cpu,gpu]
//                                        [--shadedScenario terrainStill] [--settle 5000]
//
// One pass per mesher entry; a repeated `cpu` is the metric floor. Every pass
// takes a band-ID capture and a shaded capture, each on its own fresh world,
// fresh server and fresh Chrome under the machine-wide GPU lock.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from '../../bench/webgpu-mesher/png.mjs';
import {
  CHANNELS, PIXEL_TOLERANCE, compareBands, compareShaded,
} from './mesherCompare.mjs';
import {
  CHROME_WINDOW, RESULTS_DIR, argValue, devUrl, ensureDirs, launchChrome, makeLogger,
  processStopSettleMs, serverSettleWaitMs, sinkOffset, sleep, startServer, startVite,
  stopProcess, underGpuLock, waitForSinkLine,
} from './mesherHarness.mjs';

const DEFAULT_MESHERS = 'cpu,cpu,gpu';
const BAND_SCENARIO = 'bandParity';
const BAND_READY_BEAT = 'band-ready';
const DEFAULT_SHADED_SCENARIO = 'terrainStill';
const SHADED_READY_BEAT = 'still-ready';
// The parity scenarios wait for terrain load themselves, so the probe's own
// settle only has to cover connection and the first snapshot. A scenario that
// does not wait (the `--shadedScenario overview` fallback) needs `--settle`
// raised past terrain load instead.
const DEFAULT_SETTLE_MS = 5000;
const READY_BEAT_TIMEOUT_MS = 240_000;
const REPORT_TIMEOUT_MS = 120_000;

// Verdict limits, design §11.2 (owner ruling #465 for the band fraction).
const MAX_BAND_MISMATCH_FRACTION = 0.005;
const MAX_HOLES = 0;
const MAX_SHADED_FRACTION_ABOVE_FLOOR = 0.001;

const PERCENT = 100;

const argv = process.argv.slice(2);
const meshers = argValue(argv, '--meshers', DEFAULT_MESHERS).split(',').map((m) => m.trim());
const shadedScenario = argValue(argv, '--shadedScenario', DEFAULT_SHADED_SCENARIO);
const shadedReadyBeat = shadedScenario === DEFAULT_SHADED_SCENARIO ? SHADED_READY_BEAT : null;
const settleMs = Number(argValue(argv, '--settle', String(DEFAULT_SETTLE_MS)));

const log = makeLogger(join(RESULTS_DIR, 'parity.log'));
ensureDirs();

/** `cpu, cpu, gpu` -> `cpu, cpu2, gpu`, so every pass has a distinct id. */
const passIds = (() => {
  const seen = new Map();
  return meshers.map((mesher) => {
    const n = (seen.get(mesher) ?? 0) + 1;
    seen.set(mesher, n);
    return { mesher, id: n === 1 ? mesher : `${mesher}${n}` };
  });
})();

// ------------------------------------------------------------------ capture
/**
 * One capture: fresh world + server, Chrome under the GPU lock, screenshot on
 * the scenario's ready heartbeat, then its report. `readyBeat === null` means
 * the scenario posts no ready beat, so the screenshot is taken at the report.
 */
async function capture({ mesher, scenario, readyBeat, pngPath }) {
  let server = null;
  try {
    server = startServer(log);
    await sleep(serverSettleWaitMs);
    const offset = sinkOffset();
    const url = devUrl(`perfprobe=${scenario}&settle=${settleMs}&mesher=${mesher}`);

    return await underGpuLock(log, async () => {
      const chrome = await launchChrome();
      try {
        log(`navigate ${url}`);
        await chrome.call('Page.navigate', { url });

        let png = null;
        if (readyBeat !== null) {
          const ready = await waitForSinkLine(
            offset, (l) => l.heartbeat === readyBeat, READY_BEAT_TIMEOUT_MS,
          );
          if (ready.error !== null) {
            return { ok: false, stage: `heartbeat ${readyBeat}`, detail: ready.error };
          }
          png = await chrome.screenshot();
          writeFileSync(pngPath, png);
          log(`captured ${pngPath} (${png.length} B)`);
        }

        const report = await waitForSinkLine(
          offset, (l) => l.fpsMean !== undefined, REPORT_TIMEOUT_MS,
        );
        if (report.error !== null) {
          return { ok: false, stage: 'report', detail: report.error, png };
        }
        if (png === null) {
          png = await chrome.screenshot();
          writeFileSync(pngPath, png);
          log(`captured ${pngPath} at report (${png.length} B)`);
        }
        return { ok: true, png, report: report.line };
      } finally {
        await chrome.close();
      }
    });
  } finally {
    stopProcess(server, log, 'server');
    await sleep(processStopSettleMs);
  }
}

const sameSize = (a, b, what) => {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`${what}: sizes differ ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
};

// -------------------------------------------------------------------- main
const results = {
  startedAt: new Date().toISOString(),
  meshers, shadedScenario, settleMs,
  passes: {}, failures: [],
};

let vite = null;
try {
  vite = await startVite(log);

  for (const { mesher, id } of passIds) {
    results.passes[id] = { mesher, band: null, shaded: null };

    const band = await capture({
      mesher, scenario: BAND_SCENARIO, readyBeat: BAND_READY_BEAT,
      pngPath: join(RESULTS_DIR, `band-${id}.png`),
    });
    results.passes[id].band = band.ok
      ? { ok: true, png: `band-${id}.png`, clientVersion: band.report.clientVersion }
      : { ok: false, stage: band.stage, detail: band.detail };
    if (!band.ok) {
      // Design §11.2 requires the band scenario; a missing scenario must be loud.
      results.failures.push(`${id}/${BAND_SCENARIO}: ${JSON.stringify(band.detail)}`);
      log(`FAIL ${id}/${BAND_SCENARIO} at ${band.stage}: ${JSON.stringify(band.detail)}`);
    }

    const shaded = await capture({
      mesher, scenario: shadedScenario, readyBeat: shadedReadyBeat,
      pngPath: join(RESULTS_DIR, `shaded-${id}.png`),
    });
    results.passes[id].shaded = shaded.ok
      ? {
        ok: true, png: `shaded-${id}.png`, scenario: shadedScenario,
        clientVersion: shaded.report.clientVersion,
        blockyChunks: shaded.report.blockyChunks ?? null,
      }
      : { ok: false, stage: shaded.stage, detail: shaded.detail };
    if (!shaded.ok) {
      results.failures.push(`${id}/${shadedScenario}: ${JSON.stringify(shaded.detail)}`);
      log(`FAIL ${id}/${shadedScenario} at ${shaded.stage}: ${JSON.stringify(shaded.detail)}`);
    }
  }
} finally {
  stopProcess(vite, log, 'vite');
}

// -------------------------------------------------------------- comparisons
const readImage = (id, kind) => {
  const pass = results.passes[id];
  if (pass === undefined || pass[kind] === null || !pass[kind].ok) return null;
  return decodePng(readFileSync(join(RESULTS_DIR, pass[kind].png)));
};

const bandGpu = readImage('gpu', 'band');
const bandCpu = readImage('cpu', 'band');
if (bandGpu !== null && bandCpu !== null) {
  sameSize(bandGpu, bandCpu, 'band images');
  const band = compareBands(bandGpu, bandCpu);
  writeFileSync(join(RESULTS_DIR, 'diff-band.png'), encodePng(band.width, band.height, band.diff));
  delete band.diff;
  results.band = band;
} else {
  results.band = null;
}

const shadedGpu = await readImage('gpu', 'shaded');
const shadedCpu = await readImage('cpu', 'shaded');
const shadedCpu2 = await readImage('cpu2', 'shaded');
if (shadedGpu !== null && shadedCpu !== null) {
  sameSize(shadedGpu, shadedCpu, 'shaded images');
  const paint = new Uint8Array(shadedGpu.width * shadedGpu.height * CHANNELS);
  const gpuVsCpu = compareShaded(shadedGpu, shadedCpu, paint);
  writeFileSync(
    join(RESULTS_DIR, 'diff-shaded.png'),
    encodePng(shadedGpu.width, shadedGpu.height, paint),
  );
  results.shaded = { gpuVsCpu, floor: null, fractionAboveFloor: null };
}
if (shadedCpu !== null && shadedCpu2 !== null) {
  sameSize(shadedCpu, shadedCpu2, 'floor images');
  const floorPaint = new Uint8Array(shadedCpu.width * shadedCpu.height * CHANNELS);
  const floor = compareShaded(shadedCpu, shadedCpu2, floorPaint);
  writeFileSync(
    join(RESULTS_DIR, 'diff-shaded-floor.png'),
    encodePng(shadedCpu.width, shadedCpu.height, floorPaint),
  );
  results.shaded = results.shaded ?? { gpuVsCpu: null, floor: null, fractionAboveFloor: null };
  results.shaded.floor = floor;
  if (results.shaded.gpuVsCpu !== null) {
    results.shaded.fractionAboveFloor = results.shaded.gpuVsCpu.fraction - floor.fraction;
  }
}
results.shaded = results.shaded ?? null;

// Blocky-chunk exemption: the CPU's work-budget fallback (design §9.2). The
// band image carries no chunk id, so the list is reported, not spatially applied.
const blockyChunks = results.passes.cpu?.shaded?.blockyChunks ?? null;
results.blockyChunks = blockyChunks;
results.blockyExemption = blockyChunks === null
  ? 'not applied: the client exposes no `blockyChunks` field on the shaded report'
  : blockyChunks.length === 0
    ? 'vacuous: the CPU path drew no chunk blocky'
    : `not applied: ${blockyChunks.length} blocky chunks listed, but the band image carries no chunk id to mask them by`;

// ------------------------------------------------------------------ verdict
const criteria = [
  ['band mismatch fraction (non-exempt, covered)', results.band?.mismatchFraction ?? null, MAX_BAND_MISMATCH_FRACTION],
  ['band holes (non-exempt)', results.band?.holes ?? null, MAX_HOLES],
  ['shaded mismatch fraction above floor', results.shaded?.fractionAboveFloor ?? null, MAX_SHADED_FRACTION_ABOVE_FLOOR],
];
results.criteria = criteria.map(([name, value, limit]) => ({
  name, value, limit, pass: value === null ? null : value <= limit,
}));
results.verdict = results.failures.length > 0 ? 'incomplete'
  : results.criteria.some((c) => c.pass === null) ? 'incomplete'
    : results.criteria.every((c) => c.pass) ? 'pass' : 'fail';

writeFileSync(join(RESULTS_DIR, 'parity.json'), JSON.stringify(results, null, 2));

// --------------------------------------------------------------------- md
// Counts stay exact; only fractional values are rounded for the table.
const MD_DECIMALS = 2;
const fmt = (v) => (v === null || v === undefined ? 'n/a'
  : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(MD_DECIMALS) : String(v));
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * PERCENT).toFixed(4)} %`);
const mark = (p) => (p === null ? 'n/a' : p ? 'pass' : 'FAIL');

const passRows = Object.entries(results.passes).map(([id, p]) =>
  `| ${id} | ${p.mesher} | ${p.band?.ok ? p.band.png : `FAILED (${p.band?.stage})`} | ${p.shaded?.ok ? p.shaded.png : `FAILED (${p.shaded?.stage})`} |`).join('\n');

writeFileSync(join(RESULTS_DIR, 'parity.md'), `# GPU mesher parity — design §11.2

Started ${results.startedAt}. Meshers: \`${meshers.join(', ')}\`. Shaded scenario:
\`${shadedScenario}\`. Chrome window ${CHROME_WINDOW}.

Verdict: **${results.verdict}**

| criterion | measured | limit | |
|---|---|---|---|
| band-ID mismatch fraction, gpu vs cpu, non-exempt covered samples | ${pct(results.band?.mismatchFraction)} | ${pct(MAX_BAND_MISMATCH_FRACTION)} | ${mark(results.criteria[0].pass)} |
| band-ID holes (gpu background where cpu has terrain), non-exempt | ${fmt(results.band?.holes)} | ${MAX_HOLES} | ${mark(results.criteria[1].pass)} |
| shaded mismatch fraction above the metric floor | ${pct(results.shaded?.fractionAboveFloor)} | ${pct(MAX_SHADED_FRACTION_ABOVE_FLOOR)} | ${mark(results.criteria[2].pass)} |

## Raw numbers

Band image (${fmt(results.band?.width)}x${fmt(results.band?.height)} = ${fmt(results.band?.pixels)} px):

- covered non-exempt samples: ${fmt(results.band?.consideredSamples)}
- exempt (3x3 contour adjacency in the cpu image): ${fmt(results.band?.exemptSamples)}
- mismatched: ${fmt(results.band?.mismatched)}
- holes, non-exempt: ${fmt(results.band?.holes)}; over all pixels: ${fmt(results.band?.holesAllPixels)}

Shaded (gate 1 metric: 3x3 window, tolerance ${PIXEL_TOLERANCE}, both directions):

- gpu vs cpu: ${fmt(results.shaded?.gpuVsCpu?.mismatched)} / ${fmt(results.shaded?.gpuVsCpu?.pixels)} = ${pct(results.shaded?.gpuVsCpu?.fraction)}
- floor (cpu vs cpu, separate stacks): ${fmt(results.shaded?.floor?.mismatched)} / ${fmt(results.shaded?.floor?.pixels)} = ${pct(results.shaded?.floor?.fraction)}
- above floor: ${pct(results.shaded?.fractionAboveFloor)}

## CPU blocky-fallback chunks

${blockyChunks === null ? '(the client reports none)' : JSON.stringify(blockyChunks)}

Exemption: ${results.blockyExemption}

## Passes

| pass | mesher | band capture | shaded capture |
|---|---|---|---|
${passRows}

## Failures

${results.failures.length === 0 ? '(none)' : results.failures.map((f) => `- ${f}`).join('\n')}
`);

for (const line of [
  `verdict ${results.verdict}`,
  `band: ${fmt(results.band?.mismatched)} / ${fmt(results.band?.consideredSamples)} = ${pct(results.band?.mismatchFraction)}, holes ${fmt(results.band?.holes)}, exempt ${fmt(results.band?.exemptSamples)}`,
  `shaded: gpu-vs-cpu ${pct(results.shaded?.gpuVsCpu?.fraction)}, floor ${pct(results.shaded?.floor?.fraction)}, above floor ${pct(results.shaded?.fractionAboveFloor)}`,
  ...results.failures.map((f) => `FAILURE ${f}`),
]) console.log(line);

process.exit(results.verdict === 'pass' ? 0 : 1);

