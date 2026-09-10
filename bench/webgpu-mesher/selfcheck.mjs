// Verifies, without a browser, everything the WGSL is a transliteration of:
// the isoline reduction, the band field, and the PNG codec run.mjs uses.
// Every routine below is the same integer algorithm mesher.html runs in WGSL.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng, decodePng } from './png.mjs';
import {
  CASE_COUNT, CORNER_REFS, SADDLE_5_SPLIT_CASE, SADDLE_10_SPLIT_CASE,
  buildMarchingTable, complementCase, contourSegments, polygonArea,
} from './marching.mjs';

const OUT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(OUT, '..', '..');
const shared = await import(pathToFileURL(join(REPO, 'shared', 'src', 'index.ts')).href);
const meta = JSON.parse(readFileSync(`${OUT}/meta.json`, 'utf8'));

const [SAMPLE_SHIFT, BAND_HEIGHT_SHIFT, BAND_NUMERATOR_SHIFT] = [2, 4, 24];
const SAMPLE_MASK = meta.samplesPerCell - 1;
const COORD_PER_SAMPLE = meta.coordDenom / meta.samplesPerCell;
const BIAS_NUMERATOR = meta.bandBias * meta.coordDenom * meta.coordDenom;
const HALF_SAMPLE = meta.samplesPerCell / 2;
const BEDROCK_BAND = meta.bedrockFloor >> BAND_HEIGHT_SHIFT;
const SPAN_OFFSET_MASK = (1 << meta.spanCountShift) - 1;
const ISOLINE_SOLVE_SHIFT = 16;
const ISOLINE_SOLVE_DENOM = 1 << ISOLINE_SOLVE_SHIFT;
const SOLVE_PER_COORD_UNIT = ISOLINE_SOLVE_DENOM / meta.coordDenom;
const ISOLINE_NO_CROSSING = -1;
const [I32_MIN, I32_MAX] = [-(2 ** 31), 2 ** 31 - 1];
const BAND_SAMPLE_STRIDE = 7; // coprime with the lattice width, so it walks every row

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const guardI32 = (label, value) => {
  if (value > I32_MAX || value < I32_MIN) throw new RangeError(`${label} overflows i32: ${value}`);
  return value;
};

// --- the isoline reduction --------------------------------------------------
const scaledQuotient = (a, d) => {
  let rem = a;
  let q = 0;
  for (let bit = 0; bit < ISOLINE_SOLVE_SHIFT; bit++) {
    rem = guardI32('isoline remainder', rem * 2);
    q *= 2;
    if (rem >= d) {
      rem -= d;
      q += 1;
    }
  }
  return [q, rem];
};

const isolineUnits = (nw, ne, sw, se, threshold, fixedUnits, alongX) => {
  const fixedScaled = fixedUnits * SOLVE_PER_COORD_UNIT;
  const targetHeight = threshold - meta.bandBias;
  const lowNear = nw;
  const lowFar = alongX ? ne : sw;
  const highNear = alongX ? sw : ne;
  const highFar = se;
  const other = ISOLINE_SOLVE_DENOM - fixedScaled;
  const a = guardI32('isoline a', lowNear * other + lowFar * fixedScaled - targetHeight * ISOLINE_SOLVE_DENOM);
  const b = guardI32('isoline b', highNear * other + highFar * fixedScaled - targetHeight * ISOLINE_SOLVE_DENOM);
  const insideLow = a >= 0;
  if (insideLow === b >= 0) return ISOLINE_NO_CROSSING;
  const c = guardI32('isoline c', b - a);
  if (insideLow) return scaledQuotient(a, -c)[0];
  const [q, rem] = scaledQuotient(-a, c);
  return rem !== 0 ? q + 1 : q;
};

const cases = JSON.parse(readFileSync(`${OUT}/isoline-cases.json`, 'utf8'));
let [isolineBad, crossings] = [0, 0];
let isolineExample = '';
for (const c of cases) {
  const got = isolineUnits(c.nw, c.ne, c.sw, c.se, c.threshold, c.fixedUnits, c.alongX !== 0);
  if (c.units !== ISOLINE_NO_CROSSING) crossings++;
  if (got === c.units) continue;
  isolineBad++;
  if (!isolineExample) isolineExample = `${JSON.stringify(c)} -> ${got}`;
}
check(
  'isoline reduction matches drawnIsolineAt',
  isolineBad === 0,
  `${cases.length} cases, ${crossings} with a crossing, ${isolineBad} mismatches ${isolineExample}`,
);

// A dense sweep of one cell, which the random cases only sample sparsely.
const SWEEP_CORNERS = [-1536, -8, 0, 7, 8, 9, 512, 1024];
let sweepBad = 0;
for (const nw of SWEEP_CORNERS) {
  for (const se of SWEEP_CORNERS) {
    for (const threshold of [-1536, -16, 0, 16, 512, 1008]) {
      for (const fixedUnits of [0, 1, 341, 512, 1023, 1024]) {
        for (const alongX of [true, false]) {
          const want = shared.drawnIsolineAt(nw, se, se, nw, threshold, fixedUnits, alongX);
          const wantUnits = want === null ? ISOLINE_NO_CROSSING : Math.round(want * ISOLINE_SOLVE_DENOM);
          if (isolineUnits(nw, se, se, nw, threshold, fixedUnits, alongX) !== wantUnits) sweepBad++;
        }
      }
    }
  }
}
check('isoline reduction over a dense corner sweep', sweepBad === 0, `${sweepBad} mismatches`);

// --- the band field ---------------------------------------------------------
const size = meta.size;
const heights = new Int16Array(readFileSync(`${OUT}/world.bin`).buffer.slice(0));
const spansBin = readFileSync(`${OUT}/spans.bin`);
const spanDesc = new Uint32Array(spansBin.buffer.slice(spansBin.byteOffset, spansBin.byteOffset + meta.spanDescBytes));
const spanData = new Int32Array(spansBin.buffer.slice(
  spansBin.byteOffset + meta.spanDescBytes,
  spansBin.byteOffset + meta.spanDescBytes + meta.spanDataPairs * 8,
));

const clampCell = (i) => (i < 0 ? 0 : i > size - 1 ? size - 1 : i);
const quantizeToBand = (h) => (h >> BAND_HEIGHT_SHIFT) << BAND_HEIGHT_SHIFT;
const spanCountOf = (cell) => {
  const packed = spanDesc[cell] >>> meta.spanCountShift;
  return packed === 0 ? 1 : packed;
};
const spanFloor = (cell, k) => {
  const desc = spanDesc[cell];
  return desc === 0 ? meta.bedrockFloor : spanData[((desc & SPAN_OFFSET_MASK) + k) * 2];
};
const spanCeiling = (cell, k) => {
  const desc = spanDesc[cell];
  return desc === 0 ? heights[cell] : spanData[((desc & SPAN_OFFSET_MASK) + k) * 2 + 1];
};
const spanLowestBandHeight = (f) => {
  const q = quantizeToBand(f);
  return q === f ? q : q + meta.bandHeight;
};
const isSpanDrawn = (f, c) => spanLowestBandHeight(f) <= quantizeToBand(c);

const columnSampleAtBand = (cell, band) => {
  const threshold = band * meta.bandHeight;
  const count = spanCountOf(cell);
  let below = meta.openColumnSample;
  for (let k = 0; k < count; k++) {
    const f = spanFloor(cell, k);
    const c = spanCeiling(cell, k);
    if (!isSpanDrawn(f, c)) continue;
    const capHeight = quantizeToBand(c);
    if (f <= threshold && threshold <= capHeight) return c;
    if (capHeight < threshold) below = c;
  }
  return below;
};

const cornerSample = (cell, band, useCells) => (useCells ? heights[cell] : columnSampleAtBand(cell, band));

const fieldNumerator = (x0, x1, z0, z1, tx, tz, band, useCells) => {
  const nw = cornerSample(z0 * size + x0, band, useCells);
  const ne = cornerSample(z0 * size + x1, band, useCells);
  const sw = cornerSample(z1 * size + x0, band, useCells);
  const se = cornerSample(z1 * size + x1, band, useCells);
  const west = meta.coordDenom - tx;
  const north = meta.coordDenom - tz;
  return guardI32('field numerator', (nw * west + ne * tx) * north + (sw * west + se * tx) * tz);
};

const bandOfNumerator = (numerator) => (numerator + BIAS_NUMERATOR) >> BAND_NUMERATOR_SHIFT;

const lowestDrawnBandNear = (i0, j0) => {
  let lowest = BEDROCK_BAND;
  let found = false;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const cell = clampCell(j0 + dz) * size + clampCell(i0 + dx);
      const count = spanCountOf(cell);
      for (let k = 0; k < count; k++) {
        if (!isSpanDrawn(spanFloor(cell, k), spanCeiling(cell, k))) continue;
        const band = spanCeiling(cell, k) >> BAND_HEIGHT_SHIFT;
        if (!found || band < lowest) lowest = band;
        found = true;
        break;
      }
    }
  }
  return lowest;
};

const keyAtSample = (sx, sz) => {
  const i0 = sx >> SAMPLE_SHIFT;
  const j0 = sz >> SAMPLE_SHIFT;
  const tx = (sx & SAMPLE_MASK) * COORD_PER_SAMPLE;
  const tz = (sz & SAMPLE_MASK) * COORD_PER_SAMPLE;
  const x0 = clampCell(i0);
  const x1 = clampCell(i0 + 1);
  const z0 = clampCell(j0);
  const z1 = clampCell(j0 + 1);
  const top = bandOfNumerator(fieldNumerator(x0, x1, z0, z1, tx, tz, 0, true));
  let band = top;
  const layered = meta.layeredCells > 0 && (
    spanDesc[z0 * size + x0] !== 0 || spanDesc[z0 * size + x1] !== 0 ||
    spanDesc[z1 * size + x0] !== 0 || spanDesc[z1 * size + x1] !== 0);
  if (layered) {
    const lowest = lowestDrawnBandNear(i0, j0);
    band = lowest;
    for (let candidate = top; candidate > lowest; candidate--) {
      if (bandOfNumerator(fieldNumerator(x0, x1, z0, z1, tx, tz, candidate, false)) >= candidate) {
        band = candidate;
        break;
      }
    }
  }
  const nearest = clampCell((sz + HALF_SAMPLE) >> SAMPLE_SHIFT) * size
    + clampCell((sx + HALF_SAMPLE) >> SAMPLE_SHIFT);
  return band * 2 + (band === 0 && columnSampleAtBand(nearest, 0) >= meta.shoreThreshold ? 1 : 0);
};

// keys.bin is dump.mjs's key per sample, band * 2 + shoreBit, with the band
// straight out of drawnBandAt and the shore bit out of columnSampleAtBand.
const expected = new Int32Array(readFileSync(`${OUT}/keys.bin`).buffer.slice(0));
const lattice = meta.sampleLattice;
let [bandBad, bandChecked, layeredChecked] = [0, 0, 0];
let bandExample = '';
for (let at = 0; at < lattice * lattice; at += BAND_SAMPLE_STRIDE) {
  const sx = at % lattice;
  const sz = (at - sx) / lattice;
  const key = keyAtSample(sx, sz);
  bandChecked++;
  if (key !== expected[at]) {
    bandBad++;
    if (!bandExample) bandExample = `sample (${sx}, ${sz}) gave key ${key}, dump gave ${expected[at]}`;
  }
}
// Every layered column, exhaustively: that is the branch the stride can miss.
for (let cell = 0; cell < size * size; cell++) {
  if (spanDesc[cell] === 0) continue;
  const cx = cell % size;
  const cy = (cell - cx) / size;
  for (let dz = -1; dz <= meta.samplesPerCell; dz++) {
    for (let dx = -1; dx <= meta.samplesPerCell; dx++) {
      const sx = cx * meta.samplesPerCell + dx;
      const sz = cy * meta.samplesPerCell + dz;
      if (sx < 0 || sz < 0 || sx >= lattice || sz >= lattice) continue;
      const key = keyAtSample(sx, sz);
      layeredChecked++;
      if (key !== expected[sz * lattice + sx]) {
        bandBad++;
        if (!bandExample) bandExample = `layered sample (${sx}, ${sz}) gave key ${key}, dump gave ${expected[sz * lattice + sx]}`;
      }
    }
  }
}
check(
  'integer key field matches drawnBandAt + columnSampleAtBand',
  bandBad === 0,
  `${bandChecked} strided + ${layeredChecked} layered samples, ${bandBad} mismatches ${bandExample}`,
);


// --- the marching-squares case table ---------------------------------------
// The WGSL derives a riser from any polygon edge whose two ends are both
// crossings, so the table has to make caps and risers agree by construction.
const { polys } = buildMarchingTable();
const maskOfCase = (c) => (c === SADDLE_5_SPLIT_CASE ? 5 : c === SADDLE_10_SPLIT_CASE ? 10 : c);
const SIDE_OF_CROSSING = [[0, 1], [1, 2], [2, 3], [3, 0]];
const UNIT_SQUARE_AREA = 1;
const AREA_EPSILON = 1e-12;
let tableBad = 0;
const tableNote = [];
const complain = (message) => { tableBad++; if (tableNote.length < 4) tableNote.push(message); };

for (let c = 0; c < CASE_COUNT; c++) {
  const mask = maskOfCase(c);
  const segments = contourSegments(polys[c]);
  const seen = new Map();
  for (const poly of polys[c]) {
    for (const r of poly) seen.set(r, (seen.get(r) ?? 0) + 1);
  }
  for (let corner = 0; corner < CORNER_REFS; corner++) {
    const want = (mask & (1 << corner)) !== 0 ? 1 : 0;
    if ((seen.get(corner) ?? 0) !== want) complain(`case ${c}: corner ${corner} used ${seen.get(corner) ?? 0}x, wanted ${want}`);
  }
  for (let side = 0; side < 4; side++) {
    const [from, to] = SIDE_OF_CROSSING[side];
    const crosses = ((mask >> from) & 1) !== ((mask >> to) & 1);
    const want = crosses ? 1 : 0;
    if ((seen.get(CORNER_REFS + side) ?? 0) !== want) {
      complain(`case ${c}: crossing ${side} used ${seen.get(CORNER_REFS + side) ?? 0}x, wanted ${want}`);
    }
  }
  // A riser must span two different sides of the square, never fold onto one.
  for (const [a, b] of segments) {
    if (a === b) complain(`case ${c}: riser segment folds onto crossing ${a}`);
  }
  const expectedSegments = mask === 0 || mask === 15 ? 0 : (mask === 5 || mask === 10 ? 2 : 1);
  if (segments.length !== expectedSegments) {
    complain(`case ${c}: ${segments.length} riser segments, wanted ${expectedSegments}`);
  }
  // The case and the reading of its complement tile the square exactly, and
  // share the same risers, which is what makes the mesh watertight.
  const other = complementCase(c);
  const area = polys[c].reduce((sum, poly) => sum + polygonArea(poly), 0);
  const otherArea = polys[other].reduce((sum, poly) => sum + polygonArea(poly), 0);
  if (Math.abs(area + otherArea - UNIT_SQUARE_AREA) > AREA_EPSILON) {
    complain(`case ${c} + ${other} cover ${area + otherArea}, wanted ${UNIT_SQUARE_AREA}`);
  }
  const key = (list) => list.map(([a, b]) => [a, b].sort().join('-')).sort().join(' ');
  if (key(segments) !== key(contourSegments(polys[other]))) {
    complain(`case ${c} and ${other} disagree on riser segments`);
  }
}
check('marching-squares case table is consistent', tableBad === 0,
  `${CASE_COUNT} cases, ${tableBad} problems ${tableNote.join('; ')}`);

// --- PNG round trip ---------------------------------------------------------
const [PNG_TEST_WIDTH, PNG_TEST_HEIGHT] = [137, 91];
const pixels = new Uint8Array(PNG_TEST_WIDTH * PNG_TEST_HEIGHT * 4);
for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + (i >> 5)) & 0xff;
const decoded = decodePng(encodePng(PNG_TEST_WIDTH, PNG_TEST_HEIGHT, pixels));
const sameSize = decoded.width === PNG_TEST_WIDTH && decoded.height === PNG_TEST_HEIGHT;
let pngBad = 0;
for (let i = 0; i < pixels.length; i++) if (decoded.rgba[i] !== pixels[i]) pngBad++;
check('PNG encode/decode round trip', sameSize && pngBad === 0, `${pngBad} bytes differ`);

console.log(failures === 0 ? 'all self-checks passed' : `${failures} self-check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
