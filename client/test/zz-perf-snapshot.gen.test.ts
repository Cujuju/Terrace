// TEMPORARY — regenerates .terrace-perf/snapshot.json for the sculpt bench,
// in-process from the server's own genesis (no server, no ports).
import { writeFileSync } from 'node:fs';
import { ensurePerfDir, PERF_SNAPSHOT } from './support/perfPaths.ts';
import { it } from 'vitest';
import {
  applySculpt,
  createHeightmap,
  extractChunkPayload,
  chunksPerEdge,
  CHUNK_SIZE,
} from '@terrace/shared';
import {
  buildFreshGenesisTerrain,
  freshGenesisHeightAt,
} from '../../server/src/world/genesis.ts';

const WORLD_SIZE = 512;
const SEED = 20260826;
const REVEALED_CHUNK_SPAN = 20; // 20 x 20 = 400 chunks, matching the brief's fixture
const SCULPT_STROKES = 400;
const SCULPT_AMOUNT = 64;

/** Genesis plus 198 strokes over 512² takes about two and a half minutes. */
const GENERATE_TIMEOUT_MS = 300_000;

it('writes a 512² snapshot with 400 revealed chunks', () => {
  const terrain = buildFreshGenesisTerrain(WORLD_SIZE, SEED);
  const map = createHeightmap(WORLD_SIZE);
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      map.cells[y * WORLD_SIZE + x] = freshGenesisHeightAt(terrain, x, y);
    }
  }
  // SCULPT IT. A fresh genesis world is band-quantised everywhere, so no cell
  // is a STRICT local maximum and it has no springs at all — a river fixture
  // with no rivers. Real relief (and therefore real rivers) only exists where
  // someone has sculpted, so the fixture sculpts: deterministic raise strokes
  // over the highest ground, through the same applySculpt the server runs.
  const rand = (() => { let s0 = 0x9e3779b9; return () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  const edge = chunksPerEdge(WORLD_SIZE);
  // Pick the 20x20 chunk window carrying the most high ground: springs need a
  // strict local maximum at least one band above sea, so an all-ocean window
  // makes a river fixture with no rivers in it.
  const highPerChunk = new Int32Array(edge * edge);
  for (let cy = 0; cy < edge; cy++) {
    for (let cx = 0; cx < edge; cx++) {
      let n = 0;
      for (let y = cy * CHUNK_SIZE; y < (cy + 1) * CHUNK_SIZE; y++) {
        for (let x = cx * CHUNK_SIZE; x < (cx + 1) * CHUNK_SIZE; x++) {
          if (map.cells[y * WORLD_SIZE + x]! >= 64) n++;
        }
      }
      highPerChunk[cy * edge + cx] = n;
    }
  }
  let bestX = 0, bestY = 0, best = -1;
  for (let oy = 0; oy + REVEALED_CHUNK_SPAN <= edge; oy++) {
    for (let ox = 0; ox + REVEALED_CHUNK_SPAN <= edge; ox++) {
      let sum = 0;
      for (let cy = oy; cy < oy + REVEALED_CHUNK_SPAN; cy++)
        for (let cx = ox; cx < ox + REVEALED_CHUNK_SPAN; cx++) sum += highPerChunk[cy * edge + cx]!;
      if (sum > best) { best = sum; bestX = ox; bestY = oy; }
    }
  }
  const cellLo = bestX * CHUNK_SIZE;
  const cellHi = (bestX + REVEALED_CHUNK_SPAN) * CHUNK_SIZE;
  const cellLoY = bestY * CHUNK_SIZE;
  const cellHiY = (bestY + REVEALED_CHUNK_SPAN) * CHUNK_SIZE;
  let strokes = 0;
  for (let i = 0; i < SCULPT_STROKES; i++) {
    const x = cellLo + Math.floor(rand() * (cellHi - cellLo));
    const y = cellLoY + Math.floor(rand() * (cellHiY - cellLoY));
    if (map.cells[y * WORLD_SIZE + x]! < 0) continue;
    const radius = 4 + Math.floor(rand() * 7);
    const dir = rand() < 0.75 ? 1 : -1;
    for (let r = 0; r < 3; r++) applySculpt(map, x, y, radius, dir * SCULPT_AMOUNT);
    strokes++;
  }
  console.log(`sculpted ${strokes} strokes`);

  const chunks = [];
  for (let cy = bestY; cy < bestY + REVEALED_CHUNK_SPAN; cy++) {
    for (let cx = bestX; cx < bestX + REVEALED_CHUNK_SPAN; cx++) {
      chunks.push(extractChunkPayload(map, cx, cy));
    }
  }
  console.log(`window chunks (${bestX},${bestY}) high cells ${best}`);
  const snap = { type: 'snapshot', worldSize: WORLD_SIZE, chunks };
  ensurePerfDir();
  writeFileSync(PERF_SNAPSHOT, JSON.stringify({ snap, unlocks: [] }));
  console.log(`wrote ${chunks.length} chunks, world ${WORLD_SIZE}²`);
}, GENERATE_TIMEOUT_MS);
