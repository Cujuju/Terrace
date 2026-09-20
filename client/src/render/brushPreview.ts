import type { Scene } from 'three';
import {
  MIN_BRUSH_RADIUS,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../config.ts';
import type { PickFace } from '../terrain/picking.ts';
import type { DenialCue } from './denialCue.ts';
import { BRUSH_RADII } from '../state/hudState.ts';
import {
  brushFootprint,
  footprintFromMark,
  type BrushFootprint,
} from './brush/brushGeometry.ts';
import { createConformedGeometry, type BrushGround } from './brush/conform.ts';
import { drawnBandCapY } from '../terrain/capEmission.ts';
import { createBrushStage, type CursorSurface } from './brush/brushStage.ts';
import { markFromOffsets, type SculptDir } from './brush/footprintMark.ts';
import { OUTLINE_COLOR_CAP, OUTLINE_COLOR_RISER, OUTLINE_LIFT_WORLD_UNITS } from './brush/style.ts';

export type { CursorSurface } from './brush/brushStage.ts';
export type { BrushGround } from './brush/conform.ts';

export interface BrushHover {
  readonly x: number;
  readonly y: number;
  readonly surfaceY: number;
  readonly face: PickFace;
  readonly grabbable: boolean;
  readonly hitX?: number;
  readonly hitY?: number;
  readonly hitZ?: number;
  readonly band?: number | null;
  /** Band of the surface under the aim, whether or not a lip is grabbable there. */
  readonly aimBand?: number | null;
  /** Band a carve would open here — the same read the stroke makes. */
  readonly carveBand?: number | null;
}

export interface BrushSelection {
  readonly radius: number;
  readonly tool: SculptTool;
  readonly profile: SculptProfile;
  readonly dir: SculptDir;
}

export interface BrushPreview {
  update(hover: BrushHover | null, brush: BrushSelection): void;
  dispose(): void;
}

const SEED_TOOL: SculptTool = 'stamp';
const SEED_PROFILE: SculptProfile = 'hard';

/** Four edges bound one cell: the worst case a mark's loops can add. */
const CELL_BOUNDARY_EDGES = 4;

export const BRUSH_PREVIEW_DRAW_OBJECTS = 5;

/**
 * Cells the carve at this aim would actually cut, as offsets from it. Null when
 * the aim names no band. The applier answers; the preview never guesses.
 */
export type CarveAdmits = (
  x: number,
  y: number,
  band: number,
  radius: number,
) => readonly (readonly [number, number])[] | null;

export function createBrushPreview(
  scene: Scene,
  canvas: CursorSurface,
  worldSize: () => number,
  denial: DenialCue,
  ground: BrushGround,
  carveAdmits: CarveAdmits | null = null,
): BrushPreview {
  const footprints = new Map<string, { footprint: BrushFootprint; id: number }>();
  const key = (radius: number, tool: SculptTool, profile: SculptProfile): string =>
    `${radius}|${tool}|${profile}`;
  let maxRingVerts = 0;
  let maxGridSegments = 0;
  let nextId = 0;
  for (const r of BRUSH_RADII) {
    for (const tool of SCULPT_TOOLS) {
      if (tool === 'drag' || tool === 'carve') continue;
      for (const profile of SCULPT_PROFILES) {
        const footprint = brushFootprint(r, tool, profile);
        footprints.set(key(r, tool, profile), { footprint, id: nextId++ });
        if (footprint.ringCount > maxRingVerts) maxRingVerts = footprint.ringCount;
        if (footprint.gridCount > maxGridSegments) maxGridSegments = footprint.gridCount;
      }
    }
  }
  const initialKey = key(MIN_BRUSH_RADIUS, SCULPT_TOOLS[0]!, SCULPT_PROFILES[0]!);
  if (!footprints.has(initialKey)) {
    throw new RangeError(`brush preview has no footprint for ${initialKey}`);
  }

  // A disconnected mark's loops are bounded by its cells: each contributes at
  // most four boundary edges, over the widest footprint the radii reach.
  let maxReachCells = 0;
  for (const { footprint } of footprints.values()) {
    if (footprint.reachCells > maxReachCells) maxReachCells = footprint.reachCells;
  }
  const markCellBound = (2 * maxReachCells + 1) * (2 * maxReachCells + 1);
  const maxExtraSegments = CELL_BOUNDARY_EDGES * markCellBound;
  const conformed = createConformedGeometry(maxRingVerts, maxGridSegments, maxExtraSegments);
  let liveCarve: { footprint: BrushFootprint | null; id: number; key: string } | null = null;
  /** The admitted cells as an outline, or null when the fixed buffers cannot hold it. */
  const liveFootprint = (
    radius: number,
    cells: readonly (readonly [number, number])[],
  ): BrushFootprint | null => {
    let built: BrushFootprint;
    try {
      built = footprintFromMark(radius, markFromOffsets(cells));
    } catch {
      return null;
    }
    return built.ringCount > maxRingVerts ||
      built.gridCount > maxGridSegments ||
      built.extraCount > maxExtraSegments
      ? null
      : built;
  };
  const stage = createBrushStage(scene, canvas, denial, {
    ring: conformed.ring,
    hem: conformed.hem,
    extra: conformed.extra,
    grid: conformed.grid,
  });
  const { line, hem, cellGrid, crosshair, material, hemMaterial } = stage;
  const show = stage.show;
  const paintFlatMark = stage.paintFlatMark;

  let shownKey = initialKey;

  return {
    update(hover, brush) {
      if (hover === null) {
        // The flat cue IS the crosshair mark, so it survives an aim that left
        // the terrain: a frozen drag keeps its mark instead of vanishing.
        if (denial.flat()) {
          paintFlatMark();
          show(true, true);
          return;
        }
        show(false);
        return;
      }
      stage.syncEdgeClipTo(worldSize());
      const atX = hover.hitX ?? hover.x * CELL_WORLD_SIZE;
      const atY = hover.hitY ?? hover.surfaceY;
      const atZ = hover.hitZ ?? hover.y * CELL_WORLD_SIZE;

      const onTread = hover.face === 'tread';
      const seeding = brush.tool === 'drag' && onTread;
      // The radius outline stays up for every tool. Drag and carve have no
      // footprint, so they borrow the seed-geometry disc. A flat-posture
      // refusal collapses to the crosshair.
      const useFootprint = (wanted: string): boolean => {
        if (wanted === shownKey) return true;
        if (!footprints.has(wanted)) {
          show(false);
          return false;
        }
        shownKey = wanted;
        return true;
      };
      const tintFootprint = (): void => {
        material.color.setHex(hover.face === 'riser' ? OUTLINE_COLOR_RISER : OUTLINE_COLOR_CAP);
        hemMaterial.color.setHex(hover.face === 'riser' ? OUTLINE_COLOR_RISER : OUTLINE_COLOR_CAP);
      };
      const placeFootprint = (): void => {
        // Height lives in the vertices (absolute world Y); objects carry XZ
        // only. syncTo no-ops until the aim, footprint, or ground moves —
        // panning or rotating the camera rewrites nothing.
        line.position.set(hover.x * CELL_WORLD_SIZE, 0, hover.y * CELL_WORLD_SIZE);
        hem.position.copy(line.position);
        cellGrid.position.copy(line.position);
        const selected = footprints.get(shownKey)!;
        // Pin the footprint to the edited surface: held or lit band first,
        // else the aim's own band, so treads pin too.
        const clampBand = hover.band ?? hover.aimBand ?? null;
        const capY = clampBand == null ? null : drawnBandCapY(clampBand);
        conformed.syncTo(
          selected.footprint,
          selected.id,
          hover.x,
          hover.y,
          hover.surfaceY,
          ground,
          capY,
        );
      };

      if (carveAdmits !== null && brush.tool === 'carve') {
        // The outline is the cut, not the reach. An admitting-nothing carve
        // shows the refusal mark. A carve opens the band it reads.
        const band = hover.carveBand ?? hover.aimBand ?? null;
        const cells = band === null ? null : carveAdmits(hover.x, hover.y, band, brush.radius);
        const paintAimMark = (): void => {
          if (hover.face === 'riser') stage.paintRiserMark(band);
          else paintFlatMark();
        };
        if (cells !== null && cells.length === 0) {
          paintAimMark();
          crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
          show(true, true);
          return;
        }
        const liveKey =
          cells === null ? null : `${brush.radius}|${hover.x}|${hover.y}|${band}|${cells.length}`;
        if (liveKey !== null && (liveCarve === null || liveCarve.key !== liveKey)) {
          liveCarve = { footprint: liveFootprint(brush.radius, cells!), id: nextId++, key: liveKey };
        }
        const live = liveKey === null ? null : liveCarve;
        if (live !== null && live.footprint !== null) {
          tintFootprint();
          line.position.set(hover.x * CELL_WORLD_SIZE, 0, hover.y * CELL_WORLD_SIZE);
          hem.position.copy(line.position);
          cellGrid.position.copy(line.position);
          conformed.syncTo(
            live.footprint,
            live.id,
            hover.x,
            hover.y,
            hover.surfaceY,
            ground,
            band === null ? null : drawnBandCapY(band),
          );
          paintAimMark();
          crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
          show(true);
          return;
        }
        // An admitted set past the buffers fixed at construction falls back to
        // the reach outline rather than drawing a truncated one.
      }

      if (!seeding && (brush.tool === 'drag' || brush.tool === 'carve')) {
        if (!useFootprint(key(brush.radius, SEED_TOOL, SEED_PROFILE))) return;
        tintFootprint();
        placeFootprint();
        if (hover.face === 'riser') {
          const band = hover.band ?? null;
          const held = band !== null && (brush.tool !== 'drag' || hover.grabbable);
          stage.paintRiserMark(held ? band : null);
          crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
        } else {
          paintFlatMark();
          crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
        }
        show(true);
        return;
      }
      const wanted = seeding
        ? key(brush.radius, SEED_TOOL, SEED_PROFILE)
        : key(brush.radius, brush.tool, brush.profile);
      if (!useFootprint(wanted)) return;
      tintFootprint();
      paintFlatMark();
      placeFootprint();
      // The crosshair glides on the continuous ray-hit point, not the cell
      // centre: copying the ring position here made it snap to centre on
      // every riser/tread flip.
      crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
      show(true);
    },
    dispose() {
      show(false);
      stage.removeFromScene();
      conformed.dispose();
      stage.disposeResources();
    },
  };
}
