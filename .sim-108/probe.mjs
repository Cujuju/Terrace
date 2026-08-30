// Throwaway probe (not committed as a contract): (1) how many passes the new
// rule really needs on a 1000-unit cliff, by re-seeding smooth() until it
// reports a clean pass; (2) whether banded spill still saturates.
import * as NEW from '../shared/src/index.ts';

const size = 256;
const map = NEW.createHeightmap(size);
for (let y = 0; y < size; y++) for (let x = 0; x < size >> 1; x++) map.cells[y * size + x] = 1000;
const all = new Set();
for (let i = 0; i < map.cells.length; i++) all.add(i);
let totalPasses = 0;
for (let round = 0; round < 40; round++) {
  const p = NEW.smooth(map, new Set(all), all);
  totalPasses += p;
  if (p < NEW.SMOOTH_PASS_LIMIT) { console.log(`cliff 1000 (256²): converged, ~${totalPasses} passes (${round + 1} rounds)`); break; }
}
let worst = 0;
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = y * size + x;
  if (x < size - 1) worst = Math.max(worst, Math.abs(map.cells[i] - map.cells[i + 1]));
  if (y < size - 1) worst = Math.max(worst, Math.abs(map.cells[i] - map.cells[i + size]));
}
console.log('final max gradient', worst);

// (2) banded saturation on the #26 ledge fixture.
const L = 64;
const led = NEW.createHeightmap(L);
for (let y = 0; y < L; y++) for (let x = 0; x < L; x++) {
  const t = x + y;
  led.cells[y * L + x] = t < 40 ? 128 : t === 40 ? 96 : t < 50 ? 64 : t === 50 ? 32 : 0;
}
const fp = new Set();
NEW.forEachFootprintOffset(2, (dx, dy) => { fp.add((19 + dy) * L + (20 + dx)); });
const moved = [];
for (let s = 0; s < 40; s++) {
  const pre = Int16Array.from(led.cells);
  NEW.applySculpt(led, 20, 19, 2, NEW.DEFAULT_SCULPT_AMOUNT, { tool: 'smooth', profile: 'soft', spill: 'banded' });
  let n = 0;
  for (let i = 0; i < led.cells.length; i++) if (!fp.has(i) && led.cells[i] !== pre[i]) n++;
  moved.push(n);
}
console.log('banded outside-moved per stroke:', moved.join(','));
