// The frontier mist: a soft, ground-hugging fog bank marking the edge of the
// player's revealed territory.
//
// WHY A SEPARATE LAYER FROM vertexGrid.ts's SKIRTS. That module's skirts stay
// exactly as they were — they are the terrace-cliff look INSIDE revealed
// territory, and the design record (2026-08-14) calls that the app's
// namesake silhouette. The frontier is different: since issue #22 the mesh
// builder samples never-received chunks through mirror.sampleRenderHeight,
// which pulls the sample back onto received terrain — so the terrain simply
// extends flat to the reveal boundary and stops, exactly like the world's
// outer border, and draws no cliff there at all. This module is the ONLY
// frontier treatment: a mist bank positioned from the mirror's `received` set
// (terrain/frontier.ts) that veils the raw cross-section where the terrain
// mesh ends.
//
// GEOMETRY (issue #22 — this REPLACES the original full-height curtain, which
// spanned MIN_HEIGHT..MAX_HEIGHT and read as a towering white wall). One quad
// strip per frontier edge (a whole chunk side), FOG_COLUMNS columns
// wide so it can follow the ground, three rows tall:
//
//   top    — a bank's height above the LOCAL ground, fully transparent;
//   knee   — a fraction of the bank above the ground, fully opaque;
//   base   — one flat row just below min(local terrain, sea level), fully
//            opaque, so the strip also veils the exposed cross-section between
//            the sea and a high cap's edge without ever showing a bottom hem.
//
// Each column's knee/top follow the heights of the border cells on the
// RECEIVED side of the edge, so the bank is scaled to the local terrain
// cross-section — a low haze over a beach, a taller veil where a plateau meets
// the frontier — never to the world's full height range.
//
// COLOUR. Base row is a lightened WATER_COLOR; the top row is VOID_HAZE_COLOR
// (both imported from where the scene already defines them — see their export
// comments), blended row to row, so the haze reads as weather between the sea
// and what lies beyond the map rather than as a painted wall.
//
// The top row used to be a lightened SKY_COLOR, back when everything outside
// the map was a flat sky-coloured background. Since issue #326 that is the
// celestial void — a near-black star field — and a pale top row against it
// read as a white wall standing at the world's edge, which is the exact
// failure this gradient exists to avoid. The top row is therefore NOT
// whitened at all: FOG_COLOR_WHITEN lifts the water end so it stays visible
// against the sea, while the top end matches the dark it dissolves into.
//
// LIFECYCLE. One shared, unlit MeshBasicMaterial (fog is atmospheric, not a
// lit surface — matching why water.ts's own translucent plane needs no
// per-face lighting either) and one Group. Each frontier edge is a SEGMENT,
// keyed by terrain/frontier.ts's frontierEdgeKey so `sync` can diff the
// previous edge set against the new one and add/remove exactly the segments
// that changed, in place, whatever event (join, chunk unlock, rejoin at a new
// world size) triggered it. Because the geometry depends on HEIGHTS as well as
// the edge set, surviving segments are rewritten in place (same buffers —
// attribute rewrite only) by `sync`, and `refresh` does the same for terrain
// diffs — see the interface docs.
//
// A SEGMENT IS NOT A DRAW CALL (2026-08-22, GH #73). It used to be: one Mesh
// per frontier edge, measured on a live world at 88 meshes drawing 6 656
// triangles through ONE shared material — 76 triangles a draw call, the worst
// ratio in the scene, and it grows with how much of the world has been
// revealed rather than with what is on screen. Segments are now packed into
// SUPER-MESHES on exactly the chunk-grid blocks terrainMeshes.ts merges on
// (SUPER_MESH_SPAN_CHUNKS, imported rather than re-chosen: the two layers
// cover the same ground and should cull at the same granularity, and there is
// one knob to turn if either becomes the bottleneck). The frontier is a RING,
// so it only ever touches the blocks it passes through — that same live world
// becomes a handful of draw calls.
//
// PACKING IS TRIVIAL HERE, unlike terrain's. Every segment has exactly the
// same vertex count (FOG_ROW_COUNT × FOG_COLUMNS) and the same index topology,
// because a segment is always one whole chunk side. So a super-mesh is a plain
// array of FIXED-STRIDE slots: adding is an append, removing is a swap with
// the last live slot, and the index buffer — the template offset once per slot
// — never changes except when capacity grows. No packing splice, no per-chunk
// offset bookkeeping, no draw range that has to be recomputed from run
// lengths; the draw range is just liveSegments × INDICES_PER_SEGMENT.
//
// ANIMATION. A single slow "opacity breathing" driven by the shared
// material's own `opacity`, via the render loop's onFrame hook
// (render/scene.ts) — gentle and global rather than per-vertex, because the
// alpha shape baked into each segment's vertex colours already encodes the
// soft top falloff; breathing only needs to scale it uniformly over time. See
// FOG_BREATH_* below for the rate and why it is nowhere near the 3 Hz
// photosensitivity ceiling other plugins cite.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Sphere,
  Vector3,
  type Object3D,
} from 'three';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL, chunksPerEdge } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE, WORLD_UNIT_HEIGHT_UNITS } from '../config.ts';
import {
  frontierEdgeKey,
  frontierEdges,
  type FrontierEdge,
} from '../terrain/frontier.ts';
import { sampleHeight, type TerrainMirror } from '../terrain/mirror.ts';
import { SUPER_MESH_SPAN_CHUNKS } from './terrainMeshes.ts';
import { VOID_HAZE_COLOR } from './celestialVoid.ts';
import { WATER_COLOR } from './water.ts';

// ---------------------------------------------------------------------------
// Shape: the bank profile every segment shares.
// ---------------------------------------------------------------------------

/**
 * How far the bank rises above the local ground, in height units. A world unit
 * and a quarter: tall enough that the flat cap ending at the boundary is veiled
 * with margin even where the ground sample under a column sits a little below
 * the cap's own band floor, low enough to read as a bank of mist lying on the
 * ground rather than a wall standing on it.
 *
 * A WORLD UNIT AND A QUARTER, NOT A BAND AND A QUARTER (2026-08-20; restated
 * in world units 2026-08-21, when the cell stopped being one). Both readings
 * named the same 80 height units while a band WAS a world unit, and the
 * sentence above is the tell for which one is the real constraint: "reads as mist lying
 * on the ground rather than a wall" is a statement about the world, not about
 * the render quantum. Left band-relative, the re-terrace would have thinned
 * the mist to a quarter of the height it was tuned at. The veiling margin the
 * first clause asks for is a band-scale quantity and so it only got easier to
 * clear, never harder.
 */
const FOG_BANK_RISE = WORLD_UNIT_HEIGHT_UNITS * 1.25;

/**
 * Fraction of FOG_BANK_RISE the bank stays fully opaque above the ground
 * before fading to nothing at the top. Just under half: most of the bank's
 * height is fade, which is what makes the upper edge dissolve instead of
 * ending in a visible hem.
 */
const FOG_BANK_KNEE = 0.45;

/**
 * How far the base row sits BELOW the sea surface, in height units. The base
 * anchors at the WATERLINE, not at the local seabed: the sea plane and this
 * material both skip the depth buffer, so a bank anchored at a deep seabed
 * renders its whole underwater span as a bright veil THROUGH the water —
 * the towering-wall look all over again, just submerged (found in the #22
 * screenshot pass). Half a band below the surface buries the bottom hem so
 * no camera angle can peek under the bank, while everything deeper stays the
 * water plane's own business.
 *
 * Half a WORLD UNIT since 2026-08-20, for the same reason FOG_BANK_RISE is
 * measured that way: "no camera angle can peek under the bank" is a world-space
 * fact about the hem, and the two ends of one profile must not rescale
 * differently.
 */
const FOG_BASE_DROP = WORLD_UNIT_HEIGHT_UNITS / 2;

/**
 * Peak alpha (the base and knee rows), before the breathing modulation below
 * scales it. Deliberately below the water plane's alpha CEILING
 * (WATER_MAX_ALPHA, 0.55 — terrain/waterDepth.ts; the water plane no longer
 * has one constant opacity, see render/water.ts's 2026-08-19 header, and
 * 0.55 is now the most opaque ANY cell of it ever gets): the owner's
 * acceptance for issue #22 is "opacity low enough to read as haze" — the
 * terrain edge should remain guessable through it, softened rather than
 * hidden behind a wall.
 */
const FOG_PLATEAU_ALPHA = 0.3;

/**
  * How far toward white the water end is lightened before blending. Only the
  * water end: the top end is the void's own colour, unlightened (see COLOUR).
  */
const FOG_COLOR_WHITEN = 0.35;

/** Rows bottom-to-top: base, knee, top. */
const FOG_ROW_COUNT = 3;

/** Row alpha, normalised to the plateau's peak of 1 — scaled by material.opacity. */
const FOG_ROW_ALPHA: readonly number[] = [1, 1, 0];

/**
 * Columns across a segment: one per lattice point of the chunk side, so the
 * bank's top can follow the same per-cell ground the terrain mesh renders.
 * CHUNK_SIZE cells since the 2026-08-21 re-sample means 65 columns where it
 * meant 17 — the bank is sampled as finely as the terrain beside it, which is
 * the only way its top edge can keep following that terrain exactly.
 */
const FOG_COLUMNS = CHUNK_SIZE + 1;

function fogRowColors(): readonly Color[] {
  const water = new Color(WATER_COLOR).lerp(new Color(0xffffff), FOG_COLOR_WHITEN);
  // Not whitened — see the COLOUR note at the top of this file.
  const beyond = new Color(VOID_HAZE_COLOR);
  const rows: Color[] = [];
  for (let r = 0; r < FOG_ROW_COUNT; r++) {
    rows.push(water.clone().lerp(beyond, r / (FOG_ROW_COUNT - 1)));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Animation: opacity breathing.
// ---------------------------------------------------------------------------

/**
 * Seconds per full breathe cycle. 9 s ≈ 0.11 Hz — two orders of magnitude
 * under the 3 Hz photosensitivity ceiling other plugins in this codebase
 * cite, and slow enough to read as ambient drift rather than a pulse a
 * player would consciously track.
 */
const FOG_BREATH_PERIOD_S = 9;

/**
 * Fraction of FOG_PLATEAU_ALPHA the breathing swings by, e.g. 0.15 takes
 * the visible plateau alpha between 0.85x and 1.15x of its base value.
 * Subtle on purpose: the bank's job is to read as a stable boundary, not
 * to draw the eye the way a strong pulse would.
 */
const FOG_BREATH_AMPLITUDE_FRACTION = 0.15;

const FOG_BREATH_ANGULAR_FREQUENCY = (2 * Math.PI) / FOG_BREATH_PERIOD_S;

// ---------------------------------------------------------------------------
// Geometry for one segment.
// ---------------------------------------------------------------------------

/**
 * Vertices one segment occupies — the fixed slot stride, and the same for
 * every segment because a segment is always one whole chunk side. Exported so
 * the lifecycle tests can split a super-mesh's packed buffers back into slots
 * instead of re-deriving the stride from the geometry and getting it wrong.
 */
export const VERTICES_PER_SEGMENT = FOG_ROW_COUNT * FOG_COLUMNS;
const POSITION_COMPONENTS_PER_VERTEX = 3;
const COLOR_COMPONENTS_PER_VERTEX = 4; // RGBA — itemSize 4 is what
// triggers three's per-vertex alpha path (WebGLPrograms.js `vertexAlphas`),
// verified against three 0.185's WebGLPrograms.js / color_fragment.glsl.js:
// `diffuseColor *= vColor` runs whenever material.vertexColors is true AND
// the geometry's color attribute has itemSize 4, with no shader patch needed.

/**
 * Two triangles per quad of the (rows−1) × (columns−1) lattice. Exported with
 * VERTICES_PER_SEGMENT above, and for the same reason: a super-mesh's draw
 * range counts indices, so this is how a test reads back how many slots are
 * live.
 */
export const INDICES_PER_SEGMENT = (FOG_ROW_COUNT - 1) * (FOG_COLUMNS - 1) * 6;

/**
 * The 16 border cells on the RECEIVED side of a frontier edge, plus the
 * boundary line the segment stands on, both derived from the same chunk-side
 * facts frontierEdgeSpan documents (chunk origin 16·(cx,cy), CHUNK_SIZE cells
 * a side). `cellStep`/`lineStep` run in the same +x/+z direction whatever the
 * edge's winding, so column k's ground always sits beside column k's position.
 */
function edgeSampling(edge: FrontierEdge): {
  cellX: number;
  cellY: number;
  cellStepX: number;
  cellStepY: number;
  lineX: number;
  lineZ: number;
  lineStepX: number;
  lineStepZ: number;
} {
  const x0 = edge.cx * CHUNK_SIZE;
  const y0 = edge.cy * CHUNK_SIZE;
  switch (edge.dir) {
    case 'N':
      return {
        cellX: x0, cellY: y0, cellStepX: 1, cellStepY: 0,
        lineX: x0, lineZ: y0, lineStepX: 1, lineStepZ: 0,
      };
    case 'S':
      return {
        cellX: x0, cellY: y0 + CHUNK_SIZE - 1, cellStepX: 1, cellStepY: 0,
        lineX: x0, lineZ: y0 + CHUNK_SIZE, lineStepX: 1, lineStepZ: 0,
      };
    case 'E':
      return {
        cellX: x0 + CHUNK_SIZE - 1, cellY: y0, cellStepX: 0, cellStepY: 1,
        lineX: x0 + CHUNK_SIZE, lineZ: y0, lineStepX: 0, lineStepZ: 1,
      };
    case 'W':
      return {
        cellX: x0, cellY: y0, cellStepX: 0, cellStepY: 1,
        lineX: x0, lineZ: y0, lineStepX: 0, lineStepZ: 1,
      };
  }
}

/**
 * (Re)writes one segment's vertex positions and colours from the mirror's
 * CURRENT heights, into the slot starting at vertex `firstVertex` of its
 * super-mesh's buffers. Positions and colours only — the index buffer depends
 * on the SLOT, never on the edge or the heights, which is what lets `refresh`
 * rewrite a live segment without touching geometry or mesh identity.
 */
function writeSegmentArrays(
  mirror: TerrainMirror,
  edge: FrontierEdge,
  positions: Float32Array,
  colors: Float32Array,
  firstVertex: number,
): void {
  const s = edgeSampling(edge);
  const rowColors = fogRowColors();

  // Ground height per border cell, then per column: a column between two
  // cells takes the HIGHER neighbour, so the opaque part of the bank always
  // reaches above whichever cap actually ends at that point of the boundary.
  // Underwater ground clamps to the WATERLINE — the bank hugs whichever
  // surface the player actually sees there (see FOG_BASE_DROP for why it must
  // never chase the seabed down).
  const cellHeights: number[] = [];
  for (let t = 0; t < CHUNK_SIZE; t++) {
    const h = sampleHeight(mirror, s.cellX + t * s.cellStepX, s.cellY + t * s.cellStepY);
    cellHeights.push(h > SEA_LEVEL ? h : SEA_LEVEL);
  }
  const baseY = (SEA_LEVEL - FOG_BASE_DROP) * HEIGHT_WORLD_SCALE;

  let p = firstVertex * POSITION_COMPONENTS_PER_VERTEX;
  let c = firstVertex * COLOR_COMPONENTS_PER_VERTEX;
  for (let r = 0; r < FOG_ROW_COUNT; r++) {
    const alpha = FOG_ROW_ALPHA[r];
    const color = rowColors[r];
    for (let k = 0; k < FOG_COLUMNS; k++) {
      const left = cellHeights[k - 1 < 0 ? 0 : k - 1];
      const right = cellHeights[k >= CHUNK_SIZE ? CHUNK_SIZE - 1 : k];
      const ground = left > right ? left : right;
      const rise =
        r === 0 ? 0 : r === 1 ? FOG_BANK_RISE * FOG_BANK_KNEE : FOG_BANK_RISE;
      const y = r === 0 ? baseY : (ground + rise) * HEIGHT_WORLD_SCALE;
      positions[p++] = (s.lineX + k * s.lineStepX) * CELL_WORLD_SIZE;
      positions[p++] = y;
      positions[p++] = (s.lineZ + k * s.lineStepZ) * CELL_WORLD_SIZE;
      colors[c++] = color.r;
      colors[c++] = color.g;
      colors[c++] = color.b;
      colors[c++] = alpha;
    }
  }
}

/**
 * The index pattern of ONE segment, relative to its own first vertex. Every
 * segment is one whole chunk side and so has exactly this topology; a slot's
 * real indices are these plus slot × VERTICES_PER_SEGMENT.
 */
const SEGMENT_INDEX_TEMPLATE: readonly number[] = (() => {
  const indices: number[] = [];
  for (let r = 0; r < FOG_ROW_COUNT - 1; r++) {
    for (let k = 0; k < FOG_COLUMNS - 1; k++) {
      const a = r * FOG_COLUMNS + k;
      const b = a + 1;
      const nextA = a + FOG_COLUMNS;
      const nextB = b + FOG_COLUMNS;
      // MeshBasicMaterial ignores normals entirely (no lighting to orient
      // against), and the material is DoubleSide, so winding is not
      // load-bearing here — either diagonal tiles the band correctly.
      indices.push(a, b, nextA, b, nextB, nextA);
    }
  }
  return indices;
})();

// ---------------------------------------------------------------------------
// Public interface.
// ---------------------------------------------------------------------------

/**
 * Slots a super-mesh is born with, and the unit its capacity doubles from.
 *
 * EIGHT, which is a whole chunk-grid block's worth of frontier for the shape
 * the frontier actually has: a super-mesh spans SUPER_MESH_SPAN_CHUNKS² chunks
 * and the boundary is a curve crossing it, so it clips a row or a corner of
 * that block — of the order of SUPER_MESH_SPAN_CHUNKS sides — rather than
 * enveloping every chunk in it. The pathological case (a checkerboard of
 * received chunks, four sides each) is 4 × SUPER_MESH_SPAN_CHUNKS² and it is
 * reached by doubling, so guessing low costs a few reallocations during the
 * reveal and guessing high would cost every super-mesh the memory forever.
 */
const INITIAL_SEGMENT_CAPACITY = 8;

/** One frontier edge's placement: which super-mesh holds it, and in which slot. */
interface FogSegment {
  edge: FrontierEdge;
  /** Flat chunk index of the edge's own (received) chunk — refresh's key. */
  chunkIdx: number;
  /** Flat index of the super-mesh block the edge's chunk falls in. */
  superIdx: number;
  /** This segment's fixed-stride slot inside that super-mesh. Moves on a swap-remove. */
  slot: number;
}

/**
 * One drawn object: every frontier segment inside one SUPER_MESH_SPAN_CHUNKS
 * square of the chunk grid, packed into fixed-stride slots.
 */
interface FogSuperMesh {
  mesh: Mesh;
  positions: Float32Array;
  colors: Float32Array;
  positionAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  /**
   * Slot → the segment living in it. Its LENGTH is the live slot count, so
   * there are never holes: a removal swaps the last occupant down into the
   * freed slot (order is irrelevant to a set of independent quad strips) and
   * pops, which keeps the drawn prefix contiguous with no compaction pass.
   */
  occupants: FogSegment[];
  /** Slots the buffers are sized for. Never shrinks. */
  segmentCapacity: number;
}

export interface FrontierFog {
  /**
   * Re-derives the frontier from the mirror's CURRENT received set: adds or
   * removes exactly the segments whose EDGE changed, and rewrites the heights
   * of every surviving segment in place. Call after every event that can
   * change which chunks are received — a join snapshot or a chunkUnlock.
   */
  sync(mirror: TerrainMirror): void;
  /**
   * Rewrites, in place, the segments whose own chunk is in `dirtyChunks` —
   * the same dirty set the terrain meshes were just patched with. Call after
   * every event that changes HEIGHTS without changing `received` (a terrain
   * diff, a local prediction, a prediction expiry/ack), so a sculpt at the
   * boundary moves the bank with the ground it hugs. Cheap: a handful of
   * border samples per affected segment, no allocation.
   */
  refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void;
  /**
   * Frontier edges currently drawn.
   *
   * The mesh count stopped answering this at the 2026-08-22 merge, and the
   * lifecycle contract this module is tested on — one segment per exposed
   * chunk side, added and removed as the boundary moves — is about SEGMENTS,
   * so it gets a number about segments rather than one about whatever the
   * renderer currently groups them into. Same split as terrainMeshes.ts's
   * builtChunkCount / drawCallCount.
   */
  segmentCount(): number;
  /**
   * Fog draw calls the renderer would submit with nothing culled — the number
   * the merge exists to keep down, exposed so a test can hold a budget against
   * it rather than trusting a comment.
   */
  drawCallCount(): number;
  dispose(): void;
}

export function createFrontierFog(
  parent: Object3D,
  onFrame: (handler: (dt: number) => void) => () => void,
): FrontierFog {
  const group = new Group();
  parent.add(group);

  const material = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // Not written to depth: like the sea plane (render/water.ts), the
    // curtain should never occlude terrain behind it in the depth buffer —
    // only blend over it — so overlapping segments at a concave corner never
    // fight each other for which one "wins".
    depthWrite: false,
    side: DoubleSide,
  });

  const segments = new Map<string, FogSegment>();
  const superMeshes = new Map<number, FogSuperMesh>();
  /**
   * Super-meshes whose buffers were touched since the last flush. Bounds are
   * O(live vertices) to recompute, so a sync that adds n segments to one block
   * must not pay that n times — every mutation marks, and each public call
   * flushes once at the end.
   */
  const dirtySupers = new Set<FogSuperMesh>();

  let elapsedS = 0;
  const stopAnimating = onFrame((dt: number) => {
    elapsedS += dt;
    const breathe =
      1 + FOG_BREATH_AMPLITUDE_FRACTION * Math.sin(elapsedS * FOG_BREATH_ANGULAR_FREQUENCY);
    material.opacity = FOG_PLATEAU_ALPHA * breathe;
  });

  /**
   * Points the geometry at the super-mesh's CURRENT arrays. Run at creation and
   * again after any growth — a typed array cannot be resized, so growth means
   * new arrays and therefore new attributes, and the old geometry is disposed
   * rather than left holding its GPU buffers.
   *
   * The index buffer is rebuilt here and NOWHERE else: a slot's indices are the
   * template plus its own first vertex, which depends on the slot alone, so
   * they are correct for every occupant that slot will ever have. Uint32 rather
   * than Uint16 because capacity × VERTICES_PER_SEGMENT passes 65 535 at 336
   * slots, which the pathological frontier of one block can reach.
   */
  const bindGeometry = (sm: FogSuperMesh): void => {
    const positionAttribute = new BufferAttribute(sm.positions, POSITION_COMPONENTS_PER_VERTEX);
    const colorAttribute = new BufferAttribute(sm.colors, COLOR_COMPONENTS_PER_VERTEX);

    const indices = new Uint32Array(sm.segmentCapacity * INDICES_PER_SEGMENT);
    for (let slot = 0; slot < sm.segmentCapacity; slot++) {
      const vertexBase = slot * VERTICES_PER_SEGMENT;
      const indexBase = slot * INDICES_PER_SEGMENT;
      for (let i = 0; i < INDICES_PER_SEGMENT; i++) {
        indices[indexBase + i] = SEGMENT_INDEX_TEMPLATE[i]! + vertexBase;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.setDrawRange(0, sm.occupants.length * INDICES_PER_SEGMENT);

    const previous = sm.mesh.geometry;
    sm.mesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();

    sm.positionAttribute = positionAttribute;
    sm.colorAttribute = colorAttribute;
  };

  /**
   * Grows a super-mesh to hold at least `slots`, preserving what is in it.
   * Geometric (doubling) for the same reason terrainMeshes.ts's is: the
   * frontier fills in segment by segment as chunks arrive, and growing by one
   * each time would recopy the whole buffer on every arrival.
   */
  const ensureSegmentCapacity = (sm: FogSuperMesh, slots: number): void => {
    if (slots <= sm.segmentCapacity) return;
    let capacity = sm.segmentCapacity;
    while (capacity < slots) capacity *= 2;

    const positions = new Float32Array(capacity * VERTICES_PER_SEGMENT * POSITION_COMPONENTS_PER_VERTEX);
    const colors = new Float32Array(capacity * VERTICES_PER_SEGMENT * COLOR_COMPONENTS_PER_VERTEX);
    positions.set(sm.positions);
    colors.set(sm.colors);
    sm.positions = positions;
    sm.colors = colors;
    sm.segmentCapacity = capacity;
    bindGeometry(sm);
  };

  const createSuperMesh = (superIdx: number): FogSuperMesh => {
    const placeholder = new BufferAttribute(new Float32Array(0), POSITION_COMPONENTS_PER_VERTEX);
    const sm: FogSuperMesh = {
      mesh: new Mesh(new BufferGeometry(), material),
      positions: new Float32Array(
        INITIAL_SEGMENT_CAPACITY * VERTICES_PER_SEGMENT * POSITION_COMPONENTS_PER_VERTEX,
      ),
      colors: new Float32Array(
        INITIAL_SEGMENT_CAPACITY * VERTICES_PER_SEGMENT * COLOR_COMPONENTS_PER_VERTEX,
      ),
      positionAttribute: placeholder,
      colorAttribute: placeholder,
      occupants: [],
      segmentCapacity: INITIAL_SEGMENT_CAPACITY,
    };
    bindGeometry(sm);
    group.add(sm.mesh);
    superMeshes.set(superIdx, sm);
    return sm;
  };

  /**
   * The bound the renderer culls against, over the LIVE slots only.
   *
   * Hand-rolled rather than `geometry.computeBoundingSphere()` for the same
   * reason terrainMeshes.ts's is: that reads the whole position attribute, and
   * the slots past the live prefix hold whatever a previous occupant left
   * there — a removed segment's stale coordinates would keep inflating the
   * sphere and defeat the culling this merge depends on.
   *
   * Centre-of-AABB, which is what Three's own implementation uses.
   */
  const recomputeBounds = (sm: FogSuperMesh): void => {
    const geometry = sm.mesh.geometry;
    const live = sm.occupants.length * VERTICES_PER_SEGMENT;
    if (live === 0) {
      geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 0);
      return;
    }
    const positions = sm.positions;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let v = 0; v < live; v++) {
      const x = positions[v * 3]!;
      const y = positions[v * 3 + 1]!;
      const z = positions[v * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centreZ = (minZ + maxZ) / 2;
    let maxSquared = 0;
    for (let v = 0; v < live; v++) {
      const dx = positions[v * 3]! - centreX;
      const dy = positions[v * 3 + 1]! - centreY;
      const dz = positions[v * 3 + 2]! - centreZ;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared > maxSquared) maxSquared = squared;
    }
    geometry.boundingSphere = new Sphere(
      new Vector3(centreX, centreY, centreZ),
      Math.sqrt(maxSquared),
    );
  };

  /** Publishes every buffer edit made since the last flush. */
  const flush = (): void => {
    for (const sm of dirtySupers) {
      sm.positionAttribute.needsUpdate = true;
      sm.colorAttribute.needsUpdate = true;
      // Indexed geometry: the draw range counts INDICES, and the live slots are
      // a contiguous prefix, so one range covers every segment in the block.
      sm.mesh.geometry.setDrawRange(0, sm.occupants.length * INDICES_PER_SEGMENT);
      recomputeBounds(sm);
    }
    dirtySupers.clear();
  };

  const writeSlot = (mirror: TerrainMirror, sm: FogSuperMesh, segment: FogSegment): void => {
    writeSegmentArrays(
      mirror,
      segment.edge,
      sm.positions,
      sm.colors,
      segment.slot * VERTICES_PER_SEGMENT,
    );
    dirtySupers.add(sm);
  };

  const addSegment = (mirror: TerrainMirror, segment: FogSegment): void => {
    const sm = superMeshes.get(segment.superIdx) ?? createSuperMesh(segment.superIdx);
    ensureSegmentCapacity(sm, sm.occupants.length + 1);
    segment.slot = sm.occupants.length;
    sm.occupants.push(segment);
    writeSlot(mirror, sm, segment);
  };

  /**
   * Frees a segment's slot by swapping the last live occupant down into it —
   * the whole removal, since nothing about a quad strip depends on the order
   * its neighbours are drawn in and its indices belong to the slot, not to it.
   * A block that loses its last segment loses its mesh too, so a frontier that
   * has crept out of a chunk-grid block stops costing a draw call there.
   */
  const removeSegment = (segment: FogSegment): void => {
    const sm = superMeshes.get(segment.superIdx);
    if (sm === undefined) return;
    const last = sm.occupants.length - 1;
    if (segment.slot !== last) {
      const moved = sm.occupants[last]!;
      const from = last * VERTICES_PER_SEGMENT;
      const to = segment.slot * VERTICES_PER_SEGMENT;
      sm.positions.copyWithin(
        to * POSITION_COMPONENTS_PER_VERTEX,
        from * POSITION_COMPONENTS_PER_VERTEX,
        (from + VERTICES_PER_SEGMENT) * POSITION_COMPONENTS_PER_VERTEX,
      );
      sm.colors.copyWithin(
        to * COLOR_COMPONENTS_PER_VERTEX,
        from * COLOR_COMPONENTS_PER_VERTEX,
        (from + VERTICES_PER_SEGMENT) * COLOR_COMPONENTS_PER_VERTEX,
      );
      moved.slot = segment.slot;
      sm.occupants[segment.slot] = moved;
    }
    sm.occupants.pop();

    if (sm.occupants.length === 0) {
      group.remove(sm.mesh);
      sm.mesh.geometry.dispose();
      superMeshes.delete(segment.superIdx);
      dirtySupers.delete(sm);
      return;
    }
    dirtySupers.add(sm);
  };

  return {
    sync(mirror: TerrainMirror): void {
      const chunkCols = chunksPerEdge(mirror.map.size);
      const superCols = Math.ceil(chunkCols / SUPER_MESH_SPAN_CHUNKS);
      const nextEdges = frontierEdges(mirror.received, chunkCols);
      const nextKeys = new Set(nextEdges.map(frontierEdgeKey));

      // Remove segments whose edge no longer exists — the boundary crept
      // outward past them, or the world was replaced by a rejoin.
      for (const [key, segment] of segments) {
        if (nextKeys.has(key)) continue;
        removeSegment(segment);
        segments.delete(key);
      }

      // Add segments for edges that are new; rewrite the heights of the ones
      // that survive. A surviving edge's POSITION depends only on (cx, cy,
      // dir), but its bank now follows the ground, and a rejoin can hand this
      // same key a different world's terrain — so the arrays are rewritten
      // rather than trusted.
      for (const edge of nextEdges) {
        const key = frontierEdgeKey(edge);
        const existing = segments.get(key);
        if (existing !== undefined) {
          writeSlot(mirror, superMeshes.get(existing.superIdx)!, existing);
          continue;
        }
        const sx = Math.floor(edge.cx / SUPER_MESH_SPAN_CHUNKS);
        const sy = Math.floor(edge.cy / SUPER_MESH_SPAN_CHUNKS);
        const segment: FogSegment = {
          edge,
          chunkIdx: edge.cy * chunkCols + edge.cx,
          superIdx: sy * superCols + sx,
          slot: 0,
        };
        addSegment(mirror, segment);
        segments.set(key, segment);
      }

      flush();
    },

    refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void {
      if (dirtyChunks.size === 0) return;
      for (const segment of segments.values()) {
        if (!dirtyChunks.has(segment.chunkIdx)) continue;
        writeSlot(mirror, superMeshes.get(segment.superIdx)!, segment);
      }
      flush();
    },

    segmentCount(): number {
      return segments.size;
    },

    drawCallCount(): number {
      return superMeshes.size;
    },

    dispose(): void {
      stopAnimating();
      for (const sm of superMeshes.values()) {
        group.remove(sm.mesh);
        sm.mesh.geometry.dispose();
      }
      superMeshes.clear();
      segments.clear();
      dirtySupers.clear();
      parent.remove(group);
      material.dispose();
    },
  };
}
