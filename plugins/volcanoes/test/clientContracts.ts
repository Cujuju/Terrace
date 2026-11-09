import assert from 'node:assert/strict';
import { CELL_WORLD_SIZE, CHUNK_SIZE } from '@terrace/shared';
import { Group, type BufferAttribute, type InstancedMesh, type Mesh } from 'three';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { clientPlugin } from '../client/index.ts';
import { createLavaFlow, FLOW_RADIUS_CELLS, LAVA_HOVER_HEIGHT } from '../client/lavaFlow.ts';

const WORLD_SIZE = 128;
const DT = 0.1;
const SITE = { x: 32, y: 32 };

function mount() {
  const layer = new Group();
  const messages = new Map<string, (payload: unknown) => void>();
  const frames = new Set<(dt: number) => void>();
  const terrain = new Set<(dirty: ReadonlySet<number>) => void>();
  const resets = new Set<() => void>();
  let ground = 1;
  const ctx: Pick<ClientPluginCtx, 'layer' | 'worldSize' | 'drawnGroundYAt' | 'onMessage' | 'onFrame' | 'onTerrainChanged' | 'onWorldReset'> = {
    layer, worldSize: () => WORLD_SIZE, drawnGroundYAt: () => ground,
    onMessage(type, handler) { messages.set(type, handler); return () => { messages.delete(type); }; },
    onFrame(handler) { frames.add(handler); return () => { frames.delete(handler); }; },
    onTerrainChanged(handler) { terrain.add(handler); return () => { terrain.delete(handler); }; },
    onWorldReset(handler) { resets.add(handler); return () => { resets.delete(handler); }; },
  };
  clientPlugin.attach(ctx as ClientPluginCtx);
  const lava = layer.getObjectByName('volcanoes:flow:crust') as Mesh;
  const plume = layer.getObjectByName('volcanoes:plume:particles') as InstancedMesh;
  return {
    lava, plume, frames, terrain, resets, messages,
    setGround(value: number) { ground = value; },
    send(x = SITE.x, y = SITE.y): void {
      messages.get('all')!({ vents: [{ id: 1, x, y, erupting: true }], lava: [{ x, y, ageSeconds: 0 }] });
    },
    frame(): void { for (const frame of frames) frame(DT); },
  };
}

function activeHeights(mesh: Mesh, maxX = Infinity): number[] {
  const positions = mesh.geometry.getAttribute('position');
  const strength = mesh.geometry.getAttribute('aStrength');
  const heights = new Set<number>();
  for (let vertex = 0; vertex < mesh.geometry.drawRange.count; vertex++) {
    if (strength.getX(vertex) > 0 && positions.getX(vertex) < maxX) heights.add(positions.getY(vertex));
  }
  return [...heights];
}

export function clearsWorldSynchronously(): void {
  const h = mount();
  try {
    h.send(); h.frame();
    assert(h.lava.geometry.drawRange.count > 0 && h.plume.count > 0);
    const geometry = h.lava.geometry, material = h.lava.material;
    const plumeGeometry = h.plume.geometry, plumeMaterial = h.plume.material;
    assert.equal(h.resets.size, 1);
    for (const reset of h.resets) reset();
    assert.equal(h.lava.geometry.drawRange.count, 0);
    assert.equal(h.plume.count, 0);
    h.frame();
    assert.equal(h.lava.geometry.drawRange.count, 0);
    assert.equal(h.plume.count, 0);
    h.send(80, 80); h.frame();
    assert.equal(h.lava.geometry, geometry);
    assert.equal(h.lava.material, material);
    assert.equal(h.plume.geometry, plumeGeometry);
    assert.equal(h.plume.material, plumeMaterial);
    assert.equal(h.plume.instanceMatrix.array[12], 80 * CELL_WORLD_SIZE);
    assert.equal(h.plume.instanceMatrix.array[14], 80 * CELL_WORLD_SIZE);
  } finally { clientPlugin.dispose?.(); }
  assert.equal(h.resets.size + h.frames.size + h.terrain.size + h.messages.size, 0);
}

export function followsChangedGround(): void {
  const h = mount();
  try {
    h.send(); h.frame();
    h.setGround(2);
    const edge = WORLD_SIZE / CHUNK_SIZE;
    const dirty = new Set<number>();
    for (let cy = Math.floor((SITE.y - FLOW_RADIUS_CELLS) / CHUNK_SIZE); cy <= Math.floor((SITE.y + FLOW_RADIUS_CELLS) / CHUNK_SIZE); cy++) {
      for (let cx = Math.floor((SITE.x - FLOW_RADIUS_CELLS) / CHUNK_SIZE); cx <= Math.floor((SITE.x + FLOW_RADIUS_CELLS) / CHUNK_SIZE); cx++) dirty.add(cy * edge + cx);
    }
    for (const terrain of h.terrain) terrain(dirty);
    h.frame();
    const heights = activeHeights(h.lava);
    assert(heights.length > 0 && heights.every(y => Math.abs(y - (2 + LAVA_HOVER_HEIGHT)) < 1e-6));
    assert.equal(h.plume.instanceMatrix.array[13], 2);
  } finally { clientPlugin.dispose?.(); }
}

export function refreshesGroundAcrossChunkSeams(): void {
  const flow = createLavaFlow();
  const mesh = flow.root.children[0] as Mesh;
  const near = { x: CHUNK_SIZE - 1, y: CHUNK_SIZE - 1, ageSeconds: 0 };
  const far = { x: 80, y: 80, ageSeconds: 0 };
  const queries: number[] = [];
  let nearGround: number | null = 1;
  const groundAt = (x: number): number | null => { queries.push(x); return x < 2 * CHUNK_SIZE ? nearGround : 1; };
  const diagonalChunk = new Set([WORLD_SIZE / CHUNK_SIZE + 1]);
  try {
    flow.replaceAll([near, far], 0, groundAt);
    queries.length = 0;
    nearGround = null;
    flow.refreshGround(diagonalChunk, WORLD_SIZE, groundAt);
    assert(flow.pendingGround);
    assert(queries.every(x => x < 2 * CHUNK_SIZE), 'unrelated flow must not be resampled');
    nearGround = 2;
    flow.refreshGround(diagonalChunk, WORLD_SIZE, groundAt);
    assert.equal(flow.pendingGround, false);
    const positions = mesh.geometry.getAttribute('position') as BufferAttribute;
    const strengths = mesh.geometry.getAttribute('aStrength');
    const seamX = near.x * CELL_WORLD_SIZE - CELL_WORLD_SIZE / 2;
    const seamZ = near.y * CELL_WORLD_SIZE - CELL_WORLD_SIZE / 2;
    assert(Array.from({ length: mesh.geometry.drawRange.count }, (_, vertex) => vertex).some(vertex =>
      strengths.getX(vertex) > 0 && positions.getX(vertex) === seamX && positions.getZ(vertex) === seamZ &&
      Math.abs(positions.getY(vertex) - (2 + LAVA_HOVER_HEIGHT)) < 1e-6));
    const uploadedVersion = positions.version;
    flow.refreshGround(diagonalChunk, WORLD_SIZE, groundAt);
    assert.equal(positions.version, uploadedVersion, 'unchanged ground must not upload geometry');
    flow.clear();
    assert.equal(flow.pendingGround, false);
    assert.equal(mesh.geometry.drawRange.count, 0);
  } finally { flow.dispose(); }
}
