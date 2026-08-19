// Smoothing 5 Hz server truth into 60 Hz walking — wildlife's interpolator
// (its client/interpolation.ts), carried as this plugin's own copy under the
// plugin-isolation rule, re-keyed to pilgrim rows. The mechanism and every
// constant are wildlife's; see that file for the full reasoning (measured
// window, render-pose continuation, drop-don't-ease despawns).

import type { PilgrimEntityState, SettlerRace, WalkerKind } from '../protocol.ts';

/** A walker's pose for one frame. */
export interface InterpolatedPilgrim {
  readonly id: number;
  /** Stable for the walker's lifetime (ids are never reused across kinds),
   *  so the view layer may bind a model to it at first sight. */
  readonly kind: WalkerKind;
  readonly race: SettlerRace;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;
export const DEFAULT_INTERPOLATION_SECONDS = 0.2;

const TWO_PI = Math.PI * 2;

/** Shortest-way-round angle interpolation — wildlife's lerpAngle. */
export function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return from + delta * t;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

interface Pose {
  x: number;
  y: number;
  heading: number;
}

export class PilgrimInterpolator {
  private from = new Map<number, Pose>();
  private latest: readonly PilgrimEntityState[] = [];
  private elapsed = 0;
  private window = DEFAULT_INTERPOLATION_SECONDS;
  private sinceLastMessage = 0;
  private hasReceived = false;

  /** Feeds a freshly received (already validated) pilgrim list. */
  receive(pilgrims: readonly PilgrimEntityState[]): void {
    // Freeze the rendered pose FIRST — wildlife's ordering note applies.
    const rendered = this.sample();

    if (this.hasReceived) {
      this.window = Math.min(
        MAX_INTERPOLATION_SECONDS,
        Math.max(MIN_INTERPOLATION_SECONDS, this.sinceLastMessage),
      );
    }
    this.hasReceived = true;
    this.sinceLastMessage = 0;

    const next = new Map<number, Pose>();
    for (const pilgrim of pilgrims) {
      const current = rendered.get(pilgrim.id);
      next.set(
        pilgrim.id,
        current === undefined
          ? { x: pilgrim.x, y: pilgrim.y, heading: pilgrim.heading }
          : { x: current.x, y: current.y, heading: current.heading },
      );
    }

    this.from = next;
    this.latest = pilgrims;
    this.elapsed = 0;
  }

  advance(dt: number): void {
    this.elapsed += dt;
    this.sinceLastMessage += dt;
  }

  progress(): number {
    if (this.window <= 0) return 1;
    return Math.min(1, this.elapsed / this.window);
  }

  sample(): Map<number, InterpolatedPilgrim> {
    const t = this.progress();
    const poses = new Map<number, InterpolatedPilgrim>();

    for (const pilgrim of this.latest) {
      const start = this.from.get(pilgrim.id);
      if (start === undefined) {
        poses.set(pilgrim.id, pilgrim);
        continue;
      }
      poses.set(pilgrim.id, {
        id: pilgrim.id,
        kind: pilgrim.kind,
        race: pilgrim.race,
        x: lerp(start.x, pilgrim.x, t),
        y: lerp(start.y, pilgrim.y, t),
        heading: lerpAngle(start.heading, pilgrim.heading, t),
      });
    }

    return poses;
  }

  clear(): void {
    this.from.clear();
    this.latest = [];
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = DEFAULT_INTERPOLATION_SECONDS;
    this.hasReceived = false;
  }
}
