import { OUTLINE_FIXED_POINT, isClosedOutline as isClosed, type Point } from './outlineTrace.ts';

/** Outlines are resampled two points per cell, so windows are set in cells. */
export const SAMPLES_PER_CELL = 2;
export const SAMPLE_FIXED = OUTLINE_FIXED_POINT / SAMPLES_PER_CELL;

/** Blurred coordinates carry 16x precision, so repeated passes round nothing away. */
const BLUR_PRECISION = 16;

/** The median reaches twice the kink each way, so a bump up to twice the kink wide is outvoted. */
const MEDIAN_REACH_KINKS = 2;

/** Half the median window, in samples. */
export function medianReachSamples(kinkHalfCells: number): number {
  return (MEDIAN_REACH_KINKS * kinkHalfCells * SAMPLES_PER_CELL) / 2;
}

/** Points every SAMPLE_FIXED along the line, on it; one is pinned when the stretch it falls in is. A closed ring comes back unclosed. */
function resample(line: Point[]): Point[] {
  const out: Point[] = [];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.floor(Math.sqrt(dx * dx + dy * dy));
    const pinned = a.pinned && b.pinned;
    for (; carry < length; carry += SAMPLE_FIXED) {
      out.push({ x: a.x + Math.trunc((dx * carry) / length), y: a.y + Math.trunc((dy * carry) / length), pinned: pinned || (carry === 0 && a.pinned) });
    }
    carry -= length;
  }
  if (!isClosed(line)) out.push(line[line.length - 1]!);
  return out;
}

/**
 * `passes` rounds of the [1 2 1] blur: a binomial kernel, variance passes / 2
 * samples². Pinned points hold; an open line's ends see themselves past the end.
 */
function blur(values: Int32Array, pinned: Uint8Array, closed: boolean, passes: number): Int32Array {
  const n = values.length;
  let current = values.slice();
  let next = values.slice();
  const runs: number[] = [];
  for (let i = 0; i < n;) {
    if (pinned[i] === 1) { i++; continue; }
    const start = i++;
    while (i < n && pinned[i] !== 1) i++;
    runs.push(start, i);
  }
  const settled = new Uint8Array(runs.length / 2);
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    // Both buffers retain the original pinned values; only movable runs need writes.
    for (let run = 0; run < runs.length; run += 2) {
      if (settled[run / 2] === 1) continue;
      let runChanged = false;
      const start = runs[run]!;
      const end = runs[run + 1]!;
      for (let i = runs[run]!; i < end; i++) {
        const before = i > 0 ? current[i - 1]! : closed ? current[n - 1]! : current[i]!;
        const after = i < n - 1 ? current[i + 1]! : closed ? current[0]! : current[i]!;
        const value = Math.floor((before + 2 * current[i]! + after + 2) / 4);
        next[i] = value;
        if (value !== current[i]) runChanged = true;
      }
      if (runChanged) changed = true;
      else if (!closed || (start > 0 && end < n) || pinned[0] === 1 || pinned[n - 1] === 1) {
        // Fixed runs between pinned boundaries cannot be disturbed by another run.
        settled[run / 2] = 1;
      }
    }
    [current, next] = [next, current];
    // A fixed point of this integer recurrence stays fixed for every remaining pass.
    if (!changed) break;
  }
  return current;
}

/** Blurred precision back to fixed-point outline units, rounded. */
function unblurred(v: number): number {
  return Math.floor((v + BLUR_PRECISION / 2) / BLUR_PRECISION);
}

/**
 * Each point takes the median of its neighbours' offsets from a wide low-pass:
 * a narrow bump is outvoted outright, while an arc's offsets vary smoothly and stay.
 */
export function smoothLine(line: Point[], kinkHalfCells: number): Point[] {
  if (line.every((p) => p.pinned)) return line;
  const closed = isClosed(line);
  const samples = resample(line);
  const n = samples.length;
  const pinned = Uint8Array.from(samples, (p) => (p.pinned ? 1 : 0));
  if (n < 3 || !pinned.includes(0)) return line;
  const reach = medianReachSamples(kinkHalfCells);
  // Twice the blur less the blur twice keeps arcs' radius; sigma is the median's reach, variance passes / 2.
  const passes = 2 * reach * reach;
  const reference = (raw: Int32Array): Int32Array => {
    const once = blur(raw, pinned, closed, passes);
    const twice = blur(once, pinned, closed, passes);
    return raw.map((v, i) => (pinned[i] === 1 ? v : 2 * once[i]! - twice[i]!));
  };
  const xs = Int32Array.from(samples, (p) => p.x * BLUR_PRECISION);
  const ys = Int32Array.from(samples, (p) => p.y * BLUR_PRECISION);
  const refX = reference(xs);
  const refY = reference(ys);

  // Each point's offset from the reference along its normal; pinned points sit on it.
  const normalX = new Int32Array(n);
  const normalY = new Int32Array(n);
  const normalLength = new Int32Array(n);
  const offsets = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const before = i > 0 ? i - 1 : closed ? n - 1 : i;
    const after = i < n - 1 ? i + 1 : closed ? 0 : i;
    const tx = refX[after]! - refX[before]!;
    const ty = refY[after]! - refY[before]!;
    const length = Math.floor(Math.sqrt(tx * tx + ty * ty));
    normalX[i] = -ty;
    normalY[i] = tx;
    normalLength[i] = length;
    if (length > 0) offsets[i] = Math.trunc(((xs[i]! - refX[i]!) * -ty + (ys[i]! - refY[i]!) * tx) / length);
  }

  // A ring's window stops short of meeting itself, so no sample votes twice.
  const span = closed ? Math.min(reach, (n - 1) >> 1) : reach;
  const window = new Int32Array(2 * span + 1);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (pinned[i] === 1) {
      out.push(samples[i]!);
      continue;
    }
    if (normalLength[i] === 0) {
      out.push({ x: unblurred(refX[i]!), y: unblurred(refY[i]!), pinned: false });
      continue;
    }
    let count = 0;
    for (let d = -span; d <= span; d++) {
      const j = i + d;
      if (closed) window[count++] = offsets[(j + n) % n]!;
      else if (j >= 0 && j < n) window[count++] = offsets[j]!;
    }
    const votes = window.subarray(0, count).sort();
    const median = votes[(count - 1) >> 1]!;
    const x = refX[i]! + Math.trunc((median * normalX[i]!) / normalLength[i]!);
    const y = refY[i]! + Math.trunc((median * normalY[i]!) / normalLength[i]!);
    out.push({ x: unblurred(x), y: unblurred(y), pinned: false });
  }
  if (closed) out.push(out[0]!);
  return out;
}
