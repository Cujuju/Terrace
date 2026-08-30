// Issue #108 — relaxation manufactures height. Side-by-side simulation of the
// OLD and NEW movePair arithmetic on identical fixtures.
//
// Run:  node --experimental-strip-types .sim-108/run.mjs > .sim-108/results.txt
//
// OLD is not reproduced by hand: `.sim-108/old-src/` is `shared/src/` exactly
// as it stood at the commit before this change, extracted with
// `git archive HEAD shared/src | tar -x -C .sim-108/old-src --strip-components=2`
// and imported directly. NEW is the working tree's `shared/src/`. Both run
// through the same fixture builders below, so the only difference between the
// two columns is the arithmetic under test.

import * as OLD from './old-src/index.ts';
import * as NEW from '../shared/src/index.ts';

const MAX_STEP = NEW.MAX_STEP;

/** The two implementations, labelled for the table. */
const RULES = [
  { label: 'old (e>>1 / e-(e>>1))', mod: OLD },
  { label: 'new (e>>1 / e>>1)', mod: NEW },
];

// ---------------------------------------------------------------- fixtures --
// Each fixture returns { size, fill(cells), seed(cells) }. `fill` writes the
// starting heights; `seed` returns the indices the relaxation bbox starts from.

const allCells = (size) => {
  const s = new Set();
  for (let i = 0; i < size * size; i++) s.add(i);
  return s;
};

/** West half at `height`, east half at 0. */
const cliff = (size, height) => ({
  name: `cliff ${height} (${size}²)`,
  size,
  fill(cells) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size >> 1; x++) cells[y * size + x] = height;
    }
  },
  seed(cells) {
    const s = new Set();
    for (let i = 0; i < cells.length; i++) if (cells[i] === height) s.add(i);
    return s;
  },
});

/** One cell at MAX_HEIGHT on flat ground. */
const spire = (size) => ({
  name: `spire (${size}²)`,
  size,
  fill(cells) {
    cells[(size >> 1) * size + (size >> 1)] = NEW.MAX_HEIGHT;
  },
  seed() {
    return new Set([(size >> 1) * size + (size >> 1)]);
  },
});

/**
 * Rough terrain from a fixed LCG — the "ordinary ground" case, where excesses
 * are small and odd remainders are therefore common (the leak's best feeding
 * ground per unit of relief).
 */
const rough = (size, amplitude) => ({
  name: `random rough ±${amplitude} (${size}²)`,
  size,
  fill(cells) {
    let s = 0x108108;
    const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
    for (let i = 0; i < cells.length; i++) {
      cells[i] = Math.floor(next() * (2 * amplitude + 1)) - amplitude;
    }
  },
  seed: (cells) => allCells(Math.round(Math.sqrt(cells.length))),
});

/**
 * A mudslide head scour (#239): flat ground at 512, the centre cell pulled
 * down by 64 (four bands), then relaxed. The plugin measures the NET height
 * change over the brush footprint and abandons the slide when it is >= 0.
 */
const scour = (size, base, depth) => ({
  name: `scour -${depth} on flat ${base} (${size}²)`,
  size,
  fill(cells) {
    cells.fill(base);
    cells[(size >> 1) * size + (size >> 1)] = base - depth;
  },
  seed() {
    return new Set([(size >> 1) * size + (size >> 1)]);
  },
});

const FIXTURES = [
  cliff(128, 100),
  cliff(128, 401),
  cliff(128, 1000),
  cliff(256, 1000),
  spire(128),
  rough(128, 40),
  scour(128, 512, 64),
];

// ----------------------------------------------------------------- metrics --

const total = (cells) => {
  let t = 0;
  for (let i = 0; i < cells.length; i++) t += cells[i];
  return t;
};

/** Largest |height difference| across any 4-neighbour pair. */
const maxGradient = (cells, size) => {
  let worst = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (x < size - 1) worst = Math.max(worst, Math.abs(cells[i] - cells[i + 1]));
      if (y < size - 1) worst = Math.max(worst, Math.abs(cells[i] - cells[i + size]));
    }
  }
  return worst;
};

/** How many 4-neighbour pairs sit strictly above MAX_STEP. */
const pairsOverMaxStep = (cells, size) => {
  let n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (x < size - 1 && Math.abs(cells[i] - cells[i + 1]) > MAX_STEP) n++;
      if (y < size - 1 && Math.abs(cells[i] - cells[i + size]) > MAX_STEP) n++;
    }
  }
  return n;
};

/** Builds the fixture, relaxes it with `mod`, and reports. */
function run(fixture, mod) {
  const map = mod.createHeightmap(fixture.size);
  fixture.fill(map.cells);
  const before = Int16Array.from(map.cells);
  const seed = fixture.seed(map.cells);
  const beforeTotal = total(map.cells);
  const t0 = process.hrtime.bigint();
  const passes = mod.smooth(map, new Set(seed), seed);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    before,
    after: Int16Array.from(map.cells),
    beforeTotal,
    afterTotal: total(map.cells),
    manufactured: total(map.cells) - beforeTotal,
    passes,
    ms,
    maxGradient: maxGradient(map.cells, fixture.size),
    pairsOver: pairsOverMaxStep(map.cells, fixture.size),
  };
}

// ------------------------------------------------------------------- table --

const pad = (v, w) => String(v).padStart(w);
const padR = (v, w) => String(v).padEnd(w);
const num = (v) => v.toLocaleString('en-US');

const COLS = [
  ['fixture', 26, padR],
  ['rule', 22, padR],
  ['total before', 14, pad],
  ['total after', 14, pad],
  ['manufactured', 14, pad],
  ['passes', 7, pad],
  ['max grad', 9, pad],
  ['pairs>STEP', 11, pad],
  ['ms', 8, pad],
];

const header = COLS.map(([h, w, f]) => f(h, w)).join('  ');
const rule = COLS.map(([, w]) => '-'.repeat(w)).join('  ');

console.log(`Issue #108 — relaxation conservation, old vs new movePair`);
console.log(`MAX_STEP=${MAX_STEP}  RELAX_SLACK=${NEW.RELAX_SLACK}  SMOOTH_PASS_LIMIT=${NEW.SMOOTH_PASS_LIMIT}`);
console.log(`node ${process.version}   ${new Date().toISOString()}`);
console.log('');
console.log(header);
console.log(rule);

const results = new Map();
for (const fixture of FIXTURES) {
  for (const { label, mod } of RULES) {
    const r = run(fixture, mod);
    results.set(`${fixture.name}|${label}`, { fixture, r });
    const cells = [
      fixture.name,
      label,
      num(r.beforeTotal),
      num(r.afterTotal),
      num(r.manufactured),
      r.passes === NEW.SMOOTH_PASS_LIMIT ? `${r.passes}!` : r.passes,
      r.maxGradient,
      num(r.pairsOver),
      r.ms.toFixed(1),
    ];
    console.log(COLS.map(([, w, f], k) => f(cells[k], w)).join('  '));
  }
  console.log('');
}
console.log('"!" on a pass count means the sweep hit SMOOTH_PASS_LIMIT: the cascade');
console.log('was TRUNCATED, not converged, and the gradient invariant is left locally');
console.log('violated (documented residual — see SMOOTH_PASS_LIMIT).');

// -------------------------------------------------------- ASCII sections ----

/**
 * One row of the map as a fixed-width ASCII profile. Heights are scaled into
 * `rows` character rows between the profile's own min and max, so the shape is
 * readable regardless of the absolute heights.
 */
function profile(cells, size, y, x0, x1, rows) {
  const slice = [];
  for (let x = x0; x <= x1; x++) slice.push(cells[y * size + x]);
  const lo = Math.min(...slice);
  const hi = Math.max(...slice);
  const span = hi - lo || 1;
  const out = [];
  for (let r = rows - 1; r >= 0; r--) {
    let line = '';
    for (const h of slice) {
      const level = Math.round(((h - lo) / span) * (rows - 1));
      line += level > r ? '|' : level === r ? '#' : ' ';
    }
    out.push(line);
  }
  return { lines: out, lo, hi };
}

function section(title, cells, size, y, x0, x1, rows) {
  const p = profile(cells, size, y, x0, x1, rows);
  console.log(`${title}   [x ${x0}..${x1}, y ${y}]  height ${p.lo} .. ${p.hi}`);
  for (const line of p.lines) console.log(`  ${line}`);
  console.log('');
}

console.log('');
console.log('='.repeat(78));
console.log('CROSS-SECTIONS');
console.log('='.repeat(78));
console.log('');

for (const key of ['cliff 401 (128²)', 'scour -64 on flat 512 (128²)']) {
  const rowsOfDetail = key.startsWith('scour') ? 10 : 16;
  const [x0, x1] = key.startsWith('scour') ? [44, 83] : [24, 103];
  const first = results.get(`${key}|${RULES[0].label}`);
  console.log(`### ${key}`);
  console.log('');
  section('BEFORE', first.r.before, first.fixture.size, first.fixture.size >> 1, x0, x1, rowsOfDetail);
  for (const { label } of RULES) {
    const e = results.get(`${key}|${label}`);
    section(
      `AFTER  ${label}  (manufactured ${num(e.r.manufactured)}, ${e.r.passes} passes)`,
      e.r.after,
      e.fixture.size,
      e.fixture.size >> 1,
      x0,
      x1,
      rowsOfDetail,
    );
  }
}

// The scour's own headline number: what the mudslide plugin measures.
console.log('='.repeat(78));
console.log('THE #239 MEASUREMENT: net height change over the scoured centre cell');
console.log('='.repeat(78));
for (const { label } of RULES) {
  const e = results.get(`scour -64 on flat 512 (128²)|${label}`);
  const centre = (e.fixture.size >> 1) * e.fixture.size + (e.fixture.size >> 1);
  console.log(
    `  ${padR(label, 24)} centre ${e.r.before[centre]} -> ${e.r.after[centre]}` +
      `   map total change ${num(e.r.manufactured)}`,
  );
}
