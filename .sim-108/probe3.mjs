// Issue #108, pass 2 — the numbers the new tests pin.
//
// Run:  node --experimental-strip-types .sim-108/probe3.mjs
//
// Everything here is measured against the WORKING TREE's shared/src, and every
// figure it prints is transcribed into shared/test/heightmap.test.ts as an
// assertion. Kept as a script so the next person can re-run it rather than
// trusting the numbers in the test file.

import * as NEW from '../shared/src/index.ts';

const {
  applySculpt,
  createHeightmap,
  smooth,
  cellIndex,
  BAND_HEIGHT,
  DEFAULT_SCULPT_AMOUNT,
  MAX_HEIGHT,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  setColumn,
  BEDROCK_FLOOR,
} = NEW;

const SIZE = 96;

/**
 * GENESIS-SHAPED GROUND: band-quantised plateaus on a coarse lattice, exactly
 * the shape `World.createFresh` writes (every cell `bands * BAND_HEIGHT`, from
 * a noise lattice), so neighbouring plateaus meet in sheer whole-band steps.
 */
function genesisTerraces(size) {
  const map = createHeightmap(size);
  const LATTICE = 16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / LATTICE);
      const gy = Math.floor(y / LATTICE);
      let h = (gx * 73856093) ^ (gy * 19349663);
      h = (h ^ (h >>> 13)) >>> 0;
      const bands = (h % 7) - 2;
      map.cells[y * size + x] = bands * BAND_HEIGHT;
    }
  }
  return map;
}

const total = (map) => {
  let t = 0;
  for (let i = 0; i < map.cells.length; i++) t += map.cells[i];
  return t;
};

// 1 — the PLAYER smooth stroke on genesis terraces.
{
  const map = genesisTerraces(SIZE);
  const before = total(map);
  const cells = Int16Array.from(map.cells);
  const PLAYER_SMOOTH = { ...WIRE_DEFAULT_SCULPT_OPTIONS, tool: 'smooth' };
  const diff = applySculpt(map, 48, 48, 4, DEFAULT_SCULPT_AMOUNT, PLAYER_SMOOTH);
  let moved = 0;
  for (let i = 0; i < map.cells.length; i++) if (map.cells[i] !== cells[i]) moved++;
  console.log('[player smooth on genesis terraces]');
  console.log('  stroke 1: diff cells', diff.length, ' really moved', moved);
  console.log('  total before', before, ' after', total(map), ' delta', total(map) - before);

  // A second and third stroke on the same spot — does it settle?
  const counts = [diff.length];
  for (let s = 0; s < 3; s++) {
    counts.push(applySculpt(map, 48, 48, 4, DEFAULT_SCULPT_AMOUNT, PLAYER_SMOOTH).length);
  }
  console.log('  diff cells per stroke, 4 strokes:', counts.join(', '));
  console.log('  total after 4 strokes', total(map), ' delta', total(map) - before);
}

// 2 — conservation on the BANDED and ANCHORED paths, over a stroke walk.
for (const [label, options] of [
  ['banded + anchored (the wire default, smooth tool)', { ...WIRE_DEFAULT_SCULPT_OPTIONS, tool: 'smooth' }],
  ['banded + free anchor', { tool: 'smooth', profile: 'soft', spill: 'banded', anchor: 'free' }],
  ['free spill + free anchor (library default)', { ...LIBRARY_DEFAULT_SCULPT_OPTIONS }],
]) {
  const map = genesisTerraces(SIZE);
  const before = total(map);
  for (let k = 0; k < 24; k++) {
    applySculpt(map, 30 + k, 40, 4, k % 2 === 0 ? DEFAULT_SCULPT_AMOUNT : -DEFAULT_SCULPT_AMOUNT, options);
  }
  console.log(`[${label}] 24 strokes: delta`, total(map) - before);
}

// 3 — the LAYERED path's leak.
{
  const worst = { delta: 0, at: null };
  for (const gap of [2, 3, 4, 6, 8]) {
    const map = genesisTerraces(SIZE);
    // A roofed column field: every 4th cell in a patch gets a roof span over a
    // gap, which is what makes `smooth` build a LayerView.
    for (let y = 40; y < 56; y++) {
      for (let x = 40; x < 56; x++) {
        const i = cellIndex(map, x, y);
        const floorH = map.cells[i];
        setColumn(map, x, y, [
          { floor: BEDROCK_FLOOR, ceiling: floorH },
          { floor: floorH + gap * BAND_HEIGHT, ceiling: floorH + (gap + 1) * BAND_HEIGHT },
        ]);
      }
    }
    const before = total(map);
    for (let k = 0; k < 8; k++) {
      applySculpt(map, 44 + k, 48, 4, DEFAULT_SCULPT_AMOUNT, {
        tool: 'smooth',
        profile: 'soft',
        spill: 'banded',
        anchor: 'free',
      });
    }
    const delta = total(map) - before;
    console.log(`[layered, roof gap ${gap} bands] 8 strokes: delta`, delta);
    if (Math.abs(delta) > Math.abs(worst.delta)) {
      worst.delta = delta;
      worst.at = gap;
    }
  }
  console.log('[layered] worst delta', worst.delta, 'at gap', worst.at);
}

// 4 — the free-spill peak: 384 stacked library-default clicks at radius 2.
{
  const map = createHeightmap(64);
  const STACKED = (MAX_HEIGHT * 6) / DEFAULT_SCULPT_AMOUNT;
  for (let k = 0; k < STACKED; k++) applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT);
  console.log('[free spill] peak after', STACKED, 'clicks:', map.cells[cellIndex(map, 32, 32)]);
  console.log('[free spill] map total:', total(map));
}

// 5 — the movePair guard: a cell whose grasped span is UNDRAWN sits below its
// own span cap's `lo`, which makes the coupled clamp's `t` negative.
{
  const map = createHeightmap(16);
  const x = 8;
  const y = 8;
  // Top span [10, 14): thinner than a band and between two boundaries, so
  // spanLowestBandHeight is 16 — above the span's own ceiling of 14.
  setColumn(map, x, y, [
    { floor: BEDROCK_FLOOR, ceiling: -100 },
    { floor: 10, ceiling: 14 },
  ]);
  const i = cellIndex(map, x, y);
  const j = cellIndex(map, x + 1, y);
  console.log('[guard] before: high', map.cells[i], ' low', map.cells[j]);
  const seed = new Set([i, j]);
  smooth(map, new Set(seed), seed);
  console.log('[guard] after:  high', map.cells[i], ' low', map.cells[j]);
}
