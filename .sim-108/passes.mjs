import * as OLD from './old-src/index.ts';
import * as NEW from '../shared/src/index.ts';

const RULES = [
  { label: 'old', mod: OLD },
  { label: 'new', mod: NEW },
];

const SIZE = 128;
const C = SIZE / 2;
const STAMP = { tool: 'stamp', profile: 'hard' };

const CEILING_BANDS = NEW.MAX_HEIGHT / NEW.BAND_HEIGHT;

function stampPlateau(mod, map, x, y, bands) {
  for (let s = 0; s < bands; s++) {
    mod.applySculpt(map, x, y, 4, NEW.DEFAULT_SCULPT_AMOUNT, STAMP);
  }
}

function relief(cells) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] < lo) lo = cells[i];
    if (cells[i] > hi) hi = cells[i];
  }
  return hi - lo;
}

const CASES = [
  {
    name: '15-band plateau, one smooth stroke',
    build(mod, map) {
      stampPlateau(mod, map, C, C, CEILING_BANDS - 1);
    },
  },
  {
    name: 'MAX plateau (brush fully clamped)',
    build(mod, map) {
      stampPlateau(mod, map, C, C, CEILING_BANDS);
    },
  },
  {
    name: 'MAX plateau beside a MIN moat',
    build(mod, map) {
      stampPlateau(mod, map, C, C, CEILING_BANDS);
      for (let s = 0; s < 16; s++) {
        mod.applySculpt(map, C + 8, C, 4, -NEW.DEFAULT_SCULPT_AMOUNT, STAMP);
      }
    },
  },
];

const CLIFFS = [100, 401, 1000];

function cliffRun(mod, height) {
  const map = mod.createHeightmap(SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE >> 1; x++) map.cells[y * SIZE + x] = height;
  }
  const seed = new Set();
  for (let i = 0; i < map.cells.length; i++) if (map.cells[i] === height) seed.add(i);
  return { passes: mod.smooth(map, new Set(seed), seed), relief: height };
}

const pad = (v, w) => String(v).padStart(w);
const padR = (v, w) => String(v).padEnd(w);

console.log('Issue #108 pass 2 — passes per cell of spread, old rule vs new');
console.log(
  `MAX_STEP=${NEW.MAX_STEP}  SMOOTH_SPREAD_CELLS=${NEW.SMOOTH_SPREAD_CELLS}` +
    `  SMOOTH_PASS_LIMIT=${NEW.SMOOTH_PASS_LIMIT}  node ${process.version}  ${new Date().toISOString()}`,
);
console.log('');
console.log(
  `${padR('stroke', 38)}${padR('rule', 6)}${pad('relief', 8)}${pad('spread', 8)}` +
    `${pad('passes', 8)}${pad('per cell', 10)}`,
);
console.log(`${'-'.repeat(38)}  ${'-'.repeat(4)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(8)}`);

for (const testCase of CASES) {
  for (const { label, mod } of RULES) {
    const map = mod.createHeightmap(SIZE);
    testCase.build(mod, map);
    const before = relief(map.cells);
    const changed = new Set();
    mod.applyLevelFillBrush(map, C, C, 4, NEW.DEFAULT_SCULPT_AMOUNT, changed, 'free', null, null);
    let seed = changed;
    if (changed.size === 0) {
      seed = new Set();
      mod.forEachFootprintOffset(4, (dx, dy) => seed.add((C + dy) * SIZE + (C + dx)));
    }
    const passes = mod.smooth(map, changed, seed);
    const spread = Math.floor(before / NEW.MAX_STEP);
    console.log(
      `${padR(testCase.name, 38)}${padR(label, 6)}${pad(before, 8)}${pad(spread, 8)}` +
        `${pad(passes, 8)}${pad((passes / spread).toFixed(2), 10)}`,
    );
  }
}

for (const height of CLIFFS) {
  for (const { label, mod } of RULES) {
    const r = cliffRun(mod, height);
    const spread = Math.floor(r.relief / NEW.MAX_STEP);
    const capped = r.passes >= NEW.SMOOTH_PASS_LIMIT ? ' (TRUNCATED at the cap)' : '';
    console.log(
      `${padR(`bare cliff ${height} (synthetic)`, 38)}${padR(label, 6)}${pad(r.relief, 8)}` +
        `${pad(spread, 8)}${pad(r.passes, 8)}${pad((r.passes / spread).toFixed(2), 10)}${capped}`,
    );
  }
}

function cliffPassesAndGradient(height) {
  const map = NEW.createHeightmap(SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE >> 1; x++) map.cells[y * SIZE + x] = height;
  }
  const seed = new Set();
  for (let i = 0; i < map.cells.length; i++) if (map.cells[i] === height) seed.add(i);
  const passes = NEW.smooth(map, new Set(seed), seed);
  let worst = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (x < SIZE - 1) worst = Math.max(worst, Math.abs(map.cells[i] - map.cells[i + 1]));
      if (y < SIZE - 1) worst = Math.max(worst, Math.abs(map.cells[i] - map.cells[i + SIZE]));
    }
  }
  return { passes, worst };
}

console.log('');
console.log('TRUNCATION THRESHOLD — smallest bare cliff that hits the pass cap (128², new rule)');
let lo = 400;
let hi = 1000;
while (lo < hi) {
  const mid = (lo + hi) >> 1;
  if (cliffPassesAndGradient(mid).passes >= NEW.SMOOTH_PASS_LIMIT) hi = mid;
  else lo = mid + 1;
}
console.log(`  smallest wall that TRUNCATES: ${lo} height units`);
for (const height of [lo - 64, lo - 1, lo, lo + 64, 1000]) {
  const r = cliffPassesAndGradient(height);
  const flag = r.passes >= NEW.SMOOTH_PASS_LIMIT ? '  TRUNCATED' : '';
  console.log(
    `  cliff ${pad(height, 5)}: passes ${pad(r.passes, 5)}  max gradient ${r.worst}${flag}`,
  );
}
