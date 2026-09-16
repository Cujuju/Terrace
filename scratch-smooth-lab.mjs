// Scratch smooth lab: compare published smoothers on the spire fixtures.
// Temporary diagnostic, NOT the pipeline: each candidate is a ~10-line pure
// integer Jacobi pass over a copy. Run: node scratch-smooth-lab.mjs
// (delete at end of task)
import { createHeightmap } from './shared/src/grid.ts';
import { BAND_HEIGHT, MAX_STEP, RELAX_SLACK } from './shared/src/constants.ts';
import { smooth } from './shared/src/sculpt/relax.ts';

const SIZE = 64;
const C = 32;
const LIM = MAX_STEP + RELAX_SLACK;
const TOL = BAND_HEIGHT;
const GLYPHS = ' .:-=+*#%@';

const gauss = (x, y, amp, sigma) => {
  const dx = x - C, dy = y - C;
  return amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
};

const FIXTURES = {
  'A mound+spike': (x, y) => 64 + gauss(x, y, 140, 9) + (x === C && y === C ? 110 : 0),
  'B tall mound': (x, y) => 64 + gauss(x, y, 190, 10),
  'C pit': (x, y) => 220 - gauss(x, y, 150, 9),
  'D step wall': (x, y) => (x < C ? 200 : 60),
};

function build(fn) {
  const m = createHeightmap(SIZE);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) m.cells[y * SIZE + x] = Math.round(fn(x, y));
  return m.cells;
}

const at = (c, x, y) => c[y * SIZE + x];
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const W3 = [[1, 2, 1], [2, 4, 2], [1, 2, 1]]; // binomial, sums to 16

function jacobi(src, fn) {
  const out = Int16Array.from(src);
  for (let y = 1; y < SIZE - 1; y++)
    for (let x = 1; x < SIZE - 1; x++) out[y * SIZE + x] = fn(src, x, y);
  return out;
}

const CANDIDATES = {
  box3(src, x, y) {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(src, x + dx, y + dy);
    return Math.floor((s + 4) / 9);
  },
  gauss3(src, x, y) {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) s += W3[dy + 1][dx + 1] * at(src, x + dx, y + dy);
    return Math.floor((s + 8) / 16);
  },
  lap05(src, x, y) {
    const h = at(src, x, y);
    const avg = Math.floor(N4.reduce((s, [dx, dy]) => s + at(src, x + dx, y + dy), 0) / 4);
    return h + Math.trunc((avg - h) / 2);
  },
  taubin(src, x, y) {
    return y; // placeholder replaced below (two-pass)
  },
  median9(src, x, y) {
    const w = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) w.push(at(src, x + dx, y + dy));
    w.sort((a, b) => a - b);
    return w[4];
  },
  bilateral(src, x, y) {
    const h = at(src, x, y);
    let s = 0, w = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const n = at(src, x + dx, y + dy);
        if (Math.abs(n - h) > TOL) continue;
        const k = W3[dy + 1][dx + 1];
        s += k * n;
        w += k;
      }
    return w === 0 ? h : Math.floor((s + w / 2) / w);
  },
  talus1(src, x, y) {
    const h = at(src, x, y);
    const avg = Math.floor(N4.reduce((s, [dx, dy]) => s + at(src, x + dx, y + dy), 0) / 4);
    const d = avg - h;
    if (Math.abs(d) <= LIM) return h;
    return h + Math.max(-TOL, Math.min(TOL, Math.trunc(d / 2)));
  },
};

function taubinPass(src) {
  const t1 = jacobi(src, CANDIDATES.lap05);
  return jacobi(t1, (s, x, y) => {
    const h = at(s, x, y);
    const avg = Math.floor(N4.reduce((a, [dx, dy]) => a + at(s, x + dx, y + dy), 0) / 4);
    return h - Math.trunc(((avg - h) * 45) / 100);
  });
}

function currentFree(src) {
  const m = { size: SIZE, cells: Int16Array.from(src), columnSpans: new Map() };
  const seed = new Set();
  for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) seed.add(y * SIZE + x);
  smooth(m, seed);
  return m.cells;
}

function stats(orig, next) {
  let peak = -Infinity, opeak = -Infinity, ch = 0;
  let vol = 0;
  for (let i = 0; i < orig.length; i++) {
    if (orig[i] > opeak) opeak = orig[i];
    if (next[i] > peak) peak = next[i];
    vol += next[i] - orig[i];
    if (next[i] !== orig[i]) ch++;
  }
  let viol = 0;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      if (x + 1 < SIZE && Math.abs(next[y * SIZE + x] - next[y * SIZE + x + 1]) > LIM) viol++;
      if (y + 1 < SIZE && Math.abs(next[y * SIZE + x] - next[(y + 1) * SIZE + x]) > LIM) viol++;
    }
  return { dPeak: peak - opeak, dVol: vol, viol, ch };
}

function spark(cells, lo, hi) {
  let s = '';
  for (let x = C - 22; x <= C + 22; x++) {
    const h = cells[C * SIZE + x];
    const t = hi === lo ? 0 : Math.max(0, Math.min(9, Math.floor(((h - lo) / (hi - lo)) * 9)));
    s += GLYPHS[t];
  }
  return s;
}

console.log(`smooth lab: MAX_STEP=${MAX_STEP} slack=${RELAX_SLACK} limit=${LIM} band=${BAND_HEIGHT}`);
console.log('row = middle cross-section x=C-22..C+22; scale fixed per fixture; dPeak/dVol vs original');

for (const [name, fn] of Object.entries(FIXTURES)) {
  const orig = build(fn);
  let lo = Infinity, hi = -Infinity;
  for (const v of orig) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  console.log(`\n== ${name} (range ${lo}..${hi}) ==`);
  const rows = { orig };
  for (const [cname, cfn] of Object.entries(CANDIDATES)) {
    if (cname === 'taubin') rows[cname] = taubinPass(orig);
    else rows[cname] = jacobi(orig, cfn);
  }
  rows['current*'] = currentFree(orig);
  for (const [cname, cells] of Object.entries(rows)) {
    const st = stats(orig, cells);
    const dP = (st.dPeak >= 0 ? '+' : '') + st.dPeak;
    const dV = (st.dVol >= 0 ? '+' : '') + st.dVol;
    console.log(
      `${cname.padEnd(9)}|${spark(cells, lo, hi)}| dPeak=${dP} dVol=${dV} viol=${st.viol} ch=${st.ch}`,
    );
  }
}
console.log('\n*current = shared smooth() free path (full convergence), for reference only.');
