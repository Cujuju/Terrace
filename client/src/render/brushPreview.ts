// The brush outline: a light line tracing the area the current brush will
// affect, following the cursor (owner, 2026-08-14: "Show me a light outline of
// the brush so I can see how much area I'm going to affect").
//
// WHICH cells is decided by RUNNING THE SCULPT (owner, 2026-08-22: "I want the
// outline to be exactly the same size as what I'm going to get for a single
// click on flat land"). The preview simulates one click of the current brush,
// with the current tool and edge, on a synthetic flat band-aligned map, and
// outlines the cells whose RENDERED BAND changed. Same applySculpt the server
// runs, options resolved through the same sculptOptionsOf both sides of the
// prediction contract use, so the promise and the stroke cannot disagree.
//
// IT USED TO OUTLINE THE FOOTPRINT — forEachFootprintOffset, the set of cells
// applyBrush touches — and that was a different question wearing the same
// shape. The footprint is cells whose stored HEIGHT moves; the player sees
// cells whose BAND moves, and terraced rendering floors height to its band, so
// most of a soft brush's footprint moves without appearing to. Measured on
// flat ground, one click, width of what renders:
//
//     brush   outlined   stamp+hard  stamp+soft  smooth+hard  smooth+soft
//     0.25      0.25        0.25        0.25        0.25         0.25
//     0.75      0.75        0.75        0.25        0.25         0.25
//     1.75      1.75        1.75        0.25        1.00         0.25
//     3.75      3.75        3.75        0.25        3.25         0.25
//     7.75      7.75        7.75        0.25        7.25         0.25
//
// One column of five was right. The old outline was the footprint, which is
// exactly the stamp+hard column — true for that one combination and silently
// over-promising for the other three. Worst at the small end and worst of all
// across a control that is not the size control: the 0.75 brush covered
// 0.75 units as a stamp and 0.25 as a smooth, a threefold change from the Tool
// row. That is what made a click unpredictable.
//
// THE GEOMETRY IS THEREFORE PER (RADIUS, TOOL, EDGE), and all of them are built
// at startup rather than on demand — 64 simulations, 24 ms measured, and it
// keeps the structural guards below firing at load or never, which is what they
// were written to promise. Showing, moving and hiding still allocates nothing.
//
// HOW that set is DRAWN is the terrain's business, and this is the whole point
// of the module (owner, 2026-08-19: "use the terrain's pipeline for the brush
// shape"). The outline used to be the polyomino boundary of the footprint —
// axis-aligned segments along cell edges. It was exact and it was foreign:
// nothing else in the world is drawn in cell-edge geometry, so radius 2's
// five-cell plus read as a shape from another renderer laid over the ground,
// and no amount of aligning it with the stamp could make the two look related.
//
// So that cell set is marched and smoothed by the code that marches and
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
// THE RING IS DRAWN AS AN OVERLAY, THE SKIRT IS NOT (owner, 2026-08-22: "the
// brush is drawn as if it's floating ... it is difficult to make out where it
// would be drawing"). The ring's depthTest is off and its render order is
// high, so it reads through terrain steps inside the footprint instead of
// being sliced by them. That is the honest presentation — the brush affects
// those cells whatever their current height — and it is what makes a single
// flat ring correct over terraced ground. What it does NOT do is say where
// that ring meets the ground: at one sampled height with depth testing off,
// nothing in the picture connects the ring to the terrain under it.
//
// So the same outline is also extruded straight DOWN into a thin translucent
// wall — the skirt — drawn with depthTest ON. Terrain occludes the wall
// wherever the ground is higher, so the visible bottom edge of the wall IS the
// line where the brush's boundary meets the terrain, resolved per pixel by the
// depth buffer. No height sampling, no per-frame geometry: the contact line
// falls out of the depth test that was already running.
//
// HOW FAR IT HANGS is derived, not chosen. MAX_STEP bounds every 4-neighbour
// height difference in the world (shared/constants.ts), and MAX_STEP equals
// BAND_HEIGHT, so the RENDERED (band-quantised) surface drops at most one band
// per cell of 4-neighbour travel. The furthest ground the outline passes over
// is therefore its own Manhattan reach, in bands, below the hovered cell — and
// that reach is measured from the footprint iterator itself rather than from a
// formula, so it cannot drift if the footprint's shape changes again.
//
// AND IT NEVER CROSSES THE EDGE OF THE CELLS IT PROMISES (owner, 2026-08-22:
// "draw the brush outline inside the cells the brush edits, not outside").
// Marching alone already guaranteed this — every crossing sits ON the shared
// edge of an inside cell and an outside one, so the raw contour traces the
// footprint's own boundary exactly. CHAIKIN IS WHAT BROKE IT: cutting a corner
// at a CONVEX step moves the line inward, which is the documented corner-clip
// above, but cutting one at a CONCAVE step — the notches a digitised disc is
// full of — moves it OUTWARD, over ground the brush will not touch. Measured
// before the fix: 0 stray vertices at radius 1, 2 and 4; 24 of 96 at radius 8
// and 48 of 160 at radius 16, overhanging by up to 0.1875 of a cell.
//
// So every smoothed vertex is clamped back into the union of the footprint's
// cells (clampIntoFootprint). It is a post-pass rather than a different
// smoother because the smoothing is the terrain's, shared on purpose, and this
// is a constraint the outline has that a terrain contour does not: a band
// boundary may lie anywhere, but a brush edge is a promise about whole cells.
//
// THE CELLS THEMSELVES ARE DRAWN (owner, 2026-08-22: "physically draw the
// outline of the cells inside of the brush outline ... in a darker colour").
// Only the INTERIOR edges — the ones shared by two footprint cells. The
// boundary edges are what the ring already traces, and drawing them twice
// would thicken and brighten exactly the line the grid is meant to stay under.
//
// ACCEPTED RESIDUAL: heightmap.ts's banded spill containment (issue #26)
// explicitly suspends the MAX_STEP invariant where a band cap binds, so an
// over-steep wall can exist. Where the outline crosses one, the skirt's bottom
// edge stops short and hangs in the air for that span. It is a visual hint
// falling back to the old floating-ring reading, not a wrong promise about
// which cells are edited.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  type Scene,
} from 'three';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  applySculpt,
  bandOf,
  createHeightmap,
  forEachFootprintOffset,
  sculptOptionsOf,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE } from '../config.ts';
import { bandColorOf } from '../terrain/bandColors.ts';
import {
  MAX_LATTICE_SPAN,
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
 * The skirt is fainter than the ring it hangs from, and deliberately so: the
 * ring is a LINE a few pixels wide, the skirt is a SURFACE that can cover a
 * large slice of the viewport at a low camera angle. At the ring's own opacity
 * it would read as a wall standing in the world rather than as a hint about
 * where that ring meets the ground, and it would tint the terrain the player
 * is trying to judge. A third of the ring's value is the most that still
 * resolves against the palette's lightest band (snow) at a glancing angle.
 */
const SKIRT_OPACITY = OUTLINE_OPACITY / 3;

/**
 * The cell grid inside the footprint: a mid grey rather than the ring's white,
 * so it is darker than the line it sits under at equal opacity, and dimmer
 * again so the ring stays the thing the eye lands on. Slightly green-biased
 * off neutral — a pure grey reads as UI laid over the world, and everything
 * else this module draws is trying to look like it belongs to the ground.
 */
const CELL_GRID_COLOR = 0x8b918a;

/**
 * A little over half the ring's opacity: present when the player looks for the
 * cell boundaries, gone when they are looking at the outline.
 */
const CELL_GRID_OPACITY = OUTLINE_OPACITY * 0.55;

/**
 * Half-length of the centre crosshair's arms, in world units — a fraction of a
 * cell so the mark fits inside even the smallest footprint without touching
 * its outline, and CONSTANT across radii so it reads as a pointer, not as part
 * of the (radius-scaling) stamp shape.
 */
const CROSSHAIR_ARM_WORLD_UNITS = CELL_WORLD_SIZE * 0.3;

/**
 * Gap between the crosshair's centre and where its arms begin, in world
 * units — leaves the exact centre pixel-clear so the point itself is legible.
 */
const CROSSHAIR_GAP_WORLD_UNITS = CELL_WORLD_SIZE * 0.08;

/**
 * The centre mark's opacity — a step brighter than the ring it sits inside,
 * because it is the POINTER: the OS arrow is hidden while it is drawn, so it
 * has to be the most legible thing the preview puts on screen.
 */
const CROSSHAIR_OPACITY = 1;

/**
 * The centre mark's own hue on a RISER — a saturated magenta, deliberately
 * outside everything the terrain palette holds (owner, 2026-08-27: "make the
 * crosshair a more visible colour"). The amber the outline uses sits too close
 * to soil and sand once it is lerped toward the band's colour, and the mark
 * is the pointer: it has to read at a glance against every band there is.
 */
const MARK_COLOR_RISER = 0xff2d95;

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
  /**
   * Whether the pointer is on the SIDE of a terrace step rather than its tread
   * (terrain/picking.ts's TerrainRayPick.hitRiser). Drives the outline's colour
   * only — the footprint is identical either way, because a click still sculpts
   * the same cell.
   */
  readonly hitRiser: boolean;
  /**
   * Whether a terrace lip is within grabbing range here — i.e. whether a press
   * would DRAG that band rather than stamp (input/sculptInput.ts asks the same
   * question of the same pick).
   *
   * It hides the footprint outline and leaves the bare crosshair (owner,
   * 2026-08-23). The ring is a promise about which cells one click will change,
   * and a drag does not keep that promise: it changes one cell, follows the
   * cursor, and its extent is however far the player pulls. Showing a
   * radius-4 stamp footprint over a lip the player is about to drag would
   * advertise an edit that is not the one about to happen — so the pointer
   * says only "here", which is all a drag actually commits to.
   *
   * IT IS THE TOOL-GATED FORM OF `band`: main.tsx sets it only for the Pull,
   * because only the Pull takes HOLD of a lip. The mark below reads both — see
   * `held` in `update` — so the Pull's pointer cannot promise a grab that the
   * press itself would not make.
   */
  readonly grabbable: boolean;
  /**
   * World-space point where the ray met the terrain — TerrainRayPick's
   * `hitX`/`hitY`/`hitZ`, one point.
   *
   * WHY THE MARK MOVED HERE (owner, 2026-08-27: "you can see where the mouse
   * cursor is, you can see the selected band, but the user is forced to
   * manually figure out where the two would intersect. I want that mouse
   * pointer to be pointing to those cells on the band lip"). Drawn at the cell
   * lattice position and `surfaceY`, the mark sits on the column's CAP — so on
   * a riser the pointer stood on top of the terrace whose SIDE the player was
   * aiming at, several bands above the lip they were about to grab, and the
   * two had to be intersected by eye.
   *
   * OPTIONAL, falling back to the cell centre at `surfaceY` — which is the
   * cap, and on a horizontal face the cap IS where the ray met the terrain, so
   * the fallback is exact for every hit that is not a riser.
   */
  readonly hitX?: number;
  readonly hitY?: number;
  readonly hitZ?: number;
  /**
   * The terrace band a press here would act on — World.highlightLayerEdge's
   * answer: the band whose slab the ray struck on a riser, admitted by the
   * overlay's lip-exists guard. Null when the pick names none, or when the
   * guard refused the one it named.
   *
   * The mark takes its TINT from it (see `riserMarkColor`), so the pointer and
   * the lit lip read as one object rather than two marks the player has to
   * associate. Optional, defaulting to null — a hover that does not say which
   * band it is on is drawn as one that has hold of nothing.
   */
  readonly band?: number | null;
}

/**
 * The brush as the outline needs it: everything about the player's selection
 * that changes what one click renders. Tool and edge are here for the same
 * reason radius is — see the table in the module header, where the Tool row
 * moves the 0.75 brush's mark by a factor of three.
 */
export interface BrushSelection {
  readonly radius: number;
  readonly tool: SculptTool;
  readonly profile: SculptProfile;
}

export interface BrushPreview {
  /** Shows the outline for `brush` at the hovered cell, or hides on null. */
  update(hover: BrushHover | null, brush: BrushSelection): void;
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
 * Outline colour when the pointer is on a terrace TREAD — the plain overlay
 * white the outline has always been.
 */
const OUTLINE_COLOR_CAP = 0xffffff;
/**
 * Outline colour when the pointer is on a terrace RISER (a step's side).
 * Amber rather than a second neutral: this is a MODE readout, and the whole
 * point is that it is unmistakable at a glance while sweeping the cursor over
 * terraced ground. It is the one hue in the preview, so it cannot be confused
 * with the dim grey cell grid or the white ring.
 */
const OUTLINE_COLOR_RISER = 0xffb347;

/**
 * Colour of the pointer mark when the pick names no band a press could act on
 * — a riser whose band the lip-exists guard REFUSED, so the stroke would be
 * emitted and then thrown away by the shared math.
 *
 * A dead neutral grey, and deliberately the one thing this module draws with
 * no hue at all: OUTLINE_COLOR_RISER says "you have this band", so its absence
 * has to be unmistakable rather than a shade of it. It is also why the mark
 * dims — see MARK_REFUSED_OPACITY.
 */
const MARK_COLOR_REFUSED = 0x9aa09b;

/**
 * Opacity of the pointer mark over a refused band, as a fraction of its
 * ordinary opacity. The mark must still be FINDABLE — it is standing in for
 * the mouse cursor, which may never vanish — but it is reporting that a press
 * here does nothing, and a hollowed-out mark says that without a second
 * symbol. Half is the most that still reads as deliberate rather than as the
 * mark fading out.
 */
const MARK_REFUSED_OPACITY = 0.5;

/**
 * How far the riser mark's amber is pulled toward the colour the terrain
 * itself paints the band the pointer has hold of.
 *
 * A MINORITY SHARE ON PURPOSE. The band tint is what ties the mark to the lip
 * lit under it (render/layerEdgeOverlay.ts draws that lip at the band's own
 * height), but the terrain palette is a smooth ramp, so neighbouring bands
 * differ by very little and a large share would only mud the amber without
 * telling the player anything they could name. A third is enough to read as
 * "this mark belongs to that band" while amber stays the hue that says RISER.
 */
const MARK_BAND_TINT_MIX = 1 / 3;

/**
 * The tool and edge the tread SEED sculpts with — input/sculptInput.ts's
 * `seedLayer` sends exactly this intent at the HUD's own radius, and the ring
 * drawn for a Drag press on a tread is that intent's footprint. Named here
 * rather than written twice: if the seed's shape ever changes, the ring that
 * promises it must change with it.
 */
const SEED_TOOL: SculptTool = 'stamp';
const SEED_PROFILE: SculptProfile = 'hard';

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
 * Cells of clear lattice the footprint needs beyond its own reach: one for the
 * outside samples that make the boundary crossings exist at all.
 */
const FOOTPRINT_LATTICE_MARGIN_CELLS = 1;

/**
 * Cells across the scratch lattice the footprint is marched on.
 *
 * ITS OWN SIZE SINCE 2026-08-21, having borrowed the CHUNK's until then. The
 * two were the same square while a brush was small next to a chunk; the
 * re-sample left the widest brush at four world units (MAX_BRUSH_RADIUS cells)
 * and made a chunk four world units in TOTAL, so the footprint stopped fitting
 * — and it was never a fact about chunks in the first place. Wide enough for
 * the largest footprint plus its clear margin on both sides, and even so it is
 * the marcher's scratch bound (contours.ts's MAX_LATTICE_SPAN) that the guard
 * below checks against.
 */
const FOOTPRINT_LATTICE_SPAN = 2 * (MAX_BRUSH_RADIUS + FOOTPRINT_LATTICE_MARGIN_CELLS);

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
const FOOTPRINT_LATTICE_CENTRE = FOOTPRINT_LATTICE_SPAN / 2;

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
    FOOTPRINT_LATTICE_SPAN ||
  FOOTPRINT_LATTICE_SPAN > MAX_LATTICE_SPAN
) {
  throw new RangeError(
    `brush radius ${MAX_BRUSH_RADIUS} does not fit a ${FOOTPRINT_LATTICE_SPAN}-cell contour lattice`,
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
/**
 * The cells one click moves, in both of the shapes this module needs them in:
 * the membership test the marcher samples, and the flat list the clamp and the
 * cell grid walk. Built once per (radius, tool, edge) so the two can never
 * describe different sets.
 */
interface Mark {
  readonly has: (dx: number, dy: number) => boolean;
  readonly cells: readonly (readonly [number, number])[];
}

/**
 * Cells across the synthetic map one click is simulated on.
 *
 * Wide enough that the widest brush plus the margin the marcher needs sits
 * clear of the border, for the same reason FOOTPRINT_LATTICE_SPAN is: a stroke
 * clipped by the map edge would be a different stroke, and a mark touching the
 * border would march differently. The smooth tool's relaxation cannot reach
 * past this either — player sculpts run `spill: 'banded'`, so no cell outside
 * the footprint may change BAND at all, which is precisely what is measured
 * here.
 */
const SIMULATION_SPAN_CELLS = 2 * (MAX_BRUSH_RADIUS + FOOTPRINT_LATTICE_MARGIN_CELLS + 1);

/** Height every cell of the synthetic map starts at: flat, and on a band floor. */
const SIMULATION_GROUND_HEIGHT = 0;

/**
 * The cells a single click of this brush would visibly move, on flat ground.
 *
 * RUNS THE REAL SCULPT. `applySculpt` is the function the server applies and
 * the client predicts with, and the options come from `sculptOptionsOf` — the
 * one place "an intent means this" is decided, which both sides of the
 * prediction contract already call. So this is not a model of the stroke that
 * has to be kept in step with it; it IS the stroke, run once on a scratch map.
 *
 * BAND CHANGED, NOT HEIGHT CHANGED. Terraced rendering draws `bandOf(height)`,
 * so a cell whose height moved within its band is invisible to the player and
 * has no business inside a line that promises what they will see.
 *
 * FLAT GROUND IS THE PREMISE, and it is the owner's ("what I'm going to get for
 * a single click on flat land"). It has to be a premise rather than a reading
 * of the terrain under the cursor: how much of a soft brush's falloff clears
 * the next band depends on how far the ground already sits above its band
 * floor, which is a quantity the player cannot see — sixteen different stored
 * heights all draw as the same flat plain. An outline computed from live ground
 * would resize as the cursor crossed terrain that looks identical, which is
 * less predictable than one honest premise, not more.
 */
function oneClickMark(radius: number, tool: SculptTool, profile: SculptProfile): Mark {
  const map = createHeightmap(SIMULATION_SPAN_CELLS);
  const centre = SIMULATION_SPAN_CELLS >> 1;
  map.cells.fill(SIMULATION_GROUND_HEIGHT);

  const before = bandOf(SIMULATION_GROUND_HEIGHT);
  applySculpt(
    map,
    centre,
    centre,
    radius,
    DEFAULT_SCULPT_AMOUNT,
    // `dir` and the amount only have to be a legal RAISE — the mark's
    // shape is symmetric between raise and lower on the band-aligned ground
    // this simulates (applyLevelFillBrush's own note), so one direction
    // answers for both.
    sculptOptionsOf({ type: 'sculpt', x: centre, y: centre, radius, dir: 1, tool, profile }),
  );

  const keys = new Set<string>();
  const cells: (readonly [number, number])[] = [];
  for (let j = 0; j < SIMULATION_SPAN_CELLS; j++) {
    for (let i = 0; i < SIMULATION_SPAN_CELLS; i++) {
      if (bandOf(map.cells[j * SIMULATION_SPAN_CELLS + i]!) === before) continue;
      const dx = i - centre;
      const dy = j - centre;
      keys.add(`${dx},${dy}`);
      cells.push([dx, dy]);
    }
  }
  // A brush that moves nothing has nothing to outline, and every combination
  // moves at least the clicked cell — so an empty mark means the sculpt rules
  // changed underneath this module. All inputs are constants; startup or never.
  if (cells.length === 0) {
    throw new RangeError(`brush radius ${radius} (${tool}, ${profile}) renders no change`);
  }
  return { has: (dx, dy) => keys.has(`${dx},${dy}`), cells };
}

/**
 * The nearest point to `x, z` that lies inside the union of the footprint's
 * cells, each cell being the unit square centred on its own coordinates.
 *
 * A vertex already inside a footprint cell is returned untouched, which is
 * every vertex at radius 1, 2 and 4 and most of them above — the scan only
 * runs for the handful Chaikin pushed over a concave step. Clamping to the
 * nearest cell's box (rather than, say, pulling the vertex toward the centre)
 * keeps the correction perpendicular to the edge it crossed, so the smoothed
 * curve is nudged back onto the boundary instead of being kinked toward the
 * middle of the brush.
 */
function clampIntoMark(x: number, z: number, mark: Mark): [number, number] {
  if (mark.has(Math.round(x), Math.round(z))) return [x, z];
  let bestX = x;
  let bestZ = z;
  let bestDistance = Infinity;
  for (const [cx, cz] of mark.cells) {
    const nx = x < cx - 0.5 ? cx - 0.5 : x > cx + 0.5 ? cx + 0.5 : x;
    const nz = z < cz - 0.5 ? cz - 0.5 : z > cz + 0.5 ? cz + 0.5 : z;
    const dx = x - nx;
    const dz = z - nz;
    const distance = dx * dx + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestX = nx;
      bestZ = nz;
    }
  }
  return [bestX, bestZ];
}

function markOutline(radius: number, mark: Mark): ContourLoop {
  loadSampleField(
    (i, j) =>
      mark.has(i - FOOTPRINT_LATTICE_CENTRE, j - FOOTPRINT_LATTICE_CENTRE)
        ? FOOTPRINT_INSIDE
        : FOOTPRINT_OUTSIDE,
    FOOTPRINT_LATTICE_SPAN,
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

  // The clamp — see the module header. Smoothing runs first so the curve is
  // still the terrain's shape; this only pulls back the vertices it pushed
  // over a concave step.
  for (const point of loops[0]) {
    const [x, z] = clampIntoMark(point.x, point.z, mark);
    point.x = x;
    point.z = z;
  }
  return loops[0];
}

/**
 * The cell boundaries INSIDE the mark, as a flat line-segment soup in
 * cell coordinates.
 *
 * Interior edges only: an edge is emitted for a mark cell's +x or +z
 * neighbour exactly when that neighbour is also in the mark. Every edge
 * therefore appears once (it is emitted by the lower-coordinate cell of the
 * pair and by nobody else), and no edge of the footprint's own boundary is
 * emitted at all — that line is the ring's, and drawing it twice would
 * brighten the one thing this grid is meant to stay beneath.
 */
function cellGridSegments(mark: Mark): number[] {
  const segments: number[] = [];
  for (const [dx, dy] of mark.cells) {
    if (mark.has(dx + 1, dy)) {
      // Shared edge with the cell to the +x side: vertical, at their midpoint.
      segments.push(dx + 0.5, dy - 0.5, dx + 0.5, dy + 0.5);
    }
    if (mark.has(dx, dy + 1)) {
      segments.push(dx - 0.5, dy + 0.5, dx + 0.5, dy + 0.5);
    }
  }
  return segments;
}

/**
 * How far below the ring the skirt must hang to be certain of reaching the
 * ground everywhere the outline passes over, in world units.
 *
 * DERIVED FROM THE FOOTPRINT, NOT PICKED. MAX_STEP bounds every 4-neighbour
 * height difference in the world and equals BAND_HEIGHT, so the band-quantised
 * surface the player sees drops at most ONE BAND per cell of 4-neighbour
 * travel. The deepest ground under the outline is therefore its Manhattan
 * reach in bands below the hovered cell — and the reach is measured by running
 * the footprint iterator itself, so a change to the footprint's shape carries
 * into this number instead of silently invalidating a formula.
 *
 * The `+ 1` is the OUTSIDE cell of each boundary crossing: the outline sits on
 * the edge between the outermost footprint cell and its neighbour, and that
 * neighbour is one 4-neighbour step further out than anything the iterator
 * reports. The lift is added back because the skirt hangs from the RING, which
 * floats OUTLINE_LIFT_WORLD_UNITS above the surface rather than on it.
 */
function skirtDropWorldUnits(mark: Mark): number {
  let manhattanReachCells = 0;
  for (const [dx, dy] of mark.cells) {
    manhattanReachCells = Math.max(manhattanReachCells, Math.abs(dx) + Math.abs(dy));
  }
  return (manhattanReachCells + 1) * BAND_WORLD_HEIGHT + OUTLINE_LIFT_WORLD_UNITS;
}

/**
 * The ring, its skirt and the cell grid inside it — all in world units, all
 * from ONE march of ONE simulated click.
 */
interface BrushGeometry {
  readonly ring: BufferGeometry;
  readonly skirt: BufferGeometry;
  readonly cellGrid: BufferGeometry;
}

function brushGeometry(
  radius: number,
  tool: SculptTool,
  profile: SculptProfile,
): BrushGeometry {
  const mark = oneClickMark(radius, tool, profile);
  const outline = markOutline(radius, mark);
  const drop = skirtDropWorldUnits(mark);

  const ringPositions: number[] = [];
  for (const point of outline) {
    ringPositions.push(point.x * CELL_WORLD_SIZE, 0, point.z * CELL_WORLD_SIZE);
  }
  const ring = new BufferGeometry();
  ring.setAttribute('position', new Float32BufferAttribute(ringPositions, 3));

  // One quad per outline segment, wrapping at the end because the loop is
  // closed (the same reason the ring is a LineLoop). Two triangles each,
  // non-indexed: at a few dozen segments the index buffer would cost more to
  // read than it saves, and this is built once at startup.
  const skirtPositions: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const ax = a.x * CELL_WORLD_SIZE;
    const az = a.z * CELL_WORLD_SIZE;
    const bx = b.x * CELL_WORLD_SIZE;
    const bz = b.z * CELL_WORLD_SIZE;
    skirtPositions.push(
      ax, 0, az, bx, 0, bz, bx, -drop, bz,
      ax, 0, az, bx, -drop, bz, ax, -drop, az,
    );
  }
  const skirt = new BufferGeometry();
  skirt.setAttribute('position', new Float32BufferAttribute(skirtPositions, 3));

  // The cell grid, flat at the ring's own height: a pair of (x, z) per segment
  // end, lifted into 3-space here rather than in cellGridSegments so that
  // function stays about the footprint and knows nothing about world units.
  const gridPositions: number[] = [];
  const flat = cellGridSegments(mark);
  for (let i = 0; i < flat.length; i += 2) {
    gridPositions.push(flat[i]! * CELL_WORLD_SIZE, 0, flat[i + 1]! * CELL_WORLD_SIZE);
  }
  const cellGrid = new BufferGeometry();
  cellGrid.setAttribute('position', new Float32BufferAttribute(gridPositions, 3));

  return { ring, skirt, cellGrid };
}

/**
 * What the preview adds to the scene, as draw objects — its share of the
 * frame's draw budget (part B of
 * docs/plans/frame-budget-growth-and-draw-calls.md; core is held to the same
 * ratchet as a plugin).
 *
 * FOUR, ALL CREATED AT BOOT AND ONLY EVER HIDDEN, which is why this is a
 * constant rather than a live count: the outline LineLoop, the skirt, the cell
 * grid and the crosshair. `visible = false` takes them out of the walk but not
 * out of the budget — the budget is the ceiling, and a preview under the
 * cursor has all four up.
 */
export const BRUSH_PREVIEW_DRAW_OBJECTS = 4;

export function createBrushPreview(scene: Scene, canvas: CursorSurface): BrushPreview {
  /**
   * Every (radius, tool, edge) the wire allows, built once at startup — see the
   * module header for the cost and for why it is eager rather than lazy.
   */
  const geometries = new Map<string, BrushGeometry>();
  const key = (radius: number, tool: SculptTool, profile: SculptProfile): string =>
    `${radius}|${tool}|${profile}`;
  for (let r = MIN_BRUSH_RADIUS; r <= MAX_BRUSH_RADIUS; r++) {
    for (const tool of SCULPT_TOOLS) {
      // THE PULL AND THE CARVE HAVE NO FOOTPRINT OF THEIR OWN TO CACHE.
      // Building a ring, a skirt and a cell grid under either tool's own key
      // would be part of this eager cache that nothing ever displays. Skipped
      // here rather than filtered at the draw site so the cache holds exactly
      // what is drawable.
      //
      // The PULL has no footprint of its own: what it changes is however far
      // the player drags. Its one press with an exact extent is the tread SEED,
      // and that is a hard stamp (SEED_TOOL/SEED_PROFILE), so `update` draws it
      // from the stamp's entry — the same simulation, not a duplicate of it.
      //
      // The CARVE has a footprint, but not one this cache can answer for:
      // `oneClickMark` runs the real sculpt on FLAT GROUND, and flat ground is
      // precisely where `canCarveBandAt` refuses every cell (columns.ts) — so
      // the honest flat-ground mark for a carve is empty, and a ring drawn from
      // it would promise a footprint the tool will not deliver. Which cells a
      // carve takes depends on where the open air beside them is, which is
      // terrain the flat-ground premise cannot express; the mark
      // under-promises instead.
      if (tool === 'drag' || tool === 'carve') continue;
      for (const profile of SCULPT_PROFILES) {
        geometries.set(key(r, tool, profile), brushGeometry(r, tool, profile));
      }
    }
  }
  const initial = geometries.get(
    key(MIN_BRUSH_RADIUS, SCULPT_TOOLS[0]!, SCULPT_PROFILES[0]!),
  )!;

  const material = new LineBasicMaterial({
    color: OUTLINE_COLOR_CAP,
    transparent: true,
    opacity: OUTLINE_OPACITY,
    // Overlay semantics — see the module header.
    depthTest: false,
    depthWrite: false,
  });

  // LineLoop, not LineSegments: the outline is one closed contour now, so the
  // closing edge comes free instead of costing a duplicated vertex pair.
  const line = new LineLoop(initial.ring, material);
  line.renderOrder = 998;
  line.visible = false;
  scene.add(line);

  // The skirt: the same outline hung downward as a translucent wall, and the
  // ONE part of the preview that is depth-tested — see the module header. Its
  // bottom edge is wherever the terrain cuts it, which is the whole point, so
  // depthWrite stays off (it must not occlude the world or itself) and both
  // faces are drawn (the camera orbits, so either side can face it).
  const skirtMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: SKIRT_OPACITY,
    side: DoubleSide,
    depthWrite: false,
  });
  const skirt = new Mesh(initial.skirt, skirtMaterial);
  // Below the two overlays: it is part of the world's depth-sorted pass, and
  // the ring and crosshair are meant to sit on top of it.
  skirt.renderOrder = 997;
  skirt.visible = false;
  scene.add(skirt);

  // The cell grid inside the ring: which cells, exactly, drawn one step down
  // in weight from the ring so it reads as detail rather than as a second
  // outline. Same overlay semantics as the ring (depthTest off, high render
  // order) — it describes the same set of cells and must read through the same
  // terrace steps, or the two would disagree over stepped ground.
  const cellGridMaterial = new LineBasicMaterial({
    color: CELL_GRID_COLOR,
    transparent: true,
    opacity: CELL_GRID_OPACITY,
    depthTest: false,
    depthWrite: false,
  });
  const cellGrid = new LineSegments(initial.cellGrid, cellGridMaterial);
  // Under the ring and the crosshair, over the skirt.
  cellGrid.renderOrder = 998;
  cellGrid.visible = false;
  scene.add(cellGrid);

  // A fine fixed-size crosshair at the footprint's centre: the outline grows
  // with the brush, so on large stamps the hovered cell is only implied by
  // symmetry — the owner asked for "a fine crosshair in the middle of the
  // brush stamp" to mark exactly where the mouse is. Same overlay material
  // family (depthTest off, high render order) and lifted with the outline.
  // Built once; its size does not vary with radius by design.
  const crosshairMaterial = new LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: CROSSHAIR_OPACITY,
    depthTest: false,
    depthWrite: false,
  });
  const arm = CROSSHAIR_ARM_WORLD_UNITS;
  const gap = CROSSHAIR_GAP_WORLD_UNITS;
  const crosshairGeometry = new BufferGeometry();
  crosshairGeometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        -arm, 0, 0, -gap, 0, 0,
        gap, 0, 0, arm, 0, 0,
        0, 0, -arm, 0, 0, -gap,
        0, 0, gap, 0, 0, arm,
      ],
      3,
    ),
  );
  const crosshair = new LineSegments(crosshairGeometry, crosshairMaterial);
  crosshair.renderOrder = 999;
  crosshair.visible = false;
  scene.add(crosshair);

  /**
   * Scratch colours for the crosshair's per-frame tint. Reused rather than
   * allocated: `update` runs every frame the pointer or the camera moves, and
   * this module's stated promise is that showing, moving and hiding allocate
   * nothing.
   */
  const markColor = new Color();
  const bandTint = new Color();

  /**
   * Paints the crosshair for a RISER hit: the riser amber pulled part of the
   * way toward the colour the terrain itself paints the band under the
   * pointer, or the refused grey when there is no band to act on.
   */
  const paintRiserMark = (band: number | null): void => {
    if (band === null) {
      crosshairMaterial.color.setHex(MARK_COLOR_REFUSED);
      crosshairMaterial.opacity = CROSSHAIR_OPACITY * MARK_REFUSED_OPACITY;
      return;
    }
    markColor.setHex(MARK_COLOR_RISER, SRGBColorSpace);
    // `bandColorOf` takes a HEIGHT, and band k's slab tops out at
    // k·BAND_HEIGHT — the height the terrain paints that band's cap with.
    const [r, g, b] = bandColorOf(band * BAND_HEIGHT);
    bandTint.setRGB(r, g, b, SRGBColorSpace);
    crosshairMaterial.color.copy(markColor.lerp(bandTint, MARK_BAND_TINT_MIX));
    crosshairMaterial.opacity = CROSSHAIR_OPACITY;
  };

  /** The plain white centre mark: the pointer over anything but a riser face. */
  const paintFlatMark = (): void => {
    crosshairMaterial.color.setHex(OUTLINE_COLOR_CAP);
    crosshairMaterial.opacity = CROSSHAIR_OPACITY;
  };

  /** The key currently bound to the three objects, so a still brush rebinds nothing. */
  let shownKey = key(MIN_BRUSH_RADIUS, SCULPT_TOOLS[0]!, SCULPT_PROFILES[0]!);

  /**
   * The ONE place either visibility is written. Both callers of `update` used
   * to be able to return early having hidden the line — with the cursor state
   * living in a second assignment, every such path was a chance to hide the
   * outline and leave the pointer hidden with nothing in its place. Routing
   * both through here makes "the arrow is hidden exactly while the outline is
   * drawn" true by construction rather than by remembering.
   */
  let showing = false;
  /**
   * `crosshairOnly` drops the footprint parts and keeps the centre mark — the
   * drag pointer (see BrushHover.grabbable). The cursor class still follows
   * `visible` alone: the crosshair IS the pointer in that state, so hiding the
   * arrow is just as right as when the full outline stands in for it.
   */
  const show = (visible: boolean, crosshairOnly = false): void => {
    const footprint = visible && !crosshairOnly;
    line.visible = footprint;
    skirt.visible = footprint;
    cellGrid.visible = footprint;
    crosshair.visible = visible;
    if (visible === showing) return;
    showing = visible;
    canvas.classList.toggle(OUTLINE_IS_CURSOR_CLASS, visible);
  };

  return {
    update(hover, brush) {
      if (hover === null) {
        show(false);
        return;
      }
      // THE POINT THE RAY MET THE TERRAIN. Optional on the hover, because the
      // cell centre at the cap IS that point on every horizontal face — see
      // BrushHover.hitX. Read once here so no branch below can forget the
      // fallback and put the pointer back on top of the terrace.
      const atX = hover.hitX ?? hover.x * CELL_WORLD_SIZE;
      const atY = hover.hitY ?? hover.surfaceY;
      const atZ = hover.hitZ ?? hover.y * CELL_WORLD_SIZE;

      // A DRAG PRESS ON A TREAD SEEDS, and the seed has an exact footprint
      // (input/sculptInput.ts's takeHold → seedLayer): a hard stamp of one
      // band at the HUD's radius. So the pointer promises it with the ring for
      // that very combination — the KNOWN GAP this comment used to record is
      // closed. It could be closed because there is no grab RANGE any more:
      // under the riser-only rule a tread always seeds and a riser always
      // grabs, so the two pointer shapes cannot flicker into each other as the
      // cursor sweeps past a lip.
      //
      // "On a tread" means the ray crossed this span's own CAP. Lower down the
      // same horizontal test is a cave roof's UNDERSIDE, where a raise is
      // refused outright and there is nothing to promise.
      const onTread = !hover.hitRiser && atY === hover.surfaceY;
      const seeding = brush.tool === 'drag' && onTread;

      // THE PULL AND THE CARVE ARE POINTED, NOT OUTLINED, everywhere else — a
      // ring is a promise about which cells one click will change, and neither
      // tool keeps it: the Pull changes however far the player drags, and the
      // Carve's reach depends on where the open air beside the cut is, which
      // the flat-ground premise cannot express. Over a riser the layer-edge
      // overlay lights the band's lip beside the mark, which is the affordance
      // that says what a press takes hold of.
      if (!seeding && (brush.tool === 'drag' || brush.tool === 'carve')) {
        if (hover.hitRiser) {
          // THE MARK GOES WHERE THE RAY MET THE FACE, and NOTHING is drawn at
          // the column's cap (owner, 2026-08-27). Drawing at the cap is the
          // "stuck on the top terrace" defect: on a cliff that drops five
          // bands the cap is five bands above the lip being aimed at.
          //
          // A PRESS THAT WOULD TAKE HOLD is amber tinted by its band; one that
          // would not is the refused grey. `grabbable` and `band` are both
          // read, and both do work: `band` is the aimed band for either tool,
          // while `grabbable` is main.tsx's tool-gated statement that a press
          // will actually GRAB — true only for the Pull. They agree by
          // construction, and on the Pull the conjunction means a regression in
          // either derivation shows a refused mark rather than promising a hold
          // the press will not make. The Carve does not grab: it cuts from the
          // aimed band, so `band` alone answers for it.
          const band = hover.band ?? null;
          const held = band !== null && (brush.tool !== 'drag' || hover.grabbable);
          paintRiserMark(held ? band : null);
          crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
          show(true, true);
          return;
        }
        // A tread with the Carve, or either tool on a cave roof's underside:
        // the bare mark at the cell, which is where the ray met the horizontal
        // face anyway.
        paintFlatMark();
        crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
        show(true, true);
        return;
      }
      const wanted = seeding
        ? key(brush.radius, SEED_TOOL, SEED_PROFILE)
        : key(brush.radius, brush.tool, brush.profile);
      if (wanted !== shownKey) {
        const geometry = geometries.get(wanted);
        // An unknown combination means a bug upstream (the HUD only offers the
        // legal sets); hiding beats drawing a wrong promise.
        if (geometry === undefined) {
          show(false);
          return;
        }
        line.geometry = geometry.ring;
        skirt.geometry = geometry.skirt;
        cellGrid.geometry = geometry.cellGrid;
        shownKey = wanted;
      }
      // The riser/cap readout, on the ring and its skirt. The crosshair has its
      // own material and its own rule — see paintRiserMark — because on a
      // riser the two no longer sit in the same place: the ring lies on the
      // footprint's tread, the mark stands on the face.
      material.color.setHex(hover.hitRiser ? OUTLINE_COLOR_RISER : OUTLINE_COLOR_CAP);
      skirtMaterial.color.setHex(hover.hitRiser ? OUTLINE_COLOR_RISER : OUTLINE_COLOR_CAP);
      paintFlatMark();
      const lift = hover.surfaceY + OUTLINE_LIFT_WORLD_UNITS;
      line.position.set(hover.x * CELL_WORLD_SIZE, lift, hover.y * CELL_WORLD_SIZE);
      crosshair.position.copy(line.position);
      skirt.position.copy(line.position);
      cellGrid.position.copy(line.position);
      show(true);
    },
    dispose() {
      show(false);
      scene.remove(line);
      scene.remove(crosshair);
      scene.remove(skirt);
      scene.remove(cellGrid);
      for (const g of geometries.values()) {
        g.ring.dispose();
        g.skirt.dispose();
        g.cellGrid.dispose();
      }
      material.dispose();
      crosshairGeometry.dispose();
      crosshairMaterial.dispose();
      skirtMaterial.dispose();
      cellGridMaterial.dispose();
    },
  };
}
