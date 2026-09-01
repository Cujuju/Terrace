// What flora has standing over a cell — the answer that makes a tree pointable
// without raycasting the forest (GH #252).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AT ALL.
//
// A tree is one instance in an InstancedMesh, and three's raycast walks every
// live instance of every declared mesh, per pick. At the shipped cap that is
// eight thousand per-instance tests — 0.72–0.85 ms, measured, paid IN FULL even
// when the ray hits nothing, because the forest's bounding sphere spans the
// world and accepts every ray. The torch re-picks once a frame while the player
// aims, so a tenth of the frame budget went on it.
//
// The plugin already knows where its trees are: it is handed CELLS and places
// one tree per cell. So instead of asking "which of my eight thousand instances
// does this ray meet", the host marches the cells the ray crosses and asks this
// module "what stands over cell (x, y), and how high does it reach there?" —
// the ClientPluginCtx.markPickable occupancy contract.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A SILHOUETTE AND NOT A BOX.
//
// A crown is nearly two cells wide at the shipped scale (CELL_WORLD_SIZE is a
// quarter of a world unit), so a tree occupies several cells and reaches a
// different height over each of them: nearly its full height over its own
// trunk, a few centimetres over the rim of the canopy. Answering with the
// bounding box instead would make every tree a 2×2-cell tower and let the
// player point at a tree through the clear gap beside it. So the profile is
// evaluated analytically from the SAME constants models.ts builds the geometry
// from — a cone for a fir, a sphere for a broadleaf.
//
// The drawn crowns are 6-segment facets inscribed in those shapes, so the
// circle is not quite the silhouette either way round: see facetedRadius below
// for which of the two bounds this takes and what it was measured against.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW CLOSE IT ACTUALLY GETS, and the residual that stays.
//
// Swept headless against the raycast it replaces — 4 camera framings × 41 × 41
// pointer positions, 4 096 trees clumped over a 512-cell world: 94.7 % of
// positions resolve to the IDENTICAL cell, 97.5 % to within one cell, and 1.1 %
// disagree by more.
//
// The residual is the lattice, not a bug to be found: the host tests the ray's
// whole Y sweep ACROSS a cell against one column, so a ray that clears a crown
// by less than the height it gains crossing that cell is still called a hit,
// and a stand of overlapping crowns answers as one canopy (see widen). Both
// err toward "you pointed at the tree you could see", which is the direction
// this pick exists to serve; the raycast's own answer was never the trunk's
// cell either, only the cell of the point where the ray met the canopy.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure arithmetic. The three-dependent constants it imports from models.ts are
// numbers, so nothing here pulls a renderer in at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  CellColumn,
  CellOccupancy,
  CellRayChord,
} from '../../../client/src/plugins/types.ts';
import {
  cropKey,
  treeKey,
  treeVariation,
  FLORA_TREE_SCALE_MAX,
  type CropCell,
  type TreeCell,
} from '../protocol.ts';
import {
  BROADLEAF_CROWN_CENTRE_Y,
  BROADLEAF_CROWN_RADIUS,
  BROADLEAF_CROWN_SEGMENTS,
  CONIFER_CROWN_HEIGHT,
  CONIFER_CROWN_RADIUS,
  CONIFER_CROWN_SEGMENTS,
  TRUNK_BOTTOM_RADIUS,
  TRUNK_HEIGHT,
} from './models.ts';
import type { InstanceReach } from './instanceBounds.ts';
import type { GroundLookup } from './placement.ts';

/**
 * A faceted crown's radius, as a fraction of the circle it is inscribed in.
 *
 * The crowns are drawn as `segments`-sided prisms of revolution, so the SURFACE
 * sits at the polygon's inradius over a facet and at its full radius only along
 * an edge — `cos(π/segments)` and 1 respectively. Evaluating the circle instead
 * would make every tree wider than the one on screen, in a pick whose whole job
 * is to agree with what the player can see, and the per-cell answer already
 * rounds a partly covered cell up to a fully covered one on top of that.
 *
 * The inradius is the tighter of the two bounds and measured closest: over a
 * scripted sweep of camera angles it cut the "occupancy says tree, the raycast
 * says ground behind it" disagreements by more than half.
 */
function facetedRadius(radius: number, segments: number): number {
  return radius * Math.cos(Math.PI / segments);
}

const CONIFER_SILHOUETTE_RADIUS = facetedRadius(CONIFER_CROWN_RADIUS, CONIFER_CROWN_SEGMENTS);
const BROADLEAF_SILHOUETTE_RADIUS = facetedRadius(
  BROADLEAF_CROWN_RADIUS,
  BROADLEAF_CROWN_SEGMENTS,
);

/**
 * Half a cell's diagonal, in cells — how far inside its own cell the ray's
 * crossing can wander from the centre.
 */
const CELL_HALF_DIAGONAL_IN_CELLS = Math.SQRT2 / 2;

/**
 * How far, in CELLS, a plant's own cell can be from the cell being asked about
 * and still reach the ray crossing it.
 *
 * THE HALF-DIAGONAL IS NOT SLACK. The question is asked about a CELL but
 * answered against the ray's chord through it, and a chord runs to the cell's
 * corners — so a plant one cell further out than its own radius covers can
 * still reach the near end of that chord. Scanning only to the radius dropped
 * exactly those trees, and a dropped tree is a ray that goes through the wood
 * the player is aiming at.
 */
function neighbourhoodInCells(worldRadius: number): number {
  return Math.floor(worldRadius / CELL_WORLD_SIZE + CELL_HALF_DIAGONAL_IN_CELLS);
}

/**
 * The widest a tree gets, in world units: the broader of the two crowns at the
 * biggest scale the variation rolls. Sets how far the probe below has to look —
 * one cell either way at the shipped dimensions.
 */
const TREE_MAX_CROWN_RADIUS = Math.max(CONIFER_SILHOUETTE_RADIUS, BROADLEAF_SILHOUETTE_RADIUS) *
  FLORA_TREE_SCALE_MAX;
const TREE_NEIGHBOURHOOD_CELLS = neighbourhoodInCells(TREE_MAX_CROWN_RADIUS);

/**
 * The vertical extent of ONE tree over a point `distance` world units from its
 * trunk, or null when the tree does not reach that far.
 *
 * The trunk is folded into the same answer: within its own radius the tree
 * reaches all the way down to the ground it stands on, which is what makes a
 * near-horizontal ray meet the trunk rather than pass under the canopy.
 */
function treeColumnAt(
  kind: 'conifer' | 'broadleaf',
  scale: number,
  groundY: number,
  distance: number,
): CellColumn | null {
  const trunkTopY = groundY + TRUNK_HEIGHT * scale;
  const onTrunk = distance <= TRUNK_BOTTOM_RADIUS * scale;

  if (kind === 'conifer') {
    const radius = CONIFER_SILHOUETTE_RADIUS * scale;
    if (distance > radius) return onTrunk ? { loY: groundY, hiY: trunkTopY } : null;
    // A cone's silhouette falls off linearly from apex to rim, and its
    // underside is the flat disc at the trunk top.
    const hiY = trunkTopY + CONIFER_CROWN_HEIGHT * scale * (1 - distance / radius);
    return { loY: onTrunk ? groundY : trunkTopY, hiY };
  }

  const radius = BROADLEAF_SILHOUETTE_RADIUS * scale;
  if (distance > radius) return onTrunk ? { loY: groundY, hiY: trunkTopY } : null;
  const centreY = groundY + BROADLEAF_CROWN_CENTRE_Y * scale;
  const halfChord = Math.sqrt(radius * radius - distance * distance);
  return {
    loY: onTrunk ? groundY : centreY - halfChord,
    hiY: centreY + halfChord,
  };
}

/**
 * How close the ray's crossing of this cell comes to a plant standing at
 * (plantX, plantZ), in world units.
 *
 * The chord is a SEGMENT, not a line: clamping the projection to it is what
 * keeps a crown in the next cell along from being reported over this one.
 */
function distanceToChord(chord: CellRayChord, plantX: number, plantZ: number): number {
  const alongX = chord.toX - chord.fromX;
  const alongZ = chord.toZ - chord.fromZ;
  const toPlantX = plantX - chord.fromX;
  const toPlantZ = plantZ - chord.fromZ;
  const lengthSquared = alongX * alongX + alongZ * alongZ;
  let along = lengthSquared > 0 ? (toPlantX * alongX + toPlantZ * alongZ) / lengthSquared : 0;
  if (along < 0) along = 0;
  else if (along > 1) along = 1;
  return Math.hypot(toPlantX - along * alongX, toPlantZ - along * alongZ);
}

/**
 * Merges one plant's extent into the answer for a cell.
 *
 * A UNION, so a stand of overlapping crowns answers as the one canopy it looks
 * like. It can only ever over-cover — two crowns with a vertical gap between
 * them report the gap as filled — and over-covering is the safe direction here:
 * the error is "the player pointed at the wood they could see", never "the ray
 * went through a tree".
 */
function widen(into: CellColumn | null, column: CellColumn): CellColumn {
  if (into === null) return column;
  return {
    loY: into.loY < column.loY ? into.loY : column.loY,
    hiY: into.hiY > column.hiY ? into.hiY : column.hiY,
  };
}

/**
 * The occupancy lookup for the forest: what the trees reach over cell (x, y).
 *
 * Reads the LIVE maps the plugin keeps, so a felled tree stops being pointable
 * on the same message that stops it being drawn — there is no second index to
 * invalidate, which is the whole reason this scans a neighbourhood instead of
 * stamping a footprint grid.
 */
export function treeOccupancy(
  trees: ReadonlyMap<number, TreeCell>,
  groundAt: GroundLookup,
): CellOccupancy {
  return (x: number, y: number, chord: CellRayChord): CellColumn | null => {
    if (trees.size === 0) return null;
    let column: CellColumn | null = null;
    for (let dy = -TREE_NEIGHBOURHOOD_CELLS; dy <= TREE_NEIGHBOURHOOD_CELLS; dy++) {
      for (let dx = -TREE_NEIGHBOURHOOD_CELLS; dx <= TREE_NEIGHBOURHOOD_CELLS; dx++) {
        const cell = trees.get(treeKey(x + dx, y + dy));
        if (cell === undefined) continue;
        const groundY = groundAt(cell.x, cell.y);
        // A tree over ground this client has not been sent is not DRAWN
        // (placement.ts), so it is not pointable either.
        if (groundY === null) continue;
        const variation = treeVariation(cell.x, cell.y);
        const distance = distanceToChord(
          chord,
          cell.x * CELL_WORLD_SIZE,
          cell.y * CELL_WORLD_SIZE,
        );
        const one = treeColumnAt(variation.kind, variation.scale, groundY, distance);
        if (one !== null) column = widen(column, one);
      }
    }
    return column;
  };
}

/**
 * The occupancy lookup for the crop field.
 *
 * A CYLINDER, unlike the trees: a plot is a dense cluster of stalks that fills
 * its own patch to a nearly even height, so the reach cropModels.ts already
 * derives for its culling sphere — the cluster spread out, the tallest stalk up
 * — is the shape, not a loose bound on it.
 */
export function cropOccupancy(
  crops: ReadonlyMap<number, CropCell>,
  groundAt: GroundLookup,
  reach: InstanceReach,
): CellOccupancy {
  const neighbourhood = neighbourhoodInCells(reach.horizontal);
  return (x: number, y: number, chord: CellRayChord): CellColumn | null => {
    if (crops.size === 0) return null;
    let column: CellColumn | null = null;
    for (let dy = -neighbourhood; dy <= neighbourhood; dy++) {
      for (let dx = -neighbourhood; dx <= neighbourhood; dx++) {
        const cell = crops.get(cropKey(x + dx, y + dy));
        if (cell === undefined) continue;
        const distance = distanceToChord(
          chord,
          cell.x * CELL_WORLD_SIZE,
          cell.y * CELL_WORLD_SIZE,
        );
        if (distance > reach.horizontal) continue;
        const groundY = groundAt(cell.x, cell.y);
        if (groundY === null) continue;
        column = widen(column, {
          loY: groundY - reach.down,
          hiY: groundY + reach.up,
        });
      }
    }
    return column;
  };
}
