// Multi-seed cost of one sculpt stroke on fresh genesis terrain (issue #68 / #282).
// Run from repo root: node --experimental-strip-types .sculpt-audit/bench-smooth-genesis.mjs
// Each stroke lands on a COLD copy of the genesis map, so the cost is the first
// stroke a player makes there, not progressively re-graded ground.
import { pathToFileURL } from 'node:url';
const g = await import(pathToFileURL('server/src/world/genesis.ts').href);
const m = await import(pathToFileURL('shared/src/index.ts').href);
const { applySculpt, createHeightmap, MAX_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, BAND_HEIGHT } = m;

const SIZE = 512;
const SEEDS = [12345, 777, 4242, 90210, 31337];
const STROKES_PER_SEED = 10;
const MARGIN = 40;

function genesisMap(seed) {
  const terrain = g.buildFreshGenesisTerrain(SIZE, seed);
  const map = createHeightmap(SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) map.cells[y * SIZE + x] = g.freshGenesisHeightAt(terrain, x, y);
  return map;
}
function steepPairs(map) {
  let n = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 1; x < SIZE; x++) if (Math.abs(map.cells[y * SIZE + x] - map.cells[y * SIZE + x - 1]) > BAND_HEIGHT) n++;
  return n;
}
function stats(t) {
  t.sort((a, b) => a - b);
  return { median: t[t.length >> 1], p90: t[Math.floor(t.length * 0.9)], max: t[t.length - 1] };
}
const TOOLS = [
  ['stamp soft r16', { tool: 'stamp', profile: 'soft', spill: 'banded' }, MAX_BRUSH_RADIUS],
  ['smooth soft r4', { tool: 'smooth', profile: 'soft', spill: 'banded' }, 4],
  ['smooth soft r8', { tool: 'smooth', profile: 'soft', spill: 'banded' }, 8],
  ['smooth soft r16', { tool: 'smooth', profile: 'soft', spill: 'banded' }, MAX_BRUSH_RADIUS],
  ['smooth hard r16', { tool: 'smooth', profile: 'hard', spill: 'banded' }, MAX_BRUSH_RADIUS],
];
const all = new Map(TOOLS.map(([label]) => [label, []]));
for (const seed of SEEDS) {
  const base = genesisMap(seed);
  console.log(`seed ${seed}: steep pairs (>1 band) ${steepPairs(base)} of ${SIZE * (SIZE - 1)}`);
  for (const [label, opts, radius] of TOOLS) {
    const t = [];
    for (let i = 0; i < STROKES_PER_SEED; i++) {
      const map = createHeightmap(SIZE); map.cells.set(base.cells);
      const cx = MARGIN + ((i * 97 + seed) % (SIZE - 2 * MARGIN));
      const cy = MARGIN + ((i * 61 + (seed >> 3)) % (SIZE - 2 * MARGIN));
      const s = performance.now();
      applySculpt(map, cx, cy, radius, DEFAULT_SCULPT_AMOUNT, opts);
      t.push(performance.now() - s);
    }
    all.get(label).push(...t);
    const { median, p90, max } = stats([...t]);
    console.log(`  ${label.padEnd(16)} median ${median.toFixed(2).padStart(8)} ms  p90 ${p90.toFixed(2).padStart(8)} ms  max ${max.toFixed(1).padStart(8)} ms`);
  }
}
console.log(`\nALL SEEDS (${SEEDS.length} × ${STROKES_PER_SEED} strokes)`);
for (const [label, t] of all) {
  const { median, p90, max } = stats(t);
  const over100 = t.filter((v) => v > 100).length;
  console.log(`  ${label.padEnd(16)} median ${median.toFixed(2).padStart(8)} ms  p90 ${p90.toFixed(2).padStart(8)} ms  max ${max.toFixed(1).padStart(8)} ms  >100ms: ${over100}/${t.length}`);
}
