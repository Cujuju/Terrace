// The ultralight frame meter: what `renderer.render` costs on the CPU, held
// against how long the page has been open.
//
// WHY NOT perfProbe.ts: the decay in
// docs/plans/frame-rate-decay-2026-09-05.md §7d is entirely CPU time inside
// `renderer.render` while GPU time, draw calls and the scene graph stay flat.
// perfProbe.ts can see that, but only in a dev build behind `?perfprobe=`,
// and by wrapping rAF/setTimeout/addEventListener — a whole night went into
// proving the probe wasn't itself the cause (§7d, `noInstrument`). This file
// wraps nothing; it costs two extra clock reads and three floats per frame,
// so it ships enabled and the decay can be watched in a normal session.
//
// WHY WORK TIME, NOT INTERVAL: interval is vsync-capped, so a frame whose CPU
// cost doubles from 2ms to 4ms shows an unchanged 16.7ms interval right up
// until it crosses budget, then falls off a cliff. Interval is recorded too
// since "has growth crossed budget yet" needs both.
//
// WHY COUNTERS ARE READ ONCE PER WINDOW: `renderer.info` (the only thing here
// shown to grow — §7d: textures 37→74) grows on the scale of minutes; reading
// it per frame would cost more than everything else in this file combined.
//
// WHY NOTHING PUBLISHES UNLESS SOMETHING LISTENS: main.tsx installs a sink
// only when a readout is on. With no sink the window still closes and
// `latestSample` still updates, so `__terracePerf.stats()` is never stale —
// but no signal writes and Solid never re-renders.

import { FRAME_STATS_CAPACITY, FRAME_STATS_WINDOW_MS } from '../config.ts';

/**
 * What the renderer can be asked once per window, plus drawing-buffer size.
 *
 * PIXEL COUNT IS NOT OPTIONAL: frame time is a function of it, so readings at
 * different sizes aren't comparable. Every number in
 * docs/plans/frame-rate-decay-2026-09-05.md was taken at 1600x900
 * (scripts/gpu-bench.sh, 44% of the owner's actual 1440p) without stating so
 * — argued over for a night. No sample here omits it.
 */
export interface FrameCounters {
  /** Drawing-buffer width in physical pixels — canvas CSS size x pixel ratio. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /**
   * Camera-to-target distance, world units.
   *
   * INVALIDATED A DAY OF BENCH NUMBERS (2026-09-06): the bench's throwaway
   * Chrome profile has no stored camera pose and saw 138-162 draw calls; the
   * owner's restored pose saw 305-337. Same build, same world — two
   * populations of the frustum, unlabeled. A frame time without its camera
   * pose is as unreadable as one without pixel count.
   */
  readonly cameraDistance: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

/** One plugin's share of the frame, meaned over the window. */
export interface PluginFrameCost {
  readonly name: string;
  /** Mean milliseconds this plugin's frame callbacks cost, per frame. */
  readonly msPerFrame: number;
  /** That cost as a fraction of the mean whole frame, 0-1. */
  readonly shareOfFrame: number;
}

export interface FrameStatsSample {
  /** Seconds since the first recorded frame — the decay's x axis. */
  readonly uptimeS: number;
  /** Frames actually recorded in the window (may exceed those kept; see below). */
  readonly frames: number;
  /** rAF callback body, start to the return of `renderer.render`. */
  readonly frameMsP50: number;
  readonly frameMsP99: number;
  readonly frameMsMax: number;
  /** `renderer.render` alone — the quantity that decays. */
  readonly renderMsP50: number;
  readonly renderMsP99: number;
  /** Frame body minus the render: plugin callbacks, controls, clearance. */
  readonly outsideMsP50: number;
  /** Wall-clock frame-to-frame gap; vsync-capped, unlike the three above. */
  readonly intervalMsP50: number;
  /**
   * Median GPU ms/frame, or null where the timer extension is absent.
   *
   * Null, never zero: "no GPU clock" and "GPU took no time" must not read
   * alike in the row that decides whether a slow frame is the GPU's fault.
   */
  readonly gpuMsP50: number | null;
  readonly counters: FrameCounters;
  /** Every plugin that ran a frame callback in the window, dearest first. */
  readonly plugins: readonly PluginFrameCost[];
}

type FrameStatsSink = (sample: FrameStatsSample) => void;

/** What a window reports before render/scene.ts has handed over the renderer. */
const EMPTY_COUNTERS: FrameCounters = {
  pixelWidth: 0,
  pixelHeight: 0,
  cameraDistance: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
};

// Ring buffers, allocated once. Float32 gives ~7 significant digits, six more
// than a millisecond reading needs.
const frameMs = new Float32Array(FRAME_STATS_CAPACITY);
const renderMs = new Float32Array(FRAME_STATS_CAPACITY);
const intervalMs = new Float32Array(FRAME_STATS_CAPACITY);
// Derived per window rather than per frame: one subtraction at close is
// cheaper than one every frame.
const outsideMs = new Float32Array(FRAME_STATS_CAPACITY);
// Percentile sort works on this copy so it never reorders the ring under the
// write cursor.
const scratch = new Float32Array(FRAME_STATS_CAPACITY);

let writeCursor = 0;
/** Frames written since the window opened. May exceed CAPACITY — see below. */
let windowFrames = 0;
let windowStartMs = 0;
let firstFrameMs = 0;
let prevStartMs = 0;
let latestSample: FrameStatsSample | null = null;
let sink: FrameStatsSink | null = null;
let readCounters: (() => FrameCounters) | null = null;
let drainGpu: (() => number[]) | null = null;
/** GPU results that landed this window. Cleared at every close, like pluginMs. */
let gpuMs: number[] = [];

/**
 * Milliseconds each plugin spent in frame callbacks this window, by name.
 *
 * A running total, not a ring per plugin: the per-frame series above earn
 * their ring buffers because percentiles are the question there (a p99 frame
 * is a stutter someone saw); a plugin's share is a mean, needing only one
 * accumulator. Entries are zeroed each window, never deleted, so an
 * unmounted plugin falls to 0.00 for a window rather than vanishing mid-read.
 */
const pluginMs = new Map<string, number>();

/** Hands the meter its counter source; called once by render/scene.ts, so this file avoids importing three and stays testable without a GL context. */
export function setFrameCounterSource(read: () => FrameCounters): void {
  readCounters = read;
}

/** Hands the meter its GPU clock (render/gpuTimer.ts), same reason as setFrameCounterSource. */
export function setGpuSampleSource(drain: () => number[]): void {
  drainGpu = drain;
}

/** Installs (or with null, removes) the once-per-window sink. With no sink the meter still runs and updates `frameStatsSample()`; it just publishes nothing. */
export function setFrameStatsSink(next: FrameStatsSink | null): void {
  sink = next;
}

/** The most recently closed window, or null before the first one closes. */
export function frameStatsSample(): FrameStatsSample | null {
  return latestSample;
}

/** Median of a plain array; sorted in place, which the caller discards. */
function medianOf(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(0.5 * values.length) - 1))] ?? 0;
}

function sumOf(source: Float32Array, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += source[i] ?? 0;
  return total;
}

function percentile(sorted: Float32Array, count: number, fraction: number): number {
  if (count === 0) return 0;
  // Nearest-rank, clamped: with 30 samples a "p99" is just the largest one.
  const rank = Math.min(count - 1, Math.max(0, Math.ceil(fraction * count) - 1));
  return sorted[rank] ?? 0;
}

function summarise(source: Float32Array, count: number, fraction: number): number {
  scratch.set(source.subarray(0, count));
  const view = scratch.subarray(0, count);
  view.sort();
  return percentile(view, count, fraction);
}

function closeWindow(nowMs: number): void {
  // Buffers keep at most CAPACITY frames; `frames` still counts every one, so
  // an overflow is visible in the sample rather than silently changing what
  // the percentiles mean.
  const kept = Math.min(windowFrames, FRAME_STATS_CAPACITY);
  // Drained at close, not per frame: the driver answers when it answers.
  if (drainGpu !== null) gpuMs = gpuMs.concat(drainGpu());
  const gpuMsP50 = gpuMs.length === 0 ? null : medianOf(gpuMs);
  gpuMs = [];
  // Meaned over every frame in the window, including idle ones: a plugin
  // that works every third frame costs a third as much as one working every one.
  const meanFrameMs = kept === 0 ? 0 : sumOf(frameMs, kept) / kept;
  const plugins: PluginFrameCost[] = [];
  for (const [name, totalMs] of pluginMs) {
    const msPerFrame = kept === 0 ? 0 : totalMs / kept;
    plugins.push({
      name,
      msPerFrame,
      shareOfFrame: meanFrameMs === 0 ? 0 : msPerFrame / meanFrameMs,
    });
    pluginMs.set(name, 0);
  }
  plugins.sort((a, b) => b.msPerFrame - a.msPerFrame);
  // Median of the per-frame differences, not the difference of two medians —
  // those aren't the same number. Built before summarise() reuses `scratch`.
  for (let i = 0; i < kept; i++) outsideMs[i] = (frameMs[i] ?? 0) - (renderMs[i] ?? 0);
  latestSample = {
    uptimeS: (nowMs - firstFrameMs) / 1000,
    frames: windowFrames,
    frameMsP50: summarise(frameMs, kept, 0.5),
    frameMsP99: summarise(frameMs, kept, 0.99),
    frameMsMax: summarise(frameMs, kept, 1),
    renderMsP50: summarise(renderMs, kept, 0.5),
    renderMsP99: summarise(renderMs, kept, 0.99),
    outsideMsP50: summarise(outsideMs, kept, 0.5),
    intervalMsP50: summarise(intervalMs, kept, 0.5),
    gpuMsP50,
    counters: readCounters?.() ?? EMPTY_COUNTERS,
    plugins,
  };
  windowFrames = 0;
  writeCursor = 0;
  windowStartMs = nowMs;
  sink?.(latestSample);
}

/** One frame's three clock readings, from render/scene.ts. `startMs` reuses the rAF callback's own first `performance.now()`, so this costs two extra clock reads per frame. */
export function recordFrame(startMs: number, renderStartMs: number, endMs: number): void {
  if (firstFrameMs === 0) {
    firstFrameMs = startMs;
    windowStartMs = startMs;
    prevStartMs = startMs;
  }
  const slot = writeCursor % FRAME_STATS_CAPACITY;
  frameMs[slot] = endMs - startMs;
  renderMs[slot] = endMs - renderStartMs;
  // Zero for the first frame: it has no predecessor to measure against.
  intervalMs[slot] = startMs === prevStartMs ? 0 : startMs - prevStartMs;
  prevStartMs = startMs;
  writeCursor++;
  windowFrames++;
  if (endMs - windowStartMs >= FRAME_STATS_WINDOW_MS) closeWindow(endMs);
}

/**
 * One plugin's frame callback, timed. Called by plugins/host.ts, the only
 * place that knows which plugin a callback belongs to — a meter that patches
 * the callbacks it measures would have to prove it isn't itself the cost,
 * which took a night the first time (§7d, `noInstrument`).
 */
export function recordPluginFrame(name: string, ms: number): void {
  pluginMs.set(name, (pluginMs.get(name) ?? 0) + ms);
}

/**
 * Publishes at once instead of waiting for the window to close.
 *
 * Owner, 2026-09-06: a block opened just after a window boundary showed
 * nothing for five seconds, reading like a broken meter, though the meter
 * had been running the whole time.
 *
 * Publishes the in-progress window if it has frames (freshest true answer;
 * the frame count says how wide its percentiles are). With no frames yet, it
 * re-publishes the last closed window rather than fabricated zeros; with
 * neither, it publishes nothing.
 */
export function flushFrameStats(): void {
  if (windowFrames > 0) {
    closeWindow(performance.now());
    return;
  }
  if (latestSample !== null) sink?.(latestSample);
}

/** Test seam: forgets every reading and the uptime origin. */
export function resetFrameStats(): void {
  writeCursor = 0;
  windowFrames = 0;
  windowStartMs = 0;
  firstFrameMs = 0;
  prevStartMs = 0;
  latestSample = null;
  pluginMs.clear();
  gpuMs = [];
}
