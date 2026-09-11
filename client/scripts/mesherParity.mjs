// Pixel-level parity of the WebGPU terrain mesher against the CPU mesher.
// Design: .claude/plans/gpu-mesher-production-design.md §11.2.
//
//   node client/scripts/mesherParity.mjs [--meshers cpu,cpu-shift,cpu-quant,gpu]
//                                        [--shadedScenario terrainStill] [--settle 5000]
//                                        [--shiftSteps 0.5]
//
// One pass per mesher entry, each on its own fresh world, fresh server and fresh
// Chrome under the GPU lock, taking a band-ID capture and a shaded capture.
// Three floors, in the order the shaded criterion prefers them:
//   `-quant` snaps the float32 CPU arena onto the GPU position grid, so it
//      isolates everything the grid itself costs;
//   `-shift` slides the same mesh half a grid step, gate 1's method for the
//      sub-pixel tread phenomenon, where identical geometry rasterizes
//      identically but which riser wins a grazing tread pixel flips;
//   a repeated `cpu` is the repeat floor, what an identical stack scores
//      against itself.
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

const DEFAULT_MESHERS = 'cpu,cpu-shift,cpu-quant,gpu';
// A mesher token ending in this runs the same mesher with `?parityShift`.
const SHIFT_SUFFIX = '-shift';
// ... and in this, with `?parityQuantize=1`.
const QUANT_SUFFIX = '-quant';
// Half a GPU position step (POSITION_XZ_UNITS_PER_WORLD_UNIT = 1024), gate 1's
// offset for measuring the metric's own floor.
const DEFAULT_SHIFT_STEPS = 0.5;
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
// Echoed to the console as they happen; the full page log is written per capture.
const INTERESTING_LOG = /terrace|wgsl|webgpu|gpu|mesher|EXCEPTION|error|warn/i;

const argv = process.argv.slice(2);
const meshers = argValue(argv, '--meshers', DEFAULT_MESHERS).split(',').map((m) => m.trim());
const shadedScenario = argValue(argv, '--shadedScenario', DEFAULT_SHADED_SCENARIO);
const shadedReadyBeat = shadedScenario === DEFAULT_SHADED_SCENARIO ? SHADED_READY_BEAT : null;
const settleMs = Number(argValue(argv, '--settle', String(DEFAULT_SETTLE_MS)));
const shiftSteps = Number(argValue(argv, '--shiftSteps', String(DEFAULT_SHIFT_STEPS)));

const log = makeLogger(join(RESULTS_DIR, 'parity.log'));
ensureDirs();

/**
 * `cpu, cpu-shift, cpu-quant, gpu` -> ids of the same names; a repeated token is
 * numbered (`cpu`, `cpu2`). A `-shift` or `-quant` token keeps its mesher and
 * carries the flag, so it is a distinct pass rather than a duplicate.
 */
const passes = (() => {
  const seen = new Map();
  return meshers.map((token) => {
    const shifted = token.endsWith(SHIFT_SUFFIX);
    const quantized = token.endsWith(QUANT_SUFFIX);
    const suffix = shifted ? SHIFT_SUFFIX : quantized ? QUANT_SUFFIX : '';
    const mesher = suffix === '' ? token : token.slice(0, -suffix.length);
    const n = (seen.get(token) ?? 0) + 1;
    seen.set(token, n);
    return {
      token, mesher, shift: shifted ? shiftSteps : 0, quantize: quantized,
      id: n === 1 ? token : `${token}${n}`,
    };
  });
})();

// ------------------------------------------------------------------ capture
/**
 * One capture: fresh world + server, Chrome under the GPU lock, screenshot on
 * the scenario's ready heartbeat, then its report. `readyBeat === null` means
 * the scenario posts no ready beat, so the screenshot is taken at the report.
 */
async function capture({ mesher, shift, quantize, scenario, readyBeat, pngPath, logName }) {
  let server = null;
  try {
    server = startServer(log);
    await sleep(serverSettleWaitMs);
    const offset = sinkOffset();
    const url = devUrl(`perfprobe=${scenario}&settle=${settleMs}&mesher=${mesher}`
      + (shift === 0 ? '' : `&parityShift=${shift}`)
      + (quantize ? '&parityQuantize=1' : ''));

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
        const lines = chrome.pageLogs();
        writeFileSync(join(RESULTS_DIR, logName), `${lines.join('\n')}\n`);
        for (const line of lines.filter((l) => INTERESTING_LOG.test(l))) log(`page: ${line}`);
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
/** What the report says about which paths actually ran. Never invented. */
const reportFacts = (report) => ({
  clientVersion: report.clientVersion ?? null,
  rendererBackend: report.rendererBackend ?? null,
  terrainMesher: report.terrainMesher ?? null,
  meshersActive: report.meshersActive ?? null,
  blockyChunks: report.blockyChunks ?? null,
  gpuMesher: report.gpuMesher ?? null,
  terrainResidentBytes: report.terrainResidentBytes ?? null,
});

const results = {
  startedAt: new Date().toISOString(),
  meshers, shadedScenario, settleMs, shiftSteps,
  passes: {}, failures: [],
};

let vite = null;
try {
  vite = await startVite(log);

  for (const { mesher, shift, quantize, id } of passes) {
    results.passes[id] = { mesher, shift, quantize, band: null, shaded: null };

    const band = await capture({
      mesher, shift, quantize, scenario: BAND_SCENARIO, readyBeat: BAND_READY_BEAT,
      pngPath: join(RESULTS_DIR, `band-${id}.png`), logName: `page-band-${id}.log`,
    });
    results.passes[id].band = band.ok
      ? { ok: true, png: `band-${id}.png`, log: `page-band-${id}.log`, ...reportFacts(band.report) }
      : { ok: false, stage: band.stage, detail: band.detail, log: `page-band-${id}.log` };
    if (!band.ok) {
      // Design §11.2 requires the band scenario; a missing scenario must be loud.
      results.failures.push(`${id}/${BAND_SCENARIO}: ${JSON.stringify(band.detail)}`);
      log(`FAIL ${id}/${BAND_SCENARIO} at ${band.stage}: ${JSON.stringify(band.detail)}`);
    }

    const shaded = await capture({
      mesher, shift, quantize, scenario: shadedScenario, readyBeat: shadedReadyBeat,
      pngPath: join(RESULTS_DIR, `shaded-${id}.png`), logName: `page-shaded-${id}.log`,
    });
    results.passes[id].shaded = shaded.ok
      ? {
        ok: true, png: `shaded-${id}.png`, scenario: shadedScenario,
        log: `page-shaded-${id}.log`, ...reportFacts(shaded.report),
      }
      : { ok: false, stage: shaded.stage, detail: shaded.detail, log: `page-shaded-${id}.log` };
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

// The reference pass is the first unshifted cpu pass; the repeat floor is a
// second one; the quantization floor is the first shifted pass.
const idOf = (pick) => passes.find(pick)?.id ?? null;
const plain = (p) => p.mesher === 'cpu' && p.shift === 0 && !p.quantize;
const REFERENCE = idOf(plain);
const REPEAT = passes.filter(plain)[1]?.id ?? null;
const SHIFTED = idOf((p) => p.shift !== 0);
const QUANT = idOf((p) => p.quantize);
const GPU = idOf((p) => p.mesher === 'gpu');
results.roles = {
  reference: REFERENCE, repeatFloor: REPEAT, shiftFloor: SHIFTED, quantFloor: QUANT, gpu: GPU,
};

// The CPU's own blocky fallback, from the reference pass that produced the image.
const blockyChunks = results.passes[REFERENCE]?.band?.blockyChunks
  ?? results.passes[REFERENCE]?.shaded?.blockyChunks ?? null;

const bandRef = readImage(REFERENCE, 'band');
/** Band comparison against the reference, with the diff written out. */
const bandAgainstRef = (id, diffName) => {
  const other = readImage(id, 'band');
  if (other === null || bandRef === null) return null;
  sameSize(other, bandRef, `band images (${id})`);
  const r = compareBands(other, bandRef, blockyChunks);
  writeFileSync(join(RESULTS_DIR, diffName), encodePng(r.width, r.height, r.diff));
  delete r.diff;
  return r;
};
results.band = bandAgainstRef(GPU, 'diff-band.png');
results.bandFloorRepeat = bandAgainstRef(REPEAT, 'diff-band-floor-repeat.png');
results.bandFloorShift = bandAgainstRef(SHIFTED, 'diff-band-floor-shift.png');
results.bandFloorQuant = bandAgainstRef(QUANT, 'diff-band-floor-quant.png');

const shadedRef = readImage(REFERENCE, 'shaded');
/** Shaded comparison against the reference, with the diff written out. */
const shadedAgainstRef = (id, diffName) => {
  const other = readImage(id, 'shaded');
  if (other === null || shadedRef === null) return null;
  sameSize(other, shadedRef, `shaded images (${id})`);
  const paint = new Uint8Array(other.width * other.height * CHANNELS);
  const r = compareShaded(other, shadedRef, paint);
  writeFileSync(join(RESULTS_DIR, diffName), encodePng(other.width, other.height, paint));
  return r;
};
const gpuVsCpu = shadedAgainstRef(GPU, 'diff-shaded.png');
const floorRepeat = shadedAgainstRef(REPEAT, 'diff-shaded-floor-repeat.png');
const floorShift = shadedAgainstRef(SHIFTED, 'diff-shaded-floor-shift.png');
const floorQuant = shadedAgainstRef(QUANT, 'diff-shaded-floor-quant.png');
// Prefer the quantize floor: it is the same mesh on the GPU's own position
// grid, so it charges the metric for everything the grid costs, of which the
// shift floor's tread flip is one part.
const floorUsed = floorQuant !== null ? 'quant'
  : floorShift !== null ? 'shift' : floorRepeat !== null ? 'repeat' : null;
const floorFraction = floorQuant?.fraction ?? floorShift?.fraction ?? floorRepeat?.fraction ?? null;
results.shaded = gpuVsCpu === null && floorUsed === null ? null : {
  gpuVsCpu, floorRepeat, floorShift, floorQuant, floorUsed,
  fractionAboveFloor: gpuVsCpu === null || floorFraction === null
    ? null : gpuVsCpu.fraction - floorFraction,
};

// Blocky-chunk exemption: the CPU's work-budget fallback (design §9.2),
// applied per pixel from the chunk index the cpu band image carries in G and B.
results.blockyChunks = blockyChunks;
results.blockyExemption = blockyChunks === null
  ? 'not applied: no `blockyChunks` field on the cpu band report'
  : blockyChunks.length === 0
    ? 'vacuous: the CPU path drew no chunk blocky'
    : `applied per pixel from the cpu band image chunk id, dilated 3x3: `
      + `${blockyChunks.length} chunks, ${results.band?.blockyExemptSamples ?? 0} samples exempt`;

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

const capsule = (c) => (c?.ok
  ? `${c.png} (backend ${fmt(c.rendererBackend)}, mesher ${fmt(c.terrainMesher)})`
  : `FAILED (${c?.stage})`);
const roleOf = (id) => Object.entries(results.roles)
  .filter(([, v]) => v === id).map(([k]) => k).join(', ') || '-';
const passRows = Object.entries(results.passes).map(([id, p]) =>
  `| ${id} | ${p.mesher} | ${p.shift} | ${p.quantize ? 'yes' : 'no'} | ${roleOf(id)}`
  + ` | ${capsule(p.band)} | ${capsule(p.shaded)} |`).join('\n');
const bandFloorRow = (label, r) => `| ${label} | ${fmt(r?.mismatched)} | ${fmt(r?.consideredSamples)}`
  + ` | ${pct(r?.mismatchFraction)} | ${fmt(r?.holes)} |`;

writeFileSync(join(RESULTS_DIR, 'parity.md'), `# GPU mesher parity — design §11.2

Started ${results.startedAt}. Meshers: \`${meshers.join(', ')}\`. Shaded scenario:
\`${shadedScenario}\`. Chrome window ${CHROME_WINDOW}. Shift floor: \`parityShift=${shiftSteps}\`
(${shiftSteps} of a 1/1024 wu GPU position step).

Verdict: **${results.verdict}**

| criterion | measured | limit | |
|---|---|---|---|
| band-ID mismatch fraction, gpu vs cpu, non-exempt covered samples | ${pct(results.band?.mismatchFraction)} | ${pct(MAX_BAND_MISMATCH_FRACTION)} | ${mark(results.criteria[0].pass)} |
| band-ID holes (gpu background where cpu has terrain), non-exempt | ${fmt(results.band?.holes)} | ${MAX_HOLES} | ${mark(results.criteria[1].pass)} |
| shaded mismatch fraction above the ${results.shaded?.floorUsed ?? 'n/a'} floor | ${pct(results.shaded?.fractionAboveFloor)} | ${pct(MAX_SHADED_FRACTION_ABOVE_FLOOR)} | ${mark(results.criteria[2].pass)} |

## Raw numbers

Band image (${fmt(results.band?.width)}x${fmt(results.band?.height)} = ${fmt(results.band?.pixels)} px):

- covered non-exempt samples: ${fmt(results.band?.consideredSamples)}
- exempt, total: ${fmt(results.band?.exemptSamples)} (of which blocky-chunk: ${fmt(results.band?.blockyExemptSamples)})
- mismatched: ${fmt(results.band?.mismatched)}
- holes, non-exempt: ${fmt(results.band?.holes)}; over all pixels: ${fmt(results.band?.holesAllPixels)}

Band, each comparison against the \`${REFERENCE}\` reference:

| comparison | mismatched | considered | fraction | holes |
|---|---|---|---|---|
${bandFloorRow(`gpu vs ${REFERENCE}`, results.band)}
${bandFloorRow(`repeat floor (${REPEAT ?? 'not run'})`, results.bandFloorRepeat)}
${bandFloorRow(`shift floor (${SHIFTED ?? 'not run'})`, results.bandFloorShift)}
${bandFloorRow(`quant floor (${QUANT ?? 'not run'})`, results.bandFloorQuant)}

Shaded (gate 1 metric: 3x3 window, tolerance ${PIXEL_TOLERANCE}, both directions),
each against \`${REFERENCE}\`:

| comparison | mismatched | of pixels | fraction |
|---|---|---|---|
| gpu | ${fmt(results.shaded?.gpuVsCpu?.mismatched)} | ${fmt(results.shaded?.gpuVsCpu?.pixels)} | ${pct(results.shaded?.gpuVsCpu?.fraction)} |
| repeat floor (${REPEAT ?? 'not run'}) | ${fmt(results.shaded?.floorRepeat?.mismatched)} | ${fmt(results.shaded?.floorRepeat?.pixels)} | ${pct(results.shaded?.floorRepeat?.fraction)} |
| shift floor (${SHIFTED ?? 'not run'}) | ${fmt(results.shaded?.floorShift?.mismatched)} | ${fmt(results.shaded?.floorShift?.pixels)} | ${pct(results.shaded?.floorShift?.fraction)} |
| quant floor (${QUANT ?? 'not run'}) | ${fmt(results.shaded?.floorQuant?.mismatched)} | ${fmt(results.shaded?.floorQuant?.pixels)} | ${pct(results.shaded?.floorQuant?.fraction)} |

Judged above the **${results.shaded?.floorUsed ?? 'n/a'}** floor: ${pct(results.shaded?.fractionAboveFloor)}

## CPU blocky-fallback chunks

${blockyChunks === null ? '(the client reports none)' : JSON.stringify(blockyChunks)}

Exemption: ${results.blockyExemption}

## Passes

| pass | mesher | shift steps | quantized | role | band capture | shaded capture |
|---|---|---|---|---|---|---|
${passRows}

## Failures

${results.failures.length === 0 ? '(none)' : results.failures.map((f) => `- ${f}`).join('\n')}
`);

for (const line of [
  `verdict ${results.verdict}`,
  `band: ${fmt(results.band?.mismatched)} / ${fmt(results.band?.consideredSamples)} = ${pct(results.band?.mismatchFraction)}, holes ${fmt(results.band?.holes)}, exempt ${fmt(results.band?.exemptSamples)}`,
  `band floors: repeat ${pct(results.bandFloorRepeat?.mismatchFraction)} (holes ${fmt(results.bandFloorRepeat?.holes)}),`
    + ` shift ${pct(results.bandFloorShift?.mismatchFraction)} (holes ${fmt(results.bandFloorShift?.holes)}),`
    + ` quant ${pct(results.bandFloorQuant?.mismatchFraction)} (holes ${fmt(results.bandFloorQuant?.holes)})`,
  `shaded: gpu-vs-cpu ${pct(results.shaded?.gpuVsCpu?.fraction)}, repeat floor ${pct(results.shaded?.floorRepeat?.fraction)},`
    + ` shift floor ${pct(results.shaded?.floorShift?.fraction)}, quant floor ${pct(results.shaded?.floorQuant?.fraction)}`,
  `shaded above ${results.shaded?.floorUsed ?? 'n/a'} floor: ${pct(results.shaded?.fractionAboveFloor)}`,
  ...results.failures.map((f) => `FAILURE ${f}`),
]) console.log(line);

process.exit(results.verdict === 'pass' ? 0 : 1);

