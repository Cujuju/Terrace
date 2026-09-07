// The frontier line: a red thread laid on the ground wherever revealed
// territory ends at a chunk that could still be opened.
//
// WHY IT EXISTS (owner, 2026-09-06). Since issue #22 the terrain simply runs
// flat to the reveal boundary and stops — no cliff, no seam — and the mist
// bank that used to mark it is off by default because it read as a wall. So
// nothing at all showed where a player's territory ended, and a sculpt aimed
// at the frontier was aimed at an unmarked line: whether the brush reached
// across was invisible before the click and unexplained after it. This is the
// replacement the owner asked for — "draw a red line where that frontier mist
// border is" — and it is a MARKER, not a veil: it hides nothing and stands
// no height.
//
// ONLY WHERE THERE IS SOMETHING TO OPEN. `frontierEdges` includes the world's
// own outer rim, which is a frontier by its rule and an opportunity by no
// rule at all — no chunk exists past it, so no sculpt can ever open it.
// Drawing the same red there would promise ground that does not exist, so the
// rim is skipped (neighbourChunkIndex is the one test, shared with the edge
// derivation itself).
//
// ONE DRAW CALL, REBUILT WHOLE. The mist bank packs its segments into
// super-meshes because it carries FOG_ROW_COUNT × FOG_COLUMNS vertices per
// edge and grows with how much of the world has been revealed (GH #73). A
// line carries CHUNK_SIZE + 1 points per edge — a fortieth of that — so the
// whole frontier fits in one LineSegments and one buffer rewrite, and there
// is no packing, no slot bookkeeping and no per-edge diffing to keep correct.
// The buffer grows by doubling and never shrinks, so a steady frontier
// rewrites in place and allocates nothing.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  Sphere,
  Vector3,
  type Object3D,
} from 'three';
import { CHUNK_SIZE, SEA_LEVEL, chunksPerEdge } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE, WORLD_UNIT_HEIGHT_UNITS } from '../config.ts';
import {
  frontierEdgeSampling,
  frontierEdges,
  neighbourChunkIndex,
  type FrontierEdge,
} from '../terrain/frontier.ts';
import { sampleHeight, type TerrainMirror } from '../terrain/mirror.ts';

/**
 * The colour of the boundary. Owner's word, 2026-09-06: red — the one hue
 * nothing else in this world wears, so the line cannot be read as terrain,
 * water, a terrace lip or a plugin's own marker.
 */
const FRONTIER_LINE_COLOR = 0xe03127;

/**
 * How far the thread floats above the ground it traces, in height units.
 *
 * An eighth of a world unit: enough that it never z-fights the cap it lies
 * on at any camera distance, small enough that it still reads as lying ON the
 * ground rather than hovering over it. Measured in world units rather than
 * bands for the reason FOG_BANK_RISE is (frontierFog.ts): "sits on the
 * ground" is a fact about the world, not about the render quantum.
 */
const FRONTIER_LINE_LIFT = WORLD_UNIT_HEIGHT_UNITS / 8;

/** Lattice points along one chunk side — one per cell boundary, as the mist bank has. */
const POINTS_PER_EDGE = CHUNK_SIZE + 1;

/** Line segments per edge, each two vertices of three components. */
const VERTICES_PER_EDGE = (POINTS_PER_EDGE - 1) * 2;
const POSITION_COMPONENTS_PER_VERTEX = 3;

/** Edges the buffer is born sized for, and the unit it doubles from. */
const INITIAL_EDGE_CAPACITY = 64;

export interface FrontierLine {
  /** Shows or hides the line. Geometry stays maintained while hidden. */
  setVisible(visible: boolean): void;
  /**
   * Rebuilds from the mirror's CURRENT received set. Call after every event
   * that can change which chunks are received — a join snapshot, a chunkUnlock.
   */
  sync(mirror: TerrainMirror): void;
  /**
   * Re-traces the ground under the line where heights moved. Call after every
   * event that changes HEIGHTS without changing `received`, so a sculpt at the
   * boundary carries the line with it.
   *
   * `dirtyChunks` is the same dirty set the terrain meshes were just patched
   * with; the rebuild is whole and cheap, so this only decides WHETHER to run,
   * never which part to run.
   */
  refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void;
  /** Frontier edges currently drawn — the openable ones, not every edge. */
  edgeCount(): number;
  /** Draw calls with nothing culled, so a test can hold a budget against it. */
  drawCallCount(): number;
  dispose(): void;
}

export function createFrontierLine(parent: Object3D): FrontierLine {
  const material = new LineBasicMaterial({ color: new Color(FRONTIER_LINE_COLOR) });
  let capacity = INITIAL_EDGE_CAPACITY;
  let positions = new Float32Array(capacity * VERTICES_PER_EDGE * POSITION_COMPONENTS_PER_VERTEX);
  let attribute = new BufferAttribute(positions, POSITION_COMPONENTS_PER_VERTEX);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', attribute);
  geometry.setDrawRange(0, 0);
  // The bounding sphere is set by hand on every rebuild (see below), so three
  // never computes one from a buffer whose tail is stale.
  geometry.boundingSphere = new Sphere(new Vector3(), 0);

  const line = new LineSegments(geometry, material);
  line.frustumCulled = false;
  // Hidden until the pref is applied, for the reason frontierFog starts
  // hidden: world.ts drives the mode through an effect that Solid flushes a
  // microtask later, and a layer the player turned off must not flash first.
  line.visible = false;
  parent.add(line);

  /** Edges drawn by the last rebuild, so `refresh` knows whether one is worth doing. */
  let drawnEdges: FrontierEdge[] = [];

  const grow = (edges: number): void => {
    if (edges <= capacity) return;
    while (capacity < edges) capacity *= 2;
    positions = new Float32Array(capacity * VERTICES_PER_EDGE * POSITION_COMPONENTS_PER_VERTEX);
    attribute = new BufferAttribute(positions, POSITION_COMPONENTS_PER_VERTEX);
    geometry.setAttribute('position', attribute);
  };

  /**
   * Ground height at lattice point k of an edge, in height units.
   *
   * The HIGHER of the two border cells the point sits between, so the line
   * rides on top of whichever cap actually ends there rather than sinking into
   * it — the same rule the mist bank's opaque row follows. Never below the
   * waterline: ground under the sea is drawn as sea, and a thread traced along
   * the seabed would be hidden under the water plane exactly where the player
   * most needs to see the boundary.
   */
  const groundAt = (mirror: TerrainMirror, edge: FrontierEdge, k: number): number => {
    const s = frontierEdgeSampling(edge);
    const left = k - 1 < 0 ? 0 : k - 1;
    const right = k >= CHUNK_SIZE ? CHUNK_SIZE - 1 : k;
    const a = sampleHeight(mirror, s.cellX + left * s.cellStepX, s.cellY + left * s.cellStepY);
    const b = sampleHeight(mirror, s.cellX + right * s.cellStepX, s.cellY + right * s.cellStepY);
    const higher = a > b ? a : b;
    return higher > SEA_LEVEL ? higher : SEA_LEVEL;
  };

  /** Writes every drawn edge's points into the buffer and sizes the draw range. */
  const write = (mirror: TerrainMirror): void => {
    grow(drawnEdges.length);

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let p = 0;

    for (const edge of drawnEdges) {
      const s = frontierEdgeSampling(edge);
      // Each lattice point is written twice — once ending the previous
      // segment, once starting the next — because LineSegments draws
      // independent pairs. One shared strip would have joined this edge to
      // the next unrelated edge in the buffer.
      let prevX = 0;
      let prevY = 0;
      let prevZ = 0;
      for (let k = 0; k < POINTS_PER_EDGE; k++) {
        const x = (s.lineX + k * s.lineStepX) * CELL_WORLD_SIZE;
        const y = (groundAt(mirror, edge, k) + FRONTIER_LINE_LIFT) * HEIGHT_WORLD_SCALE;
        const z = (s.lineZ + k * s.lineStepZ) * CELL_WORLD_SIZE;
        if (k > 0) {
          positions[p++] = prevX;
          positions[p++] = prevY;
          positions[p++] = prevZ;
          positions[p++] = x;
          positions[p++] = y;
          positions[p++] = z;
        }
        prevX = x;
        prevY = y;
        prevZ = z;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }

    attribute.needsUpdate = true;
    geometry.setDrawRange(0, drawnEdges.length * VERTICES_PER_EDGE);
    const sphere = geometry.boundingSphere ?? new Sphere();
    if (drawnEdges.length === 0) {
      sphere.center.set(0, 0, 0);
      sphere.radius = 0;
    } else {
      sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      sphere.radius = sphere.center.distanceTo(new Vector3(maxX, maxY, maxZ));
    }
    geometry.boundingSphere = sphere;
  };

  return {
    setVisible(visible: boolean): void {
      line.visible = visible;
    },

    sync(mirror: TerrainMirror): void {
      const cols = chunksPerEdge(mirror.map.size);
      drawnEdges = frontierEdges(mirror.received, cols).filter(
        (edge) => neighbourChunkIndex(edge, cols) !== null,
      );
      write(mirror);
    },

    refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void {
      if (drawnEdges.length === 0 || dirtyChunks.size === 0) return;
      const cols = chunksPerEdge(mirror.map.size);
      const touched = drawnEdges.some((edge) => dirtyChunks.has(edge.cy * cols + edge.cx));
      if (!touched) return;
      write(mirror);
    },

    edgeCount(): number {
      return drawnEdges.length;
    },

    drawCallCount(): number {
      return drawnEdges.length === 0 ? 0 : 1;
    },

    dispose(): void {
      parent.remove(line);
      geometry.dispose();
      material.dispose();
      drawnEdges = [];
    },
  };
}
