// Speed and efficiency of the WebGPU terrain mesher against the CPU mesher.
// Design: .claude/plans/gpu-mesher-production-design.md §11.3.
//
//   node client/scripts/mesherBench.mjs [--meshers cpu,gpu] [--runs 3]
//
// Per mesher: `runs` sculpt runs (settle 45000) and one overview run. Fresh
// world and fresh server per run; one Vite; the GPU lock per Chrome launch.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHROME_WINDOW, RESULTS_DIR, argValue, devUrl, ensureDirs, launchChrome, makeLogger,
  processStopSettleMs, serverSettleWaitMs, sinkOffset, sleep, startServer, startVite,
  stopProcess, underGpuLock, waitForSinkLine,
} from './mesherHarness.mjs';

const DEFAULT_MESHERS = 'cpu,gpu';
const DEFAULT_SCULPT_RUNS = 3;
const SCULPT_SCENARIO = 'sculpt';
const OVERVIEW_SCENARIO = 'overview';
// perfProbe's own default; stated so the URL is explicit in the log.
const SCULPT_SETTLE_MS = 45_000;
const OVERVIEW_SETTLE_MS = 45_000;
// Settle + 240 idle frames + a 5 s stroke + slack.
const RUN_TIMEOUT_MS = 300_000;

// Design §11.3: render + mesher GPU time must stay inside one 140 fps frame.
const GPU_FRAME_BUDGET_MS = 7;
// Echoed as they happen; the full page log is written per run.
const INTERESTING_LOG = /terrace|wgsl|webgpu|gpu|mesher|EXCEPTION|error|warn/i;

const argv = process.argv.slice(2);
const meshers = argValue(argv, '--meshers', DEFAULT_MESHERS).split(',').map((m) => m.trim());
const sculptRuns = Number(argValue(argv, '--runs', String(DEFAULT_SCULPT_RUNS)));

const log = makeLogger(join(RESULTS_DIR, 'bench.log'));
ensureDirs();

/** One run: fresh world + server, Chrome under the GPU lock, the probe report. */
async function runOnce({ mesher, scenario, settleMs, label, logName }) {
  let server = null;
  try {
    server = startServer(log);
    await sleep(serverSettleWaitMs);
    const offset = sinkOffset();
    const url = devUrl(`perfprobe=${scenario}&settle=${settleMs}&mesher=${mesher}`);

    return await underGpuLock(log, async () => {
      const chrome = await launchChrome();
      try {
        log(`${label}: navigate ${url}`);
        await chrome.call('Page.navigate', { url });
        const report = await waitForSinkLine(
          offset, (l) => l.fpsMean !== undefined, RUN_TIMEOUT_MS,
        );
        if (report.error !== null) {
          log(`${label}: FAILED ${JSON.stringify(report.error)}`);
          return { ok: false, detail: report.error };
        }
        log(`${label}: p50 ${report.line.sample?.msP50} p95 ${report.line.sample?.msP95} fps ${report.line.fpsMean}`);
        return { ok: true, report: report.line };
      } finally {
        const lines = chrome.pageLogs();
        writeFileSync(join(RESULTS_DIR, logName), `${lines.join('\n')}\n`);
        for (const line of lines.filter((l) => INTERESTING_LOG.test(l))) log(`${label} page: ${line}`);
        await chrome.close();
      }
    });
  } finally {
    stopProcess(server, log, 'server');
    await sleep(processStopSettleMs);
  }
}

/** Only the fields the probe report actually carries; nothing invented. */
const rowOf = (report) => {
  const sample = report.sample ?? {};
  const idle = report.idle ?? {};
  const load = report.terrainLoad ?? {};
  return {
    clientVersion: report.clientVersion ?? null,
    gpu: report.gpu ?? null,
    rendererBackend: report.rendererBackend ?? null,
    terrainMesher: report.terrainMesher ?? null,
    pixel: `${report.pixelWidth}x${report.pixelHeight}@${report.pixelRatio}`,
    strokeP50: sample.msP50 ?? null,
    strokeP95: sample.msP95 ?? null,
    strokeP99: sample.msP99 ?? null,
    strokeMax: sample.msMax ?? null,
    idleP50: idle.msP50 ?? null,
    fpsMean: report.fpsMean ?? null,
    drawCalls: sample.drawCalls ?? null,
    triangles: sample.triangles ?? null,
    rendererGpuMsP50: sample.gpuMsP50 ?? null,
    rendererGpuMsP99: sample.gpuMsP99 ?? null,
    rendererGpuMsMax: sample.gpuMsMax ?? null,
    gpuTimerSupported: sample.gpuTimerSupported ?? null,
    // The arena's own accounting; renderer.info does not see injected GPU buffers.
    terrainResidentBytes: report.terrainResidentBytes ?? null,
    terrainLoad: {
      firstUpdateMs: load.firstUpdateMs ?? null,
      queueEmptyAfterMs: load.queueEmptyAfterMs ?? null,
      chunksSpliced: load.chunksSpliced ?? null,
      medianSpliceMs: load.medianSpliceMs ?? null,
      maxSpliceMs: load.maxSpliceMs ?? null,
    },
    // Design §6.5; present only on the GPU path.
    gpuMesher: report.gpuMesher ?? null,
  };
};

const median = (values) => {
  const present = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (present.length === 0) return null;
  const mid = present.length >> 1;
  return present.length % 2 === 1 ? present[mid] : (present[mid - 1] + present[mid]) / 2;
};

const medianRow = (rows) => {
  if (rows.length === 0) return null;
  const pick = (key) => median(rows.map((r) => r[key]));
  return {
    strokeP50: pick('strokeP50'), strokeP95: pick('strokeP95'),
    strokeP99: pick('strokeP99'), strokeMax: pick('strokeMax'),
    idleP50: pick('idleP50'), fpsMean: pick('fpsMean'),
    drawCalls: pick('drawCalls'), triangles: pick('triangles'),
    rendererGpuMsP50: pick('rendererGpuMsP50'), rendererGpuMsP99: pick('rendererGpuMsP99'),
    rendererGpuMsMax: pick('rendererGpuMsMax'),
    terrainResidentBytes: pick('terrainResidentBytes'),
    terrainLoad: {
      queueEmptyAfterMs: median(rows.map((r) => r.terrainLoad.queueEmptyAfterMs)),
      chunksSpliced: median(rows.map((r) => r.terrainLoad.chunksSpliced)),
      medianSpliceMs: median(rows.map((r) => r.terrainLoad.medianSpliceMs)),
      maxSpliceMs: median(rows.map((r) => r.terrainLoad.maxSpliceMs)),
    },
  };
};

// -------------------------------------------------------------------- main
const results = {
  startedAt: new Date().toISOString(),
  meshers, sculptRuns, chromeWindow: CHROME_WINDOW,
  sculpt: {}, overview: {}, failures: [],
};

let vite = null;
try {
  vite = await startVite(log);

  for (const mesher of meshers) {
    results.sculpt[mesher] = { runs: [], median: null };
    for (let run = 1; run <= sculptRuns; run++) {
      const label = `${mesher}/sculpt/${run}`;
      const out = await runOnce({
        mesher, scenario: SCULPT_SCENARIO, settleMs: SCULPT_SETTLE_MS, label,
        logName: `page-${mesher}-sculpt-${run}.log`,
      });
      if (out.ok) results.sculpt[mesher].runs.push(rowOf(out.report));
      else results.failures.push(`${label}: ${JSON.stringify(out.detail)}`);
    }
    results.sculpt[mesher].median = medianRow(results.sculpt[mesher].runs);

    const label = `${mesher}/overview`;
    const out = await runOnce({
      mesher, scenario: OVERVIEW_SCENARIO, settleMs: OVERVIEW_SETTLE_MS, label,
      logName: `page-${mesher}-overview.log`,
    });
    results.overview[mesher] = out.ok ? rowOf(out.report) : null;
    if (!out.ok) results.failures.push(`${label}: ${JSON.stringify(out.detail)}`);
  }
} finally {
  stopProcess(vite, log, 'vite');
}

// ------------------------------------------------------------------ verdict
// Design §11.3: the GPU path must beat the CPU path on every row.
const lower = (gpuValue, cpuValue) =>
  (typeof gpuValue === 'number' && typeof cpuValue === 'number' ? gpuValue < cpuValue : null);
const notHigher = (gpuValue, cpuValue) =>
  (typeof gpuValue === 'number' && typeof cpuValue === 'number' ? gpuValue <= cpuValue : null);

const gpuMedian = results.sculpt.gpu?.median ?? null;
const cpuMedian = results.sculpt.cpu?.median ?? null;
const gpuOverview = results.overview.gpu ?? null;
const cpuOverview = results.overview.cpu ?? null;

const renderPlusMesher = (row) => {
  if (row === null || typeof row.rendererGpuMsP99 !== 'number') return null;
  const mesher = results.sculpt.gpu?.runs?.[0]?.gpuMesher ?? null;
  if (mesher === null) return null;
  return row.rendererGpuMsP99 + (mesher.countMs ?? 0) + (mesher.emitMs ?? 0);
};

results.criteria = [
  { name: 'stroke p95 lower than cpu', gpu: gpuMedian?.strokeP95 ?? null, cpu: cpuMedian?.strokeP95 ?? null, pass: lower(gpuMedian?.strokeP95, cpuMedian?.strokeP95) },
  { name: 'stroke p99 lower than cpu', gpu: gpuMedian?.strokeP99 ?? null, cpu: cpuMedian?.strokeP99 ?? null, pass: lower(gpuMedian?.strokeP99, cpuMedian?.strokeP99) },
  { name: 'stroke max lower than cpu', gpu: gpuMedian?.strokeMax ?? null, cpu: cpuMedian?.strokeMax ?? null, pass: lower(gpuMedian?.strokeMax, cpuMedian?.strokeMax) },
  { name: 'load queue-empty lower than cpu', gpu: gpuOverview?.terrainLoad.queueEmptyAfterMs ?? null, cpu: cpuOverview?.terrainLoad.queueEmptyAfterMs ?? null, pass: lower(gpuOverview?.terrainLoad.queueEmptyAfterMs, cpuOverview?.terrainLoad.queueEmptyAfterMs) },
  { name: `render + mesher GPU ms <= ${GPU_FRAME_BUDGET_MS}`, gpu: renderPlusMesher(gpuMedian), cpu: null, pass: renderPlusMesher(gpuMedian) === null ? null : renderPlusMesher(gpuMedian) <= GPU_FRAME_BUDGET_MS },
  // Design §11.3: resident arena bytes no worse than the CPU path's.
  { name: 'terrain resident bytes <= cpu', gpu: gpuMedian?.terrainResidentBytes ?? null, cpu: cpuMedian?.terrainResidentBytes ?? null, pass: notHigher(gpuMedian?.terrainResidentBytes, cpuMedian?.terrainResidentBytes) },
];
results.verdict = results.failures.length > 0 ? 'incomplete'
  : results.criteria.some((c) => c.pass === null) ? 'incomplete'
    : results.criteria.every((c) => c.pass) ? 'pass' : 'fail';

writeFileSync(join(RESULTS_DIR, 'bench.json'), JSON.stringify(results, null, 2));

// --------------------------------------------------------------------- md
// The probe reports raw f64 frame times; the tables round, bench.json keeps them.
const MD_DECIMALS = 2;
const fmt = (v) => (v === null || v === undefined ? 'n/a'
  : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(MD_DECIMALS) : String(v));
const mark = (p) => (p === null ? 'n/a' : p ? 'pass' : 'FAIL');
const gpuMesherCell = (row) => (row?.gpuMesher === null || row?.gpuMesher === undefined
  ? 'n/a'
  : `count ${row.gpuMesher.countMs} / emit ${row.gpuMesher.emitMs} ms, ${row.gpuMesher.batches} batches, ${row.gpuMesher.chunks} chunks`);

const MB = 1e6;
const mb = (v) => (typeof v === 'number' ? `${(v / MB).toFixed(1)} MB` : 'n/a');
const runRow = (label, r) => `| ${label} | ${fmt(r.strokeP50)} | ${fmt(r.strokeP95)} | ${fmt(r.strokeP99)} | ${fmt(r.strokeMax)} | ${fmt(r.idleP50)} | ${fmt(r.fpsMean)} | ${fmt(r.drawCalls)} | ${fmt(r.triangles)} | ${fmt(r.rendererGpuMsP50)} | ${fmt(r.rendererGpuMsP99)} | ${fmt(r.terrainLoad.firstUpdateMs)} | ${fmt(r.terrainLoad.queueEmptyAfterMs)} | ${fmt(r.terrainLoad.chunksSpliced)} | ${fmt(r.terrainLoad.medianSpliceMs)} | ${fmt(r.terrainLoad.maxSpliceMs)} | ${mb(r.terrainResidentBytes)} | ${gpuMesherCell(r)} |`;

const sculptRows = [];
for (const mesher of meshers) {
  const block = results.sculpt[mesher];
  block.runs.forEach((r, i) => sculptRows.push(runRow(`${mesher} run ${i + 1}`, r)));
  if (block.median !== null) {
    sculptRows.push(runRow(`**${mesher} median**`, { ...block.median, gpuMesher: null }));
  }
}
const overviewRows = meshers
  .filter((m) => results.overview[m] !== null && results.overview[m] !== undefined)
  .map((m) => runRow(`${m} overview`, results.overview[m]));

const HEADER = '| run | stroke p50 | p95 | p99 | max | idle p50 | fpsMean | draws | tris | rGPU p50 | rGPU p99 | first update ms | load queue-empty ms | chunks spliced | median splice | max splice | terrain resident | gpuMesher |';
const RULE = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

writeFileSync(join(RESULTS_DIR, 'bench.md'), `# GPU mesher speed and efficiency — design §11.3

Started ${results.startedAt}. Meshers: \`${meshers.join(', ')}\`. Sculpt runs per
mesher: ${sculptRuns} (settle ${SCULPT_SETTLE_MS} ms). Chrome window ${CHROME_WINDOW}.
All times in ms. \`rGPU\` = the renderer's own GPU timestamps from the probe report.

Verdict: **${results.verdict}**

| criterion | gpu | cpu | |
|---|---|---|---|
${results.criteria.map((c) => `| ${c.name} | ${fmt(c.gpu)} | ${fmt(c.cpu)} | ${mark(c.pass)} |`).join('\n')}

## Sculpt

${HEADER}
${RULE}
${sculptRows.join('\n')}

## Overview

${HEADER}
${RULE}
${overviewRows.join('\n') || '| (none) |'}

## Failures

${results.failures.length === 0 ? '(none)' : results.failures.map((f) => `- ${f}`).join('\n')}
`);

for (const line of [
  `verdict ${results.verdict}`,
  ...meshers.map((m) => `${m} sculpt median: p50 ${fmt(results.sculpt[m]?.median?.strokeP50)} p95 ${fmt(results.sculpt[m]?.median?.strokeP95)} p99 ${fmt(results.sculpt[m]?.median?.strokeP99)} max ${fmt(results.sculpt[m]?.median?.strokeMax)}`),
  ...meshers.map((m) => `${m} overview load queue-empty: ${fmt(results.overview[m]?.terrainLoad?.queueEmptyAfterMs)} ms`),
  ...results.failures.map((f) => `FAILURE ${f}`),
]) console.log(line);

process.exit(results.verdict === 'pass' ? 0 : 1);
