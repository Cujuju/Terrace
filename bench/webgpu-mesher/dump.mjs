// Dumps every input the WebGPU mesher page needs, straight out of the shipped
// TypeScript so nothing is re-derived by hand. Read-only on the world DB.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMarchingTable } from './marching.mjs';

const OUT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(OUT, '..', '..');
// One-snapshot copy of Frostwick Hollows (#1322), tracked so any checkout can regenerate the inputs.
const WORLD_DB = join(OUT, 'frostwick-gate.db');
const SRC = pathToFileURL(REPO).href;

const shared = await import(`${SRC}/shared/src/index.ts`);
const codec = await import(`${SRC}/server/src/persistence/codec.ts`);
const colors = await import(`${SRC}/client/src/terrain/bandColors.ts`);
const cap = await import(`${SRC}/client/src/terrain/capEmission.ts`);
const config = await import(`${SRC}/client/src/config.ts`);

const {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  CELL_WORLD_SIZE,
  DRAWN_GROUND_BAND_BIAS,
  DRAWN_GROUND_COORD_DENOM,
  DRAWN_GROUND_CROSSING_MIDPOINT,
  SHEER_WALL_SPREAD_CELLS,
  SHEER_RISE_HEIGHT_UNITS_PER_CELL,
  ISOLINE_SAMPLES_PER_CELL,
  MAX_HEIGHT,
  MIN_HEIGHT,
  SEA_LEVEL,
  createHeightmap,
  columnSampleAtBand,
  drawnBandAt,
  drawnIsolineAt,
  setColumn,
} = shared;
const { BAND_WORLD_HEIGHT } = config;
const {
  CLIFF_PALETTE,
  TERRAIN_PALETTE,
  bandPaletteIndex,
  isEmissivePaletteIndex,
  isSeabedPaletteIndex,
} = colors;
const { SEABED_CAP_SINK, SEABED_RISER_BORDER_WORLD_HEIGHT } = cap;

// Emission constants shared with the WGSL mesher. Any change here must be
// mirrored in mesher.html; the page asserts its atomic vertex total against
// the count this file computes.
const SAMPLES_PER_CELL = ISOLINE_SAMPLES_PER_CELL;
const SAMPLE_WORLD_SIZE = CELL_WORLD_SIZE / SAMPLES_PER_CELL;
// The page's vertex: x and z as u16 over the world's own extent, y as an i16 in
// 1/HEIGHT_SCALE world units, then rgba. Both sources quantize identically, so
// two squares that share a crossing still land on the same vertex.
const BYTES_PER_VERTEX = 12;
const HEIGHT_SCALE = 256;
const POSITION_MAX = 65535;
// Quantization steps held back above the world extent, so the mesher can nudge
// its outermost squares past the far edge without the clamp eating the nudge.
const POSITION_BORDER_STEPS = 4;
const SHORE_EDGE_CROSSING = 1 / 2;
const [BAND_LUT_OFFSET, BAND_LUT_SIZE] = [128, 256];
const [SELF_LIT_OFF, SELF_LIT_ON] = [0, 1];
const SHORE_THRESHOLD = SEA_LEVEL + 1;
const HOLE_BAND = -128;

// --- world ------------------------------------------------------------------
const require = createRequire(join(REPO, 'server', 'package.json'));
const Database = require('better-sqlite3');
const db = new Database(WORLD_DB, { readonly: true });
const row = db
  .prepare('select world_size, heightmap, column_spans from snapshots order by id desc limit 1')
  .get();
db.close();

const size = row.world_size;
const heights = codec.decodeHeights(new Uint8Array(row.heightmap), size * size);
const spansByCell = codec.decodeColumnSpans(
  new Uint8Array(row.column_spans),
  size * size,
  'gate1 dump',
);

const map = createHeightmap(size);
map.cells.set(heights);
for (const [cellIndex, spans] of spansByCell) {
  setColumn(map, cellIndex % size, Math.floor(cellIndex / size), spans);
}

let [minHeight, maxHeight, maxCellStep] = [Infinity, -Infinity, 0];
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const h = map.cells[y * size + x];
    minHeight = Math.min(minHeight, h);
    maxHeight = Math.max(maxHeight, h);
    if (x + 1 < size) maxCellStep = Math.max(maxCellStep, Math.abs(map.cells[y * size + x + 1] - h));
    if (y + 1 < size) maxCellStep = Math.max(maxCellStep, Math.abs(map.cells[(y + 1) * size + x] - h));
  }
}

writeFileSync(`${OUT}/world.bin`, Buffer.from(map.cells.buffer, 0, size * size * 2));

// --- spans.bin --------------------------------------------------------------
// [ u32 desc[size*size] ][ i32 spanData[2 * totalSpans] ]
// desc = (spanCount << SPAN_COUNT_SHIFT) | spanDataOffset, where the offset
// counts (floor, ceiling) pairs into spanData. desc == 0 means "not layered":
// the column is the single implicit span [BEDROCK_FLOOR, cells[i]).
const SPAN_COUNT_SHIFT = 24;
const MAX_SPANS_PER_COLUMN = 255;
const desc = new Uint32Array(size * size);
const spanValues = [];
for (const [cellIndex, spans] of spansByCell) {
  if (spans.length > MAX_SPANS_PER_COLUMN) {
    throw new RangeError(`cell ${cellIndex} holds ${spans.length} spans; desc packs at most ${MAX_SPANS_PER_COLUMN}`);
  }
  desc[cellIndex] = (spans.length << SPAN_COUNT_SHIFT) | (spanValues.length / 2);
  for (const span of spans) spanValues.push(span.floor, span.ceiling);
}
const spanData = Int32Array.from(spanValues);
const spansBin = Buffer.concat([
  Buffer.from(desc.buffer, 0, desc.byteLength),
  Buffer.from(spanData.buffer, 0, spanData.byteLength),
]);
writeFileSync(`${OUT}/spans.bin`, spansBin);

// --- expected.bin, plus the exact vertex budget -----------------------------
const S = size * SAMPLES_PER_CELL;
const lattice = S + 1;
const CELL_CENTRE_OFFSET = 1 / 2;

const expected = new Int8Array(lattice * lattice);
// key = band * 2 + shoreBit; shoreBit marks the shipped mesher's extra
// shoreline level (threshold SEA_LEVEL + 1, cap at world y 0).
const keys = new Int32Array(lattice * lattice);

// The shipped mesher marches the shoreline level with crossingOverride
// SHORE_EDGE_CROSSING, so its contour sits on cell-edge midpoints rather than
// on the interpolated field. The faithful per-sample test is therefore the
// nearest lattice cell's own sample, not a bilinear read.
const nearestCell = (s) => Math.min(size - 1, Math.max(0, Math.round(s / SAMPLES_PER_CELL)));
const shoreInside = (sx, sz) =>
  columnSampleAtBand(map, nearestCell(sx), nearestCell(sz), 0) >= SHORE_THRESHOLD;

for (let sz = 0; sz < lattice; sz++) {
  for (let sx = 0; sx < lattice; sx++) {
    const px = sx / SAMPLES_PER_CELL;
    const pz = sz / SAMPLES_PER_CELL;
    const band = drawnBandAt(map, px + CELL_CENTRE_OFFSET, pz + CELL_CENTRE_OFFSET);
    if (band < HOLE_BAND + 1 || band > 127) throw new RangeError(`band ${band} escapes Int8`);
    const at = sz * lattice + sx;
    expected[at] = band;
    keys[at] = band * 2 + (band === 0 && shoreInside(sx, sz) ? 1 : 0);
  }
}
writeFileSync(`${OUT}/expected.bin`, Buffer.from(expected.buffer, 0, expected.byteLength));
// keys.bin is not an input to the page; selfcheck.mjs compares its port of the
// key function against it, so the shoreline bit is verified too, not just band.
writeFileSync(`${OUT}/keys.bin`, Buffer.from(keys.buffer, 0, keys.byteLength));

// --- band lookup tables (palette work stays out of WGSL) --------------------
const bandCapY = (band) => (band === 0 ? -SEABED_CAP_SINK : band * BAND_WORLD_HEIGHT);

const capLut = new Float32Array(BAND_LUT_SIZE * 4);
const cliffLut = new Float32Array(BAND_LUT_SIZE * 4);
const borderLut = new Float32Array(BAND_LUT_SIZE * 4);
for (let band = -BAND_LUT_OFFSET; band < BAND_LUT_SIZE - BAND_LUT_OFFSET; band++) {
  const slot = (band + BAND_LUT_OFFSET) * 4;
  const index = bandPaletteIndex(band * BAND_HEIGHT);
  // A seabed riser wears a thin rim of the band below it; every riser drop in
  // this mesher exceeds SEABED_RISER_BORDER_WORLD_HEIGHT, so the border flag is
  // the shipped mesher's `bordered` test with its drop condition already true.
  const seabed = isSeabedPaletteIndex(index) ? SELF_LIT_ON : SELF_LIT_OFF;
  capLut.set([...TERRAIN_PALETTE[index], isEmissivePaletteIndex(index) ? SELF_LIT_ON : SELF_LIT_OFF], slot);
  cliffLut.set([...CLIFF_PALETTE[index], seabed], slot);
  borderLut.set([...TERRAIN_PALETTE[bandPaletteIndex((band - 1) * BAND_HEIGHT)], seabed], slot);
  if (isSeabedPaletteIndex(index) && bandCapY(band) - bandCapY(band - 1) <= SEABED_RISER_BORDER_WORLD_HEIGHT) {
    throw new Error(`band ${band} riser is too short for the shipped rim rule`);
  }
}
const shoreIndex = bandPaletteIndex(SHORE_THRESHOLD);
const shoreCap = TERRAIN_PALETTE[shoreIndex];
const shoreCliff = CLIFF_PALETTE[shoreIndex];

// --- exact vertex count (mirrors the WGSL emission rules) -------------------
// --- cpu-mesh.bin -----------------------------------------------------------
// The shipped mesher's output in the page's own vertex layout, quantized the
// same way the WGSL quantizes, so both sources share one pipeline.
const chunksPerEdge = size / CHUNK_SIZE;
const POSITION_SCALE = (POSITION_MAX - POSITION_BORDER_STEPS) / (size * CELL_WORLD_SIZE);
const quantizePosition = (v) => Math.min(POSITION_MAX, Math.max(0, Math.round(v * POSITION_SCALE)));
const mirror = { map, received: new Set() };
for (let i = 0; i < chunksPerEdge * chunksPerEdge; i++) mirror.received.add(i);
const PALETTES = { top: TERRAIN_PALETTE, cliff: CLIFF_PALETTE };

const buffers = cap.createChunkGeometryBuffers();
const chunkOut = [];
let cpuVertexCount = 0;
const cpuFallbackChunks = [];
const buildStart = performance.now();
for (let cy = 0; cy < chunksPerEdge; cy++) {
  for (let cx = 0; cx < chunksPerEdge; cx++) {
    const counts = cap.writeChunkVertexData(mirror, cx, cy, buffers, PALETTES);
    if (counts.usedFallback) cpuFallbackChunks.push(cy * chunksPerEdge + cx);
    const n = counts.vertexCount;
    const slab = Buffer.alloc(n * BYTES_PER_VERTEX);
    for (let v = 0; v < n; v++) {
      const o = v * BYTES_PER_VERTEX;
      slab.writeUInt16LE(quantizePosition(buffers.positions[v * 3]), o);
      slab.writeUInt16LE(quantizePosition(buffers.positions[v * 3 + 2]), o + 2);
      slab.writeInt16LE(Math.round(buffers.positions[v * 3 + 1] * HEIGHT_SCALE) << 16 >> 16, o + 4);
      for (let c = 0; c < 3; c++) slab[o + 8 + c] = buffers.colors[v * 3 + c];
      slab[o + 11] = buffers.selfLit[v] === 0 ? 0 : 255;
    }
    chunkOut.push(slab);
    cpuVertexCount += n;
  }
}
const cpuBuildMs = performance.now() - buildStart;
writeFileSync(`${OUT}/cpu-mesh.bin`, Buffer.concat(chunkOut));

const marching = buildMarchingTable();
writeFileSync(
  `${OUT}/marching.json`,
  JSON.stringify({ len: Array.from(marching.len), ref: Array.from(marching.ref) }),
);

writeFileSync(
  `${OUT}/palette.json`,
  JSON.stringify(
    {
      bandLutOffset: BAND_LUT_OFFSET,
      bandLutSize: BAND_LUT_SIZE,
      capLut: Array.from(capLut),
      cliffLut: Array.from(cliffLut),
      borderLut: Array.from(borderLut),
      shoreCap: [shoreCap[0], shoreCap[1], shoreCap[2], SELF_LIT_OFF],
      shoreCliff: [shoreCliff[0], shoreCliff[1], shoreCliff[2], SELF_LIT_OFF],
      terrainPalette: TERRAIN_PALETTE.map((c) => [c[0], c[1], c[2]]),
      cliffPalette: CLIFF_PALETTE.map((c) => [c[0], c[1], c[2]]),
    },
    null,
    2,
  ),
);

// --- isoline oracle: 4096 random cases for the WGSL port to reproduce -------
let seed = 0x9e3779b9;
const nextRandom = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const ISOLINE_CASE_COUNT = 4096;
const ISOLINE_SOLVE_DENOM = 1 << 16;
const ISOLINE_NO_CROSSING = -1; // stands for the TypeScript's null
const randomHeight = () => Math.round(MIN_HEIGHT + nextRandom() * (MAX_HEIGHT - MIN_HEIGHT));
const isolineCases = [];
for (let i = 0; i < ISOLINE_CASE_COUNT; i++) {
  const [nw, ne, sw, se] = [randomHeight(), randomHeight(), randomHeight(), randomHeight()];
  const band = Math.floor(MIN_HEIGHT / BAND_HEIGHT)
    + Math.floor((nextRandom() * (MAX_HEIGHT - MIN_HEIGHT)) / BAND_HEIGHT);
  const threshold = band * BAND_HEIGHT;
  const fixedUnits = Math.floor(nextRandom() * (DRAWN_GROUND_COORD_DENOM + 1));
  const alongX = nextRandom() < 0.5;
  const solved = drawnIsolineAt(nw, ne, sw, se, threshold, fixedUnits, alongX);
  isolineCases.push({ nw, ne, sw, se, threshold, fixedUnits, alongX: alongX ? 1 : 0,
    units: solved === null ? ISOLINE_NO_CROSSING : Math.round(solved * ISOLINE_SOLVE_DENOM) });
}
writeFileSync(`${OUT}/isoline-cases.json`, JSON.stringify(isolineCases));

const meta = {
  size, sampleLattice: lattice, samplesPerCell: SAMPLES_PER_CELL,
  sampleWorldSize: SAMPLE_WORLD_SIZE, cellWorldSize: CELL_WORLD_SIZE, chunkSize: CHUNK_SIZE,
  chunksPerEdge, bandHeight: BAND_HEIGHT, bandWorldHeight: BAND_WORLD_HEIGHT,
  bandBias: DRAWN_GROUND_BAND_BIAS, coordDenom: DRAWN_GROUND_COORD_DENOM,
  seabedCapSink: SEABED_CAP_SINK,
  seabedRiserBorderWorldHeight: SEABED_RISER_BORDER_WORLD_HEIGHT,
  shoreThreshold: SHORE_THRESHOLD, shoreEdgeCrossing: SHORE_EDGE_CROSSING,
  crossingMidpoint: DRAWN_GROUND_CROSSING_MIDPOINT,
  sheerWallSpreadCells: SHEER_WALL_SPREAD_CELLS,
  sheerRiseHeightUnitsPerCell: SHEER_RISE_HEIGHT_UNITS_PER_CELL,
  bedrockFloor: BEDROCK_FLOOR, openColumnSample: shared.OPEN_COLUMN_SAMPLE,
  spanCountShift: SPAN_COUNT_SHIFT, spanDescBytes: desc.byteLength,
  spanDataPairs: spanData.length / 2, layeredCells: spansByCell.size,
  minHeight, maxHeight, maxCellStep,
  bytesPerVertex: BYTES_PER_VERTEX, positionScale: POSITION_SCALE, heightScale: HEIGHT_SCALE,
  cpuVertexCount, cpuTriangleCount: cpuVertexCount / 3,
  cpuFallbackChunks, cpuFallbackChunkCount: cpuFallbackChunks.length,
  cpuBuildMs: +cpuBuildMs.toFixed(1), cpuVertexBytes: cpuVertexCount * BYTES_PER_VERTEX,
  isolineCaseCount: ISOLINE_CASE_COUNT, holeBand: HOLE_BAND,
};
writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
