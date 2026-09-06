// The ultralight frame meter: what `renderer.render` costs on the CPU, held
// against how long the page has been open.
//
// WHY IT EXISTS, AND WHY IT IS NOT perfProbe.ts. The decay in
// docs/plans/frame-rate-decay-2026-09-05.md §7d is entirely CPU time inside
// `renderer.render` — GPU time, draw calls and the scene graph all stay flat
// while the frame triples. perfProbe.ts can see that, but only in a dev build,
// only behind `?perfprobe=`, and only by wrapping rAF, setTimeout and
// addEventListener, which is why a whole night went into proving the probe was
// not itself the cause (§7d, `noInstrument`). This file wraps nothing. It reads
// the clock twice more per frame than scene.ts already does and writes three
// floats, so it can ship enabled and the decay can be watched in a NORMAL play
// session instead of only in the bench rig.
//
// WHY WORK TIME AND NOT THE FRAME INTERVAL: the interval is capped by vsync, so
// a frame whose CPU cost doubled from 2 ms to 4 ms shows an unchanged 16.7 ms
// interval right up until it crosses the budget, and then falls off a cliff.
// Work time moves the whole way. The interval is recorded too, because the
// question "has the growth crossed the budget yet" needs both.
//
// WHY THE COUNTERS ARE READ ONCE PER WINDOW: `renderer.info` is the only thing
// measured here that was shown to grow (§7d: textures 37 -> 74 with 7 reachable
// from the scene), but it grows on the scale of minutes. Reading it per frame
// would cost more than everything else in this file put together.
//
// WHY NOTHING IS PUBLISHED UNLESS SOMETHING IS LISTENING: a sink is installed
// by main.tsx only when a readout is actually on. With no sink the window still
// closes and `latestSample` is still updated — so `__terracePerf.stats()` is
// never stale — but no signal is written and Solid never re-renders.

import { FRAME_STATS_CAPACITY, FRAME_STATS_WINDOW_MS } from '../config.ts';

/** Three's own resource tables, sampled once per window. */
export interface FrameCounters {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
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
  readonly counters: FrameCounters;
}

type FrameStatsSink = (sample: FrameStatsSample) => void;

/** What a window reports before render/scene.ts has handed over the renderer. */
const EMPTY_COUNTERS: FrameCounters = {
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
};

// Ring buffers, allocated once. Float32 carries ~7 significant digits, which is
// six more than a millisecond reading of this kind can justify.
const frameMs = new Float32Array(FRAME_STATS_CAPACITY);
const renderMs = new Float32Array(FRAME_STATS_CAPACITY);
const intervalMs = new Float32Array(FRAME_STATS_CAPACITY);
// Derived per window from the two above rather than written per frame: one
// subtraction at window close is cheaper than one on every frame.
const outsideMs = new Float32Array(FRAME_STATS_CAPACITY);
// The percentile sort works on a copy, so a window's readings are not reordered
// underneath the ring's write cursor. Allocated once for the same reason.
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

/**
 * Hands the meter its counter source. Called once by render/scene.ts, which is
 * the only place holding the renderer; this file deliberately does not import
 * three, so it stays testable without a GL context.
 */
export function setFrameCounterSource(read: () => FrameCounters): void {
  readCounters = read;
}

/**
 * Installs (or with null, removes) the once-per-window sink. main.tsx wires
 * this to the HUD signal and the console line; with no sink the meter still
 * runs and still updates `frameStatsSample()`, it just publishes nothing.
 */
export function setFrameStatsSink(next: FrameStatsSink | null): void {
  sink = next;
}

/** The most recently closed window, or null before the first one closes. */
export function frameStatsSample(): FrameStatsSample | null {
  return latestSample;
}

function percentile(sorted: Float32Array, count: number, fraction: number): number {
  if (count === 0) return 0;
  // Nearest-rank on a zero-based array, clamped: with 30 samples a "p99" is the
  // largest one, and saying so is honest where interpolating between two
  // readings that do not exist is not.
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
  // The buffers keep at most CAPACITY frames of one window. A window that
  // overflowed reports percentiles over the frames it kept, while `frames`
  // still counts every one — so an overflow is visible in the sample rather
  // than silently changing what the percentiles mean.
  const kept = Math.min(windowFrames, FRAME_STATS_CAPACITY);
  // The median of the per-frame differences, not the difference of the two
  // medians: those are not the same number, and only the first is a frame that
  // actually happened. Built before the summarise() calls below because they
  // reuse `scratch`.
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
    counters: readCounters?.() ?? EMPTY_COUNTERS,
  };
  windowFrames = 0;
  writeCursor = 0;
  windowStartMs = nowMs;
  sink?.(latestSample);
}

/**
 * One frame's three clock readings, from render/scene.ts. `startMs` is the rAF
 * callback's own first `performance.now()` — reused rather than read again, so
 * this costs exactly two extra clock reads per frame.
 */
export function recordFrame(startMs: number, renderStartMs: number, endMs: number): void {
  if (firstFrameMs === 0) {
    firstFrameMs = startMs;
    windowStartMs = startMs;
    prevStartMs = startMs;
  }
  const slot = writeCursor % FRAME_STATS_CAPACITY;
  frameMs[slot] = endMs - startMs;
  renderMs[slot] = endMs - renderStartMs;
  // Zero for the very first frame: it has no predecessor, and inventing one
  // would put a fabricated reading in the first window's median.
  intervalMs[slot] = startMs === prevStartMs ? 0 : startMs - prevStartMs;
  prevStartMs = startMs;
  writeCursor++;
  windowFrames++;
  if (endMs - windowStartMs >= FRAME_STATS_WINDOW_MS) closeWindow(endMs);
}

/** Test seam: forgets every reading and the uptime origin. */
export function resetFrameStats(): void {
  writeCursor = 0;
  windowFrames = 0;
  windowStartMs = 0;
  firstFrameMs = 0;
  prevStartMs = 0;
  latestSample = null;
}
