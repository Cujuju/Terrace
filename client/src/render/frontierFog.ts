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
// COLOUR. Base row is a lightened WATER_COLOR, top row a lightened SKY_COLOR
// (both imported from where the scene already defines them — see their export
// comments), blended row to row, so the haze reads as weather between sea and
// sky rather than as a painted wall.
//
// LIFECYCLE. One shared, unlit MeshBasicMaterial (fog is atmospheric, not a
// lit surface — matching why water.ts's own translucent plane needs no
// per-face lighting either) and one Group; each frontier edge gets its own
// small indexed BufferGeometry, keyed by terrain/frontier.ts's
// frontierEdgeKey so `sync` can diff the previous edge set against the new
// one and add/dispose exactly the segments that changed, in place, whatever
// event (join, chunk unlock, rejoin at a new world size) triggered it.
// Because the geometry now depends on HEIGHTS as well as the edge set,
// surviving segments are refreshed in place (same mesh, same geometry, same
// arrays — attribute rewrite only) by `sync`, and `refresh` does the same for
// terrain diffs — see the interface docs.
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
import { SKY_COLOR } from './scene.ts';
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

/** How far toward white each end colour is lightened before blending. */
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
  const sky = new Color(SKY_COLOR).lerp(new Color(0xffffff), FOG_COLOR_WHITEN);
  const rows: Color[] = [];
  for (let r = 0; r < FOG_ROW_COUNT; r++) {
    rows.push(water.clone().lerp(sky, r / (FOG_ROW_COUNT - 1)));
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

const VERTICES_PER_SEGMENT = FOG_ROW_COUNT * FOG_COLUMNS;
const POSITION_COMPONENTS = VERTICES_PER_SEGMENT * 3;
const COLOR_COMPONENTS = VERTICES_PER_SEGMENT * 4; // RGBA — itemSize 4 is what
// triggers three's per-vertex alpha path (WebGLPrograms.js `vertexAlphas`),
// verified against three 0.185's WebGLPrograms.js / color_fragment.glsl.js:
// `diffuseColor *= vColor` runs whenever material.vertexColors is true AND
// the geometry's color attribute has itemSize 4, with no shader patch needed.

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
 * CURRENT heights. Positions and colours only — the index buffer never
 * changes, which is what lets `refresh` rewrite a live segment without
 * touching its geometry or mesh identity.
 */
function writeSegmentArrays(
  mirror: TerrainMirror,
  edge: FrontierEdge,
  positions: Float32Array,
  colors: Float32Array,
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

  let p = 0;
  let c = 0;
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

function buildSegmentIndices(): number[] {
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
}

// ---------------------------------------------------------------------------
// Public interface.
// ---------------------------------------------------------------------------

interface FogSegment {
  mesh: Mesh;
  geometry: BufferGeometry;
  positionAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  edge: FrontierEdge;
  /** Flat chunk index of the edge's own (received) chunk — refresh's key. */
  chunkIdx: number;
}

export interface FrontierFog {
  /**
   * Re-derives the frontier from the mirror's CURRENT received set: adds or
   * disposes exactly the segments whose EDGE changed, and rewrites the heights
   * of every surviving segment in place (same mesh and geometry identity).
   * Call after every event that can change which chunks are received — a join
   * snapshot or a chunkUnlock.
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

  let elapsedS = 0;
  const stopAnimating = onFrame((dt: number) => {
    elapsedS += dt;
    const breathe =
      1 + FOG_BREATH_AMPLITUDE_FRACTION * Math.sin(elapsedS * FOG_BREATH_ANGULAR_FREQUENCY);
    material.opacity = FOG_PLATEAU_ALPHA * breathe;
  });

  const rewriteSegment = (mirror: TerrainMirror, segment: FogSegment): void => {
    writeSegmentArrays(
      mirror,
      segment.edge,
      segment.positionAttribute.array as Float32Array,
      segment.colorAttribute.array as Float32Array,
    );
    segment.positionAttribute.needsUpdate = true;
    segment.colorAttribute.needsUpdate = true;
    // Heights moved, so the culling bound is stale — same rule as
    // terrainMeshes.ts's writeChunk, and just as cheap at 51 vertices.
    segment.geometry.computeBoundingSphere();
  };

  const buildSegment = (mirror: TerrainMirror, edge: FrontierEdge, chunkCols: number): FogSegment => {
    const positions = new Float32Array(POSITION_COMPONENTS);
    const colors = new Float32Array(COLOR_COMPONENTS);
    writeSegmentArrays(mirror, edge, positions, colors);

    const geometry = new BufferGeometry();
    const positionAttribute = new BufferAttribute(positions, 3);
    const colorAttribute = new BufferAttribute(colors, 4);
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setIndex(buildSegmentIndices());

    const mesh = new Mesh(geometry, material);
    return {
      mesh,
      geometry,
      positionAttribute,
      colorAttribute,
      edge,
      chunkIdx: edge.cy * chunkCols + edge.cx,
    };
  };

  return {
    sync(mirror: TerrainMirror): void {
      const chunkCols = chunksPerEdge(mirror.map.size);
      const nextEdges = frontierEdges(mirror.received, chunkCols);
      const nextKeys = new Set(nextEdges.map(frontierEdgeKey));

      // Remove segments whose edge no longer exists — the boundary crept
      // outward past them, or the world was replaced by a rejoin.
      for (const [key, entry] of segments) {
        if (nextKeys.has(key)) continue;
        group.remove(entry.mesh);
        entry.geometry.dispose();
        segments.delete(key);
      }

      // Add segments for edges that are new; refresh the heights of the ones
      // that survive. A surviving edge's POSITION depends only on (cx, cy,
      // dir), but its bank now follows the ground, and a rejoin can hand this
      // same key a different world's terrain — so the arrays are rewritten in
      // place (identity preserved) rather than trusted.
      for (const edge of nextEdges) {
        const key = frontierEdgeKey(edge);
        const existing = segments.get(key);
        if (existing !== undefined) {
          rewriteSegment(mirror, existing);
          continue;
        }
        const segment = buildSegment(mirror, edge, chunkCols);
        group.add(segment.mesh);
        segments.set(key, segment);
      }
    },

    refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void {
      if (dirtyChunks.size === 0) return;
      for (const segment of segments.values()) {
        if (!dirtyChunks.has(segment.chunkIdx)) continue;
        rewriteSegment(mirror, segment);
      }
    },

    dispose(): void {
      stopAnimating();
      for (const entry of segments.values()) {
        group.remove(entry.mesh);
        entry.geometry.dispose();
      }
      segments.clear();
      parent.remove(group);
      material.dispose();
    },
  };
}
