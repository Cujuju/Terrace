export interface PoseSegment {
  generation: number;
}

export interface PoseInterpolatorSpec<S, F extends PoseSegment, R> {
  readonly minWindowSeconds: number;
  readonly maxWindowSeconds: number;
  readonly defaultWindowSeconds: number;

  createSegment(): F;
  freeze(target: F, source: S | R): void;
  createRecord(state: S): R;
  updateRecord(record: R, state: S, segment: F | undefined, t: number): void;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

const TWO_PI = Math.PI * 2;

export function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return from + delta * t;
}

export class PoseInterpolator<S extends { readonly id: number }, F extends PoseSegment, R> {
  private readonly from = new Map<number, F>();
  private readonly poses = new Map<number, R>();
  private generation = 0;
  private latest: readonly S[] = [];
  private elapsed = 0;
  private window: number;
  private sinceLastMessage = 0;
  private hasReceived = false;

  private readonly spec: PoseInterpolatorSpec<S, F, R>;

  constructor(spec: PoseInterpolatorSpec<S, F, R>) {
    this.spec = spec;
    this.window = spec.defaultWindowSeconds;
  }

  receive(states: readonly S[]): void {
    const spec = this.spec;

    const rendered = this.sample();

    if (this.hasReceived) {
      this.window = Math.min(
        spec.maxWindowSeconds,
        Math.max(spec.minWindowSeconds, this.sinceLastMessage),
      );
    }
    this.hasReceived = true;
    this.sinceLastMessage = 0;

    const generation = ++this.generation;
    for (const state of states) {
      const current = rendered.get(state.id);
      let start = this.from.get(state.id);
      if (start === undefined) {
        start = spec.createSegment();
        this.from.set(state.id, start);
      }
      spec.freeze(start, current === undefined ? state : current);
      start.generation = generation;
    }
    for (const [id, start] of this.from) {
      if (start.generation !== generation) {
        this.from.delete(id);
        this.poses.delete(id);
      }
    }

    this.latest = states;
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

  lagSeconds(): number {
    return Math.max(0, this.window - this.elapsed);
  }

  sample(): ReadonlyMap<number, R> {
    const spec = this.spec;
    const t = this.progress();
    const poses = this.poses;

    for (const state of this.latest) {
      let record = poses.get(state.id);
      if (record === undefined) {
        record = spec.createRecord(state);
        poses.set(state.id, record);
      }
      spec.updateRecord(record, state, this.from.get(state.id), t);
    }

    return poses;
  }

  clear(): void {
    this.from.clear();
    this.poses.clear();
    this.latest = [];
    this.elapsed = 0;
    this.sinceLastMessage = 0;
    this.window = this.spec.defaultWindowSeconds;
    this.hasReceived = false;
  }
}
