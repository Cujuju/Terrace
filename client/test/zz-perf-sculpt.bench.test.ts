// TEMPORARY perf bench — not for commit. Times the client-side work one sculpt
// triggers (applyDirty chain in world.ts) against a real world snapshot.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PERF_CPU_PROFILE, PERF_OWNER_SNAPSHOT } from './support/perfPaths.ts';
import { Session } from 'node:inspector';
import { Group } from 'three';
import { it } from 'vitest';
import { createTerrainMirror, applySnapshot } from '../src/terrain/mirror.ts';
import { createPredictionStore } from '../src/terrain/prediction.ts';
import { createTerrainMeshes } from '../src/render/terrainMeshes.ts';
import { createWater } from '../src/render/water.ts';
import { createFrontierFog } from '../src/render/frontierFog.ts';
import { createLayerEdgeOverlay } from '../src/render/layerEdgeOverlay.ts';
import { createRiverRig } from '../src/render/riverRig.ts';
import { createDrawnGround } from '../src/terrain/drawnGround.ts';
import { computeRiverNetwork, chunkIndexOfCell, CELL_WORLD_SIZE } from '@terrace/shared';
import { flattenRiverNetwork, EMPTY_RIVER_SURFACE, type RiverSurface } from '../src/render/water/riverSurface.ts';

const rev = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '__typed' in (v as object)
    ? new (globalThis as any)[(v as any).__typed]((v as any).data)
    : v;
// snapshot.owner.json is the OWNER'S world (frostwick-hollows, 491 KB). It is a
// separate file because snapshot.json is shared with other agents' rigs and has
// twice been overwritten mid-session with a freshly generated world — whose
// busiest super-mesh holds 33 k vertices against the real one's 1.25 M, which
// silently turns every number here into a different measurement.
const snapshotPath = PERF_OWNER_SNAPSHOT;
// Blessed by hand and never generated, so a checkout without it skips the
// bench rather than failing the suite at import.
const blessed = existsSync(snapshotPath);
const { snap } = blessed
  ? JSON.parse(readFileSync(snapshotPath, 'utf8'), rev)
  : { snap: { worldSize: 0, chunks: [] } };
const noop = () => () => {};
// The rig throttles itself to RIVER_RECOMPUTE_INTERVAL_MS, so a tight loop
// would measure 29 no-ops. Skew the clock forward past the window before each
// refresh; the skew is constant within a call, so ms() still times truthfully.
let clockSkew = 0;
const realNow = performance.now.bind(performance);
performance.now = () => realNow() + clockSkew;
const ms = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };
const stat = (a: number[]) => `n=${a.length} med=${[...a].sort((x, y) => x - y)[a.length >> 1]!.toFixed(2)} max=${Math.max(...a).toFixed(2)} sum=${a.reduce((x, y) => x + y, 0).toFixed(1)}`;

it.skipIf(!blessed)('bench one sculpt', () => {
  const size = snap.worldSize as number;
  const mirror = createTerrainMirror(size);
  const group = new Group();
  const meshes = createTerrainMeshes(group, mirror); // no scheduling → synchronous flush (worst case, no budget)
  const water = createWater(group, size);
  const fog = createFrontierFog(group, noop);
  const layerEdges = createLayerEdgeOverlay(group, mirror, size, meshes.drawnGround());
  // The app drives this from build completion; the bench does the same so the
  // `layerEdges` row measures what a sculpt really costs the overlay.
  const refreshEdges = (dirty: Set<number>) => { for (const idx of dirty) layerEdges.refreshChunk(idx); };
  // The network arrives from a worker in the real client, so the bench stages it
  // OUTSIDE the timed region and hands it over synchronously: `rivers` then
  // measures exactly the main-thread cost of a refresh, and `riverNetwork`
  // measures the part that no longer runs on this thread.
  let stagedSurface: RiverSurface = EMPTY_RIVER_SURFACE;
  const rivers = createRiverRig(group, noop, {
    networkSource: { compute: () => stagedSurface, dispose: () => {} },
  });
  const computeNetwork = () => {
    stagedSurface = flattenRiverNetwork(mirror.map, computeRiverNetwork(mirror.map, {
      isActive: (x, y) => mirror.received.has(chunkIndexOfCell(mirror.map.size, x, y)),
    }));
  };
  const predictions = createPredictionStore(mirror);
  const ground = createDrawnGround(mirror, meshes.drawnGround());
  const tInit = ms(() => {
    const dirty = predictions.applyAuthoritative((m) => applySnapshot(m, snap), 0);
    meshes.update(dirty); refreshEdges(dirty); fog.sync(mirror); water.sync(mirror); computeNetwork(); rivers.forceRefresh(mirror, ground);
  });
  console.log(`world ${size}² received ${mirror.received.size} chunks; initial build ${tInit.toFixed(0)} ms; drawCalls terrain=${meshes.drawCallCount()} fog=${fog.drawCallCount()}`);

  // WHERE THE SCULPT LANDS DECIDES THE NUMBERS. (b)'s bounds saving is
  // proportional to the live vertex count of the super-mesh the site sits in
  // (§4.1: 0.03 ms on a barely-revealed one, ~14 ms on this world's busiest),
  // so the bench sculpts in the BUSIEST super-mesh rather than in whatever
  // chunk happens to sort first near the world centre. Boxes are read off the
  // drawn meshes rather than module internals: scan each mesh's live position
  // range for its XZ extent and its draw-range count.
  const superBoxes = meshes.pickables().map((mesh, i) => {
    const g = mesh.geometry;
    const pos = g.getAttribute('position') as any;
    const live = g.drawRange.count;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let v = 0; v < live; v++) {
      const x = pos.array[v * 3], z = pos.array[v * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { i, live, minX, maxX, minZ, maxZ };
  });
  console.log('super-mesh live vertices:', superBoxes.map((b) => `#${b.i}=${b.live}`).join(' '));
  const busiest = superBoxes.reduce((a, b) => (b.live > a.live ? b : a));
  const cpe = Math.floor(size / 16);
  let cx = 0, cy = 0;
  let bestScore = -Infinity;
  for (const idx of mirror.received) {
    const chx = idx % cpe, chy = (idx - (idx % cpe)) / cpe;
    const wx = (chx * 16 + 8) * CELL_WORLD_SIZE, wz = (chy * 16 + 8) * CELL_WORLD_SIZE;
    if (wx < busiest.minX || wx > busiest.maxX || wz < busiest.minZ || wz > busiest.maxZ) continue;
    // Centre-most chunk of that super-mesh, so the 30-step walk in +x stays
    // inside it and every sculpt pays the same super-mesh's tail move.
    const score = -(Math.abs(wx - (busiest.minX + busiest.maxX) / 2) + Math.abs(wz - (busiest.minZ + busiest.maxZ) / 2));
    if (score > bestScore) { bestScore = score; cx = chx * 16 + 8; cy = chy * 16 + 8; }
  }
  console.log(
    `sculpt site cell (${cx},${cy}) world (${(cx * CELL_WORLD_SIZE).toFixed(1)},${(cy * CELL_WORLD_SIZE).toFixed(1)}) -> ` +
      `super-mesh #${busiest.i} live vertices ${busiest.live} ` +
      `x[${busiest.minX.toFixed(0)},${busiest.maxX.toFixed(0)}] z[${busiest.minZ.toFixed(0)},${busiest.maxZ.toFixed(0)}]`,
  );

  const T: Record<string, number[]> = { predict: [], meshes: [], layerEdges: [], fog: [], water: [], riverNetwork: [], rivers: [], drawnGround: [], diffApply: [] };
  let dirtySizes: number[] = [];
  const sess = new Session(); sess.connect(); sess.post('Profiler.enable'); sess.post('Profiler.setSamplingInterval', { interval: 200 }); sess.post('Profiler.start');
  for (let i = 0; i < 30; i++) {
    const intent = { type: 'sculpt' as const, seq: i + 1, x: cx + i, y: cy, radius: 4, dir: 1 as const };
    let dirty = new Set<number>();
    T.predict!.push(ms(() => { dirty = predictions.predict(intent, i * 120); }));
    dirtySizes.push(dirty.size);
    T.meshes!.push(ms(() => meshes.update(dirty)));
    T.layerEdges!.push(ms(() => refreshEdges(dirty)));
    T.fog!.push(ms(() => fog.refresh(mirror, dirty)));
    T.water!.push(ms(() => water.refresh(mirror, dirty)));
    T.riverNetwork!.push(ms(computeNetwork));
    clockSkew += 1000;
    T.rivers!.push(ms(() => rivers.refresh(mirror, dirty, ground)));
    T.drawnGround!.push(ms(() => { const g = createDrawnGround(mirror, meshes.drawnGround()); g.capYAt(cx, cy); g.capYAt(cx + 20, cy + 20); }));
    // authoritative echo of the same edit, like the server's terrainDiff
    const cells = [] as { x: number; y: number; h: number }[];
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (dx * dx + dy * dy <= 16) cells.push({ x: cx + i + dx, y: cy + dy, h: mirror.map.cells[(cy + dy) * size + cx + i + dx]! });
    T.diffApply!.push(ms(() => { const d = predictions.applyCellDiff({ type: 'terrainDiff', cells } as any, i * 120 + 60); predictions.resolveSeq(i + 1); meshes.update(d); }));
  }
  sess.post('Profiler.stop', (_e, r: any) => writeFileSync(PERF_CPU_PROFILE, JSON.stringify(r.profile)));
  // ARENA OCCUPANCY (vertex-arena plan §7.2). Dead space is not asserted as a
  // number anywhere — §3d argues convergence, not a bound — so what the bench
  // does is report it. `growths` is the one upload the arena does not bound.
  const arena = (label: string) => console.log(
    `arenaStats ${label}:`,
    meshes.arenaStats()
      .map((a, i) => `#${i} liveEnd=${a.liveEnd} live=${a.liveCount} dead=${a.deadVertices} holes=${a.holeCount} growths=${a.growths}`)
      .filter((_, i) => meshes.arenaStats()[i]!.liveEnd > 0)
      .join(' '),
  );
  arena('after 30 sculpts');
  meshes.flush();
  arena('after flush');
  console.log('dirty chunks per predict:', dirtySizes.join(','));
  console.log('median splice ms (direct path, includes the build):', meshes.medianSpliceMs());
  for (const [k, v] of Object.entries(T)) console.log(k.padEnd(12), stat(v));
});
