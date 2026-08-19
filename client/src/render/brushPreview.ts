// The brush outline: a light line tracing the EXACT cells the current brush
// will touch, following the cursor (owner, 2026-08-14: "Show me a light
// outline of the brush so I can see how much area I'm going to affect").
//
// The outline is the boundary of the shared brush footprint — built with
// forEachFootprintOffset, the same iterator applyBrush edits with, so what it
// promises and what a stroke does cannot drift apart. One geometry per radius
// is built once at startup (there are only MAX_BRUSH_RADIUS of them) and the
// single line object swaps between them; showing, moving and hiding the
// preview allocates nothing.
//
// DRAWN AS AN OVERLAY, not as geometry in the world: depthTest is off and the
// render order is high, so the outline reads through terrain steps inside the
// footprint instead of being sliced by them. That is the honest presentation —
// the brush affects those cells whatever their current height — and it is what
// makes a single flat ring correct over terraced ground.

import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  type Scene,
} from 'three';
import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  forEachFootprintOffset,
} from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../config.ts';

/**
 * How far above the picked surface the outline floats, in world units. Only
 * legibility at glancing angles — with depthTest off it cannot z-fight — and
 * small enough that the outline still reads as lying ON the ground.
 */
const OUTLINE_LIFT_WORLD_UNITS = 0.05;

/**
 * White at less than half opacity: visible on every band colour the palette
 * holds (sea, soil, grass, rock and snow all sit well below full white) while
 * staying a hint rather than a cursor — the owner asked for "a light outline".
 */
const OUTLINE_OPACITY = 0.45;

/** What the preview needs to know about the hovered spot. */
export interface BrushHover {
  /** Cell coordinates (integers, world-bounds-checked by the picker). */
  readonly x: number;
  readonly y: number;
  /** World-space height of the picked surface point. */
  readonly surfaceY: number;
}

export interface BrushPreview {
  /** Shows the outline for `radius` at the hovered cell, or hides on null. */
  update(hover: BrushHover | null, radius: number): void;
  dispose(): void;
}

/**
 * The footprint's boundary as line segments, in cell-local units where (0,0)
 * is the CENTRE cell's minimum corner. An edge belongs to the boundary when
 * the cell on its far side is not in the footprint — the same test on the
 * same membership the brush itself uses.
 */
function boundaryGeometry(radius: number): BufferGeometry {
  const inFootprint = new Set<string>();
  forEachFootprintOffset(radius, (dx, dy) => inFootprint.add(`${dx},${dy}`));

  const positions: number[] = [];
  const edge = (x1: number, z1: number, x2: number, z2: number): void => {
    positions.push(
      x1 * CELL_WORLD_SIZE, 0, z1 * CELL_WORLD_SIZE,
      x2 * CELL_WORLD_SIZE, 0, z2 * CELL_WORLD_SIZE,
    );
  };

  forEachFootprintOffset(radius, (dx, dy) => {
    if (!inFootprint.has(`${dx - 1},${dy}`)) edge(dx, dy, dx, dy + 1);
    if (!inFootprint.has(`${dx + 1},${dy}`)) edge(dx + 1, dy, dx + 1, dy + 1);
    if (!inFootprint.has(`${dx},${dy - 1}`)) edge(dx, dy, dx + 1, dy);
    if (!inFootprint.has(`${dx},${dy + 1}`)) edge(dx, dy + 1, dx + 1, dy + 1);
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}

export function createBrushPreview(scene: Scene): BrushPreview {
  /** Index r - MIN_BRUSH_RADIUS holds radius r's boundary. Built once. */
  const geometries: BufferGeometry[] = [];
  for (let r = MIN_BRUSH_RADIUS; r <= MAX_BRUSH_RADIUS; r++) {
    geometries.push(boundaryGeometry(r));
  }

  const material = new LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: OUTLINE_OPACITY,
    // Overlay semantics — see the module header.
    depthTest: false,
    depthWrite: false,
  });

  const line = new LineSegments(geometries[0], material);
  line.renderOrder = 998;
  line.visible = false;
  scene.add(line);

  let shownRadius = MIN_BRUSH_RADIUS;

  return {
    update(hover, radius) {
      if (hover === null) {
        line.visible = false;
        return;
      }
      if (radius !== shownRadius) {
        const index = radius - MIN_BRUSH_RADIUS;
        // An out-of-range radius means a bug upstream (the HUD only offers the
        // legal set); hiding beats drawing a wrong promise.
        if (index < 0 || index >= geometries.length) {
          line.visible = false;
          return;
        }
        line.geometry = geometries[index];
        shownRadius = radius;
      }
      line.position.set(
        hover.x * CELL_WORLD_SIZE,
        hover.surfaceY + OUTLINE_LIFT_WORLD_UNITS,
        hover.y * CELL_WORLD_SIZE,
      );
      line.visible = true;
    },
    dispose() {
      scene.remove(line);
      for (const g of geometries) g.dispose();
      material.dispose();
    },
  };
}
