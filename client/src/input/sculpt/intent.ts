import { TOOLS_WITHOUT_DIRECTION, TOOLS_WITHOUT_EDGE_PROFILE, type SculptIntent, type SculptTool } from '@terrace/shared';
import {
  brushProfile, brushRadius, carveDepthBands, nudgeStrength, smoothKinkHalfCells,
} from '../../state/hudState.ts';
import { footOfFaceCell } from '../../terrain/faceFoot.ts';
import type { TerrainRayPick, Vec3 } from '../../terrain/picking.ts';

export interface SculptTarget {
  readonly x: number;
  readonly y: number;
  readonly spanBand: number | null;
}

export const TOOLS_WITH_FOOT_ANCHOR: readonly SculptTool[] = ['stamp', 'smooth', 'nudge'];

export function sculptTargetOf(
  pick: TerrainRayPick,
  direction: Vec3 | null,
  worldSize: number,
  tool: SculptTool,
  grasp: (pick: TerrainRayPick, x: number, y: number) => number | null,
  heldAnchor: { x: number; y: number } | null = null,
): SculptTarget {
  const foot = direction !== null && TOOLS_WITH_FOOT_ANCHOR.includes(tool)
    ? footOfFaceCell(pick, direction, worldSize)
    : null;
  const anchor = heldAnchor ?? foot ?? pick;
  return { x: anchor.x, y: anchor.y, spanBand: grasp(pick, anchor.x, anchor.y) };
}

/** Input and quotes read the same live brush settings. */
export function pointSculptIntent(
  target: SculptTarget,
  tool: SculptTool,
  dir: SculptIntent['dir'],
  alt: boolean,
): SculptIntent {
  return {
    type: 'sculpt', x: target.x, y: target.y, radius: brushRadius(),
    dir: TOOLS_WITHOUT_DIRECTION.includes(tool) ? -1 : dir, tool,
    ...(TOOLS_WITHOUT_EDGE_PROFILE.includes(tool) ? {} : { profile: brushProfile() }),
    ...(tool === 'smooth' ? { smoothKinkHalfCells: smoothKinkHalfCells() } : {}),
    ...(tool === 'smooth' && alt ? { smoothWalls: true } : {}),
    ...(tool === 'nudge' ? { nudgeStrength: nudgeStrength() } : {}),
    ...(tool === 'carve' ? { depthBands: carveDepthBands() } : {}),
    ...(target.spanBand !== null ? { spanBand: target.spanBand } : {}),
  };
}
