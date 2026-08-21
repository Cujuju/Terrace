// Mesh-management tests. These construct real Three.js geometries but never a
// WebGLRenderer, so they run headless — BufferGeometry, BufferAttribute and
// Mesh are plain data structures. Actual rendering is verified manually
// (design doc §8 "Testing").

import { describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  Group,
  ShaderLib,
  type BufferGeometry,
  type Material,
  type MeshStandardMaterial,
} from 'three';
import { BAND_HEIGHT, CHUNK_SIZE, chunkIndex, type ChunkPayload } from '@terrace/shared';
import {
  applySnapshot,
  applyTerrainDiff,
  createTerrainMirror,
} from '../src/terrain/mirror.ts';
import {
  CHUNK_BUILD_FRAME_BUDGET_MS,
  createTerrainMeshes,
} from '../src/render/terrainMeshes.ts';
import {
  INITIAL_CHUNK_TRIANGLE_CAPACITY,
  VERTICES_PER_TRIANGLE,
} from '../src/terrain/vertexGrid.ts';
import { BAND_WORLD_HEIGHT } from '../src/config.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
/**
 * A chunk with one band and no contour is two triangles: its whole domain, at
 * that band's height. That is the smallest geometry the builder can emit, and
 * the draw range has to cut everything after it.
 */
const FLAT_CHUNK_VERTEX_COUNT = 2 * VERTICES_PER_TRIANGLE;

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

/**
 * `getAttribute` is typed as BufferAttribute | InterleavedBufferAttribute.
 * Chunk geometries only ever use the plain kind, so narrow once here rather
 * than casting at every assertion.
 */
function plainAttribute(geometry: BufferGeometry, name: string): BufferAttribute {
  const attribute = geometry.getAttribute(name);
  if (!(attribute instanceof BufferAttribute)) {
    throw new Error(`expected a plain BufferAttribute for "${name}"`);
  }
  return attribute;
}

function setup(chunks: ChunkPayload[]) {
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const meshes = createTerrainMeshes(group, mirror);
  meshes.update(
    applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks }),
  );
  return { mirror, group, meshes };
}

describe('createTerrainMeshes', () => {
  it('creates one mesh per received chunk and none for locked chunks', () => {
    const { group, meshes } = setup([chunkPayload(0, 0, 100), chunkPayload(1, 0, 100)]);
    expect(group.children).toHaveLength(2);
    expect(meshes.pickables()).toHaveLength(2);
  });

  it('ignores dirty indices for chunks that were never received', () => {
    // This is how locked terrain stays invisible: a diff may name a chunk we
    // do not hold, and it must not conjure a mesh for it.
    const { group, meshes, mirror } = setup([chunkPayload(0, 0, 100)]);
    expect(group.children).toHaveLength(1);

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 40, y: 40, h: 500 }],
      }),
    );
    expect(group.children).toHaveLength(1);
  });

  it('patches vertex buffers IN PLACE, never rebuilding geometry', () => {
    // The client performance contract (design doc §8). If any of these object
    // identities change, an edit is reallocating GPU resources per sculpt —
    // and this still has to hold now that the emitted triangle count VARIES
    // widely with the terrain, which is exactly what the working-capacity
    // strategy buys (a chunk only ever rebinds when it outgrows its buffers,
    // and this edit is nowhere near that).
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);

    const mesh = meshes.pickables()[0];
    const geometryBefore = mesh.geometry;
    const positionBefore = plainAttribute(mesh.geometry, 'position');
    const normalBefore = plainAttribute(mesh.geometry, 'normal');
    const colorBefore = plainAttribute(mesh.geometry, 'color');
    const positionArrayBefore = positionBefore.array;
    const normalArrayBefore = normalBefore.array;
    // `needsUpdate` on a BufferAttribute is a setter with no getter — reading
    // it yields undefined. `version`, which it increments, is the observable
    // that actually drives the GPU re-upload.
    const positionVersionBefore = positionBefore.version;
    const normalVersionBefore = normalBefore.version;
    const colorVersionBefore = colorBefore.version;

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 256 }],
      }),
    );

    expect(group.children).toHaveLength(1);
    expect(mesh.geometry).toBe(geometryBefore);
    expect(mesh.geometry.getAttribute('position')).toBe(positionBefore);
    expect(mesh.geometry.getAttribute('normal')).toBe(normalBefore);
    expect(mesh.geometry.getAttribute('color')).toBe(colorBefore);
    // Same backing typed arrays — rewritten, not replaced.
    expect(mesh.geometry.getAttribute('position').array).toBe(positionArrayBefore);
    expect(mesh.geometry.getAttribute('normal').array).toBe(normalArrayBefore);

    // And every attribute was flagged for re-upload, or the GPU would keep
    // showing the stale buffer.
    expect(positionBefore.version).toBeGreaterThan(positionVersionBefore);
    expect(normalBefore.version).toBeGreaterThan(normalVersionBefore);
    expect(colorBefore.version).toBeGreaterThan(colorVersionBefore);
  });

  it('builds non-indexed geometry, so every triangle keeps its own crease', () => {
    // Flat shading needs unshared vertices at every cap/skirt boundary, so no
    // vertex is ever reused — an index buffer that never shares is pure
    // overhead, and there is none.
    const { meshes } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 300)]);
    for (const mesh of meshes.pickables()) {
      expect(mesh.geometry.getIndex()).toBeNull();
    }
  });

  it('gives each chunk its OWN normals, since skirt normals differ per chunk', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 300)]);
    const [first, second] = meshes.pickables();
    expect(first.geometry.getAttribute('normal')).not.toBe(
      second.geometry.getAttribute('normal'),
    );
  });

  it('draws only the emitted prefix of the buffers', () => {
    // A flat chunk is two triangles; the draw range must cut the rest of the
    // capacity rather than rasterising it. On non-indexed geometry the range
    // counts vertices.
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const geometry = meshes.pickables()[0].geometry;
    expect(geometry.drawRange.start).toBe(0);
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_VERTEX_COUNT);
    expect(geometry.drawRange.count).toBeLessThan(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
  });

  it('grows and shrinks the draw range as sculpting adds and removes terraces', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const geometry = meshes.pickables()[0].geometry;
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_VERTEX_COUNT);

    // Raising one interior cell four bands cuts a stepped column around it.
    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 256 }],
      }),
    );
    const raised = geometry.drawRange.count;
    expect(raised).toBeGreaterThan(FLAT_CHUNK_VERTEX_COUNT);
    expect(raised).toBeLessThanOrEqual(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );

    // Level it again and the column — and the range — go away.
    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 0 }],
      }),
    );
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_VERTEX_COUNT);
  });

  it('writes the new height into the patched chunk', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        // Four bands up — the assertion below reads this as a band count, so it
        // must be stated as one (it was the literal 256, four bands only at 64).
        cells: [{ x: 2, y: 3, h: 4 * BAND_HEIGHT }],
      }),
    );

    // Somewhere in the live range there is now a cap at four bands up — the
    // top of the column the sculpt raised.
    const position = mesh.geometry.getAttribute('position');
    let highest = -Infinity;
    for (let v = 0; v < mesh.geometry.drawRange.count; v++) {
      highest = Math.max(highest, position.getY(v));
    }
    expect(highest).toBeCloseTo(4 * BAND_WORLD_HEIGHT);
  });

  it('refreshes the bounding sphere so edited chunks stay pickable', () => {
    // A stale bound makes a raised mountain fail both frustum culling and the
    // raycaster's sphere test — it would vanish and stop being clickable.
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];
    const radiusBefore = mesh.geometry.boundingSphere?.radius ?? 0;

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 8, y: 8, h: 1024 }],
      }),
    );

    expect(mesh.geometry.boundingSphere?.radius ?? 0).toBeGreaterThan(radiusBefore);
  });

  it('keeps the bounding sphere tight around a distant chunk', () => {
    // The unused tail is collapsed onto a vertex inside the chunk precisely so
    // that computeBoundingSphere — which ignores the draw range — cannot be
    // dragged back toward the world origin by dead vertices.
    const { meshes } = setup([chunkPayload(3, 3, 0)]);
    const sphere = meshes.pickables()[0].geometry.boundingSphere;
    // A 16×16 flat chunk: half-diagonal of a 16-cell square is ~11.3.
    expect(sphere?.radius ?? 0).toBeLessThan(CHUNK_SIZE);
    expect(sphere?.center.x ?? 0).toBeGreaterThan(WORLD - CHUNK_SIZE - 1);
  });

  it('adds a mesh when a chunk is unlocked later', () => {
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);
    expect(group.children).toHaveLength(1);

    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, 300)],
    });
    meshes.update(dirty);

    expect(group.children).toHaveLength(2);
    // The pre-existing neighbour was re-patched too, so the terrace that now
    // runs up to the seam is rebuilt against the newly revealed heights.
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
    const left = meshes.pickables()[0];
    expect(left.geometry.drawRange.count).toBeGreaterThan(FLAT_CHUNK_VERTEX_COUNT);
  });

  it('rebinds attributes when a chunk outgrows its buffers, keeping one geometry', () => {
    // Growth is the one path that reallocates. It must swap in fresh
    // attributes, dispose the geometry it replaced, and leave the mesh in the
    // scene exactly once.
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];
    const positionBefore = plainAttribute(mesh.geometry, 'position');

    // A chunk-wide hill: several bands of contour, past the starting capacity.
    const cells = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        cells.push({ x, y, h: Math.round(360 - 3 * ((x - 8) ** 2 + (y - 8) ** 2)) });
      }
    }
    meshes.update(applyTerrainDiff(mirror, { type: 'terrainDiff', cells }));

    expect(group.children).toHaveLength(1);
    expect(meshes.pickables()[0]).toBe(mesh);
    expect(mesh.geometry.getAttribute('position')).not.toBe(positionBefore);
    expect(mesh.geometry.drawRange.count).toBeGreaterThan(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
    expect(mesh.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(
      mesh.geometry.drawRange.count,
    );
  });

  // -------------------------------------------------------------------------
  // SELF-LIT SEABED RIMS (owner, 2026-08-14). The geometry builder flags the
  // underwater cut faces (asserted in vertexGrid.test.ts); this is the other
  // half of that contract — the material has to be wired to honour the flag,
  // and the wiring is a string patch against three's stock shader, which is
  // exactly the kind of thing that fails silently on a dependency upgrade.
  // -------------------------------------------------------------------------

  /** The one shader-patching material every chunk mesh shares. */
  function terrainMaterial(mesh: { material: Material | Material[] }): MeshStandardMaterial {
    const material = mesh.material;
    if (Array.isArray(material)) throw new Error('expected a single material');
    return material as MeshStandardMaterial;
  }

  it('binds the self-lit flag as a normalised one-byte attribute', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const attribute = plainAttribute(meshes.pickables()[0].geometry, 'selfLit');
    expect(attribute.itemSize).toBe(1);
    // Normalised, so the builder's 0/255 bytes arrive in the shader as 0.0/1.0
    // and the injected mix() needs no scaling of its own.
    expect(attribute.normalized).toBe(true);
    expect(attribute.array).toBeInstanceOf(Uint8Array);
    expect(attribute.count).toBe(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
  });

  it('re-uploads and rebinds the flag alongside the other attributes', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];
    const before = plainAttribute(mesh.geometry, 'selfLit');
    const versionBefore = before.version;

    meshes.update(
      applyTerrainDiff(mirror, { type: 'terrainDiff', cells: [{ x: 2, y: 3, h: 256 }] }),
    );
    expect(plainAttribute(mesh.geometry, 'selfLit')).toBe(before);
    expect(before.version).toBeGreaterThan(versionBefore);

    // And on the growth path it must be replaced too, or the flags would keep
    // addressing the old, shorter buffer.
    const cells = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        cells.push({ x, y, h: Math.round(360 - 3 * ((x - 8) ** 2 + (y - 8) ** 2)) });
      }
    }
    meshes.update(applyTerrainDiff(mirror, { type: 'terrainDiff', cells }));
    const grown = plainAttribute(mesh.geometry, 'selfLit');
    expect(grown).not.toBe(before);
    expect(grown.count).toBeGreaterThanOrEqual(mesh.geometry.drawRange.count);
  });

  it('patches the terrain shader so a flagged vertex is shaded unlit', () => {
    // Run the material's own onBeforeCompile over three's REAL stock shader for
    // MeshStandardMaterial. This is the regression guard: if a three upgrade
    // moves the anchors, the patch must not quietly no-op and leave every
    // underwater outline dark again.
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const material = terrainMaterial(meshes.pickables()[0]);
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
    };
    material.onBeforeCompile(shader as never, null as never);

    expect(shader.vertexShader).toContain('attribute float selfLit;');
    expect(shader.vertexShader).toContain('vSelfLit = selfLit;');
    expect(shader.fragmentShader).toContain('varying float vSelfLit;');
    // The mix has to sit BEFORE <opaque_fragment>, where outgoingLight is
    // already assembled and tone mapping, colour space and fog have not run —
    // a rim must still fog with distance, it just must not go dark for facing
    // away from the sun.
    const mixAt = shader.fragmentShader.indexOf(
      'outgoingLight = mix( outgoingLight, diffuseColor.rgb, vSelfLit );',
    );
    const opaqueAt = shader.fragmentShader.indexOf('#include <opaque_fragment>');
    const fogAt = shader.fragmentShader.indexOf('#include <fog_fragment>');
    expect(mixAt).toBeGreaterThan(-1);
    expect(mixAt).toBeLessThan(opaqueAt);
    expect(opaqueAt).toBeLessThan(fogAt);
  });

  it('refuses to silently no-op when three moves an anchor', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const material = terrainMaterial(meshes.pickables()[0]);
    expect(() =>
      material.onBeforeCompile(
        { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: '' } as never,
        null as never,
      ),
    ).toThrow(/shader patch failed/);
  });

  it('drops every mesh on clear', () => {
    const { meshes, group } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 0)]);
    meshes.clear();
    expect(group.children).toHaveLength(0);
    expect(meshes.pickables()).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// MULTI-FRAME MESHING (issue #47). The tests above all run the no-scheduler
// path, which drains inside `update` — that is the documented behaviour when
// there is no frame loop to defer to, and it is what keeps them meaningful as
// tests of the BUILDER. These drive the other path: a fake frame hook and a
// fake clock, so "how much did this frame do" is asserted rather than raced.
// -----------------------------------------------------------------------------

/**
 * A frame loop under the test's control, plus the clock the drain budget is
 * measured against.
 *
 * `costPerBuildMs` is how far the clock jumps each time the builder reads it.
 * `now` is read twice per build (once before the first, once after each), so a
 * cost at or above the budget makes every build the frame's last — which is how
 * a "this chunk is heavier than the whole budget" frame is simulated without
 * needing terrain that actually takes that long.
 */
function fakeScheduler(costPerBuildMs: number) {
  const handlers = new Set<(dt: number) => void>();
  let clockMs = 0;
  return {
    scheduling: {
      onFrame(handler: (dt: number) => void): () => void {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      now: (): number => {
        const read = clockMs;
        clockMs += costPerBuildMs;
        return read;
      },
    },
    frame(): void {
      for (const handler of handlers) handler(1 / 60);
    },
    handlerCount: (): number => handlers.size,
  };
}

function scheduledSetup(chunks: ChunkPayload[], costPerBuildMs: number) {
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const clock = fakeScheduler(costPerBuildMs);
  const meshes = createTerrainMeshes(group, mirror, clock.scheduling);
  const dirty = applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks });
  meshes.update(dirty);
  return { mirror, group, meshes, clock };
}

describe('multi-frame chunk meshing', () => {
  const FOUR_CHUNKS = [
    chunkPayload(0, 0, 100),
    chunkPayload(1, 0, 100),
    chunkPayload(0, 1, 100),
    chunkPayload(1, 1, 100),
  ];

  it('builds nothing until a frame runs', () => {
    const { group, meshes } = scheduledSetup(FOUR_CHUNKS, 0);
    expect(meshes.pendingCount()).toBe(4);
    expect(group.children).toHaveLength(0);
  });

  it('drains the whole queue in one frame when the work fits the budget', () => {
    const { group, meshes, clock } = scheduledSetup(FOUR_CHUNKS, 0);
    clock.frame();
    expect(group.children).toHaveLength(4);
    expect(meshes.pendingCount()).toBe(0);
  });

  it('spreads the queue across frames when it does not', () => {
    // Every build costs the whole budget, so each frame gets exactly one.
    const { group, meshes, clock } = scheduledSetup(
      FOUR_CHUNKS,
      CHUNK_BUILD_FRAME_BUDGET_MS,
    );
    for (let built = 1; built <= 4; built++) {
      clock.frame();
      expect(group.children).toHaveLength(built);
      expect(meshes.pendingCount()).toBe(4 - built);
    }
    // And it stops once there is nothing left rather than spinning.
    clock.frame();
    expect(group.children).toHaveLength(4);
  });

  it('always builds at least one chunk per frame, however over budget it is', () => {
    // FORWARD PROGRESS. A chunk costing many times the budget must still be
    // built, or the queue stalls on it forever and the terrain freezes behind
    // it. Ten times the budget per build, and a frame still makes progress.
    const { group, clock } = scheduledSetup(FOUR_CHUNKS, CHUNK_BUILD_FRAME_BUDGET_MS * 10);
    clock.frame();
    expect(group.children).toHaveLength(1);
  });

  it('keeps drawing the previous mesh while a rebuild is queued', () => {
    // The whole reason deferral is invisible: a chunk waiting its turn is
    // STALE, never absent. If it vanished for a frame the queue would read as
    // a flicker and the tradeoff would not be worth making.
    const { meshes, mirror, group, clock } = scheduledSetup(
      [chunkPayload(0, 0, 0)],
      CHUNK_BUILD_FRAME_BUDGET_MS,
    );
    clock.frame();
    const mesh = meshes.pickables()[0];
    const rangeBefore = mesh.geometry.drawRange.count;

    const cells = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        cells.push({ x, y, h: Math.round(360 - 3 * ((x - 8) ** 2 + (y - 8) ** 2)) });
      }
    }
    meshes.update(applyTerrainDiff(mirror, { type: 'terrainDiff', cells }));

    // Queued, not built: same mesh, still in the scene, still drawing the old
    // flat geometry.
    expect(meshes.pendingCount()).toBe(1);
    expect(group.children).toHaveLength(1);
    expect(meshes.pickables()[0]).toBe(mesh);
    expect(mesh.geometry.drawRange.count).toBe(rangeBefore);

    clock.frame();
    expect(mesh.geometry.drawRange.count).toBeGreaterThan(rangeBefore);
  });

  it('builds a chunk once however many times it was dirtied first', () => {
    // A held stroke re-dirties the same chunk ~8 times a second; the queue must
    // collapse that to one build against the newest heights.
    const { meshes, mirror, clock } = scheduledSetup([chunkPayload(0, 0, 0)], 0);
    clock.frame();

    for (let repeat = 0; repeat < 8; repeat++) {
      meshes.update(
        applyTerrainDiff(mirror, {
          type: 'terrainDiff',
          cells: [{ x: 4, y: 4, h: 100 + repeat }],
        }),
      );
    }
    expect(meshes.pendingCount()).toBe(1);
  });

  it('drops the queue when the world is replaced', () => {
    // Indices name chunks of the world being thrown away; draining them
    // against its replacement would build geometry nobody asked for.
    const { meshes } = scheduledSetup(FOUR_CHUNKS, 0);
    expect(meshes.pendingCount()).toBe(4);
    meshes.clear();
    expect(meshes.pendingCount()).toBe(0);
  });

  it('unsubscribes its frame handler on dispose', () => {
    // resetWorld disposes the old meshes and creates new ones on every rejoin,
    // so a handler that outlived its owner would accumulate one dead drain per
    // reconnect, each holding a whole world's meshes alive.
    const { meshes, clock } = scheduledSetup(FOUR_CHUNKS, 0);
    expect(clock.handlerCount()).toBe(1);
    meshes.dispose();
    expect(clock.handlerCount()).toBe(0);
  });

  it('flush builds everything regardless of budget', () => {
    const { group, meshes } = scheduledSetup(FOUR_CHUNKS, CHUNK_BUILD_FRAME_BUDGET_MS * 10);
    meshes.flush();
    expect(group.children).toHaveLength(4);
    expect(meshes.pendingCount()).toBe(0);
  });
});
