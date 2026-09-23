import { protectedDrawnSample } from './protected-kernel-reference.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as production from '../client/src/terrain/contours.ts';
import { simplifyLoop } from '../client/src/terrain/contourSmoothing.ts';
import { groupLoops } from '../client/src/terrain/triangulation.ts';
import { bandLevelHeight, drawnBandOfSample, drawnLevelThreshold, DRAWN_GROUND_BAND_BIAS as BIAS,
  columnSampleAtBand, ISOLINE_SAMPLES_PER_CELL } from '../shared/src/index.ts';
import { CHUNK_SIZE } from '../shared/src/constants.ts';
import { deriveProtectedField, FILTER_DENOM, FILTER_WEIGHTS, RAW_NEIGHBOR_REACH,
  GUARD_THIN, GUARD_SADDLE, GUARD_LAYER } from './protected-field.mjs';

const ORIGIN = 16;
const SPAN = 32;
const CENTER = ORIGIN + SPAN / 2;
const DENSE_SEGMENTS = 32;
const DISPLAY_COORD_SCALE = 10000;
const ARC_STEP = 0.25;
const source = await readFile(new URL('../client/src/terrain/contours.ts', import.meta.url), 'utf8');
const denseSource = `const ISOLINE_SAMPLES_PER_CELL = ${DENSE_SEGMENTS};\n` + source
  .replace('  ISOLINE_SAMPLES_PER_CELL,', '')
  .replace("from '@terrace/shared'", `from '${new URL('../shared/src/index.ts', import.meta.url).href}'`)
  .replace("from './mirror.ts'", `from '${new URL('../client/src/terrain/mirror.ts', import.meta.url).href}'`);
await writeFile(new URL('dense-contours.ts', import.meta.url), denseSource);
const dense = await import('./dense-contours.ts');
const archiveBytes = await readFile(new URL('measurements.json.gz', import.meta.url));
const archived = JSON.parse(gunzipSync(archiveBytes));
const digest = value => createHash('sha256').update(value).digest('hex');
const fixtures = archived.cases.map(f => ({
  name: f.name, bands: [...new Set(f.rows.map(row => row.band))],
  map: { size: f.size, cells: Int16Array.from(f.heights),
    columnSpans: new Map(f.spans.map(([i, spans]) => [i, Int16Array.from(spans)])) },
}));

// Additional visual controls; same 64×64 domain, canonical heights and centered placement as the archive.
const size = fixtures[0].map.size;
for (const kind of ['ridge', 'channel', 'saddle']) {
  const cells = new Int16Array(size * size).fill(bandLevelHeight(0));
  if (kind === 'saddle') {
    for (const [dx, dy] of [[0, 0], [1, 1]]) cells[(CENTER + dy) * size + CENTER + dx] = bandLevelHeight(1);
  } else {
    for (let y = CENTER - 5; y <= CENTER + 5; y++) {
      cells[y * size + CENTER] = bandLevelHeight(kind === 'ridge' ? 1 : -1);
    }
  }
  fixtures.push({ name: `one-cell-${kind}-control`, bands: [kind === 'channel' ? 0 : 1],
    map: { size, cells, columnSpans: new Map() } });
}

function extract(mod, field, band, scale) {
  mod.loadSampleField((x, y) => field[(y + ORIGIN) * size + x + ORIGIN], SPAN);
  const threshold = (drawnLevelThreshold(band) - BIAS) * scale + BIAS;
  const count = mod.marchLevel(threshold, ORIGIN, ORIGIN, null);
  return mod.assembleLoops(count, ORIGIN, ORIGIN, mod.domainInside(threshold, null)).map(simplifyLoop);
}

function loopArea(loop) {
  return loop.reduce((sum, a, i) => {
    const b = loop[(i + 1) % loop.length];
    return sum + (a.x * b.z - a.z * b.x) / 2;
  }, 0);
}

function turning(loop) {
  const points = [];
  let next = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    while (next < length) {
      points.push({ x: a.x + (b.x - a.x) * next / length, z: a.z + (b.z - a.z) * next / length });
      next += ARC_STEP;
    }
    next -= length;
  }
  return points.reduce((sum, b, i) => {
    const a = points[(i + points.length - 1) % points.length], c = points[(i + 1) % points.length];
    const ux = b.x - a.x, uz = b.z - a.z, vx = c.x - b.x, vz = c.z - b.z;
    return sum + Math.abs(Math.atan2(ux * vz - uz * vx, ux * vx + uz * vz));
  }, 0);
}

function describe(loops) {
  const groups = groupLoops(loops);
  const round = value => Math.round(value * DISPLAY_COORD_SCALE) / DISPLAY_COORD_SCALE;
  return {
    polygons: groups.map(p => [p.outer, ...p.holes].map(loop => loop.map(p => [round(p.x - CENTER), round(p.z - CENTER)]))),
    metrics: {
      components: groups.length,
      holes: groups.reduce((n, p) => n + p.holes.length, 0),
      areaCells: groups.reduce((n, p) => n + Math.abs(loopArea(p.outer)) - p.holes.reduce((a, h) => a + Math.abs(loopArea(h)), 0), 0),
      vertices: loops.reduce((n, loop) => n + loop.length, 0),
      absoluteTurn: loops.reduce((n, loop) => n + turning(loop), 0),
    },
  };
}

function measureWindowAgreement(raw, layeredCells, whole) {
  const windowSize = CHUNK_SIZE + 1 + RAW_NEIGHBOR_REACH * 2;
  let comparedSamples = 0, differingSamples = 0;
  for (const originY of [ORIGIN, ORIGIN + CHUNK_SIZE]) {
    for (const originX of [ORIGIN, ORIGIN + CHUNK_SIZE]) {
      const windowX = originX - RAW_NEIGHBOR_REACH, windowY = originY - RAW_NEIGHBOR_REACH;
      const windowLayers = new Set();
      const windowRaw = Int32Array.from({ length: windowSize ** 2 }, (_, i) => {
        const sourceIndex = (windowY + Math.floor(i / windowSize)) * size + windowX + i % windowSize;
        if (layeredCells.has(sourceIndex)) windowLayers.add(i);
        return raw[sourceIndex];
      });
      const local = deriveProtectedField(windowRaw, windowSize, windowLayers);
      for (let y = 0; y <= CHUNK_SIZE; y++) {
        for (let x = 0; x <= CHUNK_SIZE; x++) {
          const wi = (y + RAW_NEIGHBOR_REACH) * windowSize + x + RAW_NEIGHBOR_REACH;
          const gi = (originY + y) * size + originX + x;
          comparedSamples++;
          differingSamples += Number(['full', 'clamped', 'protectedField', 'strictField', 'guards'].some(key => local[key][wi] !== whole[key][gi]));
        }
      }
    }
  }
  return { windowSize, comparedSamples, differingSamples, scope: 'Complete interior windows only; no missing-chunk policy modeled.' };
}

const data = [];
const report = {
  status: 'Offline appearance prototype; owner review pending. Not production CPU/GPU validation.',
  archiveSha256: digest(archiveBytes), contourSourceSha256: digest(source),
  settings: { filterWeights: FILTER_WEIGHTS, filterDenominator: FILTER_DENOM, rawNeighborReach: RAW_NEIGHBOR_REACH,
    productionSegments: ISOLINE_SAMPLES_PER_CELL, denseSegments: DENSE_SEGMENTS, origin: ORIGIN, span: SPAN,
    displayCoordinateScale: DISPLAY_COORD_SCALE, turningResampleStep: ARC_STEP },
  cases: [],
};

for (const fixture of fixtures) {
  const { map, name } = fixture;
  const inputHashBefore = digest(JSON.stringify({ cells: [...map.cells], spans: [...map.columnSpans].map(([i, s]) => [i, [...s]]) }));
  const full = name === 'stamp' || name === 'stamp-smooth';
  const bands = full ? Array.from({ length: drawnBandOfSample(Math.max(...map.cells)) + 2 }, (_, i) => i)
    : name === 'layered-opening-control' ? [4] : [fixture.bands.at(-1)];
  const resolutions = {};
  const rows = [];
  for (const band of bands) {
    const raw = map.columnSpans.size ? Int32Array.from(map.cells, (_, i) => columnSampleAtBand(map, i % size, Math.floor(i / size), band))
      : Int32Array.from(map.cells);
    const layeredCells = new Set(map.columnSpans.keys());
    const derived = deriveProtectedField(raw, size, layeredCells);
    // Archived protected kernel; production now uses the plain binomial pass.
    // Retain the original experiment as an independent parity reference.
    const filterSource = { size, sample: (x, y) => raw[y * size + x],
      layered: (x, y) => layeredCells.has(y * size + x), available: () => true };
    const filterScratch = new Int32Array(25);
    const productionProtected = Int32Array.from(raw, (_, i) =>
      protectedDrawnSample(filterSource, i % size, Math.floor(i / size), band, filterScratch));
    if (productionProtected.some((value, i) => value !== derived.protectedField[i])) {
      throw new Error(`${name}, band ${band}: production/prototype mismatch`);
    }
    const fields = { production: [raw, 1], 'full-filter': [derived.full, FILTER_DENOM],
      'protected-filter': [productionProtected, FILTER_DENOM], 'strict-filter': [derived.strictField, FILTER_DENOM],
      'band-clamp-only': [derived.clamped, FILTER_DENOM] };
    for (const [resolution, mod] of [['production', production], ['dense', dense]]) {
      const modes = resolutions[resolution] ??= {};
      let baseline, baselineHoles;
      for (const [method, [field, scale]] of Object.entries(fields)) {
        const loops = extract(mod, field, band, scale);
        const result = describe(loops);
        const holes = groupLoops(loops).flatMap(p => p.holes);
        if (method === 'production') { baseline = loops; baselineHoles = holes; }
        (modes[method] ??= []).push({ band, ...result });
        rows.push({ resolution, band, method, ...result.metrics,
          exactOriginalContours: JSON.stringify(loops) === JSON.stringify(baseline),
          exactOriginalHoleContours: JSON.stringify(holes) === JSON.stringify(baselineHoles) });
      }
    }
    let membershipChanges = 0, strictMembershipChanges = 0, guardedChanges = 0, maxNumerator = 0;
    const guardCounts = { thin: 0, saddle: 0, layered: 0, any: 0 };
    for (let y = ORIGIN; y <= ORIGIN + SPAN; y++) {
      for (let x = ORIGIN; x <= ORIGIN + SPAN; x++) {
        const i = y * size + x, mask = derived.guards[i];
        membershipChanges += Number(drawnBandOfSample(derived.protectedField[i] / FILTER_DENOM) !== drawnBandOfSample(raw[i]));
        strictMembershipChanges += Number(drawnBandOfSample(derived.strictField[i] / FILTER_DENOM) !== drawnBandOfSample(raw[i]));
        guardedChanges += Number(mask !== 0 && derived.protectedField[i] !== raw[i] * FILTER_DENOM);
        maxNumerator = Math.max(maxNumerator, Math.abs(derived.protectedField[i]));
        guardCounts.any += Number(mask !== 0);
        guardCounts.thin += Number((mask & GUARD_THIN) !== 0);
        guardCounts.saddle += Number((mask & GUARD_SADDLE) !== 0);
        guardCounts.layered += Number((mask & GUARD_LAYER) !== 0);
      }
    }
    rows.push({ band, diagnostics: { membershipChanges, strictMembershipChanges, guardedChanges, maxNumerator, guardCounts,
      thinSamples: derived.thinSamples, saddleSquares: derived.saddleSquares,
      ...(band === bands.at(-1) ? { windowAgreement: measureWindowAgreement(raw, layeredCells, derived) } : {}) } });
  }
  const inputHashAfter = digest(JSON.stringify({ cells: [...map.cells], spans: [...map.columnSpans].map(([i, s]) => [i, [...s]]) }));
  data.push({ name, full, bands, resolutions });
  report.cases.push({ name, inputUnchanged: inputHashBefore === inputHashAfter, inputHash: inputHashBefore, rows });
}

await writeFile(new URL('protected-data.json.gz', import.meta.url), gzipSync(JSON.stringify(data)));
await writeFile(new URL('protected-measurements.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.cases.map(c => ({ name: c.name, inputUnchanged: c.inputUnchanged,
  rows: c.rows.filter(r => r.resolution === 'production' && (r.band === 12 || !c.name.startsWith('stamp'))) })), null, 2));
