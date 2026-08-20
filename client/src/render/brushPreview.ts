// The brush outline: a light line tracing the area the current brush will
// affect, following the cursor (owner, 2026-08-14: "Show me a light outline of
// the brush so I can see how much area I'm going to affect").
//
// WHICH cells is the shared footprint's business — forEachFootprintOffset, the
// same iterator applyBrush edits with, so what the preview promises and what a
// stroke does cannot drift apart. One geometry per radius is built once at
// startup (there are only MAX_BRUSH_RADIUS of them) and the single line object
// swaps between them; showing, moving and hiding the preview allocates
// nothing.
//
// HOW that set is DRAWN is the terrain's business, and this is the whole point
// of the module (owner, 2026-08-19: "use the terrain's pipeline for the brush
// shape"). The outline used to be the polyomino boundary of the footprint —
// axis-aligned segments along cell edges. It was exact and it was foreign:
// nothing else in the world is drawn in cell-edge geometry, so radius 2's
// five-cell plus read as a shape from another renderer laid over the ground,
// and no amount of aligning it with the stamp could make the two look related.
//
// So the footprint is now marched and smoothed by the code that marches and
// smooths terrain — loadSampleField → marchLevel → assembleLoops → smoothLoop,
// the exact sequence terrain/capEmission.ts runs per band — over a BINARY
// in/out field instead of heights. One marching-squares implementation, one
// saddle rule, one Chaikin pass: preview and terrain speak one shape language
// because they are one piece of code, not because someone kept them in step.
//
// WHAT THAT COSTS, stated. A crossing sits halfway between an inside cell
// centre and an outside one — the cell edge — so the outline touches every
// edge midpoint of the footprint but CLIPS THE CORNER of each outermost cell,
// and Chaikin rounds those corners further. A few cells are therefore edited
// just outside the line. That is the same corner-cut the terrain applies to
// itself, and it is why the outline reads as a lower bound rather than a
// promise of exact coverage. It is also only a lower bound in the other
// direction: the real band edge lands at the INTERPOLATED height fraction, so
// a multi-band raise bulges its lowest band outward past this line while its
// top plateau contracts inside it. No static outline tracks that without
// re-contouring every frame, which would shimmer as the falloff crosses band
// boundaries.
//
// IT IS ALSO THE CURSOR (owner, 2026-08-19: "hide the mouse pointer when it's
// in the canvas"). While an outline is drawn, the canvas carries
// OUTLINE_IS_CURSOR_CLASS and the OS arrow is hidden — the outline already
// marks the spot, and the arrow only competes with the stamp it sits inside.
// It is tied to the outline's own visibility rather than to "the pointer is
// over the canvas" so that the pointer can never be invisible with nothing in
// its place: over sky, off-world, or before the first snapshot there is no
// outline, so the arrow comes back. The HUD panels are separate elements with
// their own cursor, so this never reaches a control.
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
  LineLoop,
  type Scene,
} from 'three';
import {
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  forEachFootprintOffset,
} from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../config.ts';
import {
  assembleLoops,
  loadSampleField,
  marchLevel,
  type ContourLoop,
} from '../terrain/contours.ts';
import { smoothLoop } from '../terrain/contourSmoothing.ts';

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

/**
 * Class the canvas carries while the outline stands in for the mouse pointer.
 * Its `cursor: none` rule lives beside the canvas's other styling in
 * ui/hud.css; this module owns only WHEN it is applied.
 */
const OUTLINE_IS_CURSOR_CLASS = 'brush-outline-shown';

/**
 * All this module needs of the canvas: somewhere to hang the cursor class.
 * Declared structurally rather than as HTMLCanvasElement so the preview keeps
 * no DOM dependency — test/ runs in a plain node environment by design (see
 * vite.config.ts), and the cursor contract is worth testing there. A real
 * HTMLCanvasElement satisfies it.
 */
export interface CursorSurface {
  readonly classList: { toggle(token: string, force: boolean): void };
}

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
 * The field marched to find the outline: a cell is in the footprint or it is
 * not. `marchLevel` classifies a sample as inside when `sample >= threshold`,
 * so INSIDE doubles as the threshold.
 */
const FOOTPRINT_OUTSIDE = 0;
const FOOTPRINT_INSIDE = 1;

/**
 * Where the outline crosses the lattice edge between an inside cell and an
 * outside one, as a fraction from the outside end.
 *
 * Passed as marchLevel's crossing OVERRIDE rather than left to its height
 * interpolation, because there is nothing here to interpolate: membership is
 * binary, so the only defensible boundary is the midpoint between the two cell
 * centres — which is exactly the cell edge the two share. Letting the height
 * form run would make the outline's shape depend on BAND_HEIGHT, a constant
 * with no bearing whatsoever on which cells a brush covers.
 */
const FOOTPRINT_EDGE_CROSSING = 0.5;

/**
 * Lattice index the brush's centre cell is loaded at.
 *
 * marchLevel works over the chunk-sized lattice; a footprint is far smaller,
 * so it is placed in the middle, where it cannot reach the domain border. That
 * matters for correctness, not tidiness: a contour point ON the border is
 * flagged and then PINNED by smoothLoop (seam contract S4), which would leave
 * the outline with unsmoothed straight runs, and assembleLoops would close the
 * shape along the border rather than around the brush.
 */
const FOOTPRINT_LATTICE_CENTRE = CHUNK_SIZE / 2;

/**
 * Cells of clear lattice the footprint needs beyond its own reach: one for the
 * outside samples that make the boundary crossings exist at all.
 */
const FOOTPRINT_LATTICE_MARGIN_CELLS = 1;

/**
 * How far the largest footprint reaches from its centre cell, in cells —
 * forEachFootprintOffset scans offsets in [−(r−1), r−1].
 */
const MAX_FOOTPRINT_REACH_CELLS = MAX_BRUSH_RADIUS - 1;

// The placement above is only safe while the largest brush still clears the
// domain border on every side. Checked here, at module load, because the
// failure it guards is silent — a pinned border vertex draws a subtly wrong
// outline rather than throwing — and because every input is a constant, so
// this either always holds or never does.
if (
  MAX_FOOTPRINT_REACH_CELLS + FOOTPRINT_LATTICE_MARGIN_CELLS > FOOTPRINT_LATTICE_CENTRE ||
  FOOTPRINT_LATTICE_CENTRE + MAX_FOOTPRINT_REACH_CELLS + FOOTPRINT_LATTICE_MARGIN_CELLS >
    CHUNK_SIZE
) {
  throw new RangeError(
    `brush radius ${MAX_BRUSH_RADIUS} does not fit the ${CHUNK_SIZE}-cell contour lattice`,
  );
}

/**
 * The footprint's outline, in CELL coordinates with the centre cell's centre
 * at the origin — the frame the hovered cell is expressed in, so positioning
 * the line is a plain multiply by CELL_WORLD_SIZE with no half-cell shift.
 *
 * This is terrain/capEmission.ts's per-band sequence, run over the footprint
 * instead of over heights: load the lattice, march it, assemble the crossings
 * into loops, smooth each one.
 */
function footprintOutline(radius: number): ContourLoop {
  const inFootprint = new Set<string>();
  forEachFootprintOffset(radius, (dx, dy) => inFootprint.add(`${dx},${dy}`));

  loadSampleField((i, j) =>
    inFootprint.has(`${i - FOOTPRINT_LATTICE_CENTRE},${j - FOOTPRINT_LATTICE_CENTRE}`)
      ? FOOTPRINT_INSIDE
      : FOOTPRINT_OUTSIDE,
  );

  // Origin chosen so lattice index FOOTPRINT_LATTICE_CENTRE lands on cell 0.
  const origin = -FOOTPRINT_LATTICE_CENTRE;
  const segmentCount = marchLevel(
    FOOTPRINT_INSIDE,
    origin,
    origin,
    FOOTPRINT_EDGE_CROSSING,
  );
  // `wholeDomainInside` is false by construction: the guard above keeps the
  // footprint clear of the border, so the domain's corner sample is outside.
  const loops = assembleLoops(segmentCount, origin, origin, false).map(smoothLoop);

  // Every footprint forEachFootprintOffset produces is one solid, hole-free
  // blob, so anything else means the footprint rule changed underneath this
  // module and the outline it would draw is no longer trustworthy. All inputs
  // are constants, so this fires at startup or never.
  if (loops.length !== 1) {
    throw new RangeError(
      `brush radius ${radius} marched to ${loops.length} contour loops, expected 1`,
    );
  }
  return loops[0];
}

/** The outline as a closed line, in world units. */
function outlineGeometry(radius: number): BufferGeometry {
  const positions: number[] = [];
  for (const point of footprintOutline(radius)) {
    positions.push(point.x * CELL_WORLD_SIZE, 0, point.z * CELL_WORLD_SIZE);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}

export function createBrushPreview(scene: Scene, canvas: CursorSurface): BrushPreview {
  /** Index r - MIN_BRUSH_RADIUS holds radius r's boundary. Built once. */
  const geometries: BufferGeometry[] = [];
  for (let r = MIN_BRUSH_RADIUS; r <= MAX_BRUSH_RADIUS; r++) {
    geometries.push(outlineGeometry(r));
  }

  const material = new LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: OUTLINE_OPACITY,
    // Overlay semantics — see the module header.
    depthTest: false,
    depthWrite: false,
  });

  // LineLoop, not LineSegments: the outline is one closed contour now, so the
  // closing edge comes free instead of costing a duplicated vertex pair.
  const line = new LineLoop(geometries[0], material);
  line.renderOrder = 998;
  line.visible = false;
  scene.add(line);

  let shownRadius = MIN_BRUSH_RADIUS;

  /**
   * The ONE place either visibility is written. Both callers of `update` used
   * to be able to return early having hidden the line — with the cursor state
   * living in a second assignment, every such path was a chance to hide the
   * outline and leave the pointer hidden with nothing in its place. Routing
   * both through here makes "the arrow is hidden exactly while the outline is
   * drawn" true by construction rather than by remembering.
   */
  let showing = false;
  const show = (visible: boolean): void => {
    line.visible = visible;
    if (visible === showing) return;
    showing = visible;
    canvas.classList.toggle(OUTLINE_IS_CURSOR_CLASS, visible);
  };

  return {
    update(hover, radius) {
      if (hover === null) {
        show(false);
        return;
      }
      if (radius !== shownRadius) {
        const index = radius - MIN_BRUSH_RADIUS;
        // An out-of-range radius means a bug upstream (the HUD only offers the
        // legal set); hiding beats drawing a wrong promise.
        if (index < 0 || index >= geometries.length) {
          show(false);
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
      show(true);
    },
    dispose() {
      show(false);
      scene.remove(line);
      for (const g of geometries) g.dispose();
      material.dispose();
    },
  };
}
