import type { ClimbLeg, ClimbState, LeapArc } from '@terrace/shared';

const FINITE_FIELDS = [
  'visualId', 'toX', 'toY', 'footX', 'footY', 'entryX', 'entryY', 'exitX', 'exitY',
  'fromHeight', 'toHeight', 'lowHeight', 'highHeight', 'heading', 'turnFrom',
  'risePerSecond', 'lipSeconds', 'groundSeconds', 'height', 'legIndex', 'legElapsed', 'releaseHeight',
] as const satisfies readonly (keyof ClimbState)[];

const CLIMB_LEGS: readonly ClimbLeg[] = ['turn', 'lip', 'face', 'ground', 'leap'];
const LEAP_FIELDS = ['seconds', 'riseSeconds', 'apexHeight', 'releaseSeconds'] as const satisfies readonly (keyof LeapArc)[];

/** Validate the complete saved engine state; endpoints and timing are never reconstructed from terrain. */
export function isPersistedClimb(value: unknown): value is ClimbState | null {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const state = value as Partial<ClimbState>;
  if (!FINITE_FIELDS.every((key) => typeof state[key] === 'number' && Number.isFinite(state[key]))) return false;
  if (typeof state.descending !== 'boolean' || typeof state.doomed !== 'boolean' || typeof state.falling !== 'boolean') return false;
  if (!Array.isArray(state.legs) || state.legs.length === 0 || state.legs.length > CLIMB_LEGS.length) return false;
  if (!state.legs.every((leg: unknown) => CLIMB_LEGS.includes(leg as ClimbLeg))) return false;
  const complete = state as ClimbState;
  if (!Number.isSafeInteger(complete.visualId) || !Number.isSafeInteger(complete.toX) ||
    !Number.isSafeInteger(complete.toY) || complete.toX < 0 || complete.toY < 0) return false;
  if (!Number.isInteger(complete.legIndex) || complete.legIndex < 0 || complete.legIndex > complete.legs.length) return false;
  if (complete.risePerSecond <= 0 || complete.lipSeconds < 0 || complete.groundSeconds < 0 || complete.legElapsed < 0) return false;
  if (complete.fromHeight === complete.toHeight || complete.lowHeight !== Math.min(complete.fromHeight, complete.toHeight) ||
    complete.highHeight !== Math.max(complete.fromHeight, complete.toHeight) ||
    complete.descending !== (complete.toHeight < complete.fromHeight)) return false;
  if (complete.releaseHeight < complete.lowHeight || complete.releaseHeight > complete.highHeight ||
    (complete.falling && !complete.doomed)) return false;
  const leap = state.leap;
  if (leap !== null) {
    if (typeof leap !== 'object' || leap === undefined) return false;
    if (!LEAP_FIELDS.every((key) => typeof leap[key] === 'number' && Number.isFinite(leap[key]))) return false;
    if (leap.seconds <= 0 || leap.riseSeconds <= 0 || leap.riseSeconds >= leap.seconds ||
      leap.releaseSeconds < 0 || leap.releaseSeconds > leap.seconds || leap.apexHeight < complete.highHeight) return false;
    if (complete.legs.length !== 1 || complete.legs[0] !== 'leap') return false;
  } else if (complete.legs.includes('leap')) return false;
  return true;
}
