import { MAX_BRUSH_RADIUS, MAX_DRAG_SWEEP_CELLS, MIN_BRUSH_RADIUS } from '../constants.ts';
import { BEDROCK_BAND } from '../columns.ts';
import { chebyshevDistance } from '../grid.ts';
import {
  CARVE_DEFAULT_DEPTH_BANDS,
  isValidCarveDepth,
  LOWEST_CARVEABLE_BAND,
  MAX_BAND,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  SMOOTH_FEATHER_DEFAULT,
  SMOOTH_FEATHER_MAX,
  SMOOTH_FEATHER_MIN,
  SMOOTH_KERNELS,
  SMOOTH_KERNEL_DEFAULT,
  SMOOTH_LAMBDA_DEFAULT,
  SMOOTH_LAMBDA_MAX,
  SMOOTH_LAMBDA_MIN,
  SMOOTH_RIM_DEFAULT,
  SMOOTH_RIM_MAX,
  SMOOTH_RIM_MIN,
  TOOLS_WITHOUT_EDGE_PROFILE,
} from '../sculpt/options.ts';
import type {
  ResolvedSculptOptions,
  SculptProfile,
  SculptTool,
  SmoothKernel,
} from '../sculpt/options.ts';
import type { CellDiff } from '../sculpt/diff.ts';

export interface SculptIntent {
  type: 'sculpt';
  x: number;
  y: number;
  radius: number;
  dir: 1 | -1;
  tool?: SculptTool;
  profile?: SculptProfile;
  targetBand?: number;
  floorBand?: number;
  dragAlt?: boolean;
  spanBand?: number;
  smoothLambda?: number;
  smoothFeather?: number;
  smoothRim?: number;
  smoothBilateral?: boolean;
  smoothFullSteps?: boolean;
  smoothKernel?: SmoothKernel;
  depthBands?: number;
  fromX?: number;
  fromY?: number;
  seq?: number;
}

/** What an intent resolves to: only the wire-reachable tools, never a library one. */
export interface ResolvedWireSculptOptions extends ResolvedSculptOptions {
  readonly tool: SculptTool;
}

export const WIRE_DEFAULT_SCULPT_OPTIONS: ResolvedWireSculptOptions = {
  tool: 'stamp',
  depthBands: CARVE_DEFAULT_DEPTH_BANDS,
  profile: 'soft',
  spill: 'banded',
  targetBand: null,
  spanBand: null,
  anchor: 'clicked',
  runFloorBand: null,
  dragAlt: false,
  sweepFrom: null,
  smoothLambda: SMOOTH_LAMBDA_DEFAULT,
  smoothFeather: SMOOTH_FEATHER_DEFAULT,
  smoothRim: SMOOTH_RIM_DEFAULT,
  smoothBilateral: false,
  smoothFullSteps: false,
  smoothKernel: SMOOTH_KERNEL_DEFAULT,
};

export const EDGELESS_SCULPT_PROFILE: SculptProfile = 'hard';

export function sculptProfileOf(tool: SculptTool, profile: SculptProfile): SculptProfile {
  return TOOLS_WITHOUT_EDGE_PROFILE.includes(tool) ? EDGELESS_SCULPT_PROFILE : profile;
}

export function sculptOptionsOf(intent: SculptIntent): ResolvedWireSculptOptions {
  const tool = intent.tool ?? WIRE_DEFAULT_SCULPT_OPTIONS.tool;
  const targetBand =
    tool === 'drag' ? (intent.targetBand ?? null) : WIRE_DEFAULT_SCULPT_OPTIONS.targetBand;
  return {
    tool,
    depthBands: intent.depthBands ?? WIRE_DEFAULT_SCULPT_OPTIONS.depthBands,
    profile: sculptProfileOf(tool, intent.profile ?? WIRE_DEFAULT_SCULPT_OPTIONS.profile),
    spill: WIRE_DEFAULT_SCULPT_OPTIONS.spill,
    anchor: targetBand !== null ? 'band' : WIRE_DEFAULT_SCULPT_OPTIONS.anchor,
    targetBand,
    runFloorBand:
      tool === 'drag' ? (intent.floorBand ?? null) : WIRE_DEFAULT_SCULPT_OPTIONS.runFloorBand,
    dragAlt: tool === 'drag' ? (intent.dragAlt ?? false) : false,
    spanBand: intent.spanBand ?? null,
    sweepFrom:
      tool === 'drag' && intent.fromX !== undefined && intent.fromY !== undefined
        ? { x: intent.fromX, y: intent.fromY }
        : null,
    smoothLambda:
      tool === 'smooth'
        ? (intent.smoothLambda ?? SMOOTH_LAMBDA_DEFAULT)
        : SMOOTH_LAMBDA_DEFAULT,
    smoothFeather:
      tool === 'smooth'
        ? (intent.smoothFeather ?? SMOOTH_FEATHER_DEFAULT)
        : SMOOTH_FEATHER_DEFAULT,
    smoothRim:
      tool === 'smooth' ? (intent.smoothRim ?? SMOOTH_RIM_DEFAULT) : SMOOTH_RIM_DEFAULT,
    smoothBilateral: tool === 'smooth' ? (intent.smoothBilateral ?? false) : false,
    smoothFullSteps: tool === 'smooth' ? (intent.smoothFullSteps ?? false) : false,
    smoothKernel:
      tool === 'smooth' ? (intent.smoothKernel ?? SMOOTH_KERNEL_DEFAULT) : SMOOTH_KERNEL_DEFAULT,
  };
}

export type SculptDeniedReason =
  | 'malformed'
  | 'locked'
  | 'plugin-denied'
  | 'plugin-modified-invalid'
  | 'server-fault';

export interface SculptDeniedMessage {
  type: 'sculptDenied';
  seq: number;
  reason?: SculptDeniedReason;
  detail?: string;
}

export interface SculptAppliedMessage {
  type: 'sculptApplied';
  seq: number;
}

export interface TerrainDiffMessage {
  type: 'terrainDiff';
  cells: CellDiff[];
}

export function validateSculptIntent(
  msg: unknown,
  worldSize: number,
): SculptIntent | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'sculpt') return null;

  const { x, y, radius, dir } = m;
  if (!Number.isInteger(x) || (x as number) < 0 || (x as number) >= worldSize) return null;
  if (!Number.isInteger(y) || (y as number) < 0 || (y as number) >= worldSize) return null;
  if (
    !Number.isInteger(radius) ||
    (radius as number) < MIN_BRUSH_RADIUS ||
    (radius as number) > MAX_BRUSH_RADIUS
  ) {
    return null;
  }
  if (dir !== 1 && dir !== -1) return null;

  const { seq } = m;
  if (seq !== undefined && !Number.isSafeInteger(seq)) return null;

  const { tool, profile } = m;
  if (tool !== undefined && !SCULPT_TOOLS.includes(tool as SculptTool)) return null;
  if (tool === 'carve' && dir === 1) return null;
  if (profile !== undefined && !SCULPT_PROFILES.includes(profile as SculptProfile)) {
    return null;
  }

  const { targetBand } = m;
  if (
    targetBand !== undefined &&
    (!Number.isInteger(targetBand) ||
      (targetBand as number) < BEDROCK_BAND ||
      (targetBand as number) > MAX_BAND)
  ) {
    return null;
  }

  // A band travels with a drag and only with a drag: a drag without one names
  // no lip to move and would apply as a silent, acked no-op.
  if ((targetBand !== undefined) !== (tool === 'drag')) return null;

  // The run's floor, read in the grabbed column because no swept cell can
  // derive it. Rides with a drag and only a drag, never above its own band.
  const { floorBand } = m;
  if ((floorBand !== undefined) !== (tool === 'drag')) return null;
  if (
    floorBand !== undefined &&
    (!Number.isInteger(floorBand) ||
      (floorBand as number) < BEDROCK_BAND ||
      (floorBand as number) > (targetBand as number))
  ) {
    return null;
  }

  // Alt narrows a drag to the grabbed band alone. Rides with a drag and
  // only a drag; anything else carrying one promises a cut nothing reads.
  const { dragAlt } = m;
  if (dragAlt !== undefined) {
    if (typeof dragAlt !== 'boolean') return null;
    if (tool !== 'drag') return null;
  }

  // A carve grasps a band it can open; bedrock is not one, and acking a stroke
  // the applier always refuses would promise a cut that never happens.
  const { spanBand } = m;
  const lowestGraspableBand = tool === 'carve' ? LOWEST_CARVEABLE_BAND : BEDROCK_BAND;
  if (
    spanBand !== undefined &&
    (!Number.isInteger(spanBand) ||
      (spanBand as number) < lowestGraspableBand ||
      (spanBand as number) > MAX_BAND)
  ) {
    return null;
  }

  // A drag names its lip with targetBand; its cursor cell is not the grasped
  // cell, so a spanBand on one would be wrong where it mattered.
  if (spanBand !== undefined && tool === 'drag') return null;

  // Lambda tunes the smooth blur and only the smooth blur.
  const { smoothLambda } = m;
  if (smoothLambda !== undefined) {
    if (
      !Number.isInteger(smoothLambda) ||
      (smoothLambda as number) < SMOOTH_LAMBDA_MIN ||
      (smoothLambda as number) > SMOOTH_LAMBDA_MAX
    ) {
      return null;
    }
    if (tool !== 'smooth') return null;
  }

  // Feathering softens the smooth rim and only the smooth rim.
  const { smoothFeather } = m;
  if (smoothFeather !== undefined) {
    if (
      !Number.isInteger(smoothFeather) ||
      (smoothFeather as number) < SMOOTH_FEATHER_MIN ||
      (smoothFeather as number) > SMOOTH_FEATHER_MAX
    ) {
      return null;
    }
    if (tool !== 'smooth') return null;
  }

  // The rim clamp tightens the smooth halo and only the smooth halo.
  const { smoothRim } = m;
  if (smoothRim !== undefined) {
    if (
      !Number.isInteger(smoothRim) ||
      (smoothRim as number) < SMOOTH_RIM_MIN ||
      (smoothRim as number) > SMOOTH_RIM_MAX
    ) {
      return null;
    }
    if (tool !== 'smooth') return null;
  }

  // The Gaussian kernel reshapes the smooth average and only the smooth average.
  const { smoothKernel } = m;
  if (smoothKernel !== undefined) {
    if (!SMOOTH_KERNELS.includes(smoothKernel as SmoothKernel)) return null;
    if (tool !== 'smooth') return null;
  }

  // Bilateral gating narrows the smooth voters and only the smooth voters.
  const { smoothBilateral } = m;
  if (smoothBilateral !== undefined) {
    if (typeof smoothBilateral !== 'boolean') return null;
    if (tool !== 'smooth') return null;
  }

  // Full steps gate dust-driven unit moves, smooth only.
  const { smoothFullSteps } = m;
  if (smoothFullSteps !== undefined) {
    if (typeof smoothFullSteps !== 'boolean') return null;
    if (tool !== 'smooth') return null;
  }

  // A carve cuts the band it grasps: without one it names nothing to open and
  // would apply as a silent, acked no-op. Optional on a stamp or smooth.
  if (spanBand === undefined && tool === 'carve') return null;

  // A depth travels with a carve and only with a carve: on any other tool
  // nothing reads it, so acking it would promise a cut that never happens.
  const { depthBands } = m;
  if (depthBands !== undefined) {
    if (tool !== 'carve') return null;
    if (!isValidCarveDepth(depthBands as number)) return null;
  }

  const { fromX, fromY } = m;
  if (fromX !== undefined || fromY !== undefined) {
    if (tool !== 'drag') return null;
    if (!Number.isInteger(fromX) || (fromX as number) < 0 || (fromX as number) >= worldSize) return null;
    if (!Number.isInteger(fromY) || (fromY as number) < 0 || (fromY as number) >= worldSize) return null;
    if (chebyshevDistance(fromX as number, fromY as number, x as number, y as number) > MAX_DRAG_SWEEP_CELLS) {
      return null;
    }
  }

  return {
    type: 'sculpt',
    x: x as number,
    y: y as number,
    radius: radius as number,
    dir,
    ...(tool !== undefined ? { tool: tool as SculptTool } : {}),
    ...(profile !== undefined ? { profile: profile as SculptProfile } : {}),
    ...(targetBand !== undefined ? { targetBand: targetBand as number } : {}),
    ...(floorBand !== undefined ? { floorBand: floorBand as number } : {}),
    ...(dragAlt !== undefined ? { dragAlt: dragAlt as boolean } : {}),
    ...(spanBand !== undefined ? { spanBand: spanBand as number } : {}),
    ...(smoothLambda !== undefined ? { smoothLambda: smoothLambda as number } : {}),
    ...(smoothFeather !== undefined ? { smoothFeather: smoothFeather as number } : {}),
    ...(smoothRim !== undefined ? { smoothRim: smoothRim as number } : {}),
    ...(smoothBilateral !== undefined ? { smoothBilateral: smoothBilateral as boolean } : {}),
    ...(smoothFullSteps !== undefined ? { smoothFullSteps: smoothFullSteps as boolean } : {}),
    ...(smoothKernel !== undefined ? { smoothKernel: smoothKernel as SmoothKernel } : {}),
    ...(depthBands !== undefined ? { depthBands: depthBands as number } : {}),
    ...(fromX !== undefined ? { fromX: fromX as number, fromY: fromY as number } : {}),
    ...(seq !== undefined ? { seq: seq as number } : {}),
  };
}
