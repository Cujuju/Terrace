// Renders the shipped contour geometry top-down into an integer target and
// compares every texel centre to shared/src/drawnGround.ts. Texel centres within
// PARITY_CHORD_MARGIN_SUBCELLS of a chord are excluded and counted. Zero
// mismatches among the rest is the bar.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { resolveChromeHeadlessShell } from './chromeHeadlessShell.mjs';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MAX_SPANS_PER_COLUMN,
  MIN_HEIGHT,
  TERRAIN_LOD_FAR_N,
  TERRAIN_LOD_NEAR_N,
} from '../../shared/src/constants.ts';
import { cellIndex, createHeightmap } from '../../shared/src/grid.ts';
import { BEDROCK_FLOOR, setColumn } from '../../shared/src/columns.ts';
import { chunkIndex, chunksPerEdge } from '../../shared/src/chunks.ts';
import { carveArchFixture } from '../src/terrain/archFixture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CLIENT_ROOT = resolve(HERE, '..');
const PATCH_ENV_VAR = 'TERRACE_PATCH_JSON';
const PATCH_RELATIVE_PATH = '.terrain-options/patch.json';

// .terrain-options is untracked, so a worktree has to reach the main checkout.
function resolvePatchFile() {
  const override = process.env[PATCH_ENV_VAR];
  if (override !== undefined && override !== '') return override;
  const here = resolve(REPO_ROOT, PATCH_RELATIVE_PATH);
  if (existsSync(here)) return here;
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const main = resolve(dirname(commonDir), PATCH_RELATIVE_PATH);
  if (existsSync(main)) return main;
  throw new Error(`no ${PATCH_RELATIVE_PATH} at ${here} or ${main}; set ${PATCH_ENV_VAR}`);
}

const PATCH_FILE = resolvePatchFile();

const CHROME_ENDPOINT_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 250;
const CDP_PORT_BASE = 9700;
const CDP_PORT_SPREAD = 200;

const SUBDIVISIONS = [TERRAIN_LOD_NEAR_N, TERRAIN_LOD_FAR_N];

/** Shifts that drag the frostwick patch below sea level, where floor != trunc. */
const PATCH_SHIFTS = [0, -400, -1400];

const SWEEP_SEED = 0x2545f491;
const SWEEP_MULTIPLIER = 1664525;
const SWEEP_INCREMENT = 1013904223;
const SWEEP_MODULUS = 2 ** 32;

/** The cell the sculpt-path check rewrites, and the band it moves by. */
const SCULPT_CHUNK = { cx: 1, cy: 1 };
const SCULPT_DELTA = -777;

/** Wide enough for the arch fixture's mound, which reaches 30 cells from centre. */
const LAYERED_CHUNKS_PER_EDGE = 4;
const LAYERED_SIZE = CHUNK_SIZE * LAYERED_CHUNKS_PER_EDGE;

const BASE_X_STRIDE = 3;
const BASE_Y_STRIDE = 5;
const BASE_BAND_SPREAD = 17;
const BASE_BAND_FLOOR = -4;

/** Every fifth cell on a stride that is coprime with the lattice, so caves straddle blends. */
const CAVE_X_STRIDE = 7;
const CAVE_Y_STRIDE = 11;
const CAVE_PERIOD = 5;
const CAVE_ROOF_BANDS = 2;
const CAVE_FLOOR_BANDS = 6;

/** The overhang plateau measured on this arc: a bedrock slab, a gap, then a roof. */
const OVERHANG_CELLS = 16;
const OVERHANG_SLAB_CEILING = 0;
const OVERHANG_ROOF_FLOOR = 256;
const OVERHANG_ROOF_CEILING = 320;

const MAX_SPAN_REGION_CELLS = 12;
const MAX_SPAN_FIRST_BANDS = 3;
const MAX_SPAN_GAP_SPREAD = 2 * BAND_HEIGHT;
const MAX_SPAN_RUN_SPREAD = 3 * BAND_HEIGHT;
const MAX_SPAN_GAP_X_STRIDE = 3;
const MAX_SPAN_GAP_Y_STRIDE = 5;
const MAX_SPAN_GAP_K_STRIDE = 7;
const MAX_SPAN_RUN_X_STRIDE = 5;
const MAX_SPAN_RUN_Y_STRIDE = 3;
const MAX_SPAN_RUN_K_STRIDE = 11;

/**
 * Four adjacent columns, searched for the deepest bounded fixpoint they can drive.
 * Offsets above BEDROCK_FLOOR; the best sub-cell settles after 15 blends.
 */
const FIXPOINT_CHAIN_COLUMNS = [
  [[0, 27], [39, 67], [100, 101], [134, 135], [200, 233], [266, 299], [332, 333], [398, 399]],
  [[0, 1], [66, 131], [132, 165], [230, 231], [232, 265], [330, 395], [428, 461], [526, 591]],
  [[0, 17], [82, 115], [148, 213], [246, 279], [280, 345], [410, 411], [412, 477], [542, 607]],
  [[0, 33], [98, 163], [228, 229], [294, 295], [360, 425], [490, 491], [556, 557], [558, 591]],
];

const FIXPOINT_CHAIN_CELLS = 2;

/** Chunks the span-upload check empties and fills; the plateau covers the first, not the second. */
const SPAN_FREED_CHUNK = { cx: 1, cy: 1 };
const SPAN_ADDED_CHUNK = { cx: 0, cy: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampHeight(h) {
  return h < MIN_HEIGHT ? MIN_HEIGHT : h > MAX_HEIGHT ? MAX_HEIGHT : h;
}

function patchMaps() {
  const patch = JSON.parse(readFileSync(PATCH_FILE, 'utf8'));
  const size = patch.patch;
  const maps = [];
  for (const shift of PATCH_SHIFTS) {
    const map = createHeightmap(size);
    for (let i = 0; i < size * size; i++) map.cells[i] = clampHeight(patch.cells[i] + shift);
    maps.push({ name: `frostwick${shift === 0 ? '' : shift}`, map });
  }
  const sweep = createHeightmap(size);
  let state = SWEEP_SEED;
  for (let i = 0; i < size * size; i++) {
    state = (state * SWEEP_MULTIPLIER + SWEEP_INCREMENT) % SWEEP_MODULUS;
    sweep.cells[i] = MIN_HEIGHT + (state % (MAX_HEIGHT - MIN_HEIGHT + 1));
  }
  maps.push({ name: 'sweep', map: sweep });
  return maps;
}

function baseTerrain(size) {
  const map = createHeightmap(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const band = ((x * BASE_X_STRIDE + y * BASE_Y_STRIDE) % BASE_BAND_SPREAD) + BASE_BAND_FLOOR;
      map.cells[cellIndex(map, x, y)] = band * BAND_HEIGHT;
    }
  }
  return map;
}

function carveCaves(map) {
  for (let y = 0; y < map.size; y++) {
    for (let x = 0; x < map.size; x++) {
      if ((x * CAVE_X_STRIDE + y * CAVE_Y_STRIDE) % CAVE_PERIOD !== 0) continue;
      const ground = map.cells[cellIndex(map, x, y)];
      setColumn(map, x, y, [
        { floor: BEDROCK_FLOOR, ceiling: ground - CAVE_FLOOR_BANDS * BAND_HEIGHT },
        { floor: ground - CAVE_ROOF_BANDS * BAND_HEIGHT, ceiling: ground },
      ]);
    }
  }
  return map;
}

function overhangPlateau(map) {
  const origin = Math.floor((map.size - OVERHANG_CELLS) / 2);
  for (let y = origin; y < origin + OVERHANG_CELLS; y++) {
    for (let x = origin; x < origin + OVERHANG_CELLS; x++) {
      setColumn(map, x, y, [
        { floor: BEDROCK_FLOOR, ceiling: OVERHANG_SLAB_CEILING },
        { floor: OVERHANG_ROOF_FLOOR, ceiling: OVERHANG_ROOF_CEILING },
      ]);
    }
  }
  return map;
}

/** A full stack of MAX_SPANS_PER_COLUMN, some of them sub-band slivers that are never drawn. */
function maxSpanColumn(x, y) {
  const spans = [];
  let ceiling = BEDROCK_FLOOR + BAND_HEIGHT * (1 + ((x + y) % MAX_SPAN_FIRST_BANDS));
  spans.push({ floor: BEDROCK_FLOOR, ceiling });
  for (let k = 1; k < MAX_SPANS_PER_COLUMN; k++) {
    const floor =
      ceiling +
      1 +
      ((x * MAX_SPAN_GAP_X_STRIDE + y * MAX_SPAN_GAP_Y_STRIDE + k * MAX_SPAN_GAP_K_STRIDE) %
        MAX_SPAN_GAP_SPREAD);
    ceiling =
      floor +
      1 +
      ((x * MAX_SPAN_RUN_X_STRIDE + y * MAX_SPAN_RUN_Y_STRIDE + k * MAX_SPAN_RUN_K_STRIDE) %
        MAX_SPAN_RUN_SPREAD);
    spans.push({ floor, ceiling });
  }
  return spans;
}

function maxSpanRegion(map) {
  const origin = Math.floor((map.size - MAX_SPAN_REGION_CELLS) / 2);
  for (let y = origin; y < origin + MAX_SPAN_REGION_CELLS; y++) {
    for (let x = origin; x < origin + MAX_SPAN_REGION_CELLS; x++) {
      setColumn(map, x, y, maxSpanColumn(x, y));
    }
  }
  return map;
}

function fixpointChain(map) {
  const origin = Math.floor(map.size / 2);
  for (let j = 0; j < FIXPOINT_CHAIN_CELLS; j++) {
    for (let i = 0; i < FIXPOINT_CHAIN_CELLS; i++) {
      const column = FIXPOINT_CHAIN_COLUMNS[j * FIXPOINT_CHAIN_CELLS + i];
      setColumn(
        map,
        origin + i,
        origin + j,
        column.map(([floor, ceiling]) => ({
          floor: BEDROCK_FLOOR + floor,
          ceiling: BEDROCK_FLOOR + ceiling,
        })),
      );
    }
  }
  return map;
}

function archMap(size) {
  const map = baseTerrain(size);
  const received = new Set();
  const perEdge = chunksPerEdge(size);
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) received.add(chunkIndex(size, cx, cy));
  }
  carveArchFixture({ map, renderMap: map, received });
  return map;
}

function layeredMaps() {
  return [
    { name: 'caves', map: carveCaves(baseTerrain(LAYERED_SIZE)) },
    { name: 'overhangs', map: overhangPlateau(baseTerrain(LAYERED_SIZE)) },
    { name: 'maxspans', map: maxSpanRegion(carveCaves(baseTerrain(LAYERED_SIZE))) },
    { name: 'arch', map: archMap(LAYERED_SIZE) },
    { name: 'fixpoint', map: fixpointChain(carveCaves(baseTerrain(LAYERED_SIZE))) },
  ];
}

/** Every column in the chunk loses its spans, so the chunk's block is freed. */
function flattenColumn(map, x, y) {
  setColumn(map, x, y, [
    { floor: BEDROCK_FLOOR, ceiling: map.cells[cellIndex(map, x, y)] },
  ]);
}

/** A chequer of overhangs in a chunk that held none, so a block is allocated. */
function raiseOverhang(map, x, y) {
  if ((x + y) % 2 !== 0) return;
  setColumn(map, x, y, [
    { floor: BEDROCK_FLOOR, ceiling: OVERHANG_SLAB_CEILING },
    { floor: OVERHANG_ROOF_FLOOR, ceiling: OVERHANG_ROOF_CEILING },
  ]);
}

function sculptChunk(map, chunk, mutate) {
  const x = chunk.cx * CHUNK_SIZE;
  const y = chunk.cy * CHUNK_SIZE;
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) mutate(map, x + i, y + j);
  }
  const cells = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  const spans = [];
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const index = cellIndex(map, x + i, y + j);
      cells[j * CHUNK_SIZE + i] = map.cells[index];
      const packed = map.columnSpans.get(index);
      spans.push([index, packed === undefined ? null : Array.from(packed)]);
    }
  }
  return { x, y, cells, spans };
}

function spanEntries(map) {
  return Array.from(map.columnSpans, ([index, packed]) => [index, Array.from(packed)]);
}

// ---------------------------------------------------------------------------
// The gate. The page renders the shipped contour geometry top-down into an
// RGBA32I target and compares every texel centre with the drawn contract.
// ---------------------------------------------------------------------------

/** Texels per sub-cell edge. A vertex misplaced by a texel has to show up here. */
const PARITY_TEXELS_PER_SUBCELL = 64;

/** Sub-cells per render pass, so one target stays at 1024 x 1024 RGBA32I. */
const PARITY_TILE_SUBCELLS = 16;

/** A quarter texel: well above the rasteriser's 1/256-pixel snap, well below a texel. */
const PARITY_CHORD_MARGIN_SUBCELLS = 1 / 256;

/**
 * Per chord in a sub-cell: its excluded strip is at most 2 * sqrt(2) * margin
 * wide over at most sqrt(2) of length, so this much of the sub-cell's area.
 */
const PARITY_MAX_EXCLUDED_PER_CHORD = 4 * PARITY_CHORD_MARGIN_SUBCELLS;

/** Clear value, below every drawable height, so a bare texel cannot read as one. */
const PARITY_EMPTY_HEIGHT = MIN_HEIGHT - 1;

/** Risers and curtains say nothing from above; they carry this and the fragment drops them. */
const PARITY_RISER_HEIGHT = MIN_HEIGHT - 2;

const CAMERA_HEIGHT_WORLD = 128;
const CAMERA_NEAR_WORLD = 1;
const CAMERA_FAR_WORLD = 256;

const INSTANCE_COMPONENTS = 2;

const PROBE_PAGE = `<!doctype html><meta charset="utf-8"><title>gpu terrain parity</title>
<script type="module" src="/probe.js"></script>`;

const PROBE_SCRIPT = `
import * as THREE from 'three';
import {
  CELL_CENTRE_OFFSET_CELLS,
  drawnGroundChunkBandSpans,
  drawnGroundFarHeight,
  drawnGroundHeight,
  drawnGroundSubcell,
  drawnGroundSubcellIsLayered,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from 'clientConfig';
import {
  createBandPaletteTexture,
  createColumnSpanTextures,
  createHeightTexture,
} from 'gpuTerrainTextures';
import {
  BASE_CLASS_STEPS,
  CLASS_STEPS_UNIFORM,
  DRAWS_LAYERED_UNIFORM,
  GPU_TERRAIN_VERTEX_ATTRIBUTES_GLSL,
  GPU_TERRAIN_VERTEX_BODY_GLSL,
  GPU_TERRAIN_VERTEX_HEAD_GLSL,
  LAYERED_OVERLAY_CLASS,
  PALETTE_UNIFORM,
  SMOOTH_UNIFORM,
  SUBDIVISION_UNIFORM,
  createChunkTemplate,
  overlayClassCap,
} from 'gpuTerrainMaterial';

const CHUNK_CELLS = ${CHUNK_SIZE};
const LATTICE_N = ${TERRAIN_LOD_NEAR_N};
const TEXELS_PER_SUBCELL = ${PARITY_TEXELS_PER_SUBCELL};
const TILE_SUBCELLS = ${PARITY_TILE_SUBCELLS};
const CHORD_MARGIN = ${PARITY_CHORD_MARGIN_SUBCELLS};
const EMPTY_HEIGHT = ${PARITY_EMPTY_HEIGHT};
const RISER_HEIGHT = ${PARITY_RISER_HEIGHT};
const CAMERA_HEIGHT = ${CAMERA_HEIGHT_WORLD};
const CAMERA_NEAR = ${CAMERA_NEAR_WORLD};
const CAMERA_FAR = ${CAMERA_FAR_WORLD};
const INSTANCE_COMPONENTS = ${INSTANCE_COMPONENTS};
const TARGET_SIDE = TILE_SUBCELLS * TEXELS_PER_SUBCELL;

const VERTEX_PREAMBLE = \`precision highp float;
precision highp int;
#define attribute in
#define varying out
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
\`;

const PARITY_VERTEX =
  VERTEX_PREAMBLE +
  GPU_TERRAIN_VERTEX_ATTRIBUTES_GLSL +
  GPU_TERRAIN_VERTEX_HEAD_GLSL +
  \`
flat out int vParityHeight;
void main() {
\${GPU_TERRAIN_VERTEX_BODY_GLSL}
  // worldY covers the layered flat cap too, which carries no tread band.
  vParityHeight = vIsRiser > 0.5
    ? \${RISER_HEIGHT}
    : int(floor(worldY / HEIGHT_WORLD_SCALE + 0.5));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
\`;

const PARITY_FRAGMENT = \`precision highp float;
precision highp int;
flat in int vParityHeight;
layout(location = 0) out ivec4 outHeight;
void main() {
  if (vParityHeight == \${RISER_HEIGHT}) discard;
  outHeight = ivec4(vParityHeight, 0, 0, 0);
}
\`;

// An integer target cannot be gl.clear()ed, so a quad lays the sentinel down first.
const EMPTY_VERTEX = \`precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
\`;

const EMPTY_FRAGMENT = \`precision highp float;
precision highp int;
layout(location = 0) out ivec4 outHeight;
void main() { outHeight = ivec4(\${EMPTY_HEIGHT}, 0, 0, 0); }
\`;

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
// three reports a failed shader compile through console.error and nowhere else.
const baseConsoleError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map(String).join(' '));
  baseConsoleError(...args);
};
window.__errors = () => errors;

const canvas = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.autoClear = false;

const emptyMaterial = new THREE.RawShaderMaterial({
  vertexShader: EMPTY_VERTEX,
  fragmentShader: EMPTY_FRAGMENT,
  glslVersion: THREE.GLSL3,
  blending: THREE.NoBlending,
  depthTest: false,
  depthWrite: false,
});
const emptyMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), emptyMaterial);
emptyMesh.frustumCulled = false;
emptyMesh.renderOrder = -1;

const palette = createBandPaletteTexture();
const cellCoordToWorld = (c) => (c - CELL_CENTRE_OFFSET_CELLS) * CELL_WORLD_SIZE;

let state = null;

// The span store re-points its own sampler when it grows, so re-read every time.
const syncSpanUniforms = () => {
  for (const name of ['uChunkSpanBlock', 'uColumnSpans', 'uWorldHasSpans']) {
    state.uniforms[name] = state.spans.uniforms[name];
  }
};

const uploadChunksOver = (x, y, w, h) => {
  const first = { x: Math.floor(x / CHUNK_CELLS), y: Math.floor(y / CHUNK_CELLS) };
  const last = {
    x: Math.floor((x + w - 1) / CHUNK_CELLS),
    y: Math.floor((y + h - 1) / CHUNK_CELLS),
  };
  for (let cy = first.y; cy <= last.y; cy++) {
    for (let cx = first.x; cx <= last.x; cx++) state.spans.uploadChunk(renderer, cx, cy);
  }
  syncSpanUniforms();
};

window.__load = (cells, size, spans) => {
  if (state !== null) {
    state.height.dispose();
    state.spans.dispose();
  }
  const columnSpans = new Map(spans.map(([index, packed]) => [index, Int16Array.from(packed)]));
  const map = { size, cells: Int16Array.from(cells), columnSpans };
  const height = createHeightTexture(map);
  const spanTextures = createColumnSpanTextures(map);
  state = {
    map,
    height,
    spans: spanTextures,
    uniforms: {
      uHeight: { value: height.texture },
      uSizeCells: { value: size },
      [PALETTE_UNIFORM]: { value: palette },
      [SMOOTH_UNIFORM]: { value: 0 },
    },
  };
  uploadChunksOver(0, 0, size, size);
  return true;
};

window.__writeRect = (x, y, w, h, cells, spans) => {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      state.map.cells[(y + j) * state.map.size + x + i] = cells[j * w + i];
    }
  }
  for (const [index, packed] of spans) {
    if (packed === null) state.map.columnSpans.delete(index);
    else state.map.columnSpans.set(index, Int16Array.from(packed));
  }
  state.height.uploadRect(renderer, x, y, w, h);
  uploadChunksOver(x, y, w, h);
  return true;
};

/** Smallest class that draws a sub-cell: the base pass, the layered class, or an overlay. */
const classOf = (bandSpan, layered) => {
  if (layered) return LAYERED_OVERLAY_CLASS;
  if (bandSpan <= BASE_CLASS_STEPS) return BASE_CLASS_STEPS;
  return overlayClassCap(bandSpan);
};

const referenceHeight = (subdiv) =>
  subdiv === LATTICE_N ? drawnGroundHeight : drawnGroundFarHeight;

/** Base instance for the chunk, plus one overlay instance per sub-cell that needs a class. */
function passesFor(map, cx, cy, subdiv) {
  const span = CHUNK_CELLS * subdiv;
  const spans = drawnGroundChunkBandSpans(map, cx, cy, subdiv);
  const byClass = new Map();
  for (let j = 0; j < span; j++) {
    for (let i = 0; i < span; i++) {
      const sx = cx * span + i;
      const sz = cy * span + j;
      const layered = drawnGroundSubcellIsLayered(map, sx, sz, subdiv);
      const steps = classOf(spans[j * span + i], layered);
      if (steps === BASE_CLASS_STEPS && !layered) continue;
      const list = byClass.get(steps) ?? [];
      list.push(sx / subdiv, sz / subdiv);
      byClass.set(steps, list);
    }
  }
  const passes = [
    { steps: BASE_CLASS_STEPS, cells: CHUNK_CELLS, origins: [cx * CHUNK_CELLS, cy * CHUNK_CELLS] },
  ];
  for (const [steps, origins] of Array.from(byClass).sort((a, b) => a[0] - b[0])) {
    passes.push({ steps, cells: 1 / subdiv, origins });
  }
  return passes;
}

function buildScene(passes, subdiv) {
  const scene = new THREE.Scene();
  scene.add(emptyMesh);
  const disposables = [];
  for (const pass of passes) {
    const { geometry } = createChunkTemplate(subdiv, pass.steps, pass.cells);
    const origins = new THREE.InstancedBufferAttribute(
      Float32Array.from(pass.origins),
      INSTANCE_COMPONENTS,
    );
    geometry.setAttribute('aChunk', origins);
    geometry.instanceCount = pass.origins.length / INSTANCE_COMPONENTS;
    const material = new THREE.RawShaderMaterial({
      vertexShader: PARITY_VERTEX,
      fragmentShader: PARITY_FRAGMENT,
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      blending: THREE.NoBlending,
      uniforms: {
        ...state.uniforms,
        [SUBDIVISION_UNIFORM]: { value: subdiv },
        [CLASS_STEPS_UNIFORM]: { value: pass.steps },
        [DRAWS_LAYERED_UNIFORM]: { value: pass.steps === LAYERED_OVERLAY_CLASS ? 1 : 0 },
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    disposables.push(geometry, material);
  }
  return { scene, disposables };
}

/** Chords of one sub-cell, in sub-cell local units, as flat [ax, az, bx, bz, ...]. */
function localChords(map, sx, sz, subdiv) {
  const flat = [];
  for (const riser of drawnGroundSubcell(map, sx, sz, subdiv).risers) {
    flat.push(
      riser.from.x * subdiv - sx,
      riser.from.y * subdiv - sz,
      riser.to.x * subdiv - sx,
      riser.to.y * subdiv - sz,
    );
  }
  return flat;
}

/** Each chord is four numbers: both ends, in sub-cell local units. */
const CHORD_POINT_STRIDE = 4;

function nearAChord(flat, lx, lz) {
  for (let k = 0; k < flat.length; k += CHORD_POINT_STRIDE) {
    const ax = flat[k];
    const az = flat[k + 1];
    const ex = flat[k + 2] - ax;
    const ez = flat[k + 3] - az;
    const len2 = ex * ex + ez * ez;
    let t = len2 === 0 ? 0 : ((lx - ax) * ex + (lz - az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = lx - (ax + t * ex);
    const dz = lz - (az + t * ez);
    if (dx * dx + dz * dz < CHORD_MARGIN * CHORD_MARGIN) return true;
  }
  return false;
}

window.__parity = (subdiv, cx, cy) => {
  const map = state.map;
  const reference = referenceHeight(subdiv);
  const { scene, disposables } = buildScene(passesFor(map, cx, cy, subdiv), subdiv);
  const target = new THREE.WebGLRenderTarget(TARGET_SIDE, TARGET_SIDE, {
    format: THREE.RGBAIntegerFormat,
    type: THREE.IntType,
    internalFormat: 'RGBA32I',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const raw = new Int32Array(TARGET_SIDE * TARGET_SIDE * 4);
  const cellsPerTile = TILE_SUBCELLS / subdiv;
  const cellsPerTexel = cellsPerTile / TARGET_SIDE;
  const tiles = (CHUNK_CELLS * subdiv) / TILE_SUBCELLS;
  const half = (cellsPerTile * CELL_WORLD_SIZE) / 2;

  let samples = 0;
  let excluded = 0;
  let mismatches = 0;
  let chords = 0;
  let subcells = 0;
  let worst = null;

  for (let tj = 0; tj < tiles; tj++) {
    for (let ti = 0; ti < tiles; ti++) {
      const subX = (cx * CHUNK_CELLS * subdiv) + ti * TILE_SUBCELLS;
      const subZ = (cy * CHUNK_CELLS * subdiv) + tj * TILE_SUBCELLS;
      const x0 = subX / subdiv;
      const z0 = subZ / subdiv;

      // Top and bottom are swapped so readback row 0 is the low-Z edge.
      const camera = new THREE.OrthographicCamera(-half, half, -half, half, CAMERA_NEAR, CAMERA_FAR);
      camera.position.set(cellCoordToWorld(x0) + half, CAMERA_HEIGHT, cellCoordToWorld(z0) + half);
      camera.rotation.set(-Math.PI / 2, 0, 0);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();

      renderer.setRenderTarget(target);
      renderer.clear(false, true, false);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, TARGET_SIDE, TARGET_SIDE, raw);
      renderer.setRenderTarget(null);

      const tileChords = [];
      for (let j = 0; j < TILE_SUBCELLS; j++) {
        for (let i = 0; i < TILE_SUBCELLS; i++) {
          subcells++;
          const flat = localChords(map, subX + i, subZ + j, subdiv);
          chords += flat.length / CHORD_POINT_STRIDE;
          tileChords.push(flat);
        }
      }

      for (let py = 0; py < TARGET_SIDE; py++) {
        const cellZ = z0 + (py + 0.5) * cellsPerTexel;
        const sj = (py / TEXELS_PER_SUBCELL) | 0;
        const lz = (py % TEXELS_PER_SUBCELL + 0.5) / TEXELS_PER_SUBCELL;
        for (let px = 0; px < TARGET_SIDE; px++) {
          samples++;
          const si = (px / TEXELS_PER_SUBCELL) | 0;
          const lx = (px % TEXELS_PER_SUBCELL + 0.5) / TEXELS_PER_SUBCELL;
          if (nearAChord(tileChords[sj * TILE_SUBCELLS + si], lx, lz)) {
            excluded++;
            continue;
          }
          const cellX = x0 + (px + 0.5) * cellsPerTexel;
          const want = reference(map, cellX, cellZ);
          const got = raw[(py * TARGET_SIDE + px) * 4];
          if (got === want) continue;
          mismatches++;
          const delta = Math.abs(got - want);
          if (worst === null || delta > worst.delta) {
            worst = { x: cellX, y: cellZ, gpu: got, expected: want, delta };
          }
        }
      }
    }
  }

  target.dispose();
  for (const item of disposables) item.dispose();
  return { samples, excluded, mismatches, chords, subcells, worst };
};

window.__renderer = () => {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

window.__ready = true;
`;

async function startVite(scratch) {
  writeFileSync(join(scratch, 'index.html'), PROBE_PAGE);
  writeFileSync(join(scratch, 'probe.js'), PROBE_SCRIPT);
  const server = await createViteServer({
    configFile: false,
    root: scratch,
    logLevel: 'error',
    appType: 'mpa',
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: {
        three: join(CLIENT_ROOT, 'node_modules/three/build/three.module.js'),
        '@terrace/shared': join(REPO_ROOT, 'shared/src/index.ts'),
        clientConfig: join(CLIENT_ROOT, 'src/config.ts'),
        gpuTerrainField: join(CLIENT_ROOT, 'src/render/gpuTerrainField.ts'),
        gpuTerrainMaterial: join(CLIENT_ROOT, 'src/render/gpuTerrainMaterial.ts'),
        gpuTerrainTextures: join(CLIENT_ROOT, 'src/render/gpuTerrainTextures.ts'),
      },
    },
    server: { port: 0, strictPort: false, host: '127.0.0.1', fs: { allow: [REPO_ROOT] } },
  });
  await server.listen();
  return { server, port: server.config.server.port ?? server.httpServer.address().port };
}

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(READY_POLL_INTERVAL_MS);
    }
  }
  throw new Error(`chrome devtools endpoint did not come up within ${timeoutMs}ms`);
}

let nextId = 1;
function rpc(ws, method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
      else res(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function startChrome() {
  const port = CDP_PORT_BASE + Math.floor(Math.random() * CDP_PORT_SPREAD);
  const profile = mkdtempSync(join(tmpdir(), 'gpu-parity-'));
  const child = spawn(
    resolveChromeHeadlessShell(),
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.stderr.resume();
  const cleanup = () => {
    try {
      child.kill('SIGKILL');
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  };
  process.on('exit', cleanup);
  const ws = new WebSocket(await waitForEndpoint(port, CHROME_ENDPOINT_TIMEOUT_MS));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  return { ws, cleanup };
}

/** Every layered fixture centres its feature, so the centre chunk is the interesting one. */
function parityChunk(size) {
  const middle = Math.floor(chunksPerEdge(size) / 2);
  return { cx: middle, cy: middle };
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'gpu-parity-page-'));
  mkdirSync(scratch, { recursive: true });
  const { server, port } = await startVite(scratch);
  const { ws, cleanup } = await startChrome();
  const shutdown = () => {
    cleanup();
    server.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  };

  const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await rpc(ws, 'Page.enable', {}, sessionId);
  await rpc(ws, 'Runtime.enable', {}, sessionId);
  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(
        msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
      );
    }
  });
  await rpc(ws, 'Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);

  const evaluate = async (expression) => {
    const r = await rpc(
      ws,
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate('window.__ready === true')) break;
    await sleep(READY_POLL_INTERVAL_MS);
  }
  if ((await evaluate('window.__ready === true')) !== true) {
    shutdown();
    throw new Error(`probe page never became ready: ${pageErrors.join(' | ')}`);
  }

  console.log(`renderer: ${await evaluate('window.__renderer()')}`);

  const load = (map) =>
    evaluate(
      `window.__load(${JSON.stringify(Array.from(map.cells))}, ${map.size},` +
        ` ${JSON.stringify(spanEntries(map))})`,
    );
  const writeChunk = (rect) =>
    evaluate(
      `window.__writeRect(${rect.x}, ${rect.y}, ${CHUNK_SIZE}, ${CHUNK_SIZE},` +
        ` ${JSON.stringify(Array.from(rect.cells))}, ${JSON.stringify(rect.spans)})`,
    );

  const results = [];
  const blocked = new Set();
  const probe = async (label, subdiv, chunk) => {
    try {
      const r = await evaluate(`window.__parity(${subdiv}, ${chunk.cx}, ${chunk.cy})`);
      results.push({ label: `${label} N=${subdiv}`, ...r });
    } catch (error) {
      blocked.add(`N=${subdiv}: ${String(error.message).split('\n')[0]}`);
    }
  };

  for (const { name, map } of [...patchMaps(), ...layeredMaps()]) {
    await load(map);
    const chunk = parityChunk(map.size);
    for (const subdiv of SUBDIVISIONS) await probe(name, subdiv, chunk);
  }

  const { map } = patchMaps()[0];
  await load(map);
  const rect = { x: SCULPT_CHUNK.cx * CHUNK_SIZE, y: SCULPT_CHUNK.cy * CHUNK_SIZE };
  const patchCells = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let j = 0; j < CHUNK_SIZE; j++) {
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const cell = map.cells[(rect.y + j) * map.size + rect.x + i] + SCULPT_DELTA;
      patchCells[j * CHUNK_SIZE + i] = clampHeight(cell);
      map.cells[(rect.y + j) * map.size + rect.x + i] = clampHeight(cell);
    }
  }
  await writeChunk({ x: rect.x, y: rect.y, cells: patchCells, spans: [] });
  await probe('frostwick after rect upload', TERRAIN_LOD_NEAR_N, SCULPT_CHUNK);

  // Freeing a chunk's span block and allocating one for a chunk that had none.
  const layered = overhangPlateau(baseTerrain(LAYERED_SIZE));
  await load(layered);
  await writeChunk(sculptChunk(layered, SPAN_FREED_CHUNK, flattenColumn));
  await writeChunk(sculptChunk(layered, SPAN_ADDED_CHUNK, raiseOverhang));
  await probe('overhangs after span free', TERRAIN_LOD_NEAR_N, SPAN_FREED_CHUNK);
  await probe('overhangs after span add', TERRAIN_LOD_NEAR_N, SPAN_ADDED_CHUNK);

  const pageLog = await evaluate('window.__errors()');
  shutdown();

  let samples = 0;
  let excluded = 0;
  let mismatches = 0;
  let overExcluded = 0;
  let worst = null;
  for (const r of results) {
    samples += r.samples;
    excluded += r.excluded;
    mismatches += r.mismatches;
    const fraction = r.excluded / r.samples;
    const allowed = Math.min(1, (PARITY_MAX_EXCLUDED_PER_CHORD * r.chords) / r.subcells);
    if (fraction > allowed) overExcluded++;
    if (r.worst !== null && (worst === null || r.worst.delta > worst.delta)) {
      worst = { ...r.worst, label: r.label };
    }
    console.log(
      `${r.label.padEnd(34)} samples ${String(r.samples).padStart(9)}` +
        `  excluded ${(fraction * 100).toFixed(3)}% of ${(allowed * 100).toFixed(3)}%` +
        `  mismatches ${r.mismatches}`,
    );
  }
  const excludedPercent = samples === 0 ? 0 : (excluded / samples) * 100;
  console.log(
    `\ntotal samples ${samples}, excluded ${excludedPercent.toFixed(3)}%,` +
      ` mismatches ${mismatches}`,
  );
  if (overExcluded > 0) {
    console.log(`${overExcluded} label(s) excluded more than their chords can account for`);
  }
  if (worst !== null) {
    console.log(
      `worst: ${worst.label} at cell ${worst.x.toFixed(5)},${worst.y.toFixed(5)}` +
        ` gpu ${worst.gpu} expected ${worst.expected} (delta ${worst.delta})`,
    );
  }
  for (const reason of blocked) console.log(`blocked ${reason}`);
  for (const message of pageLog) console.log(`page: ${message}`);
  if (pageErrors.length > 0) console.log(`page errors: ${pageErrors.join(' | ')}`);
  const passed = mismatches === 0 && overExcluded === 0 && blocked.size === 0 && results.length > 0;
  console.log(passed ? 'PASS' : 'FAIL');
  process.exit(passed ? 0 : 1);
}

await main();
