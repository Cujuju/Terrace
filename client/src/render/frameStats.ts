import { FRAME_STATS_CAPACITY, FRAME_STATS_WINDOW_MS } from '../config.ts';
import { drainUploadMeter, type UploadKind } from './uploadMeter.ts';

export interface FrameCounters {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly cameraDistance: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

export interface PluginFrameCost {
  readonly name: string;
  /** Mean impact per frame in the window, counting skipped frames as zero. */
  readonly msPerFrame: number;
  /** Mean cost per executed run — what the plugin wants when it actually runs. */
  readonly msPerRun: number;
  /** Non-frame plugin time in the window (messages, timers); a total, not a mean. */
  readonly asyncMs: number;
  /** Slowest single frame run in the window; names spikers means cannot. */
  readonly msMaxRun: number;
  readonly shareOfFrame: number;
}

export interface UploadKindCost {
  readonly kind: UploadKind;
  readonly calls: number;
  readonly bytes: number;
}

export interface FrameStatsSample {
  readonly uptimeS: number;
  readonly frames: number;
  /** Percentiles and maxima describe only the retained ring when a window exceeds capacity. */
  readonly sampledFrames: number;
  readonly windowMs: number;
  readonly frameBudgetMs: number;
  /** CPU frame work over the design budget; refresh-rate waiting is excluded. */
  readonly workOverBudgetFrames: number;
  readonly frameMsP50: number;
  readonly frameMsP95: number;
  readonly frameMsP99: number;
  readonly frameMsMax: number;
  readonly renderMsP50: number;
  readonly renderMsP99: number;
  readonly outsideMsP50: number;
  /** Mean outside time minus attributed plugin impact; the unexplained remainder. */
  readonly unattributedMs: number;
  /** Plugins whose runner fired more often than frames ran: duplicate runners. */
  readonly duplicateRunners: readonly string[];
  readonly intervalMsP50: number;
  readonly intervalMsP95: number;
  readonly intervalMsP99: number;
  readonly intervalMsMax: number;
  readonly gpuMsP50: number | null;
  readonly counters: FrameCounters;
  readonly plugins: readonly PluginFrameCost[];
  /** queue.writeBuffer/writeTexture per frame over the window; zeros when unmetered. */
  readonly uploadBytesPerFrame: number;
  readonly uploadCallsPerFrame: number;
  /** Metered calls whose bytes could not be parsed, so the byte total undercounts. */
  readonly uploadUnparsedCallsPerFrame: number;
  readonly uploadByKind: readonly UploadKindCost[];
}

type FrameStatsSink = (sample: FrameStatsSample) => void;
type HitchSink = (intervalMs: number, typicalMs: number) => void;

// A gap this many times the smoothed interval is a hitch; smoothing tracks caps and refresh rate.
const HITCH_INTERVAL_FACTOR = 2;
const HITCH_BASELINE_SMOOTHING = 0.05;
const MILLISECONDS_PER_SECOND = 1000;
// The standing design target is 140 fps on the owner's machine.
const TARGET_FPS = 140;
const FRAME_BUDGET_MS = MILLISECONDS_PER_SECOND / TARGET_FPS;
// Ten minutes retains the decay trajectory, bounded to 120 normal windows.
const HISTORY_DURATION_MS = 10 * 60 * MILLISECONDS_PER_SECOND;
const HISTORY_CAPACITY = Math.ceil(HISTORY_DURATION_MS / FRAME_STATS_WINDOW_MS);
const MEDIAN_FRACTION = 0.5;
const P95_FRACTION = 0.95;
const P99_FRACTION = 0.99;

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

const frameMs = new Float32Array(FRAME_STATS_CAPACITY);
const renderMs = new Float32Array(FRAME_STATS_CAPACITY);
const intervalMs = new Float32Array(FRAME_STATS_CAPACITY);
const outsideMs = new Float32Array(FRAME_STATS_CAPACITY);
const scratch = new Float32Array(FRAME_STATS_CAPACITY);

let writeCursor = 0;
let windowFrames = 0;
let workOverBudgetFrames = 0;
let windowFrameMs = 0;
let windowRenderMs = 0;
let windowStartMs = 0;
let firstFrameMs = 0;
let prevStartMs = 0;
let latestSample: FrameStatsSample | null = null;
let sink: FrameStatsSink | null = null;
let hitchSink: HitchSink | null = null;
let typicalIntervalMs = 0;
let readCounters: (() => FrameCounters) | null = null;
let drainGpu: (() => number[]) | null = null;
let gpuMs: number[] = [];
const sampleHistory: (FrameStatsSample | undefined)[] = new Array(HISTORY_CAPACITY);
let historyCursor = 0;
let historyCount = 0;

const pluginMs = new Map<string, number>();
const pluginRuns = new Map<string, number>();
const pluginMaxMs = new Map<string, number>();
const pluginAsyncMs = new Map<string, number>();

export function setFrameCounterSource(read: () => FrameCounters): void {
  readCounters = read;
}

export function setGpuSampleSource(drain: () => number[]): void {
  drainGpu = drain;
}

export function setFrameStatsSink(next: FrameStatsSink | null): void {
  sink = next;
}

export function setHitchSink(next: HitchSink | null): void {
  hitchSink = next;
}

function noteInterval(intervalMs: number): void {
  if (hitchSink === null || intervalMs <= 0) return;
  if (typicalIntervalMs === 0) {
    typicalIntervalMs = intervalMs;
    return;
  }
  if (intervalMs >= typicalIntervalMs * HITCH_INTERVAL_FACTOR) {
    hitchSink(intervalMs, typicalIntervalMs);
    return;
  }
  typicalIntervalMs += (intervalMs - typicalIntervalMs) * HITCH_BASELINE_SMOOTHING;
}

export function frameStatsSample(): FrameStatsSample | null {
  return latestSample;
}

/** Oldest first; per-window percentiles must not be pooled as whole-run percentiles. */
export function frameStatsHistory(): readonly FrameStatsSample[] {
  const samples: FrameStatsSample[] = [];
  const start = (historyCursor - historyCount + HISTORY_CAPACITY) % HISTORY_CAPACITY;
  for (let index = 0; index < historyCount; index++) {
    const sample = sampleHistory[(start + index) % HISTORY_CAPACITY];
    if (sample !== undefined) samples.push(sample);
  }
  return samples;
}

function medianOf(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(MEDIAN_FRACTION * values.length) - 1))] ?? 0;
}

function percentile(sorted: Float32Array, count: number, fraction: number): number {
  if (count === 0) return 0;
  const rank = Math.min(count - 1, Math.max(0, Math.ceil(fraction * count) - 1));
  return sorted[rank] ?? 0;
}

function summarise(source: Float32Array, count: number): {
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  scratch.set(source.subarray(0, count));
  const view = scratch.subarray(0, count);
  view.sort();
  return {
    p50: percentile(view, count, MEDIAN_FRACTION),
    p95: percentile(view, count, P95_FRACTION),
    p99: percentile(view, count, P99_FRACTION),
    max: view[count - 1] ?? 0,
  };
}

function closeWindow(nowMs: number): void {
  const kept = Math.min(windowFrames, FRAME_STATS_CAPACITY);
  if (drainGpu !== null) gpuMs = gpuMs.concat(drainGpu());
  const gpuMsP50 = gpuMs.length === 0 ? null : medianOf(gpuMs);
  gpuMs = [];
  const meanFrameMs = windowFrames === 0 ? 0 : windowFrameMs / windowFrames;
  const plugins: PluginFrameCost[] = [];
  const duplicateRunners: string[] = [];
  const pluginNames = new Set([...pluginMs.keys(), ...pluginAsyncMs.keys()]);
  for (const name of pluginNames) {
    const totalMs = pluginMs.get(name) ?? 0;
    const runs = pluginRuns.get(name) ?? 0;
    const maxMs = pluginMaxMs.get(name) ?? 0;
    const asyncMs = pluginAsyncMs.get(name) ?? 0;
    if (runs === 0 && asyncMs === 0) {
      pluginMs.delete(name);
      pluginRuns.delete(name);
      pluginMaxMs.delete(name);
      pluginAsyncMs.delete(name);
      continue;
    }
    const msPerFrame = windowFrames === 0 ? 0 : totalMs / windowFrames;
    if (runs > windowFrames) duplicateRunners.push(name);
    plugins.push({
      name,
      msPerFrame,
      msPerRun: runs === 0 ? 0 : totalMs / runs,
      asyncMs,
      msMaxRun: maxMs,
      shareOfFrame: meanFrameMs === 0 ? 0 : msPerFrame / meanFrameMs,
    });
    pluginMs.set(name, 0);
    pluginRuns.set(name, 0);
    pluginMaxMs.set(name, 0);
    pluginAsyncMs.set(name, 0);
  }
  plugins.sort((a, b) => b.msPerFrame - a.msPerFrame);
  for (let i = 0; i < kept; i++) outsideMs[i] = (frameMs[i] ?? 0) - (renderMs[i] ?? 0);
  // Means, not medians: only means subtract. Clamped, timer slop can overshoot.
  const meanOutsideMs = windowFrames === 0 ? 0 : (windowFrameMs - windowRenderMs) / windowFrames;
  const attributedMs = plugins.reduce((sum, plugin) => sum + plugin.msPerFrame, 0);
  const unattributedMs = Math.max(0, meanOutsideMs - attributedMs);
  const upload = drainUploadMeter();
  const uploadByKind: UploadKindCost[] =
    windowFrames === 0
      ? []
      : upload.byKind.map((row) => ({
          kind: row.kind,
          calls: row.calls / windowFrames,
          bytes: row.bytes / windowFrames,
        }));
  const frame = summarise(frameMs, kept);
  const render = summarise(renderMs, kept);
  const outside = summarise(outsideMs, kept);
  const interval = summarise(intervalMs, kept);
  latestSample = {
    uptimeS: (nowMs - firstFrameMs) / MILLISECONDS_PER_SECOND,
    frames: windowFrames,
    sampledFrames: kept,
    windowMs: nowMs - windowStartMs,
    frameBudgetMs: FRAME_BUDGET_MS,
    workOverBudgetFrames,
    frameMsP50: frame.p50,
    frameMsP95: frame.p95,
    frameMsP99: frame.p99,
    frameMsMax: frame.max,
    renderMsP50: render.p50,
    renderMsP99: render.p99,
    outsideMsP50: outside.p50,
    unattributedMs,
    intervalMsP50: interval.p50,
    intervalMsP95: interval.p95,
    intervalMsP99: interval.p99,
    intervalMsMax: interval.max,
    gpuMsP50,
    counters: readCounters?.() ?? EMPTY_COUNTERS,
    plugins,
    duplicateRunners,
    uploadBytesPerFrame: windowFrames === 0 ? 0 : upload.bytes / windowFrames,
    uploadCallsPerFrame: windowFrames === 0 ? 0 : upload.calls / windowFrames,
    uploadUnparsedCallsPerFrame: windowFrames === 0 ? 0 : upload.unparsedCalls / windowFrames,
    uploadByKind,
  };
  sampleHistory[historyCursor] = latestSample;
  historyCursor = (historyCursor + 1) % HISTORY_CAPACITY;
  historyCount = Math.min(historyCount + 1, HISTORY_CAPACITY);
  windowFrames = 0;
  workOverBudgetFrames = 0;
  windowFrameMs = 0;
  windowRenderMs = 0;
  writeCursor = 0;
  windowStartMs = nowMs;
  sink?.(latestSample);
}

export function recordFrame(startMs: number, renderStartMs: number, endMs: number): void {
  if (firstFrameMs === 0) {
    firstFrameMs = startMs;
    windowStartMs = startMs;
    prevStartMs = startMs;
  }
  const slot = writeCursor % FRAME_STATS_CAPACITY;
  const elapsedMs = endMs - startMs;
  const renderedMs = endMs - renderStartMs;
  frameMs[slot] = elapsedMs;
  if (elapsedMs > FRAME_BUDGET_MS) workOverBudgetFrames++;
  renderMs[slot] = renderedMs;
  windowFrameMs += elapsedMs;
  windowRenderMs += renderedMs;
  intervalMs[slot] = startMs === prevStartMs ? 0 : startMs - prevStartMs;
  noteInterval(intervalMs[slot]);
  prevStartMs = startMs;
  writeCursor++;
  windowFrames++;
  if (endMs - windowStartMs >= FRAME_STATS_WINDOW_MS) closeWindow(endMs);
}

export function recordPluginFrame(name: string, ms: number): void {
  pluginMs.set(name, (pluginMs.get(name) ?? 0) + ms);
  pluginRuns.set(name, (pluginRuns.get(name) ?? 0) + 1);
  if (ms > (pluginMaxMs.get(name) ?? 0)) pluginMaxMs.set(name, ms);
}

/** Non-frame plugin work (message handlers, timers); reported as a window total. */
export function recordPluginAsync(name: string, ms: number): void {
  pluginAsyncMs.set(name, (pluginAsyncMs.get(name) ?? 0) + ms);
}

export function flushFrameStats(): void {
  if (windowFrames > 0) {
    closeWindow(performance.now());
    return;
  }
  if (latestSample !== null) sink?.(latestSample);
}

export function resetFrameStats(): void {
  writeCursor = 0;
  windowFrames = 0;
  workOverBudgetFrames = 0;
  windowFrameMs = 0;
  windowRenderMs = 0;
  windowStartMs = 0;
  firstFrameMs = 0;
  prevStartMs = 0;
  latestSample = null;
  typicalIntervalMs = 0;
  pluginMs.clear();
  pluginRuns.clear();
  pluginMaxMs.clear();
  pluginAsyncMs.clear();
  gpuMs = [];
  sampleHistory.fill(undefined);
  historyCursor = 0;
  historyCount = 0;
}
