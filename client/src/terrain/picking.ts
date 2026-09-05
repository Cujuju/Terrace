// Pointer → cell picking maths. Pure: no Three.js, no DOM types beyond a
// plain rectangle shape, so it is unit-tested headless.
//
// The WHOLE pick lives here now: screen pixel to normalised device
// coordinates, and then the ray itself, marched over the height field
// (pickTerrainCellByRay, below). Callers keep only the one job that needs
// Three — unprojecting the pointer through the camera to get the ray — and
// hand the result straight back.
//
// It used to be the other way round: the raycast lived in
// input/sculptInput.ts because it needed the live meshes, and this module held
// only the maths either side of it. Picking no longer touches the meshes at
// all; see pickTerrainCellByRay's header for why that changed.

import {
  CHUNK_SIZE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  chunkIndex,
  isSpanDrawn,
  spanAt,
  spanUndersideHeight,
  spanCapHeight,
  spanCount,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { hasChunk, type TerrainMirror } from './mirror.ts';
import type { CellOccupancy, CellRayChord } from './occupancy.ts';

/** Re-exported so a caller of the pick below needs one import, not two. */
export type { CellColumn, CellOccupancy, CellRayChord } from './occupancy.ts';

export interface Ndc {
  x: number;
  y: number;
}

/** The parts of a DOMRect this module needs. */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CellPick {
  x: number;
  y: number;
}

/**
 * Screen pixel → normalised device coordinates, the [-1, 1] square Three's
 * Raycaster expects. Y is flipped because page coordinates grow downward
 * while NDC grows upward.
 *
 * A zero-sized rect (canvas not laid out yet) would divide by zero, so it is
 * reported as "no valid position" rather than NaN propagating into a raycast.
 */
export function pointerToNdc(
  clientX: number,
  clientY: number,
  rect: ViewportRect,
): Ndc | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((clientY - rect.top) / rect.height) * 2 - 1),
  };
}

/**
 * World-space hit point → the cell to sculpt.
 *
 * Cell (x, y) is centred on world (x·CELL_WORLD_SIZE, height, y·CELL_WORLD_SIZE)
 * — see config.CELL_WORLD_SIZE — so this divides into cell space and rounds.
 *
 * THE DIVIDE IS NOT DECORATION (2026-08-21). CELL_WORLD_SIZE was 1 until the
 * re-sample, so world X/Z WERE cell coordinates and this was pure rounding;
 * a cell is a quarter of a world unit now, and without the divide every pick
 * lands four times too close to the origin.
 *
 * ROUNDING, not flooring: a vertex IS a cell, and sculpting raises vertices,
 * so the cell the user means is the nearest vertex to the point they clicked,
 * not the lower-left corner of the quad they clicked inside. Flooring makes a
 * click on the right half of a tread lift the tread to its left, which reads
 * as an off-by-one to the player.
 *
 * CLAMPS TO THE EDGE CELL, never rejects a finite point (owner decision
 * 2026-09-01, issue #281 A). The one caller is the drag's plane intersection
 * (input/sculptInput.ts dragPlaneCell): the grab-height plane is infinite and
 * the world is not, and this used to answer a point past half a cell beyond
 * the last cell centre with null, which the drag treated as "hold". A slow
 * pull never noticed — its last cell crossing had already landed on the edge
 * cell — but a flick from well inside straight onto the drawn rim, or off the
 * world, dropped that sample and left the lip one or more cells short of the
 * border until the cursor came back. Pulling past the edge means pulling TO
 * the edge, so the nearest edge cell is the answer. Only a non-finite input
 * has no nearest cell and returns null.
 *
 * (The click/hover pick never went through here: pickTerrainCellByRay returns
 * the cell it marched, so it had no edge gap to close.)
 */
export function worldPointToCell(
  worldX: number,
  worldZ: number,
  worldSize: number,
): CellPick | null {
  const max = worldSize - 1;
  const cellX = worldX / CELL_WORLD_SIZE;
  const cellZ = worldZ / CELL_WORLD_SIZE;
  if (!Number.isFinite(cellX) || !Number.isFinite(cellZ)) {
    return null;
  }

  // `<= 0` rather than `< 0`: rounding a small negative gives -0, which is not
  // less than 0 and would otherwise leak a negative zero out as a cell index.
  const clamp = (v: number): number => (v <= 0 ? 0 : v > max ? max : v);
  return { x: clamp(Math.round(cellX)), y: clamp(Math.round(cellZ)) };
}

// ---------------------------------------------------------------------------
// Ray → cell, by marching the height field.
// ---------------------------------------------------------------------------
//
// CRITICAL CODE — this is the input path: what it returns is the cell the
// player sculpts, so it must agree with what they are looking at.
//
// WHY THIS REPLACED THE MESH RAYCAST (2026-08-21). Picking used to be
// `Raycaster.intersectObjects(chunk meshes)` — brute-force ray/triangle over
// every chunk the ray's bounding sphere crossed. Its cost is therefore
// proportional to TRIANGLES, and the hover outline re-picks on every camera
// change (see input/sculptInput.ts's hoverKey), so a pan paid it once per
// frame. Measured in a live 512² world after the BAND_HEIGHT 64 → 16
// re-terrace: 29.5 ms for one centre-screen pick, testing 214,786 triangles
// across 6 chunks — a whole 60 fps frame budget, spent before anything drew,
// and it got there by scaling with the band count.
//
// Terrain is a HEIGHT FIELD, and the client already holds all of it
// (terrain/mirror.ts, 512 KB at a 512² world), so the query has a closed form:
// walk the cells the ray crosses in order and stop at the first column it
// enters at or below the top of. That is bounded by CELLS CROSSED, not
// triangles — a few hundred integer steps — and, the point of the exercise, it
// is INDEPENDENT OF BAND COUNT, so re-terracing can never make picking slower
// again.
//
// WHY THIS IS EXACT, not an approximation. vertexGrid.ts's stated honesty
// invariant is that the topmost cap over a cell CENTRE sits at exactly
// `quantizeToBand(h)` — marching squares classifies a sample as inside iff
// `h >= k·BAND_HEIGHT`, and CONTOUR_CELL_CENTRE_GUARD keeps every contour
// vertex clear of every cell centre so no amount of Chaikin smoothing can drag
// an outline across one. So a column of height `quantizeToBand(h)` per cell IS
// the rendered surface, sampled at the only points picking cares about; the
// smoothed contour only decides where within a cell the riser falls, and the
// pick rounds to a whole cell regardless.
//
// The column is treated as SOLID from its cap downward. That is not a
// simplification either: consecutive bands' skirts tile a cliff face from the
// cap down to the neighbouring column's cap, and below that the neighbour
// itself occludes, so there is no gap in the drawn surface to fall through.
//
// WHERE IT DIVERGES FROM THE OLD RAYCAST, measured rather than assumed. Over
// 1,000 oblique picks swept across a full orbit of a live 512² world:
//
//   - 738 name the identical cell.
//   - 211 differ by exactly one cell, and ALL 211 are rays that struck a
//     CLIFF FACE. On a face the two rules genuinely differ: the mesh draws
//     that face on the smoothed contour, which wanders within the boundary
//     cell, so rounding its hit point to the nearest centre named the cliff
//     233 times and the ground at its FOOT the other 8 — arbitrarily, decided
//     by which side of the cell centre the contour happened to fall. The
//     march has no such coin to flip: the face belongs to the column behind
//     it, so clicking a cliff always sculpts the cliff. That is the intended
//     answer, and 'picks the tall cell when a shallow ray strikes its riser'
//     in test/picking.test.ts pins it.
//   - 51 differ by more, all at shallow pitch (mean disagreement 0.23 cells
//     above 35° of pitch, 2.05 cells below 20°). These are silhouette grazes,
//     where clipping a ridge or clearing it decides between two points far
//     apart; 70 of them are rays the RAYCAST cannot answer stably either — a
//     1.3-pixel nudge moves its own answer as far. Ill-conditioned, not
//     mis-picked.
//
// Straight down — the case vertexGrid.ts's invariant actually promises, and
// the one a click on open ground is — 1,600 of 1,600 probes name the same
// cell, and the height matches the mirror except on seabed caps, which the
// renderer deliberately sinks by SEABED_CAP_SINK to keep off the water plane.
//
// KNOWN DIVERGENCE, named: a camera INSIDE terrain picks the column it is
// inside, where the mesh raycast returned nothing (Three's default FrontSide
// material ignores back faces). Unreachable in play — CAMERA_MIN_DISTANCE
// keeps the camera clear — and "the cell you are buried in" is the more useful
// answer than "nothing" if it ever is reached.

/**
 * A world-space point or direction. Declared here as a plain shape rather than
 * imported from Three, so this module stays headless-testable — the caller
 * hands over `raycaster.ray.origin` / `.direction`, which are structurally
 * this.
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Where a ray met the terrain.
 *
 * TWO KINDS OF FIELD LIVE IN HERE, and telling them apart is the whole of the
 * hover-pick contract (2026-09-04, issue #324).
 *
 *   - FACTS ABOUT THE RAY — `x`, `y`, `hitRiser`, `hitY`, `hitX`, `hitZ`. They
 *     describe where the player aimed, and aiming does not go stale when the
 *     ground moves.
 *   - A SNAPSHOT OF THE MAP — `spanIndex` and `surfaceY`. They are only names
 *     for what the column held at the instant this pick was marched.
 *
 * SO A PICK MUST NEVER BE CACHED ACROSS AN EDIT. `spanIndex` is a position in
 * a list whose length is state (columns.ts's `spanIndexCoveringBand` says so
 * outright): a carve that splits a column, or a raise that welds two of its
 * spans, renumbers every span above the change, and a kept index then names a
 * different span rather than a moved one. Patching the snapshot half back up
 * after an edit — which is what the client used to do — makes a dead claim
 * look like a live one.
 *
 * THE ONE CACHE IS `hoverTarget` (input/sculptInput.ts), and it does not cache
 * this object: it pins the CELL and the RAY and re-derives the pick from the
 * live map through `pickTerrainInColumn` on every read.
 */
export interface TerrainRayPick {
  /** Cell coordinates, always in bounds and in a received chunk. */
  readonly x: number;
  readonly y: number;
  /**
   * World-space Y of the RENDERED surface the ray met — the band cap of the
   * span it struck, which for a column of one span is the height the mesh
   * draws there (World.terrainHeightAt's value).
   *
   * Always the CAP, never the point on the riser the ray happened to graze:
   * the consumer is the hover outline (render/brushPreview.ts), which marks
   * the footprint about to be sculpted, and that footprint lies on the tread.
   *
   * MAP-DERIVED: valid only for the map this pick was marched against. See the
   * interface header.
   */
  readonly surfaceY: number;
  /**
   * WHICH SPAN of the column the ray met, indexed as columns.ts indexes them:
   * 0 is the deepest, `spanCount - 1` the one carrying the walkable surface.
   *
   * Always the last index while every column holds one span. It is what lets a
   * consumer answer "which layer did I click" once they do not — a ray can
   * enter a cave mouth and strike a floor with a ceiling above it, and the cell
   * coordinates alone cannot say which of them was hit.
   *
   * MAP-DERIVED, and the most perishable field on this interface: valid only
   * for the map this pick was marched against. See the interface header.
   */
  readonly spanIndex: number;
  /**
   * Whether the ray struck this span's vertical RISER rather than a flat face —
   * i.e. the player is pointing at the SIDE of a terrace step, not at its
   * tread.
   *
   * False therefore means a HORIZONTAL face, which is the tread when
   * `hitY === surfaceY` and the span's UNDERSIDE — the roof of a cave, seen
   * from below — when it is lower.
   *
   * The march has always known this (it is what the two-endpoint test below
   * distinguishes) and always discarded it, because the only consumer was the
   * hover outline, which marks a footprint on the tread either way. It is
   * surfaced for the two-method sculpt design (owner, 2026-08-23): "if I tap
   * on flat, I get a stamp. Otherwise I pull on an edge."
   *
   * VIEW-DEPENDENT, and deliberately so: this is a fact about THIS RAY, not
   * about the cell. The same step reads as a riser from a low camera and as a
   * cap from overhead, because that is what the player can actually see and
   * therefore what they can actually aim at. It is not a substitute for "this
   * cell has a band boundary on some side", which is view-independent geometry
   * and lives in the mesh builder.
   */
  readonly hitRiser: boolean;
  /**
   * World-space Y at which the ray actually MET this column — the point on the
   * riser face when `hitRiser`, and the horizontal face it crossed otherwise.
   *
   * WHY IT IS NOT `surfaceY`. A terrace face is vertical, so every lip stacked
   * on it projects to the same place on the ground: a query that asks "which
   * contour is nearest the cell under the cursor" cannot tell a band-3 lip
   * from the band-7 lip directly above it, and always answers with whichever
   * happens to be nearest in plan — in practice the topmost (owner report,
   * 2026-08-24: "it only snaps to the edge of the topmost layer, and for this
   * to really work we need to be able to grab any layer"). The HEIGHT the ray
   * struck is the only thing that distinguishes them, and the march has always
   * known it: it is where the ray entered the column.
   *
   * VIEW-DEPENDENT for the same reason `hitRiser` is — it is a fact about this
   * ray, not about the cell.
   */
  readonly hitY: number;
  /**
   * World-space X and Z of that same meeting — so `(hitX, hitY, hitZ)` is ONE
   * point: where this ray met the terrain.
   *
   * WHY THE POINTER NEEDS IT (owner, 2026-08-27: "you can see where the mouse
   * cursor is, you can see the selected band, but the user is forced to
   * manually figure out where the two would intersect"). A consumer that only
   * has the CELL must draw at the cell's lattice position, which on a riser hit
   * is the column's own cap — so the pointer sat on top of the terrace while
   * the player was aiming at its side. The march has always known this point:
   * it is `origin + t·direction` at the very `t` that produced `hitY`, and the
   * mixed cell/world space the march works in preserves `t` exactly (see the
   * scaling note in `pickTerrainCellByRay`), so no second derivation is needed.
   *
   * KNOWN, ACCEPTED: the march walks the CELL LATTICE, and the mesh draws a
   * riser on the SMOOTHED CONTOUR, which wanders within the boundary cell. So
   * on a smoothed face this point can sit a fraction of a cell off the drawn
   * surface. A cell is a quarter of a world unit since the re-sample, so the
   * error is small; the pick's own answer (the cell, the band) is unaffected,
   * because that is decided by the lattice either way.
   *
   * VIEW-DEPENDENT for the same reason `hitY` is.
   */
  readonly hitX: number;
  readonly hitZ: number;
}

/** The world's vertical extent in world units — nothing is drawn outside it. */
const MAX_TERRAIN_WORLD_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE;
const MIN_TERRAIN_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE;

/**
 * Cell (x, y) is centred on world (x, ·, y) and spans half a cell either side
 * (see worldPointToCell), so the grid the march steps over is the cell lattice
 * shifted by this much.
 */
const CELL_CENTRE_OFFSET = 0.5;

/**
 * Hard bound on march iterations, as a function of world size.
 *
 * A ray crosses at most one column boundary and one row boundary per cell it
 * enters, so a straight diagonal traverse is 2·size steps; +2 covers entering
 * and leaving. This is belt-and-suspenders against a degenerate direction
 * turning the walk into a spin, not a budget — a real pick stops at the first
 * solid column, and even a full miss over open sea terminates on the slab
 * clip below.
 */
const marchStepLimit = (worldSize: number): number => 2 * worldSize + 2;

/** Whether the chunk owning cell (x, y) has been received. In-bounds only. */
function cellRevealed(mirror: TerrainMirror, x: number, y: number): boolean {
  return hasChunk(
    mirror,
    chunkIndex(
      mirror.map.size,
      Math.floor(x / CHUNK_SIZE),
      Math.floor(y / CHUNK_SIZE),
    ),
  );
}

/**
 * One cell the ray passes through, in ray order.
 *
 * `tEnter`/`tExit` are the parameters at which the ray enters and leaves this
 * cell's column, on the SAME ray the caller passed (see the scaling note in
 * `marchCells`), so `origin + t·direction` is a world point for either of them.
 * Return true to stop the walk.
 */
type CellVisitor = (i: number, j: number, tEnter: number, tExit: number) => boolean;

/**
 * How far above the terrain's own ceiling anything declared pickable may
 * stand, in world units — the vertical headroom the march adds to the terrain
 * slab so a canopy on a summit is still reachable.
 *
 * Four world units is sixteen terrace bands, comfortably over flora's tallest
 * tree (1.5 units at scale 1, plugins/flora/client/models.ts) and over every
 * creature and structure that stands on the ground. Anything taller than this
 * is not something a player points at from across the map.
 *
 * The TERRAIN pick does not pay it: it passes the terrain's own ceiling, so
 * that walk is byte-for-byte the one it was before this parameter existed.
 */
const MAX_STANDING_WORLD_HEIGHT = 4;

/**
 * The ray in the mixed space the march works in: X and Z in CELL units,
 * shifted so cell (i, j) occupies exactly [i, i+1] × [j, j+1]; Y left in world
 * units.
 *
 * Scaling origin and direction by the same factor on the same axes maps the
 * ray to a ray with the SAME parameter t, so one t indexes this space and
 * world space alike — which is why `hitX`/`hitZ` can be evaluated on the
 * unscaled ray at a t this space produced.
 */
interface ScaledRay {
  readonly ox: number;
  readonly oz: number;
  readonly oy: number;
  readonly dx: number;
  readonly dz: number;
  readonly dy: number;
}

/**
 * ONE CONVERSION, TWO CALLERS (2026-09-04). `marchCells` walks the whole
 * lattice; `pickTerrainInColumn` clips against ONE cell of it. A second copy
 * of this arithmetic is exactly how the two would come to disagree about where
 * a cell's box is, so neither owns it.
 *
 * Null for a non-finite ray, or one with no direction at all — there is
 * nothing to walk either way.
 */
function scaleRayToCellSpace(origin: Vec3, direction: Vec3): ScaledRay | null {
  const ox = origin.x / CELL_WORLD_SIZE + CELL_CENTRE_OFFSET;
  const oz = origin.z / CELL_WORLD_SIZE + CELL_CENTRE_OFFSET;
  const dx = direction.x / CELL_WORLD_SIZE;
  const dz = direction.z / CELL_WORLD_SIZE;
  const oy = origin.y;
  const dy = direction.y;
  if (
    !Number.isFinite(ox) || !Number.isFinite(oz) || !Number.isFinite(oy) ||
    !Number.isFinite(dx) || !Number.isFinite(dz) || !Number.isFinite(dy)
  ) {
    return null;
  }
  if (dx === 0 && dz === 0 && dy === 0) return null;
  return { ox, oz, oy, dx, dz, dy };
}

/** The parameter interval a ray spends inside an axis-aligned box. */
interface RayBoxClip {
  readonly tEnter: number;
  readonly tExit: number;
}

/**
 * Clips `ray` to the box [xLo, xHi] × [zLo, zHi] in cell units, and
 * [MIN_TERRAIN_WORLD_Y, ceilingY] in world units. Null when it misses.
 *
 * The Y clip is what makes a near-horizon ray cheap: a camera high above the
 * terrain starts marching at the altitude of the tallest possible mountain,
 * not at the camera, so it never walks cells it could not have hit.
 */
function clipRayToBox(
  ray: ScaledRay,
  xLo: number,
  xHi: number,
  zLo: number,
  zHi: number,
  ceilingY: number,
): RayBoxClip | null {
  let tMin = 0;
  let tMax = Infinity;
  const clipSlab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (d === 0) return o >= lo && o <= hi;
    const t1 = (lo - o) / d;
    const t2 = (hi - o) / d;
    const near = t1 < t2 ? t1 : t2;
    const far = t1 < t2 ? t2 : t1;
    if (near > tMin) tMin = near;
    if (far < tMax) tMax = far;
    return tMin <= tMax;
  };
  if (!clipSlab(ray.ox, ray.dx, xLo, xHi)) return null;
  if (!clipSlab(ray.oz, ray.dz, zLo, zHi)) return null;
  if (!clipSlab(ray.oy, ray.dy, MIN_TERRAIN_WORLD_Y, ceilingY)) return null;
  // The ray starts at its origin, so nothing behind the camera counts.
  if (tMin < 0) tMin = 0;
  if (tMin > tMax) return null;
  return { tEnter: tMin, tExit: tMax };
}

/**
 * Walks the cells a world-space ray crosses, nearest first, and hands each to
 * `visit`.
 *
 * EXTRACTED (GH #252) rather than copied: two picks now march this lattice —
 * the terrain pick below and the pointed-at pick after it — and a second copy
 * of an Amanatides & Woo traverse is exactly the kind of duplication that lets
 * one of them drift a cell away from the other. The traverse itself is
 * unchanged; every comment on it is the original.
 *
 * `ceilingY` is the top of the vertical slab to clip against, in world units —
 * the terrain's own ceiling for a terrain pick, that plus the headroom above
 * for a pick that must also meet what stands on the terrain.
 *
 * `direction` need not be normalised; only its direction matters.
 */
function marchCells(
  size: number,
  origin: Vec3,
  direction: Vec3,
  ceilingY: number,
  visit: CellVisitor,
): void {
  // X/Z into CELL units; Y stays in world units — see ScaledRay.
  const ray = scaleRayToCellSpace(origin, direction);
  if (ray === null) return;
  const { ox, oz, dx, dz } = ray;

  // Clip to the slab the world occupies before stepping.
  const clip = clipRayToBox(ray, 0, size, 0, size, ceilingY);
  if (clip === null) return;
  const tMin = clip.tEnter;
  const tMax = clip.tExit;

  // Amanatides & Woo grid traversal over the cell lattice.
  const u = ox + tMin * dx;
  const v = oz + tMin * dz;
  // Float error at the slab boundary can land the entry cell one outside;
  // clamping (rather than bailing) keeps a ray that legitimately grazes the
  // world edge pickable.
  let i = Math.floor(u);
  let j = Math.floor(v);
  if (i < 0) i = 0;
  else if (i >= size) i = size - 1;
  if (j < 0) j = 0;
  else if (j >= size) j = size - 1;

  const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepJ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  let tNextU = stepI === 0 ? Infinity : tMin + ((stepI > 0 ? i + 1 : i) - u) / dx;
  let tNextV = stepJ === 0 ? Infinity : tMin + ((stepJ > 0 ? j + 1 : j) - v) / dz;
  const tDeltaU = stepI === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaV = stepJ === 0 ? Infinity : Math.abs(1 / dz);

  const limit = marchStepLimit(size);
  let tEnter = tMin;
  for (let step = 0; step < limit; step++) {
    if (i < 0 || i >= size || j < 0 || j >= size) return;
    const tExit = Math.min(tNextU, tNextV, tMax);
    if (tExit < tEnter) return;

    if (visit(i, j, tEnter, tExit)) return;

    if (tExit >= tMax) return;
    if (tNextU < tNextV) {
      i += stepI;
      tEnter = tNextU;
      tNextU += tDeltaU;
    } else {
      j += stepJ;
      tEnter = tNextV;
      tNextV += tDeltaV;
    }
  }
}

/**
 * The terrain hit inside ONE marched cell, or null when the ray passes through
 * the column without meeting a drawn span.
 *
 * Cells in chunks the server has never sent are SKIPPED, not treated as
 * ground: they have no mesh, so the ray passes through unrevealed territory
 * and lands on revealed terrain behind it — exactly what the mesh raycast did,
 * and what keeps a click from sculpting land the client was never shown
 * (mirror.ts invariant 1).
 */
function terrainHitInCell(
  mirror: TerrainMirror,
  i: number,
  j: number,
  origin: Vec3,
  direction: Vec3,
  tEnter: number,
  tExit: number,
): TerrainRayPick | null {
  if (!cellRevealed(mirror, i, j)) return null;

  const oy = origin.y;
  const dy = direction.y;
  const entryY = oy + tEnter * dy;
  const exitY = oy + tExit * dy;
  // Every span of this column, TOPMOST FIRST. A ray that crosses a cave
  // meets the roof before the floor, and only the first one it meets is
  // the one the player is pointing at — but "first" is along the ray, not
  // up the column, so a rising ray meets them in the other order. Scanning
  // all of them and keeping the earliest is the one rule that is right for
  // both, and a column of one span makes it a single pass.
  const count = spanCount(mirror.map, i, j);
  let hit: TerrainRayPick | null = null;
  let hitT = Infinity;
  for (let k = count - 1; k >= 0; k--) {
    const span = spanAt(mirror.map, i, j, k);
    // A span too thin to reach a band boundary draws nothing, so there is
    // nothing here to click.
    if (!isSpanDrawn(span)) continue;
    const capY = spanCapHeight(span) * HEIGHT_WORLD_SCALE;
    const baseY = spanUndersideHeight(span) * HEIGHT_WORLD_SCALE;
    // The ray meets this span iff its Y sweep across the cell overlaps the
    // span's drawn extent. Y is linear in t, so the two endpoints decide
    // it: the sweep is [min, max] of them.
    const lowY = entryY < exitY ? entryY : exitY;
    const highY = entryY < exitY ? exitY : entryY;
    if (lowY > capY || highY < baseY) continue;
    // Where it met it, and how. Entering the cell already INSIDE the span
    // means it came in through the riser; otherwise it crossed a
    // horizontal face on the way through — the cap when it arrived from
    // above, the underside when it arrived from below.
    const insideOnEntry = entryY <= capY && entryY >= baseY;
    const faceY = insideOnEntry ? entryY : entryY > capY ? capY : baseY;
    // dy === 0 is a level ray: it never crosses a face, so it can only be
    // inside on entry, and then it met the span where it came in.
    const t = insideOnEntry || dy === 0 ? tEnter : tEnter + (faceY - entryY) / dy;
    if (t >= hitT) continue;
    hitT = t;
    hit = {
      x: i,
      y: j,
      surfaceY: capY,
      spanIndex: k,
      hitRiser: insideOnEntry,
      hitY: faceY,
      // The SAME t that gave faceY, evaluated on the unscaled ray — the
      // X/Z scaling above divides origin and direction by the same factor,
      // which leaves t unchanged, so this is the world-space point the
      // march just found rather than a re-derivation of it.
      hitX: origin.x + t * direction.x,
      hitZ: origin.z + t * direction.z,
    };
  }
  return hit;
}

/**
 * The first terrain cell a world-space ray meets, or null if it meets none.
 *
 * `direction` need not be normalised; only its direction matters.
 */
export function pickTerrainCellByRay(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
): TerrainRayPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;

  let found: TerrainRayPick | null = null;
  marchCells(size, origin, direction, MAX_TERRAIN_WORLD_Y, (i, j, tEnter, tExit) => {
    found = terrainHitInCell(mirror, i, j, origin, direction, tEnter, tExit);
    return found !== null;
  });
  return found;
}

/**
 * THE SAME RAY, ASKED OF ONE PINNED COLUMN — what `hoverTarget` re-derives its
 * pick from on every read (input/sculptInput.ts), so no map-derived field ever
 * survives an edit (issue #324, 2026-09-04).
 *
 * It is `pickTerrainCellByRay`'s per-cell work with the march removed: the
 * caller has already decided WHICH cell the player aimed at, and that decision
 * is a fact about the ray rather than about the map, so it must not be
 * re-taken every time the ground moves. Re-marching after each edit is what
 * walked a held raise uphill (issue #25) and a held lower away from the
 * camera; re-deriving inside the pinned column keeps the promised cell and
 * still answers about the map as it is NOW.
 *
 * Three answers, in order:
 *
 *  1. The ray misses this cell's XZ box, or the cell is out of range or in a
 *     chunk the server never sent → null.
 *  2. The ray meets a drawn span of the column → that hit, exactly as the
 *     march would have reported it (same `terrainHitInCell`).
 *  3. GROUND UNDER THE RAY. The ray crosses the cell entirely in AIR — over a
 *     cap the player just lowered, or through a gap they just carved. The
 *     answer is the TREAD of the highest drawn span whose cap lies below the
 *     ray's Y sweep across this cell: `hitRiser: false`,
 *     `hitY === surfaceY === cap`. That is what keeps a held lower digging the
 *     same cell instead of falling through it. No such span → null, and the
 *     caller re-marches.
 *
 * WHY THE MIDPOINT OF [tEnter, tExit] FOR THE FALLBACK'S `hitX`/`hitZ`. There
 * is no meeting to report — the ray passed above this ground, so no t on it
 * lands on the tread — and the point must still lie inside the cell, because
 * its consumer measures lip distance from it (world.ts's `carveBand`). The
 * midpoint of the ray's chord across the cell is the one point that is inside
 * by construction for every ray, and is the chord's own centre rather than an
 * arbitrary end of it.
 *
 * `direction` need not be normalised; only its direction matters.
 */
export function pickTerrainInColumn(
  mirror: TerrainMirror,
  x: number,
  y: number,
  origin: Vec3,
  direction: Vec3,
): TerrainRayPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  // The same rule the march applies: an unreceived chunk has no mesh, so there
  // is nothing there to point at (mirror.ts invariant 1).
  if (!cellRevealed(mirror, x, y)) return null;

  const ray = scaleRayToCellSpace(origin, direction);
  if (ray === null) return null;
  // Cell (x, y) occupies exactly [x, x+1] × [y, y+1] in the scaled space.
  const clip = clipRayToBox(ray, x, x + 1, y, y + 1, MAX_TERRAIN_WORLD_Y);
  if (clip === null) return null;
  const { tEnter, tExit } = clip;

  const hit = terrainHitInCell(mirror, x, y, origin, direction, tEnter, tExit);
  if (hit !== null) return hit;

  const entryY = ray.oy + tEnter * ray.dy;
  const exitY = ray.oy + tExit * ray.dy;
  const lowY = entryY < exitY ? entryY : exitY;
  // TOPMOST FIRST: the highest ground still under the ray is the ground the
  // player is looking down at. A span whose cap is inside the sweep would have
  // been a hit above, so every span left here is wholly above or wholly below
  // it, and `capY < lowY` is exactly "below".
  const count = spanCount(mirror.map, x, y);
  for (let k = count - 1; k >= 0; k--) {
    const span = spanAt(mirror.map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    const capY = spanCapHeight(span) * HEIGHT_WORLD_SCALE;
    if (capY >= lowY) continue;
    const tMid = (tEnter + tExit) / 2;
    return {
      x,
      y,
      surfaceY: capY,
      spanIndex: k,
      hitRiser: false,
      hitY: capY,
      hitX: origin.x + tMid * direction.x,
      hitZ: origin.z + tMid * direction.z,
    };
  }
  return null;
}

/** Where a pointed-at pick landed: the cell, and how far away it was. */
export interface PointedCellPick {
  readonly x: number;
  readonly y: number;
  /** World-space distance from the ray origin to the hit point. */
  readonly distance: number;
}

/**
 * The cell the player is POINTING AT: the first cell where the ray meets
 * either something standing on the ground (`occupants`) or the terrain itself.
 *
 * ONE MARCH, BOTH QUESTIONS, and that is what this exists for (GH #252). The
 * alternative — a Three.js raycast over every declared object — costs the whole
 * declared world per call, because an `InstancedMesh` is tested per instance
 * and a world-spanning forest's bounding sphere accepts every on-canvas ray
 * (and every off-canvas one). This walks the cells the ray actually crosses,
 * which is tens of them, and asks each registrant one question per cell.
 *
 * WITHIN one cell an occupant wins over the terrain, which costs nothing to
 * decide: both hits are inside the same column, so the CELL is the same either
 * way and only `distance` could differ.
 */
export function pickPointedCellByRay(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
  occupants: readonly CellOccupancy[],
): PointedCellPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;

  // `distance` is world-space, so t is scaled by the ray's own length — the
  // caller is not required to hand over a unit direction.
  const dirLength = Math.hypot(direction.x, direction.y, direction.z);
  if (!(dirLength > 0)) return null;

  const oy = origin.y;
  const dy = direction.y;

  const ceilingY = MAX_TERRAIN_WORLD_Y + MAX_STANDING_WORLD_HEIGHT;
  // Refilled per cell rather than allocated per cell: the march visits tens of
  // them per pick and this runs on pointer events.
  const chord = { fromX: 0, fromZ: 0, toX: 0, toZ: 0 };

  let found: PointedCellPick | null = null;
  marchCells(size, origin, direction, ceilingY, (i, j, tEnter, tExit) => {
    const entryY = oy + tEnter * dy;
    const exitY = oy + tExit * dy;
    const lowY = entryY < exitY ? entryY : exitY;
    const highY = entryY < exitY ? exitY : entryY;

    if (occupants.length > 0) {
      chord.fromX = origin.x + tEnter * direction.x;
      chord.fromZ = origin.z + tEnter * direction.z;
      chord.toX = origin.x + tExit * direction.x;
      chord.toZ = origin.z + tExit * direction.z;
    }

    for (const occupant of occupants) {
      const column = occupant(i, j, chord);
      if (column === null) continue;
      if (lowY > column.hiY || highY < column.loY) continue;
      // The same face arithmetic the terrain spans get: inside on entry means
      // the ray came in through the side of the column, otherwise it crossed
      // the top or the bottom on the way through.
      const insideOnEntry = entryY <= column.hiY && entryY >= column.loY;
      const faceY = insideOnEntry ? entryY : entryY > column.hiY ? column.hiY : column.loY;
      const t = insideOnEntry || dy === 0 ? tEnter : tEnter + (faceY - entryY) / dy;
      found = { x: i, y: j, distance: t * dirLength };
      return true;
    }

    const terrain = terrainHitInCell(mirror, i, j, origin, direction, tEnter, tExit);
    if (terrain === null) return false;
    found = {
      x: terrain.x,
      y: terrain.y,
      distance: Math.hypot(
        terrain.hitX - origin.x,
        terrain.hitY - origin.y,
        terrain.hitZ - origin.z,
      ),
    };
    return true;
  });
  return found;
}
