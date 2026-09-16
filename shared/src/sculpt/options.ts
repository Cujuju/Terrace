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

/**
 * Bands of material one stroke cuts. Its drawn opening is one band shallower —
 * the remnant's cap rounds up — and that is the smallest gap isGapDrawn keeps.
 */
export const CARVE_BANDS_PER_STROKE = 2;

export const SCULPT_PROFILES: readonly SculptProfile[] = ['soft', 'hard'];

export type SculptSpill = 'banded' | 'free';

export type SculptAnchor = 'clicked' | 'free' | 'band';

export interface SculptOptions {
  readonly tool?: SculptOperation;
  readonly profile?: SculptProfile;
  readonly spill?: SculptSpill;
  readonly anchor?: SculptAnchor;
  readonly targetBand?: number | null;
  readonly spanBand?: number | null;
  readonly sweepFrom?: SweepOrigin | null;
}

export interface SweepOrigin {
  readonly x: number;
  readonly y: number;
}

export interface ResolvedSculptOptions {
  readonly tool: SculptOperation;
  readonly profile: SculptProfile;
  readonly spill: SculptSpill;
  readonly anchor: SculptAnchor;
  readonly targetBand: number | null;
  readonly spanBand: number | null;
  readonly sweepFrom: SweepOrigin | null;
}

export const LIBRARY_DEFAULT_SCULPT_OPTIONS: ResolvedSculptOptions = {
  tool: LIBRARY_SCULPT_TOOL,
  profile: 'soft',
  spill: 'free',
  anchor: 'free',
  targetBand: null,
  spanBand: null,
  sweepFrom: null,
};
