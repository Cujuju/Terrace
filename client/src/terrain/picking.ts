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
 * Returns null outside the terrain's extent, [0, worldSize-1] on both axes
 * (the far row/column is a shared border vertex — see vertexGrid.ts).
 */
export function worldPointToCell(
  worldX: number,
  worldZ: number,
  worldSize: number,
): CellPick | null {
  const max = worldSize - 1;
  const cellX = worldX / CELL_WORLD_SIZE;
  const cellZ = worldZ / CELL_WORLD_SIZE;
  // Half a cell of tolerance on each side matches the rounding below, so the
  // outermost half-cell of the mesh still picks the edge cell instead of
  // failing.
  const lowerBound = -0.5;
  const upperBound = max + 0.5;
  if (
    !Number.isFinite(cellX) ||
    !Number.isFinite(cellZ) ||
    cellX < lowerBound ||
    cellZ < lowerBound ||
    cellX > upperBound ||
    cellZ > upperBound
  ) {
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
 * The first terrain cell a world-space ray meets, or null if it meets none.
 *
 * Cells in chunks the server has never sent are SKIPPED, not treated as
 * ground: they have no mesh, so the ray passes through unrevealed territory
 * and lands on revealed terrain behind it — exactly what the mesh raycast did,
 * and what keeps a click from sculpting land the client was never shown
 * (mirror.ts invariant 1).
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

  // X/Z into CELL units; Y stays in world units. Scaling origin and direction
  // by the same factor on the same axes maps the ray to a ray with the SAME
  // parameter t, so one t indexes this mixed space consistently.
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

  // Clip to the slab the world occupies before stepping. The Y clip is what
  // makes a near-horizon ray cheap: a camera high above the terrain starts
  // marching at the altitude of the tallest possible mountain, not at the
  // camera, so it never walks cells it could not have hit.
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
  if (!clipSlab(ox, dx, 0, size)) return null;
  if (!clipSlab(oz, dz, 0, size)) return null;
  if (!clipSlab(oy, dy, MIN_TERRAIN_WORLD_Y, MAX_TERRAIN_WORLD_Y)) return null;
  if (tMin < 0) tMin = 0;
  if (tMin > tMax) return null;

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
    if (i < 0 || i >= size || j < 0 || j >= size) return null;
    const tExit = Math.min(tNextU, tNextV, tMax);
    if (tExit < tEnter) return null;

    if (cellRevealed(mirror, i, j)) {
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
      if (hit !== null) return hit;
    }

    if (tExit >= tMax) return null;
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
  return null;
}
