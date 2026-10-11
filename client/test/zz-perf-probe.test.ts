import { readFileSync } from 'node:fs';
import { PERF_SNAPSHOT } from './support/perfPaths.ts';
import { it } from 'vitest';
import { createTerrainMirror, applySnapshot } from '../src/terrain/mirror.ts';
import { computeRiverNetwork, chunkIndexOfCell, riverPoints } from '@terrace/shared';
const rev = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '__typed' in (v as object)
    ? new (globalThis as any)[(v as any).__typed]((v as any).data)
    : v;
const { snap } = JSON.parse(readFileSync(PERF_SNAPSHOT, 'utf8'), rev);
it('probe', () => {
  const size = snap.worldSize as number;
  const mirror = createTerrainMirror(size);
  applySnapshot(mirror, snap);
  const t = performance.now();
  const net = computeRiverNetwork(mirror.map, { isActive: (x, y) => mirror.received.has(chunkIndexOfCell(size, x, y)) });
  console.log('computeRiverNetwork ms', (performance.now() - t).toFixed(2));
  console.log('springs', net.rivers.length, 'points', net.rivers.reduce((a, r) => a + riverPoints(r).length, 0));
  const bands = new Set<number>();
  let cells = 0;
  for (const r of net.rivers) for (const p of riverPoints(r)) { cells++; }
  console.log('wet point count', cells);
  // height histogram
  const h = mirror.map.cells; let min = 1e9, max = -1e9, land = 0;
  for (const idx of mirror.received) { const cx = idx % 32, cy = (idx - cx) / 32; for (let y = cy*16; y<cy*16+16;y++) for (let x=cx*16;x<cx*16+16;x++){const v=h[y*size+x]!; if(v<min)min=v; if(v>max)max=v; if(v>0)land++;} }
  console.log('height min', min, 'max', max, 'land cells', land, 'of', mirror.received.size*256);
});
