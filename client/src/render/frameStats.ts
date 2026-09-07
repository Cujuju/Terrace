// Not perfProbe.ts: that one is dev-only and wraps rAF/setTimeout, and a whole
// night went into proving the wrapping wasn't itself the cost
// (docs/plans/frame-rate-decay-2026-09-05.md §7d, `noInstrument`). This wraps
// nothing — two clock reads and three floats a frame — so it ships enabled.
//
// Work time, not interval: interval is vsync-capped, so a frame whose CPU cost
// doubles from 2ms to 4ms shows an unchanged 16.7ms until it crosses budget,
// then falls off a cliff. Interval is recorded too — "crossed budget yet?"
// needs both.
//
// Counters once per window: `renderer.info` (§7d: textures 37→74) grows on the
// scale of minutes, and reading it per frame would cost more than the rest of
// this file combined.
//
// With no sink the window still closes and `latestSample` still updates, so
// `__terracePerf.stats()` is never stale — but Solid never re-renders.

import { FRAME_STATS_CAPACITY, FRAME_STATS_WINDOW_MS } from '../config.ts';

/**
 * Pixel count is not optional: frame time is a function of it, so readings at
 * different sizes aren't comparable. Every number in
 * docs/plans/frame-rate-decay-2026-09-05.md was taken at 1600x900 (44% of the
 * owner's 1440p) without stating so — argued over for a night.
 */
export interface FrameCounters {
  /** Physical pixels — canvas CSS size x pixel ratio. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /**
   * World units. Invalidated a day of bench numbers (2026-09-06): a throwaway
   * Chrome profile with no stored pose saw 138-162 draw calls, the owner's
   * restored pose 305-337 — same build, same world, unlabeled.
   */
  readonly cameraDistance: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

export interface PluginFrameCost {
  readonly name: string;
  readonly msPerFrame: number;
  /** A fraction of the MEAN whole frame, 0-1. */
  readonly shareOfFrame: number;
}

export interface FrameStatsSample {
  /** Since the first recorded frame — the decay's x axis. */
  readonly uptimeS: number;
  /** Every frame recorded, which may exceed the CAPACITY actually kept. */
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
   * Null, never zero, where the timer extension is absent: "no GPU clock" and
   * "GPU took no time" must not read alike in the row that decides whether a
   * slow frame is the GPU's fault.
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

// Float32 gives ~7 significant digits, six more than a millisecond reading needs.
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
/** May exceed CAPACITY; the ring keeps the last CAPACITY of them. */
let windowFrames = 0;
let windowStartMs = 0;
let firstFrameMs = 0;
let prevStartMs = 0;
let latestSample: FrameStatsSample | null = null;
let sink: FrameStatsSink | null = null;
let readCounters: (() => FrameCounters) | null = null;
let drainGpu: (() => number[]) | null = null;
let gpuMs: number[] = [];

/**
 * A running total, not a ring per plugin: a plugin's share is a mean, needing
 * one accumulator. Entries are zeroed each window and never deleted, so an
 * unmounted plugin falls to 0.00 rather than vanishing mid-read.
 */
const pluginMs = new Map<string, number>();

/** Injected by render/scene.ts, so this file never imports three and stays testable without a GL context. */
export function setFrameCounterSource(read: () => FrameCounters): void {
  readCounters = read;
}

/** render/gpuTimer.ts, injected for the same reason as setFrameCounterSource. */
export function setGpuSampleSource(drain: () => number[]): void {
  drainGpu = drain;
}

export function setFrameStatsSink(next: FrameStatsSink | null): void {
  sink = next;
}

/** The most recently CLOSED window, or null before the first one closes. */
export function frameStatsSample(): FrameStatsSample | null {
  return latestSample;
}

/** Sorts in place; every caller discards the array afterwards. */
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
  // `frames` still counts every frame, so an overflow shows in the sample rather
  // than silently changing what the percentiles mean.
  const kept = Math.min(windowFrames, FRAME_STATS_CAPACITY);
  // Drained at close, not per frame: the driver answers when it answers.
  if (drainGpu !== null) gpuMs = gpuMs.concat(drainGpu());
  const gpuMsP50 = gpuMs.length === 0 ? null : medianOf(gpuMs);
  gpuMs = [];
  // Over every frame including idle ones: a plugin working every third frame
  // costs a third as much as one working every frame.
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
  // not the same number. Built before summarise() reuses `scratch`.
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

/** `startMs` reuses the rAF callback's own first `performance.now()`, so a frame pays only two extra clock reads. */
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
 * Called by plugins/host.ts, the only place that knows which plugin a callback
 * belongs to — a meter that patched the callbacks it measures would have to
 * prove it wasn't itself the cost, which took a night (§7d, `noInstrument`).
 */
export function recordPluginFrame(name: string, ms: number): void {
  pluginMs.set(name, (pluginMs.get(name) ?? 0) + ms);
}

/**
 * Owner, 2026-09-06: a block opened just after a window boundary showed nothing
 * for five seconds, reading like a broken meter. Falls back to the last closed
 * window rather than fabricating zeros.
 */
export function flushFrameStats(): void {
  if (windowFrames > 0) {
    closeWindow(performance.now());
    return;
  }
  if (latestSample !== null) sink?.(latestSample);
}

/** Test seam. */
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
