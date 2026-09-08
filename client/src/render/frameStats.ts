import { FRAME_STATS_CAPACITY, FRAME_STATS_WINDOW_MS } from '../config.ts';

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
  readonly msPerFrame: number;
  readonly shareOfFrame: number;
}

export interface FrameStatsSample {
  readonly uptimeS: number;
  readonly frames: number;
  readonly frameMsP50: number;
  readonly frameMsP99: number;
  readonly frameMsMax: number;
  readonly renderMsP50: number;
  readonly renderMsP99: number;
  readonly outsideMsP50: number;
  readonly intervalMsP50: number;
  readonly gpuMsP50: number | null;
  readonly counters: FrameCounters;
  readonly plugins: readonly PluginFrameCost[];
}

type FrameStatsSink = (sample: FrameStatsSample) => void;

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
let windowStartMs = 0;
let firstFrameMs = 0;
let prevStartMs = 0;
let latestSample: FrameStatsSample | null = null;
let sink: FrameStatsSink | null = null;
let readCounters: (() => FrameCounters) | null = null;
let drainGpu: (() => number[]) | null = null;
let gpuMs: number[] = [];

const pluginMs = new Map<string, number>();

export function setFrameCounterSource(read: () => FrameCounters): void {
  readCounters = read;
}

export function setGpuSampleSource(drain: () => number[]): void {
  drainGpu = drain;
}

export function setFrameStatsSink(next: FrameStatsSink | null): void {
  sink = next;
}

export function frameStatsSample(): FrameStatsSample | null {
  return latestSample;
}

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
  const kept = Math.min(windowFrames, FRAME_STATS_CAPACITY);
  if (drainGpu !== null) gpuMs = gpuMs.concat(drainGpu());
  const gpuMsP50 = gpuMs.length === 0 ? null : medianOf(gpuMs);
  gpuMs = [];
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

export function recordFrame(startMs: number, renderStartMs: number, endMs: number): void {
  if (firstFrameMs === 0) {
    firstFrameMs = startMs;
    windowStartMs = startMs;
    prevStartMs = startMs;
  }
  const slot = writeCursor % FRAME_STATS_CAPACITY;
  frameMs[slot] = endMs - startMs;
  renderMs[slot] = endMs - renderStartMs;
  intervalMs[slot] = startMs === prevStartMs ? 0 : startMs - prevStartMs;
  prevStartMs = startMs;
  writeCursor++;
  windowFrames++;
  if (endMs - windowStartMs >= FRAME_STATS_WINDOW_MS) closeWindow(endMs);
}

export function recordPluginFrame(name: string, ms: number): void {
  pluginMs.set(name, (pluginMs.get(name) ?? 0) + ms);
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
  windowStartMs = 0;
  firstFrameMs = 0;
  prevStartMs = 0;
  latestSample = null;
  pluginMs.clear();
  gpuMs = [];
}
