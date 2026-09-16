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
import { brushGeometry, type BrushGeometry } from './brush/brushGeometry.ts';
import { createBrushStage, type CursorSurface } from './brush/brushStage.ts';
import type { SculptDir } from './brush/footprintMark.ts';
import { OUTLINE_COLOR_CAP, OUTLINE_COLOR_RISER, OUTLINE_LIFT_WORLD_UNITS } from './brush/style.ts';

export type { CursorSurface } from './brush/brushStage.ts';

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

export const BRUSH_PREVIEW_DRAW_OBJECTS = 4;

export function createBrushPreview(
  scene: Scene,
  canvas: CursorSurface,
  worldSize: () => number,
  denial: DenialCue,
): BrushPreview {
  const geometries = new Map<string, BrushGeometry>();
  const key = (radius: number, tool: SculptTool, profile: SculptProfile): string =>
    `${radius}|${tool}|${profile}`;
  for (const r of BRUSH_RADII) {
    for (const tool of SCULPT_TOOLS) {
      if (tool === 'drag' || tool === 'carve') continue;
      for (const profile of SCULPT_PROFILES) {
        geometries.set(key(r, tool, profile), brushGeometry(r, tool, profile));
      }
    }
  }
  const initialKey = key(MIN_BRUSH_RADIUS, SCULPT_TOOLS[0]!, SCULPT_PROFILES[0]!);
  const initial = geometries.get(initialKey)!;

  const stage = createBrushStage(scene, canvas, denial, initial);
  const { line, skirt, cellGrid, crosshair, material, skirtMaterial } = stage;
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
        const geometry = geometries.get(wanted);
        if (geometry === undefined) {
          show(false);
          return false;
        }
        line.geometry = geometry.ring;
        skirt.geometry = geometry.skirt;
        cellGrid.geometry = geometry.cellGrid;
        shownKey = wanted;
        return true;
      };
      const tintFootprint = (): void => {
        material.color.setHex(hover.face === 'riser' ? OUTLINE_COLOR_RISER : OUTLINE_COLOR_CAP);
        skirtMaterial.color.setHex(hover.face === 'riser' ? OUTLINE_COLOR_RISER : OUTLINE_COLOR_CAP);
      };
      const placeFootprint = (): void => {
        const lift = hover.surfaceY + OUTLINE_LIFT_WORLD_UNITS;
        line.position.set(hover.x * CELL_WORLD_SIZE, lift, hover.y * CELL_WORLD_SIZE);
        skirt.position.copy(line.position);
        cellGrid.position.copy(line.position);
      };

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
      const lift = hover.surfaceY + OUTLINE_LIFT_WORLD_UNITS;
      line.position.set(hover.x * CELL_WORLD_SIZE, lift, hover.y * CELL_WORLD_SIZE);
      // The crosshair glides on the continuous ray-hit point, not the cell
      // centre: copying the ring position here made it snap to centre on
      // every riser/tread flip.
      crosshair.position.set(atX, atY + OUTLINE_LIFT_WORLD_UNITS, atZ);
      skirt.position.copy(line.position);
      cellGrid.position.copy(line.position);
      show(true);
    },
    dispose() {
      show(false);
      stage.removeFromScene();
      for (const g of geometries.values()) {
        g.ring.dispose();
        g.skirt.dispose();
        g.cellGrid.dispose();
      }
      stage.disposeResources();
    },
  };
}
