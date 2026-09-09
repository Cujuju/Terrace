import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => import(pathToFileURL(resolve(here, '..', p)).href);

const {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  ISOLINE_SAMPLES_PER_CELL,
  WORLD_UNIT_CELLS,
  applySculpt,
  chunksPerEdge,
  createHeightmap,
  drawnBandAt,
  extractChunkPayload,
  setColumn,
} = await load('../shared/src/index.ts');
const { applySnapshot, createTerrainMirror } = await load('src/terrain/mirror.ts');
const { planChunkCaps } = await load('src/terrain/capEmission.ts');
const { bridgeHole, earClip } = await load('src/terrain/triangulation.ts');
const { CLIFF_PALETTE, TERRAIN_PALETTE } = await load('src/terrain/bandColors.ts');

const PALETTES = { top: TERRAIN_PALETTE, cliff: CLIFF_PALETTE };

const SAMPLE_STEP = 1 / ISOLINE_SAMPLES_PER_CELL;

const CELL_CENTRE_OFFSET = 1 / 2;

const WORLD_SIZE = CHUNK_SIZE * 3;

const CENTRE = Math.floor(WORLD_SIZE / 2);

function worldOf(fill) {
  const map = createHeightmap(WORLD_SIZE);
  fill(map);
  const chunks = [];
  const perEdge = chunksPerEdge(WORLD_SIZE);
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) chunks.push(extractChunkPayload(map, cx, cy));
  }
  const mirror = createTerrainMirror(WORLD_SIZE);
  applySnapshot(mirror, { type: 'joinSnapshot', chunks });
  return { map, mirror };
}

function stamp(map, cx, cy, radius, clicks, options = {}) {
  for (let click = 0; click < clicks; click++) {
    applySculpt(
      map,
      cx,
      cy,
      radius,
      (options.up ? 1 : -1) * DEFAULT_SCULPT_AMOUNT,
      { tool: options.tool ?? 'stamp', profile: options.profile ?? 'soft', anchor: 'free' },
    );
  }
}

const FIXTURES = [
  {
    name: 'relaxed real patch',
    build: (map) => {
      map.cells.fill(6 * BAND_HEIGHT);
      stamp(map, CENTRE, CENTRE, 4 * WORLD_UNIT_CELLS, 5);
      stamp(map, CENTRE + 7, CENTRE - 5, 3 * WORLD_UNIT_CELLS, 4, { up: true });
      stamp(map, CENTRE - 9, CENTRE + 6, 2 * WORLD_UNIT_CELLS, 6);
      stamp(map, CENTRE, CENTRE, 4 * WORLD_UNIT_CELLS, 3, { tool: 'smooth' });
      stamp(map, CENTRE + 5, CENTRE + 5, 3 * WORLD_UNIT_CELLS, 3, { tool: 'smooth' });
    },
  },
  {
    name: 'stamped whole-band plateau with 4-cell treads',
    build: (map) => {
      for (let y = 0; y < WORLD_SIZE; y++) {
        for (let x = 0; x < WORLD_SIZE; x++) {
          const ring = Math.max(Math.abs(x - CENTRE), Math.abs(y - CENTRE));
          const band = Math.max(0, 6 - Math.floor(ring / WORLD_UNIT_CELLS));
          map.cells[y * WORLD_SIZE + x] = band * BAND_HEIGHT;
        }
      }
    },
  },
  {
    name: 'sheer multi-band wall in one cell',
    build: (map) => {
      for (let y = 0; y < WORLD_SIZE; y++) {
        for (let x = 0; x < WORLD_SIZE; x++) {
          map.cells[y * WORLD_SIZE + x] = x < CENTRE ? 0 : 12 * BAND_HEIGHT;
        }
      }
    },
  },
  {
    name: 'saddle',
    build: (map) => {
      for (let y = 0; y < WORLD_SIZE; y++) {
        for (let x = 0; x < WORLD_SIZE; x++) {
          const u = x - CENTRE;
          const v = y - CENTRE;
          map.cells[y * WORLD_SIZE + x] = 4 * BAND_HEIGHT + Math.round((u * v) / 2);
        }
      }
    },
  },
  {
    name: 'chunk seam',
    build: (map) => {
      for (let y = 0; y < WORLD_SIZE; y++) {
        for (let x = 0; x < WORLD_SIZE; x++) {
          map.cells[y * WORLD_SIZE + x] = Math.round(3 * BAND_HEIGHT + x * 5 + y * 3);
        }
      }
    },
  },
  {
    name: 'layered column',
    build: (map) => {
      map.cells.fill(2 * BAND_HEIGHT);
      for (let y = CENTRE - 4; y <= CENTRE + 4; y++) {
        for (let x = CENTRE - 4; x <= CENTRE + 4; x++) {
          setColumn(map, x, y, [
            { floor: BEDROCK_FLOOR, ceiling: 2 * BAND_HEIGHT },
            { floor: 5 * BAND_HEIGHT, ceiling: 7 * BAND_HEIGHT },
          ]);
        }
      }
    },
  },
];

function trianglesOfLevel(polygons) {
  const out = [];
  for (const polygon of polygons) {
    let merged = polygon.outer;
    for (const hole of polygon.holes) merged = bridgeHole(merged, hole);
    earClip(merged, (a, b, c) => {
      out.push({
        ax: a.x, az: a.z, bx: b.x, bz: b.z, cx: c.x, cz: c.z,
        minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x),
        minZ: Math.min(a.z, b.z, c.z), maxZ: Math.max(a.z, b.z, c.z),
      });
    });
  }
  return out;
}

const BRIDGE_SLIT_TOLERANCE = 1e-4;

function inTriangle(t, px, pz) {
  if (px < t.minX || px > t.maxX || pz < t.minZ || pz > t.maxZ) return false;
  const d1 = (t.bx - t.ax) * (pz - t.az) - (t.bz - t.az) * (px - t.ax);
  const d2 = (t.cx - t.bx) * (pz - t.bz) - (t.cz - t.bz) * (px - t.bx);
  const d3 = (t.ax - t.cx) * (pz - t.cz) - (t.az - t.cz) * (px - t.cx);
  const negative =
    d1 < -BRIDGE_SLIT_TOLERANCE || d2 < -BRIDGE_SLIT_TOLERANCE || d3 < -BRIDGE_SLIT_TOLERANCE;
  const positive =
    d1 > BRIDGE_SLIT_TOLERANCE || d2 > BRIDGE_SLIT_TOLERANCE || d3 > BRIDGE_SLIT_TOLERANCE;
  return !(negative && positive);
}

function distanceToSegmentSquared(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx;
  const qz = az + t * dz;
  return (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
}

function gateChunk(map, mirror, cx, cy, report) {
  const plan = planChunkCaps(mirror, cx, cy, PALETTES);
  if (plan.overBudget) {
    report.skippedChunks++;
    return;
  }
  const levels = plan.levels.map((level, index) => ({
    band: level.sampleBand,
    triangles: trianglesOfLevel(plan.polygonsPerLevel[index]),
    loops: level.loops,
  }));

  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  const nearContour = (px, pz) => {
    const limit = SAMPLE_STEP * SAMPLE_STEP;
    for (const level of levels) {
      for (const loop of level.loops) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i];
          const b = loop[(i + 1) % loop.length];
          if (distanceToSegmentSquared(px, pz, a.x, a.z, b.x, b.z) <= limit) return true;
        }
      }
    }
    return false;
  };

  for (let sz = 0; sz <= CHUNK_SIZE / SAMPLE_STEP; sz++) {
    for (let sx = 0; sx <= CHUNK_SIZE / SAMPLE_STEP; sx++) {
      const px = originX + sx * SAMPLE_STEP;
      const pz = originZ + sz * SAMPLE_STEP;
      let drawn = null;
      for (let index = levels.length - 1; index >= 0; index--) {
        const level = levels[index];
        let hit = false;
        for (const triangle of level.triangles) {
          if (inTriangle(triangle, px, pz)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          drawn = level.band;
          break;
        }
      }
      if (drawn === null) continue;
      const expected = drawnBandAt(map, px + CELL_CENTRE_OFFSET, pz + CELL_CENTRE_OFFSET);
      report.samples++;
      if (drawn === expected) continue;
      if (nearContour(px, pz)) {
        report.skippedNearContour++;
        continue;
      }
      report.mismatches++;
      if (report.examples.length < 8) {
        report.examples.push(`(${px}, ${pz}) mesh band ${drawn}, function band ${expected}`);
      }
    }
  }
}

let failed = false;
for (const fixture of FIXTURES) {
  const { map, mirror } = worldOf(fixture.build);
  const report = { samples: 0, mismatches: 0, skippedNearContour: 0, skippedChunks: 0, examples: [] };
  const perEdge = chunksPerEdge(WORLD_SIZE);
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) gateChunk(map, mirror, cx, cy, report);
  }
  const status = report.mismatches === 0 ? 'PASS' : 'FAIL';
  if (report.mismatches > 0) failed = true;
  console.log(
    `${status} ${fixture.name}: ${report.samples} samples, ${report.mismatches} mismatches, ` +
      `${report.skippedNearContour} within one step of a contour, ${report.skippedChunks} blocky chunks`,
  );
  for (const example of report.examples) console.log(`     ${example}`);
}
process.exit(failed ? 1 : 0);
