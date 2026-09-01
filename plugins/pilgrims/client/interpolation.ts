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
  /** The receive() generation that last listed this id; older entries are dead. */
  generation: number;
}

/**
 * One pilgrim's pose record. Mutable and PERSISTENT: sample() refills these in
 * place every frame instead of allocating a Map and an object per pilgrim per
 * frame (perf review 2026-08-29, A5). Consumers see it through the readonly
 * InterpolatedPilgrim face and must not hold one across frames.
 */
interface PoseRecord extends InterpolatedPilgrim {
  x: number;
  y: number;
  heading: number;
  kind: InterpolatedPilgrim['kind'];
  race: InterpolatedPilgrim['race'];
}

export class PilgrimInterpolator {
  private from = new Map<number, Pose>();
  /** The records sample() hands out, keyed by id — refilled, never rebuilt. */
  private readonly poses = new Map<number, PoseRecord>();
  /** Bumped per receive(); a `from` entry not stamped with it has despawned. */
  private generation = 0;
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

    // Refilled in place; entries the message no longer lists are pruned below,
    // and the sampled records for those ids go with them.
    const generation = ++this.generation;
    for (const pilgrim of pilgrims) {
      const current = rendered.get(pilgrim.id);
      let start = this.from.get(pilgrim.id);
      if (start === undefined) {
        start = { x: 0, y: 0, heading: 0, generation };
        this.from.set(pilgrim.id, start);
      }
      // One seen for the first time has no history: it starts where the server
      // says it is, which is the only honest answer.
      const source = current === undefined ? pilgrim : current;
      start.x = source.x;
      start.y = source.y;
      start.heading = source.heading;
      start.generation = generation;
    }
    for (const [id, start] of this.from) {
      if (start.generation !== generation) {
        this.from.delete(id);
        this.poses.delete(id);
      }
    }
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

  sample(): ReadonlyMap<number, InterpolatedPilgrim> {
    const t = this.progress();
    const poses = this.poses;

    for (const pilgrim of this.latest) {
      let record = poses.get(pilgrim.id);
      if (record === undefined) {
        record = { ...pilgrim };
        poses.set(pilgrim.id, record);
      }
      record.kind = pilgrim.kind;
      record.race = pilgrim.race;
      const start = this.from.get(pilgrim.id);
      if (start === undefined) {
        record.x = pilgrim.x;
        record.y = pilgrim.y;
        record.heading = pilgrim.heading;
        continue;
      }
      record.x = lerp(start.x, pilgrim.x, t);
      record.y = lerp(start.y, pilgrim.y, t);
      record.heading = lerpAngle(start.heading, pilgrim.heading, t);
    }

    return poses;
  }

  clear(): void {
    this.from.clear();
    this.poses.clear();
    this.latest = [];
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = DEFAULT_INTERPOLATION_SECONDS;
    this.hasReceived = false;
  }
}
