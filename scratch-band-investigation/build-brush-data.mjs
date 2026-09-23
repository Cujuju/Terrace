// Offline prototype: edge-aware stamp brushes (round and natural) versus the current brush.
// Bands are decided on a fine grid with continuous geometry; each coarse cell keeps its
// band and stores an in-band height that places the outline where the fine shape has it.
// Floats are used for distances here; a production brush would need integer math.
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import * as production from '../client/src/terrain/contours.ts';
import { simplifyLoop } from '../client/src/terrain/contourSmoothing.ts';
import { groupLoops } from '../client/src/terrain/triangulation.ts';
import {
  applySculpt, bandFloorHeight, bandLevelHeight, createHeightmap, drawnBandOfSample,
  drawnLevelThreshold, BAND_HEIGHT, DEFAULT_SCULPT_AMOUNT, DRAWN_GROUND_BAND_BIAS as BIAS,
} from '../shared/src/index.ts';
import { softApronBandDrop, softApronReachCells } from '../shared/src/sculpt/stamp.ts';
import { footprintRadiusSquared } from '../shared/src/sculpt/footprint.ts';
import { fixtureMirror } from '../client/test/support/mesherFixtures.ts';

const SIZE = 64;
const ORIGIN = 16;
const SPAN = 32;
const CENTER = ORIGIN + SPAN / 2;
const FINE = 8;
const FINE_SIZE = SIZE * FINE + 1;
const DISPLAY_COORD_SCALE = 10000;
const ARC_STEP = 0.25;
// In-band height per cell of distance from an edge: the band midpoint is one cell away.
const UNITS_PER_CELL = BAND_HEIGHT / 2;
const SEARCH_CELLS = 2;
const FILTER = [1, 2, 1];
const FILTER_DENOM = 16;
// Natural outline: smooth value noise added to distance, in cells.
const NOISE_OCTAVES = [{ spacing: 4, amplitude: 0.9 }, { spacing: 1.75, amplitude: 0.3 }];
const NOISE_SEED = 20260922;
const BASE_BAND = 0;
const HARD_RADIUS = 4;

// ---------------------------------------------------------------- noise
const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263 + NOISE_SEED * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
};
const smooth = (t) => t * t * (3 - 2 * t);
function valueNoise(x, y, spacing) {
  const gx = x / spacing, gy = y / spacing, x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = smooth(gx - x0), ty = smooth(gy - y0);
  const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
}
const noise = (x, y) => NOISE_OCTAVES.reduce((s, o) => s + o.amplitude * valueNoise(x, y, o.spacing), 0);

// ---------------------------------------------------------- fine band model
// Mirrors the production stamp in band units: anchored target = click band + 1,
// one band per press, core radius sqrt(r(r-1)), soft apron rings past the core.
function fineStamp(bands, cx, cy, radius, profile, natural) {
  const at = (fx, fy) => fy * FINE_SIZE + fx;
  const target = bands[at(cx * FINE, cy * FINE)] + 1;
  const core = Math.sqrt(footprintRadiusSquared(radius));
  const reach = profile === 'soft' ? softApronReachCells(radius) : 0;
  const outer = Math.sqrt(footprintRadiusSquared(radius + reach)) + 2;
  const next = Int16Array.from(bands);
  for (let fy = Math.max(0, Math.floor((cy - outer) * FINE)); fy <= Math.min(FINE_SIZE - 1, Math.ceil((cy + outer) * FINE)); fy++) {
    for (let fx = Math.max(0, Math.floor((cx - outer) * FINE)); fx <= Math.min(FINE_SIZE - 1, Math.ceil((cx + outer) * FINE)); fx++) {
      const x = fx / FINE, y = fy / FINE;
      const dist = Math.hypot(x - cx, y - cy) + (natural ? noise(x, y) : 0);
      let cellTarget = null;
      if (dist < core) cellTarget = target;
      else if (reach > 0) {
        for (let d = 1; d < reach; d++) {
          if (dist < Math.sqrt(footprintRadiusSquared(radius + d))) { cellTarget = target - softApronBandDrop(d); break; }
        }
        if (cellTarget === null && dist < Math.sqrt(footprintRadiusSquared(radius + reach))) {
          cellTarget = target - softApronBandDrop(reach);
        }
      }
      if (cellTarget !== null && bands[at(fx, fy)] < cellTarget) next[at(fx, fy)] = bands[at(fx, fy)] + 1;
    }
  }
  bands.set(next);
}

// Coarse cells keep the fine band at their sample point; the in-band height encodes
// distance to the nearest edge below (band starts) or above (next band starts).
function edgeAwareHeights(bands) {
  const at = (fx, fy) => fy * FINE_SIZE + fx;
  const cells = new Int16Array(SIZE * SIZE);
  const reach = SEARCH_CELLS * FINE;
  const half = 0.5 / FINE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const band = bands[at(x * FINE, y * FINE)];
      let below = Infinity, above = Infinity;
      for (let dy = -reach; dy <= reach; dy++) {
        const fy = y * FINE + dy;
        if (fy < 0 || fy >= FINE_SIZE) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const fx = x * FINE + dx;
          if (fx < 0 || fx >= FINE_SIZE) continue;
          const other = bands[at(fx, fy)];
          const d = Math.hypot(dx, dy) / FINE - half;
          if (other < band && d < below) below = d;
          if (other > band && d < above) above = d;
        }
      }
      const floor = bandFloorHeight(band);
      const fromBelow = Math.min(BIAS, Math.round(UNITS_PER_CELL * Math.max(0, below)));
      const fromAbove = Math.min(BIAS, Math.max(1, Math.round(UNITS_PER_CELL * Math.max(0, above))));
      cells[y * SIZE + x] = below <= above ? floor + fromBelow : bandFloorHeight(band + 1) - fromAbove;
    }
  }
  return cells;
}

// ---------------------------------------------------------------- scenes
const SCENES = [
  { name: 'hard-stamps', label: 'Stamp, Hard, width 2.0 — overlapping clicks', profile: 'hard',
    clicks: [[28, 30, 4], [28, 30, 4], [34, 32, 4], [31, 37, 4], [38, 27, 4], [38, 27, 4], [38, 27, 4], [25, 36, 4]] },
  { name: 'soft-stamps', label: 'Stamp, Soft, width 2.0 — overlapping clicks', profile: 'soft',
    clicks: [[28, 30, 4], [28, 30, 4], [34, 32, 4], [31, 37, 4], [38, 27, 4], [38, 27, 4], [38, 27, 4], [25, 36, 4]] },
  { name: 'tall-tower', label: 'Stamp, Hard — six clicks in one place (tall wall)', profile: 'hard',
    clicks: Array.from({ length: 6 }, () => [32, 32, 4]) },
  { name: 'archived-stamp', label: 'Archived stamp sequence (soft)', profile: 'soft',
    clicks: [...Array.from({ length: 12 }, () => [32, 32, 4]), ...Array.from({ length: 3 }, () => [35, 30, 2])] },
];

function currentBrush(scene) {
  const map = createHeightmap(SIZE);
  map.cells.fill(bandLevelHeight(BASE_BAND));
  for (const [x, y, r] of scene.clicks) {
    applySculpt(map, x, y, r, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: scene.profile, anchor: 'clicked' });
  }
  return map.cells;
}

function prototypeBrush(scene, natural) {
  const bands = new Int16Array(FINE_SIZE * FINE_SIZE).fill(BASE_BAND);
  for (const [x, y, r] of scene.clicks) fineStamp(bands, x, y, r, scene.profile, natural);
  return edgeAwareHeights(bands);
}

function filtered(cells) {
  const at = (x, y) => cells[Math.max(0, Math.min(SIZE - 1, y)) * SIZE + Math.max(0, Math.min(SIZE - 1, x))];
  return Int32Array.from(cells, (_, i) => {
    const x = i % SIZE, y = Math.floor(i / SIZE);
    let n = 0;
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) n += at(x + k, y + j) * FILTER[k + 1] * FILTER[j + 1];
    return n;
  });
}

// ------------------------------------------------------------ extraction
function extract(field, band, scale) {
  production.loadSampleField((x, y) => field[(y + ORIGIN) * SIZE + x + ORIGIN], SPAN);
  const threshold = (drawnLevelThreshold(band) - BIAS) * scale + BIAS;
  const count = production.marchLevel(threshold, ORIGIN, ORIGIN, null);
  return production.assembleLoops(count, ORIGIN, ORIGIN, production.domainInside(threshold, null)).map(simplifyLoop);
}
// Wall rule: a cell's value for band b is its offset inside its own band, minus one band
// when it lies below b. One-band steps match the height rule exactly; every band of a
// taller step crosses at the same place, so the wall is vertical and edge-placed.
function extractWalls(cells, band) {
  production.loadSampleField((x, y) => {
    const h = cells[(y + ORIGIN) * SIZE + x + ORIGIN];
    const own = drawnBandOfSample(h);
    return h - bandFloorHeight(own) - (own < band ? BAND_HEIGHT : 0);
  }, SPAN);
  const threshold = BIAS;
  const count = production.marchLevel(threshold, ORIGIN, ORIGIN, null);
  return production.assembleLoops(count, ORIGIN, ORIGIN, production.domainInside(threshold, null)).map(simplifyLoop);
}
const loopArea = (loop) => loop.reduce((s, a, i) => { const b = loop[(i + 1) % loop.length]; return s + (a.x * b.z - a.z * b.x) / 2; }, 0);
function turning(loop) {
  const points = []; let next = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length], len = Math.hypot(b.x - a.x, b.z - a.z);
    while (next < len) { points.push({ x: a.x + (b.x - a.x) * next / len, z: a.z + (b.z - a.z) * next / len }); next += ARC_STEP; }
    next -= len;
  }
  return points.reduce((s, b, i) => {
    const a = points[(i + points.length - 1) % points.length], c = points[(i + 1) % points.length];
    const ux = b.x - a.x, uz = b.z - a.z, vx = c.x - b.x, vz = c.z - b.z;
    return s + Math.abs(Math.atan2(ux * vz - uz * vx, ux * vx + uz * vz));
  }, 0);
}
function describe(loops) {
  const groups = groupLoops(loops);
  const round = (v) => Math.round(v * DISPLAY_COORD_SCALE) / DISPLAY_COORD_SCALE;
  return {
    polygons: groups.map((p) => [p.outer, ...p.holes].map((loop) => loop.map((q) => [round(q.x - CENTER), round(q.z - CENTER)]))),
    metrics: {
      components: groups.length,
      holes: groups.reduce((n, p) => n + p.holes.length, 0),
      areaCells: groups.reduce((n, p) => n + Math.abs(loopArea(p.outer)) - p.holes.reduce((a, h) => a + Math.abs(loopArea(h)), 0), 0),
      vertices: loops.reduce((n, l) => n + l.length, 0),
      absoluteTurn: loops.reduce((n, l) => n + turning(l), 0),
    },
  };
}

const GENESIS = { name: 'genesis-noise', label: 'Generated terrain (no brush) — only the wall rule differs' };
const genesisCells = Int16Array.from(fixtureMirror('genesis-noise').map.cells.subarray(0, SIZE * SIZE));
const data = [];
const report = [];
for (const scene of [...SCENES, GENESIS]) {
  const generated = scene === GENESIS;
  const current = generated ? genesisCells : currentBrush(scene);
  const round = generated ? genesisCells : prototypeBrush(scene, false);
  const natural = generated ? genesisCells : prototypeBrush(scene, true);
  let bandDiffs = 0;
  for (let i = 0; i < current.length; i++) bandDiffs += Number(drawnBandOfSample(current[i]) !== drawnBandOfSample(round[i]));
  const top = Math.max(...[current, round, natural].map((c) => drawnBandOfSample(Math.max(...c))));
  const bottom = Math.min(0, ...[current].map((c) => drawnBandOfSample(Math.min(...c))));
  const bands = Array.from({ length: top + 2 - bottom }, (_, i) => bottom + i);
  const fields = { production: [current, 1], 'full-filter': [filtered(current), FILTER_DENOM],
    'edge-round': [round, 1], 'edge-natural': [natural, 1],
    'edge-round-walls': [round, 0], 'edge-natural-walls': [natural, 0] };
  const modes = {};
  const turns = {};
  for (const [method, [field, scale]] of Object.entries(fields)) {
    modes[method] = bands.map((band) => ({ band, ...describe(scale === 0 ? extractWalls(field, band) : extract(field, band, scale)) }));
    turns[method] = Math.round(modes[method].reduce((s, l) => s + l.metrics.absoluteTurn, 0));
  }
  data.push({ name: scene.name, full: true, bands, resolutions: { production: modes, dense: modes } });
  report.push({ scene: scene.name, cellsWhoseBandDiffersFromCurrentBrush: bandDiffs, totalTurningRadians: turns });
}
await writeFile(new URL('brush-data.json.gz', import.meta.url), gzipSync(JSON.stringify(data)));

// Viewer: reuse the comparison template, relabelled for this prototype.
const template = await readFile(new URL('comparison-template.html', import.meta.url), 'utf8');
const fixtureOptions = [...SCENES, GENESIS].map((s) => `<option value="${s.name}">${s.label}</option>`).join('\n        ');
const page = '<style>:root{--background:#f6f4ef;--foreground:#1f2328;--muted:#7d8590;--orange:#c8742c}</style>\n' + template
  .replace('__COMPRESSED_DATA__', gzipSync(JSON.stringify(data)).toString('base64'))
  .replace('__REVIEW_CONFIG__', JSON.stringify({ prototype: true }))
  .replace(/<select class="form-select" id="tbr-fixture">[\s\S]*?<\/select>/, `<select class="form-select" id="tbr-fixture">\n        ${fixtureOptions}\n      </select>`)
  .replace(/Protection\s*<select class="form-select" id="tbr-protection">[\s\S]*?<\/select>/,
    'Prototype brush <select class="form-select" id="tbr-protection"><option value="edge-round">Edge-aware — round</option><option value="edge-natural">Edge-aware — natural</option><option value="edge-round-walls">Edge-aware — round, vertical walls</option><option value="edge-natural-walls">Edge-aware — natural, vertical walls</option></select>')
  .replace(/for\(const \[value,label\]of \[\['one-cell-ridge-control'[\s\S]*?\]\]\)\{/, 'for(const [value,label]of []){')
  .replace("[['production','Original'],['full-filter','Full filter']", "[['production','Current brush'],['full-filter','Current brush + smoothing filter']")
  .replace("['protected-filter','strict-filter','band-clamp-only','clamped-filter'].includes(s.protection)", "['edge-round','edge-natural','edge-round-walls','edge-natural-walls'].includes(s.protection)");
const output = process.argv[2] ?? new URL('brush-preview.html', import.meta.url);
await writeFile(output, page);
console.log(JSON.stringify(report, null, 2));
