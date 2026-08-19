// The frontier mist: a soft fog curtain marking the edge of the player's
// revealed territory, replacing the old inconsistent skirt-cliff look.
//
// WHY A SEPARATE LAYER FROM vertexGrid.ts's SKIRTS. That module's skirts stay
// exactly as they were — they are the terrace-cliff look INSIDE revealed
// territory, and the design record (2026-08-14) calls that the app's
// namesake silhouette. The frontier is different: terrain/frontier.ts's
// header documents why the old treatment there was an accident of local
// height (skirts only appear where the edge cell happens to sit above sea
// level) rather than a deliberate boundary. Rather than teach vertexGrid.ts a
// second, height-independent reason to draw a wall — which would entangle
// the frontier's correctness with the cap/skirt/contour pipeline's — this
// module draws an entirely separate curtain, positioned purely from the
// mirror's `received` set (terrain/frontier.ts), that sits in front of
// whatever vertexGrid.ts drew there and reads as one consistent ring
// regardless of what is happening underneath it.
//
// GEOMETRY. One quad-strip per frontier edge (a whole 16-cell chunk side),
// four rows of vertices tall: transparent at the very bottom, a soft ramp up
// to a translucent plateau, the plateau held across the middle of the
// height range, then a ramp back down to transparent at the very top. The
// curtain therefore never shows a second hard edge of its own — it dissolves
// before its own geometry ends — while staying substantially opaque across
// the entire range real terrain can occupy, which is what "tall enough to
// mask the cross-section at any height difference" requires.
//
// COLOUR. Bottom row is a lightened WATER_COLOR, top row a lightened
// SKY_COLOR (both imported from where the scene already defines them — see
// their export comments), linearly blended row to row. MIN_HEIGHT and
// MAX_HEIGHT are exact negatives of each other and SEA_LEVEL is 0
// (shared/src/constants.ts), so the curtain's Y span is symmetric about the
// waterline BY CONSTRUCTION: a plain linear gradient from bottom to top
// therefore already crosses from "water tint" to "sky tint" centred on sea
// level, with no separate transition point to compute or keep in sync.
//
// LIFECYCLE. One shared, unlit MeshBasicMaterial (fog is atmospheric, not a
// lit surface — matching why water.ts's own translucent plane needs no
// per-face lighting either) and one Group; each frontier edge gets its own
// small indexed BufferGeometry, keyed by terrain/frontier.ts's
// frontierEdgeKey so `sync` can diff the previous edge set against the new
// one and add/dispose exactly the segments that changed, in place, whatever
// event (join, chunk unlock, rejoin at a new world size) triggered it.
//
// ANIMATION. A single slow "opacity breathing" driven by the shared
// material's own `opacity`, via the render loop's onFrame hook
// (render/scene.ts) — gentle and global rather than per-vertex, because the
// alpha shape baked into each segment's vertex colours already encodes the
// soft top/bottom falloff; breathing only needs to scale it uniformly over
// time. See FOG_BREATH_* below for the rate and why it is nowhere near the
// 3 Hz photosensitivity ceiling other plugins cite.

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
import { MAX_HEIGHT, MIN_HEIGHT, chunksPerEdge } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import {
  frontierEdgeKey,
  frontierEdgeSpan,
  frontierEdges,
  type FrontierEdge,
} from '../terrain/frontier.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import { SKY_COLOR } from './scene.ts';
import { WATER_COLOR } from './water.ts';

// ---------------------------------------------------------------------------
// Shape: the four-row alpha/colour profile every segment shares.
// ---------------------------------------------------------------------------

/** World Y the curtain's top row sits at: the highest a sculpt can ever reach. */
const FOG_TOP_WORLD_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE;
/** World Y the curtain's bottom row sits at: the lowest a sculpt can ever reach. */
const FOG_BOTTOM_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE;

/**
 * Fraction of the curtain's total height spent ramping from transparent to
 * the plateau at each end, rather than jumping straight to it. 0.15 leaves a
 * solid 70%-of-span plateau in the middle — comfortably wider than terrain
 * ever needs: BAND_HEIGHT quantises height into steps well inside
 * [MIN_HEIGHT, MAX_HEIGHT], so an ordinary game never even sculpts into the
 * fade zone, and the curtain still fully masks the rare stroke that does.
 */
const FOG_FADE_FRACTION = 0.15;

/**
 * Peak alpha at the plateau (the two middle rows), before the breathing
 * modulation below scales it. Translucent enough to still read as mist and
 * let the sky/sea show through — the same order as the water plane's own
 * WATER_OPACITY (0.62, render/water.ts) — rather than an opaque wall, which
 * is exactly the "raw cliff" look this replaces.
 */
const FOG_PLATEAU_ALPHA = 0.55;

/** How far toward white each end colour is lightened before blending. */
const FOG_COLOR_WHITEN = 0.35;

const FOG_ROW_COUNT = 4;

/** Row Y positions, bottom to top: fade start, plateau start, plateau end, fade end. */
function fogRowYs(): readonly number[] {
  const span = FOG_TOP_WORLD_Y - FOG_BOTTOM_WORLD_Y;
  const fade = span * FOG_FADE_FRACTION;
  return [
    FOG_BOTTOM_WORLD_Y,
    FOG_BOTTOM_WORLD_Y + fade,
    FOG_TOP_WORLD_Y - fade,
    FOG_TOP_WORLD_Y,
  ];
}

/** Row alpha, normalised to the plateau's peak of 1 — scaled by material.opacity. */
const FOG_ROW_ALPHA: readonly number[] = [0, 1, 1, 0];

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
 * Fraction of FOG_PLATEAU_ALPHA the breathing swings by by, e.g. 0.15 takes
 * the visible plateau alpha between 0.85x and 1.15x of its base value.
 * Subtle on purpose: the curtain's job is to read as a stable boundary, not
 * to draw the eye the way a strong pulse would.
 */
const FOG_BREATH_AMPLITUDE_FRACTION = 0.15;

const FOG_BREATH_ANGULAR_FREQUENCY = (2 * Math.PI) / FOG_BREATH_PERIOD_S;

// ---------------------------------------------------------------------------
// Geometry for one segment.
// ---------------------------------------------------------------------------

const VERTICES_PER_SEGMENT = FOG_ROW_COUNT * 2; // two columns (start, end) per row
const POSITION_COMPONENTS = VERTICES_PER_SEGMENT * 3;
const COLOR_COMPONENTS = VERTICES_PER_SEGMENT * 4; // RGBA — itemSize 4 is what
// triggers three's per-vertex alpha path (WebGLPrograms.js `vertexAlphas`),
// verified against three 0.185's WebGLPrograms.js / color_fragment.glsl.js:
// `diffuseColor *= vColor` runs whenever material.vertexColors is true AND
// the geometry's color attribute has itemSize 4, with no shader patch needed.

function buildSegmentGeometry(edge: FrontierEdge): BufferGeometry {
  const span = frontierEdgeSpan(edge);
  const x0 = span.x0 * CELL_WORLD_SIZE;
  const z0 = span.z0 * CELL_WORLD_SIZE;
  const x1 = span.x1 * CELL_WORLD_SIZE;
  const z1 = span.z1 * CELL_WORLD_SIZE;

  const rowYs = fogRowYs();
  const rowColors = fogRowColors();

  const positions = new Float32Array(POSITION_COMPONENTS);
  const colors = new Float32Array(COLOR_COMPONENTS);
  let p = 0;
  let c = 0;
  for (let r = 0; r < FOG_ROW_COUNT; r++) {
    const y = rowYs[r];
    const alpha = FOG_ROW_ALPHA[r];
    const color = rowColors[r];
    for (const [x, z] of [
      [x0, z0],
      [x1, z1],
    ] as const) {
      positions[p++] = x;
      positions[p++] = y;
      positions[p++] = z;
      colors[c++] = color.r;
      colors[c++] = color.g;
      colors[c++] = color.b;
      colors[c++] = alpha;
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < FOG_ROW_COUNT - 1; r++) {
    const a = r * 2;
    const b = r * 2 + 1;
    const nextA = (r + 1) * 2;
    const nextB = (r + 1) * 2 + 1;
    // MeshBasicMaterial ignores normals entirely (no lighting to orient
    // against), and the material is DoubleSide, so winding is not
    // load-bearing here — either diagonal tiles the band correctly.
    indices.push(a, b, nextA, b, nextB, nextA);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

// ---------------------------------------------------------------------------
// Public interface.
// ---------------------------------------------------------------------------

export interface FrontierFog {
  /**
   * Re-derives the frontier from the mirror's CURRENT received set and adds
   * or disposes exactly the segments that changed. Call after every event
   * that can change which chunks are received — a join snapshot or a
   * chunkUnlock — never on a plain terrain diff, since a diff never changes
   * `received` and the frontier is defined purely from that set
   * (terrain/frontier.ts).
   */
  sync(mirror: TerrainMirror): void;
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

  const segments = new Map<string, { mesh: Mesh; geometry: BufferGeometry }>();

  let elapsedS = 0;
  const stopAnimating = onFrame((dt: number) => {
    elapsedS += dt;
    const breathe =
      1 + FOG_BREATH_AMPLITUDE_FRACTION * Math.sin(elapsedS * FOG_BREATH_ANGULAR_FREQUENCY);
    material.opacity = FOG_PLATEAU_ALPHA * breathe;
  });

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

      // Add segments for edges that are new. Existing ones (same chunk side,
      // same world) are left untouched — their geometry does not depend on
      // anything but (cx, cy, dir), so there is nothing to refresh.
      for (const edge of nextEdges) {
        const key = frontierEdgeKey(edge);
        if (segments.has(key)) continue;
        const geometry = buildSegmentGeometry(edge);
        const mesh = new Mesh(geometry, material);
        group.add(mesh);
        segments.set(key, { mesh, geometry });
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
