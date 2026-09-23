import { expect, it } from 'vitest';
import { createTerrainMirror, chunksDirtiedByCell } from '../src/terrain/mirror.ts';
import { drawnSurface } from '../src/terrain/drawnSurface.ts';
import { createChunkJobWorkspace, extractChunkWindow, loadWindow } from '../src/terrain/chunkJob.ts';
import { extractWindowEntry, OVER_BUDGET } from '../src/render/gpuMesher/terrainGpuInputs.ts';

it('worker windows reproduce the live field at seams, world edges, and missing neighbours', () => {
  const live = createTerrainMirror(64);
  for (const mode of ['raw', 'binomial'] as const) {
    live.surfaceMode = mode;
    const request = extractChunkWindow(live, 5, 1);
    expect(request.windowWidth).toBe(mode === 'raw' ? 18 : 19);
    expect(request.windowHeight).toBe(request.windowWidth);
    const entry = extractWindowEntry(live, 5);
    expect(entry).not.toBe(OVER_BUDGET);
    if (entry !== OVER_BUDGET) {
      expect(entry.lattice.length).toBe((mode === 'raw' ? 17 : 19) ** 2);
      expect(entry.latticeDesc.length).toBe(entry.lattice.length);
    }
  }
  live.surfaceMode = 'binomial';
  live.surfaceRevision = 0;
  for (let i = 0; i < 16; i++) live.received.add(i);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) live.map.cells[y * 64 + x] = 20 + x + y + (x * y % 3);
  const workspace = createChunkJobWorkspace(64);
  for (const missing of [false, true]) {
    if (missing) { live.received.delete(6); live.surfaceRevision!++; }
    for (const chunk of [5, 15, 0]) {
      workspace.mirror.map.cells.fill(-1000);
      const request = extractChunkWindow(live, chunk, 1);
      const worker = loadWindow(workspace, request);
      expect(worker.surfaceMode).toBe(live.surfaceMode);
      const x0 = chunk % 4 * 16, y0 = Math.floor(chunk / 4) * 16;
      for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) {
        expect(drawnSurface(worker)!.sample(x0 + i, y0 + j, null)).toBe(drawnSurface(live)!.sample(x0 + i, y0 + j, null));
      }
    }
  }
  const before = drawnSurface(live)!.sample(17, 17, null);
  live.map.cells[17 * 64 + 17] += 100;
  expect(chunksDirtiedByCell(live, 17, 17).sort((a, b) => a - b)).toEqual([0, 1, 4, 5]);
  expect(drawnSurface(live)!.sample(17, 17, null)).not.toBe(before);
});
