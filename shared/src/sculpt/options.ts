import { BEDROCK_BAND } from '../columns.ts';
import { MAX_HEIGHT, MIN_HEIGHT } from '../constants.ts';
import { bandOf } from '../grid.ts';

export const MIN_BAND = bandOf(MIN_HEIGHT);
export const MAX_BAND = bandOf(MAX_HEIGHT);

export const FULL_HEIGHT_SPAN = MAX_HEIGHT - MIN_HEIGHT;

export type SculptTool = 'stamp' | 'smooth' | 'drag' | 'carve';

/**
 * Library-only operation: lay the brush down, then relax what it left. Plugin
 * terraforms are tuned against it. `SCULPT_TOOLS` omits it, so the wire can
 * never name it.
 */
export type LibrarySculptTool = 'settle';

/** Every operation `applySculpt` can perform, wire-reachable or not. */
export type SculptOperation = SculptTool | LibrarySculptTool;

export type SculptProfile = 'soft' | 'hard';

export const SCULPT_TOOLS: readonly SculptTool[] = ['stamp', 'smooth', 'drag', 'carve'];

export const LIBRARY_SCULPT_TOOL: LibrarySculptTool = 'settle';

export const TOOLS_WITHOUT_EDGE_PROFILE: readonly SculptTool[] = ['smooth', 'drag', 'carve'];

export const TOOLS_WITHOUT_DIRECTION: readonly SculptTool[] = ['carve'];

/** Bedrock is a column's floor, not material, so the lowest slab a stroke can open sits above it. */
export const LOWEST_CARVEABLE_BAND = BEDROCK_BAND + 1;

/** A stroke cuts whole slabs, and one slab is the shallowest cut there is. */
export const CARVE_MIN_DEPTH_BANDS = 1;

export const CARVE_DEFAULT_DEPTH_BANDS = CARVE_MIN_DEPTH_BANDS;

/** The deepest one stroke may cut. The HUD ladder and the wire share it. */
export const CARVE_MAX_DEPTH_BANDS = 10;

/** The one depth predicate: the wire validator and applyCarve both ask it. */
export function isValidCarveDepth(depthBands: number): boolean {
  return (
    Number.isInteger(depthBands) &&
    depthBands >= CARVE_MIN_DEPTH_BANDS &&
    depthBands <= CARVE_MAX_DEPTH_BANDS
  );
}

/** Laplacian strength as integer percent, 1..100. Integer keeps math exact. */
export const SMOOTH_LAMBDA_DEFAULT = 50;
export const SMOOTH_LAMBDA_MIN = 1;
export const SMOOTH_LAMBDA_MAX = 100;

export const SCULPT_PROFILES: readonly SculptProfile[] = ['soft', 'hard'];

export type SculptSpill = 'banded' | 'free';

export type SculptAnchor = 'clicked' | 'free' | 'band';

export interface SculptOptions {
  readonly tool?: SculptOperation;
  readonly depthBands?: number;
  readonly profile?: SculptProfile;
  readonly spill?: SculptSpill;
  readonly anchor?: SculptAnchor;
  readonly targetBand?: number | null;
  readonly spanBand?: number | null;
  readonly sweepFrom?: SweepOrigin | null;
  readonly smoothLambda?: number;
}

export interface SweepOrigin {
  readonly x: number;
  readonly y: number;
}

export interface ResolvedSculptOptions {
  readonly tool: SculptOperation;
  readonly depthBands: number;
  readonly profile: SculptProfile;
  readonly spill: SculptSpill;
  readonly anchor: SculptAnchor;
  readonly targetBand: number | null;
  readonly spanBand: number | null;
  readonly sweepFrom: SweepOrigin | null;
  readonly smoothLambda: number;
}

export const LIBRARY_DEFAULT_SCULPT_OPTIONS: ResolvedSculptOptions = {
  tool: LIBRARY_SCULPT_TOOL,
  depthBands: CARVE_DEFAULT_DEPTH_BANDS,
  profile: 'soft',
  spill: 'free',
  anchor: 'free',
  targetBand: null,
  spanBand: null,
  sweepFrom: null,
  smoothLambda: SMOOTH_LAMBDA_DEFAULT,
};
