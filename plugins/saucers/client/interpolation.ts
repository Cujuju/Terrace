// Smoothing 10 Hz server truth into frame-rate motion.
//
// THE MACHINERY IS THE CLIENT KIT'S (client/src/plugins/kit/interpolator.ts) —
// six plugins carried the same class over different payloads. What is left here
// is the part that is actually about saucers: this plugin's window bounds, and
// which fields walk, which turn the short way round, and which are carried
// through untouched.
//
// WHAT WALKS AND WHAT DOES NOT:
//   * x, y, alt — linear. A saucer's path is smooth everywhere except the two
//     phase boundaries, and those are half a message apart at this cadence.
//   * heading — the SHORT way round (`lerpAngle`), which matters more here than
//     for any other plugin: a saucer on the dogfight circle sweeps through ±π
//     twice a lap, and walking that the long way would spin the hull 350° in a
//     tenth of a second, every lap, twice.
//   * variant, phase, hp, speed — carried, never blended. Three of them are not
//     continuous quantities at all, and `speed` is a value the server states
//     rather than a rate the client should smooth: a blended speed would bank
//     the hull toward a turn it is no longer in.
//
// Pure logic: no three, no DOM, no clock. Time enters only through `advance(dt)`.

import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { SaucerPhase, SaucerState } from '../protocol.ts';

export { lerp, lerpAngle };

/** A saucer's pose for one frame. */
export interface InterpolatedSaucer {
  readonly id: number;
  readonly variant: number;
  readonly x: number;
  readonly y: number;
  readonly alt: number;
  readonly heading: number;
  readonly speed: number;
  readonly phase: SaucerPhase;
  readonly hp: number;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is MEASURED rather than assumed, so this keeps working if the
 * server's tick rate or broadcast interval is retuned — but a measurement taken
 * across a stall must not become the window. The floor is one 60 Hz frame; the
 * ceiling is a QUARTER SECOND, sized to ride out one dropped message at the
 * shipped 10 Hz cadence and no more.
 *
 * THAT CEILING IS EIGHT TIMES TIGHTER THAN MONSTERS', on purpose. A monster
 * gliding two seconds past its last known pose has moved half a cell; a saucer
 * doing the same has crossed 68 world units — half the world — so the clamp that
 * is generous for a lurking horror is a catastrophe here. At a quarter second
 * the worst a stall costs is a saucer holding still for a beat, which is what
 * the kit's clamp-rather-than-extrapolate rule is for.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 0.25;

/** Nominal window before any two messages have been seen (10 Hz = 0.1 s). */
export const DEFAULT_INTERPOLATION_SECONDS = 0.1;

/** The pose a segment is walked from. */
interface Pose extends PoseSegment {
  x: number;
  y: number;
  alt: number;
  heading: number;
}

/**
 * One saucer's pose record. Mutable and PERSISTENT: the kit refills these in
 * place every frame instead of allocating a Map and an object per saucer per
 * frame. Consumers see it through the readonly InterpolatedSaucer face and must
 * not hold one across frames.
 */
interface PoseRecord extends InterpolatedSaucer {
  variant: number;
  x: number;
  y: number;
  alt: number;
  heading: number;
  speed: number;
  phase: SaucerPhase;
  hp: number;
}

/**
 * Two-pose interpolator, keyed by saucer id.
 *
 * Saucers absent from the newest message are dropped immediately — a departure
 * is something the server has already decided, and both of this plugin's
 * departures (the wreck and the winner) are meant to be abrupt.
 */
export class SaucerInterpolator extends PoseInterpolator<SaucerState, Pose, PoseRecord> {
  constructor() {
    super({
      minWindowSeconds: MIN_INTERPOLATION_SECONDS,
      maxWindowSeconds: MAX_INTERPOLATION_SECONDS,
      defaultWindowSeconds: DEFAULT_INTERPOLATION_SECONDS,
      createSegment: () => ({ x: 0, y: 0, alt: 0, heading: 0, generation: 0 }),
      freeze: (target, source) => {
        target.x = source.x;
        target.y = source.y;
        target.alt = source.alt;
        target.heading = source.heading;
      },
      createRecord: (saucer) => ({ ...saucer }),
      updateRecord: (record, saucer, segment, t) => {
        record.variant = saucer.variant;
        record.speed = saucer.speed;
        record.phase = saucer.phase;
        record.hp = saucer.hp;
        if (segment === undefined) {
          record.x = saucer.x;
          record.y = saucer.y;
          record.alt = saucer.alt;
          record.heading = saucer.heading;
          return;
        }
        record.x = lerp(segment.x, saucer.x, t);
        record.y = lerp(segment.y, saucer.y, t);
        record.alt = lerp(segment.alt, saucer.alt, t);
        record.heading = lerpAngle(segment.heading, saucer.heading, t);
      },
    });
  }
}
