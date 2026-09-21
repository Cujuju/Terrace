import { DRAWN_GROUND_SIMPLIFY_EPSILON } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../config.ts';
import { RECT_NONE, type ContourLoop } from './contours.ts';

export const CONTOUR_SIMPLIFY_EPSILON = DRAWN_GROUND_SIMPLIFY_EPSILON;

function dropCollinear(loop: ContourLoop): ContourLoop {
  const n = loop.length;
  if (n < 4) return loop;
  const out: ContourLoop = [];
  for (let i = 0; i < n; i++) {
    const prev = out.length > 0 ? out[out.length - 1] : loop[(i + n - 1) % n];
    const here = loop[i];
    const next = loop[(i + 1) % n];
    if (here.rect !== RECT_NONE) {
      out.push(here);
      continue;
    }
    const area = Math.abs(
      (here.x - prev.x) * (next.z - prev.z) - (here.z - prev.z) * (next.x - prev.x),
    );
    const base = Math.hypot(next.x - prev.x, next.z - prev.z);
    if (base > 0 && area / base < CONTOUR_SIMPLIFY_EPSILON) continue;
    out.push(here);
  }
  return out.length >= 3 ? out : loop;
}

export function simplifyLoop(loop: ContourLoop): ContourLoop {
  return dropCollinear(loop);
}

// Chart lips smooth here; footprint and water loops bypass charts and can adopt the core later.
export const LIP_SMOOTH_CHAIKIN_PASSES = 2;

function lipKey(x: number, z: number): string {
  return `${Math.round((x / CELL_WORLD_SIZE) * 1024)},${Math.round((z / CELL_WORLD_SIZE) * 1024)}`;
}

function chaikin(points: number[], closed: boolean): number[] {
  const n = points.length / 2;
  if (n < 2 || (!closed && n < 3)) return points;
  const out: number[] = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    const ax = points[i * 2]!;
    const az = points[i * 2 + 1]!;
    const bx = points[j * 2]!;
    const bz = points[j * 2 + 1]!;
    if (i === 0 && !closed) out.push(ax, az);
    out.push(ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25);
    out.push(ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75);
  }
  if (!closed) out.push(points[n * 2 - 2]!, points[n * 2 - 1]!);
  return out;
}

interface LipChain {
  readonly points: number[];
  readonly closed: boolean;
}

function chainRun(
  coords: Float32Array,
  stride: number,
  firstSegment: number,
  segmentCount: number,
): LipChain[] {
  const base = firstSegment * stride;
  const xAt = (s: number, end: 0 | 1): number =>
    end === 0 ? coords[base + s * stride]! : coords[base + s * stride + stride / 2]!;
  const zAt = (s: number, end: 0 | 1): number =>
    end === 0 ? coords[base + s * stride + 1]! : coords[base + s * stride + stride / 2 + 1]!;
  const byKey = new Map<string, Array<{ seg: number; end: 0 | 1 }>>();
  for (let s = 0; s < segmentCount; s++) {
    for (const end of [0, 1] as const) {
      const key = lipKey(xAt(s, end), zAt(s, end));
      const list = byKey.get(key);
      const ref = { seg: s, end };
      if (list === undefined) byKey.set(key, [ref]);
      else list.push(ref);
    }
  }
  const used = new Array<boolean>(segmentCount).fill(false);
  const chains: LipChain[] = [];
  const walk = (seg: number, end: 0 | 1, points: number[]): void => {
    points.push(xAt(seg, end), zAt(seg, end));
    let here = seg;
    let exit: 0 | 1 = end === 0 ? 1 : 0;
    for (;;) {
      used[here] = true;
      points.push(xAt(here, exit), zAt(here, exit));
      const key = lipKey(xAt(here, exit), zAt(here, exit));
      const next = (byKey.get(key) ?? []).find((r) => !used[r.seg]);
      if (next === undefined) return;
      here = next.seg;
      exit = next.end === 0 ? 1 : 0;
    }
  };
  for (;;) {
    const start = (() => {
      for (const [, list] of byKey) {
        const free = list.filter((r) => !used[r.seg]);
        if (free.length === 1) return free[0]!;
      }
      for (let s = 0; s < segmentCount; s++) {
        if (!used[s]) return { seg: s, end: 0 as 0 | 1 };
      }
      return null;
    })();
    if (start === null) break;
    const points: number[] = [];
    walk(start.seg, start.end, points);
    if (points.length < 4) continue;
    const n = points.length;
    const closed =
      n >= 8 && points[0] === points[n - 2] && points[1] === points[n - 1];
    chains.push({ points: closed ? points.slice(0, n - 2) : points, closed });
  }
  return chains;
}

export interface SmoothedLips {
  readonly coords: Float32Array;
  readonly bands: Int32Array;
}

export function smoothLipSegments(
  coords: Float32Array,
  stride: 4 | 6,
  bands: ArrayLike<number>,
): SmoothedLips {
  const runs: number[][] = [];
  const triples: number[] = [];
  for (let i = 0; i + 2 < bands.length; i += 3) {
    const band = bands[i]!;
    const firstSegment = bands[i + 1]!;
    const segmentCount = bands[i + 2]!;
    if (segmentCount <= 0) continue;
    const y = stride === 6 ? coords[firstSegment * stride + 1]! : 0;
    const out: number[] = [];
    for (const chain of chainRun(coords, stride, firstSegment, segmentCount)) {
      let points = chain.points;
      for (let p = 0; p < LIP_SMOOTH_CHAIKIN_PASSES; p++) points = chaikin(points, chain.closed);
      const emit = (x: number, z: number): void => {
        if (stride === 6) out.push(x, y, z);
        else out.push(x, z);
      };
      const n = points.length / 2;
      for (let k = 0; k < n; k++) {
        const m = (k + 1) % n;
        if (!chain.closed && m === 0) break;
        emit(points[k * 2]!, points[k * 2 + 1]!);
        emit(points[m * 2]!, points[m * 2 + 1]!);
      }
    }
    triples.push(band, runs.reduce((sum, run) => sum + run.length / stride, 0), out.length / stride);
    runs.push(out);
  }
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  const merged = new Float32Array(total);
  let at = 0;
  for (const run of runs) {
    merged.set(run, at);
    at += run.length;
  }
  return { coords: merged, bands: Int32Array.from(triples) };
}
