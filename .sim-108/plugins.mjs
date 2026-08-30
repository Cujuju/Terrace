// Issue #108, pass 2 — what the conserving relaxation did to the PLUGIN
// constants that were tuned against the old (height-manufacturing) rule, and
// what each one has to become to restore the effect its doc comment claims.
//
// Run:  node --experimental-strip-types .sim-108/plugins.mjs > .sim-108/plugins.txt
//
// OLD is `.sim-108/old-src/` — shared/src exactly as it stood at the commit
// before the fix (see run.mjs's header for how it was extracted). NEW is the
// working tree. Both are driven through the SAME plugin arithmetic, transcribed
// below from the plugin sources, so the only difference between the columns is
// the relaxation rule.
//
// WHY THE PLUGIN ARITHMETIC IS TRANSCRIBED RATHER THAN IMPORTED: every plugin
// reaches the ground through `WorldApi.sculpt`, which is
// `applySculpt(..., {tool:'smooth', profile:'soft', spill:'banded'})` plus a
// broadcast (server/src/plugins/world-api.ts:195-220). Importing the plugin
// would drag in the whole server host for no extra fidelity in the one thing
// being measured — the ground.

import * as OLD from './old-src/index.ts';
import * as NEW from '../shared/src/index.ts';
import {
  buildFreshGenesisTerrain,
  freshGenesisHeightAt,
} from '../server/src/world/genesis.ts';

const RULES = [
  { label: 'old', mod: OLD },
  { label: 'new', mod: NEW },
];

/** server/src/plugins/world-api.ts:27 — PLUGIN_SCULPT_OPTIONS. */
const PLUGIN_SCULPT = { tool: 'smooth', profile: 'soft', spill: 'banded' };

const BAND_HEIGHT = NEW.BAND_HEIGHT;
const MAX_BRUSH_RADIUS = NEW.MAX_BRUSH_RADIUS;

const sculpt = (mod, map, x, y, r, amount) =>
  mod.applySculpt(map, x, y, r, Math.round(amount), PLUGIN_SCULPT);

const total = (cells) => {
  let t = 0;
  for (let i = 0; i < cells.length; i++) t += cells[i];
  return t;
};

/** A flat world at `base`, the plain a cone or a flow is laid on. */
function flat(mod, size, base) {
  const map = mod.createHeightmap(size);
  map.cells.fill(base);
  return map;
}

/**
 * A constant slope falling in +x at `dropPerCell`, the hillside mudslides and
 * surges act on. Legal ground: dropPerCell <= MAX_STEP + RELAX_SLACK.
 */
function slope(mod, size, top, dropPerCell) {
  const map = mod.createHeightmap(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      map.cells[y * size + x] = Math.max(NEW.MIN_HEIGHT, top - x * dropPerCell);
    }
  }
  return map;
}

/**
 * A REAL fresh world's terrain (server/src/world/world.ts:406-419, verbatim).
 *
 * WHY THIS FIXTURE EXISTS AND THE FLAT ONES ARE NOT ENOUGH: genesis writes
 * BAND-QUANTISED heights — every cell is `bands * BAND_HEIGHT`
 * (genesis.ts:1795-1806) — so a fresh world is full of 16-, 32- and 48-unit
 * steps between neighbours, four to twelve times MAX_STEP. A plugin sculpt
 * anywhere on it therefore seeds a relaxation that regrades the whole hillside
 * around it, and THAT cascade — not the brush — is what the conserving rule
 * changed. On flat or already-legal ground the two rules barely differ.
 *
 * The terrain is a pure function of (size, seed) and of shared constants the
 * fix did not move, so both columns get a BIT-IDENTICAL starting world.
 */
const genesisCache = new Map();
function genesis(mod, size, seed) {
  let heights = genesisCache.get(`${size}|${seed}`);
  if (heights === undefined) {
    const terrain = buildFreshGenesisTerrain(size, seed);
    heights = new Int16Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) heights[y * size + x] = freshGenesisHeightAt(terrain, x, y);
    }
    genesisCache.set(`${size}|${seed}`, heights);
  }
  const map = mod.createHeightmap(size);
  map.cells.set(heights);
  return map;
}

const heightAt = (map, x, y) => map.cells[y * map.size + x];

/** The steepest-drop site over MUDSLIDE_SLOPE_SPAN_CELLS, the way slopeAt picks one. */
function steepestSite(map, span, margin) {
  let best = null;
  for (let y = margin; y < map.size - margin; y++) {
    for (let x = margin; x < map.size - margin; x++) {
      const here = heightAt(map, x, y);
      if (here <= NEW.SEA_LEVEL) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx * span;
        const ny = y + dy * span;
        if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
        const drop = here - heightAt(map, nx, ny);
        if (best === null || drop > best.drop) best = { x, y, dx, dy, drop };
      }
    }
  }
  return best;
}

/** A land cell far from the edges — where a vent is sited. */
function landSite(map, margin) {
  let best = null;
  for (let y = margin; y < map.size - margin; y++) {
    for (let x = margin; x < map.size - margin; x++) {
      const h = heightAt(map, x, y);
      if (best === null || h > best.h) best = { x, y, h };
    }
  }
  return best;
}

/** A cell whose 4-neighbourhood straddles SEA_LEVEL — surge.ts's isShoreline. */
function shoreSite(map, margin) {
  for (let y = margin; y < map.size - margin; y++) {
    for (let x = margin; x < map.size - margin; x++) {
      if (heightAt(map, x, y) <= NEW.SEA_LEVEL) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (heightAt(map, x + dx, y + dy) <= NEW.SEA_LEVEL) return { x, y };
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════ VOLCANOES ══════
//
// plugins/volcanoes/server/vents.ts:382-403 `raiseCone`: the centre takes
// `bands * BAND_HEIGHT` at MAX_BRUSH_RADIUS, then four ring cells at
// ±CONE_RING_OFFSET (= MAX_BRUSH_RADIUS) take `floor(bands*BAND_HEIGHT/2)`.
// The measured intent (vents.ts:177-189) is "after ten eruptions the mountain
// is visibly taller": the CONE'S PEAK gains one band per eruption.


const GENESIS_SIZE = 512;
const GENESIS_SEED = 108;

/** The fixture world plus the site the plugin would pick on it. */
function stage(mod, world, pick) {
  if (world === 'flat') {
    const map = flat(mod, 192, 128);
    const c = 192 >> 1;
    return { map, site: { x: c, y: c } };
  }
  if (world === 'slope') {
    const map = slope(mod, 192, 512, 3);
    const c = 192 >> 1;
    return { map, site: { x: 24, y: c } };
  }
  const map = genesis(mod, GENESIS_SIZE, GENESIS_SEED);
  return { map, site: pick(map) };
}

const GENESIS_CONE_BANDS = 4; // plugins/volcanoes/protocol.ts:91

/** vents.ts:382-403 raiseCone — the centre, then the four ring cells. */
function raise(mod, map, c, cy, bands) {
  sculpt(mod, map, c, cy, MAX_BRUSH_RADIUS, bands * BAND_HEIGHT);
  const rim = Math.floor((bands * BAND_HEIGHT) / 2);
  for (const [dx, dy] of [
    [-MAX_BRUSH_RADIUS, 0],
    [MAX_BRUSH_RADIUS, 0],
    [0, -MAX_BRUSH_RADIUS],
    [0, MAX_BRUSH_RADIUS],
  ]) {
    const rx = c + dx;
    const ry = cy + dy;
    if (rx < 0 || ry < 0 || rx >= map.size || ry >= map.size) continue;
    sculpt(mod, map, rx, ry, MAX_BRUSH_RADIUS, rim);
  }
}

function coneRun(mod, { bands, eruptions, world = 'flat' }) {
  const { map, site } = stage(mod, world, (m) => landSite(m, MAX_BRUSH_RADIUS * 2));
  const { x: c, y: cy } = site;
  // THE VENT ALREADY HAS ITS GENESIS CONE (protocol.ts:91 GENESIS_CONE_BANDS =
  // 4, raised by `openVent` before the first eruption ever runs), so the
  // eruption gains below are measured on the shape the plugin really erupts
  // through — a cone whose own flanks already sit at the gradient limit — and
  // not on virgin ground.
  raise(mod, map, c, cy, GENESIS_CONE_BANDS);
  const gains = [];
  const base = heightAt(map, c, cy);
  let last = base;
  for (let e = 0; e < eruptions; e++) {
    raise(mod, map, c, cy, bands);
    const now = heightAt(map, c, cy);
    gains.push(now - last);
    last = now;
  }
  // The FIRST eruption is the one the doc comment is about ("after one it is
  // not [visibly taller]"); later ones land on a cone the earlier ones built,
  // which is a different, cone-shape question. Both are reported.
  return {
    first: gains[0],
    peak: heightAt(map, c, cy) - base,
    perEruption: gains.reduce((a, b) => a + b, 0) / gains.length,
  };
}

// plugins/volcanoes/server/flow.ts:93 FLOW_THICKNESS, applied per flow cell at
// FLOW_BRUSH_RADIUS. The intent is a SETTLED thickness of half a band over the
// ground the flow crossed: thin enough not to draw a contour of its own, thick
// enough that overlapping cells in a hollow pool and do.

const FLOW_BRUSH_RADIUS = 4; // cellsAcross(1) — plugins/volcanoes/protocol.ts

function flowRun(mod, { thickness, cells = 32, world = 'flat' }) {
  const { map, site } = stage(mod, world, (m) => landSite(m, MAX_BRUSH_RADIUS * 2));
  const y = site.y;
  const x0 = site.x - (cells >> 1);
  // ONE CELL FIRST, well clear of the line below: this is what
  // FLOW_THICKNESS's doc comment is a statement about — "how much the flow
  // raises each cell it enters". The line after it is the pooling case.
  const soloX = site.x;
  const soloY = Math.max(0, y - 40);
  const soloBefore = heightAt(map, soloX, soloY);
  sculpt(mod, map, soloX, soloY, FLOW_BRUSH_RADIUS, thickness);
  const solo = heightAt(map, soloX, soloY) - soloBefore;

  const before = Int16Array.from(map.cells);
  for (let i = 0; i < cells; i++) sculpt(mod, map, x0 + i, y, FLOW_BRUSH_RADIUS, thickness);
  let sum = 0;
  for (let i = 0; i < cells; i++) sum += heightAt(map, x0 + i, y) - before[y * map.size + x0 + i];
  return { solo, meanThickness: sum / cells, moved: total(map.cells) - total(before) };
}

// plugins/storms/server/surge.ts:148 — one surge is
// sculpt(x, y, SURGE_BRUSH_RADIUS_CELLS, -SURGE_SCOUR_HEIGHT_UNITS * intensity)
// on shoreline. The intent (surge.ts:14-23, 44-52): ONE surge takes the shore
// down by less than a visible step, and a whole landfall a band or two. The
// number that expresses it is the GROUND REMOVED per surge.

/**
 * SURGES PER LANDFALL — the number surge.ts's intent sentence is really about
 * ("a storm that sits on a coast for its whole landfall takes it down a band or
 * two"): a cyclone's landfall against SURGE_INTERVAL_SECONDS = 10.
 */
const LANDFALL_SURGES = 48; // 8 minutes of landfall / 10 s cadence

function surgeRun(mod, { radius, depth, surges = 1, world = 'slope' }) {
  const { map, site } = stage(mod, world, (m) => shoreSite(m, 24) ?? landSite(m, 24));
  const before = Int16Array.from(map.cells);
  for (let s = 0; s < surges; s++) sculpt(mod, map, site.x, site.y, radius, -depth);
  let removed = 0;
  let changed = 0;
  for (let i = 0; i < map.cells.length; i++) {
    const d = map.cells[i] - before[i];
    if (d !== 0) changed++;
    if (d < 0) removed += -d;
  }
  return { removed, changed, centreDrop: before[site.y * map.size + site.x] - heightAt(map, site.x, site.y) };
}

// ════════════════════════════════════════════════════════════ MUDSLIDES ═════
//
// The ledger from plugins/mudslides/server/slides.ts, transcribed: three head
// scours of one band (scourHead, :762-812), a track deposit of
// TRACK_DEPOSIT_FRACTION of the load per sculpt step while the front runs
// (sculptStep, :892), then TOE_DUMP_STEPS dumps walked back over
// TOE_LOBE_CELLS (:896-905). `sculptGuarded` (terrain.ts:145-185) measures the
// NET height change inside a window `margin` cells past the brush edge and
// counts anything outside it as UNMEASURED.

const MUDSLIDE_BRUSH_RADIUS_CELLS = 6; // cellsAcross(1.5)

function guarded(mod, map, x, y, radius, amount, margin) {
  const reach = radius + margin;
  const minX = Math.max(0, x - reach);
  const maxX = Math.min(map.size - 1, x + reach);
  const minY = Math.max(0, y - reach);
  const maxY = Math.min(map.size - 1, y + reach);
  const width = maxX - minX + 1;
  const before = new Int32Array(width * (maxY - minY + 1));
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      before[(cy - minY) * width + (cx - minX)] = heightAt(map, cx, cy);
    }
  }
  const diff = sculpt(mod, map, x, y, radius, amount);
  let net = 0;
  let unmeasuredCells = 0;
  for (const cell of diff) {
    if (cell.x < minX || cell.x > maxX || cell.y < minY || cell.y > maxY) {
      unmeasuredCells++;
      continue;
    }
    net += cell.h - before[(cell.y - minY) * width + (cell.x - minX)];
  }
  return { net, changedCells: diff.length, unmeasuredCells };
}

function slideRun(
  mod,
  {
    margin = 16,
    trackFraction = 0.15,
    toeDumpSteps = 8,
    toeLobeCells = 4,
    tolerance = 4,
    headScourSteps = 3,
    pathCells = 96, // MUDSLIDE_MAX_PATH_CELLS = cellsAcross(24)
    world = 'slope',
  },
) {
  const { map, site } = stage(mod, world, (m) => steepestSite(m, 8, 40));
  const headX = site.x;
  const headY = site.y;
  let excavated = 0;
  let carried = 0;
  let gain = 0;
  let unmeasured = 0;
  let maxChanged = 0;
  let deposited = 0;

  const measure = (x, y, amount) => {
    const m = guarded(mod, map, x, y, MUDSLIDE_BRUSH_RADIUS_CELLS, amount, margin);
    unmeasured += m.unmeasuredCells;
    maxChanged = Math.max(maxChanged, m.changedCells);
    return m;
  };

  const bandAmount = -BAND_HEIGHT;
  for (let s = 0; s < headScourSteps; s++) {
    const m = measure(headX, headY, bandAmount);
    if (m.net >= 0) continue;
    const removed = -m.net;
    excavated += removed;
    carried += removed;
    const g = removed / Math.abs(bandAmount);
    gain = gain === 0 ? g : (gain + g) / 2;
  }

  const deposit = (x, y, volume) => {
    if (gain <= 0 || volume <= 0) return;
    const amount = Math.max(1, Math.round(volume / gain));
    const m = measure(x, y, amount);
    if (m.net <= 0) return;
    deposited += m.net;
    carried = Math.max(0, carried - m.net);
  };

  // THE REAL CADENCE. The front moves FRONT_SPEED (4 world units/s = 16
  // cells/s) while a sculpt op fires every MUDSLIDE_SCULPT_INTERVAL_SECONDS
  // (0.3 s), so a track deposit lands every 4.8 cells — not every cell.
  const CELLS_PER_SCULPT_OP = 16 * 0.3;
  const path = [];
  let nextOpAt = 0;
  let fx0 = headX;
  let fy0 = headY;
  for (let i = 0; i < pathCells; i++) {
    path.push({ x: fx0, y: fy0 });
    if (carried > tolerance && i >= nextOpAt) {
      nextOpAt += CELLS_PER_SCULPT_OP;
      deposit(fx0, fy0, carried * trackFraction);
    }
    // Steepest descent over the four neighbours — terrain.ts's nextFlowCell.
    let best = null;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = fx0 + dx;
      const ny = fy0 + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      const h = heightAt(map, nx, ny);
      if (best === null || h < best.h) best = { x: nx, y: ny, h };
    }
    // A hollow with nowhere lower to go is `stop: 'flat'` — the front halts.
    if (best === null || best.h >= heightAt(map, fx0, fy0)) break;
    fx0 = best.x;
    fy0 = best.y;
  }

  for (let step = 1; step <= toeDumpSteps; step++) {
    if (carried <= tolerance) break;
    const back = step % toeLobeCells;
    const cell = path[Math.max(0, path.length - 1 - back)];
    const stepsLeft = Math.max(1, toeDumpSteps - step + 1);
    deposit(cell.x, cell.y, carried / stepsLeft);
  }

  return {
    excavated: Math.round(excavated),
    deposited: Math.round(deposited),
    residual: Math.round(carried),
    residualPct: excavated === 0 ? 0 : (100 * carried) / excavated,
    unmeasured,
    maxChanged,
  };
}

// ═══════════════════════════════════════════════════════════════ REPORT ═════

const pad = (v, w) => String(v).padStart(w);
const padR = (v, w) => String(v).padEnd(w);
const fx = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : String(v));

console.log('Issue #108 pass 2 — plugin constants under the conserving relaxation');
console.log(
  `MAX_STEP=${NEW.MAX_STEP}  RELAX_SLACK=${NEW.RELAX_SLACK}  BAND_HEIGHT=${BAND_HEIGHT}` +
    `  genesis ${GENESIS_SIZE}² seed ${GENESIS_SEED}  node ${process.version}  ${new Date().toISOString()}`,
);

console.log('\n=== VOLCANOES: cone peak gain per eruption (intent: one band = 16) ===');
console.log(
  `${padR('world', 9)}${padR('rule', 6)}${padR('bands/erupt', 13)}${pad('1st gain', 10)}` +
    `${pad('peak/10', 10)}${pad('mean gain', 11)}`,
);
for (const world of ['flat', 'genesis']) {
  for (const { label, mod } of RULES) {
    for (const bands of [1, 2, 3]) {
      if (label === 'old' && bands !== 1) continue;
      const r = coneRun(mod, { bands, eruptions: 10, world });
      console.log(
        `${padR(world, 9)}${padR(label, 6)}${padR(bands, 13)}${pad(r.first, 10)}` +
          `${pad(r.peak, 10)}${pad(fx(r.perEruption), 11)}`,
      );
    }
  }
}

console.log('\n=== VOLCANOES: lava settled thickness over the flow (intent: 8 = half a band) ===');
console.log(
  `${padR('world', 9)}${padR('rule', 6)}${padR('FLOW_THICKNESS', 16)}${pad('one cell', 10)}${pad('over a flow', 13)}${pad('height moved', 14)}`,
);
for (const world of ['flat', 'genesis']) {
  for (const { label, mod } of RULES) {
    for (const thickness of [BAND_HEIGHT / 2, BAND_HEIGHT, BAND_HEIGHT * 1.5, BAND_HEIGHT * 2]) {
      if (label === 'old' && thickness !== BAND_HEIGHT / 2) continue;
      const r = flowRun(mod, { thickness, world });
      console.log(
        `${padR(world, 9)}${padR(label, 6)}${padR(thickness, 16)}${pad(fx(r.solo), 10)}${pad(fx(r.meanThickness), 13)}${pad(r.moved, 14)}`,
      );
    }
  }
}

console.log('\n=== STORMS: ground one surge removes (intent: what the old rule removed) ===');
console.log(
  `${padR('world', 9)}${padR('rule', 6)}${padR('radius', 8)}${pad('removed', 10)}` +
    `${pad('centre drop', 13)}${pad('cells', 8)}${pad('vs old', 8)}`,
);
for (const world of ['slope', 'genesis']) {
  let baseline = null;
  for (const { label, mod } of RULES) {
    for (const radius of [4, 3, 2]) {
      if (label === 'old' && radius !== 4) continue;
      const r = surgeRun(mod, { radius, depth: BAND_HEIGHT / 2, world });
      if (baseline === null) baseline = r.removed;
      console.log(
        `${padR(world, 9)}${padR(label, 6)}${padR(radius, 8)}${pad(r.removed, 10)}` +
          `${pad(r.centreDrop, 13)}${pad(r.changed, 8)}${pad(fx(r.removed / baseline) + '×', 8)}`,
      );
    }
  }
}

console.log(
  `\n=== STORMS: a whole landfall (${LANDFALL_SURGES} surges on one site) — intent: a band or two ===`,
);
console.log(
  `${padR('world', 9)}${padR('rule', 6)}${padR('radius', 8)}${pad('removed', 10)}` +
    `${pad('shore drop', 12)}${pad('in bands', 10)}`,
);
for (const world of ['slope', 'genesis']) {
  for (const { label, mod } of RULES) {
    for (const radius of [4, 3]) {
      if (label === 'old' && radius !== 4) continue;
      const r = surgeRun(mod, {
        radius,
        depth: BAND_HEIGHT / 2,
        surges: LANDFALL_SURGES,
        world,
      });
      console.log(
        `${padR(world, 9)}${padR(label, 6)}${padR(radius, 8)}${pad(r.removed, 10)}` +
          `${pad(r.centreDrop, 12)}${pad(fx(r.centreDrop / BAND_HEIGHT), 10)}`,
      );
    }
  }
}

console.log('\n=== MUDSLIDES: where the load ends up, and how far the diff reaches ===');
console.log(
  `${padR('world', 9)}${padR('rule', 6)}${padR('margin', 8)}${padR('track', 7)}${padR('toe', 5)}` +
    `${pad('excavated', 10)}${pad('deposited', 10)}${pad('residual', 9)}${pad('resid %', 9)}` +
    `${pad('unmeas', 8)}${pad('max changed', 12)}`,
);
const SLIDE_CASES = [
  { rule: 'old', margin: 16, trackFraction: 0.15, toeDumpSteps: 8 },
  { rule: 'new', margin: 16, trackFraction: 0.15, toeDumpSteps: 8 },
  { rule: 'new', margin: 32, trackFraction: 0.15, toeDumpSteps: 8 },
  { rule: 'new', margin: 64, trackFraction: 0.15, toeDumpSteps: 8 },
  { rule: 'new', margin: 64, trackFraction: 0.25, toeDumpSteps: 8 },
  { rule: 'new', margin: 64, trackFraction: 0.25, toeDumpSteps: 16 },
  { rule: 'new', margin: 96, trackFraction: 0.25, toeDumpSteps: 16 },
];
for (const world of ['slope', 'genesis']) {
  for (const c of SLIDE_CASES) {
    const mod = c.rule === 'old' ? OLD : NEW;
    const r = slideRun(mod, { ...c, world });
    console.log(
      `${padR(world, 9)}${padR(c.rule, 6)}${padR(c.margin, 8)}${padR(c.trackFraction, 7)}` +
        `${padR(c.toeDumpSteps, 5)}${pad(r.excavated, 10)}${pad(r.deposited, 10)}` +
        `${pad(r.residual, 9)}${pad(fx(r.residualPct, 1), 9)}${pad(r.unmeasured, 8)}${pad(r.maxChanged, 12)}`,
    );
  }
}
