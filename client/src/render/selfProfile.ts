// The page profiling its own JavaScript — the instrument that can see inside
// `renderer.render`.
//
// WHY THIS EXISTS. The frame-rate decay (issue #378,
// docs/plans/frame-rate-decay-2026-09-05.md §7d) is entirely CPU time inside
// `renderer.render`, and three's render path cannot be sub-timed from outside:
// wrapping the callbacks around it, which is all render/frameStats.ts can do,
// says the growth is in there and nothing more. Naming the function that grows
// needs a sampled call-stack profile of a page that has ALREADY decayed.
//
// Devtools could not supply one. Only Windows-side Chrome has the discrete GPU,
// and only one direction of the WSL2 NAT boundary is open — Windows to WSL — so
// an inbound CDP socket from the agent's side times out (scripts/gpu-bench.md).
// The profile therefore has to be started by the page itself, which is exactly
// what the JS Self-Profiling API is: `new Profiler(...)` samples this document's
// own stacks and hands back a trace, no debugger attached, no socket inbound.
// It is gated behind the `Document-Policy: js-profiling` header, which
// client/vite.config.ts sets on the dev server.
//
// WHAT A TRACE IS. Three parallel tables — `frames` (function name, resource,
// line, column), `stacks` (a frame plus a parent stack index) and `samples` (a
// timestamp plus a stack index). Self time for a function is the number of
// samples whose innermost frame is that function, times the sample interval.
// Chrome's `sampleInterval` is a floor, not a promise: it reports what it
// actually used, and every figure derived here is scaled by the reported value
// rather than the requested one.
//
// COST WHEN NOT PROFILING: nothing. No timer, no wrapper, no allocation — the
// module is inert until `startSelfProfile` is called.

/** A trace as the API hands it over; the shape the analysis below expects. */
interface ProfilerTrace {
  readonly resources: readonly string[];
  readonly frames: readonly {
    readonly name: string;
    readonly resourceId?: number;
    readonly line?: number;
    readonly column?: number;
  }[];
  readonly stacks: readonly { readonly frameId: number; readonly parentId?: number }[];
  readonly samples: readonly { readonly timestamp: number; readonly stackId?: number }[];
}

interface ProfilerInstance {
  readonly sampleInterval: number;
  readonly stopped: boolean;
  stop(): Promise<ProfilerTrace>;
}

type ProfilerCtor = new (options: {
  sampleInterval: number;
  maxBufferSize: number;
}) => ProfilerInstance;

/** One function's share of the profile. */
export interface SelfProfileRow {
  readonly name: string;
  /** Where it came from — resource, line and column when the trace carries them. */
  readonly site: string;
  /** Samples whose INNERMOST frame is this function. */
  readonly selfSamples: number;
  /** Samples with this function anywhere on the stack. */
  readonly totalSamples: number;
  /** Self time in milliseconds, at the interval the profiler reported. */
  readonly selfMs: number;
}

export interface SelfProfileResult {
  readonly durationMs: number;
  readonly sampleIntervalMs: number;
  readonly sampleCount: number;
  /** Samples the profiler dropped because the buffer filled. */
  readonly truncated: boolean;
  readonly rows: readonly SelfProfileRow[];
}

/**
 * Requested sampling period. Chrome clamps this to what it can actually deliver
 * and reports the result on the instance, which is the number the arithmetic
 * below uses — a requested interval is a wish, a reported one is a measurement.
 */
const SAMPLE_INTERVAL_MS = 1;

/**
 * Sample slots to reserve. At the interval above this is ~5 minutes of stacks,
 * comfortably more than any profile worth taking here; the buffer filling is
 * reported as `truncated` rather than silently shortening the window, because a
 * profile that quietly stopped early would understate whatever came last.
 */
const MAX_BUFFER_SIZE = 300_000;

/** How many rows the summary keeps. The tail of a stack profile is all noise. */
const TOP_ROWS = 40;

function profilerCtor(): ProfilerCtor | null {
  const ctor = (globalThis as unknown as { Profiler?: ProfilerCtor }).Profiler;
  return typeof ctor === 'function' ? ctor : null;
}

/** True when the browser and the document policy both allow self-profiling. */
export function selfProfileAvailable(): boolean {
  return profilerCtor() !== null;
}

function siteOf(trace: ProfilerTrace, frameIndex: number): string {
  const frame = trace.frames[frameIndex];
  if (frame === undefined) return '';
  const resource =
    frame.resourceId === undefined ? '' : (trace.resources[frame.resourceId] ?? '');
  if (resource === '') return '';
  // Only the tail of the URL: these are dev-server paths and the leading
  // origin is the same for every row, so it is column width and nothing else.
  const short = resource.slice(resource.lastIndexOf('/') + 1);
  return frame.line === undefined ? short : `${short}:${String(frame.line)}`;
}

function summarise(trace: ProfilerTrace, durationMs: number, intervalMs: number): SelfProfileResult {
  const selfSamples = new Map<number, number>();
  const totalSamples = new Map<number, number>();
  for (const sample of trace.samples) {
    if (sample.stackId === undefined) continue;
    const innermost = trace.stacks[sample.stackId];
    if (innermost !== undefined) {
      selfSamples.set(innermost.frameId, (selfSamples.get(innermost.frameId) ?? 0) + 1);
    }
    // Walk to the root so a function that is expensive because of what it CALLS
    // is visible too — self time alone would hide `renderer.render` itself,
    // which is the very frame this profile exists to open.
    const seen = new Set<number>();
    let cursor: number | undefined = sample.stackId;
    while (cursor !== undefined) {
      const node: { frameId: number; parentId?: number } | undefined = trace.stacks[cursor];
      if (node === undefined) break;
      if (!seen.has(node.frameId)) {
        seen.add(node.frameId);
        totalSamples.set(node.frameId, (totalSamples.get(node.frameId) ?? 0) + 1);
      }
      cursor = node.parentId;
    }
  }
  const rows: SelfProfileRow[] = [];
  for (const [frameId, total] of totalSamples) {
    const frame = trace.frames[frameId];
    if (frame === undefined) continue;
    const own = selfSamples.get(frameId) ?? 0;
    rows.push({
      // An anonymous frame is a real answer, not a missing one; say so rather
      // than printing an empty cell that reads like a bug in this file.
      name: frame.name === '' ? '(anonymous)' : frame.name,
      site: siteOf(trace, frameId),
      selfSamples: own,
      totalSamples: total,
      selfMs: own * intervalMs,
    });
  }
  rows.sort((a, b) => b.selfSamples - a.selfSamples || b.totalSamples - a.totalSamples);
  return {
    durationMs,
    sampleIntervalMs: intervalMs,
    sampleCount: trace.samples.length,
    truncated: trace.samples.length >= MAX_BUFFER_SIZE,
    rows: rows.slice(0, TOP_ROWS),
  };
}

/**
 * Profiles for `durationMs` and resolves with the summary, ranked by self time.
 *
 * Rejects rather than returning an empty result when the API is absent: "no
 * profiler here" and "the profiler found nothing" are different facts, and a
 * caller shown an empty table would read the wrong one.
 */
export async function startSelfProfile(durationMs: number): Promise<SelfProfileResult> {
  const Ctor = profilerCtor();
  if (Ctor === null) {
    throw new Error(
      'self-profiling is unavailable: this needs Chrome and the ' +
        "'Document-Policy: js-profiling' header (client/vite.config.ts sets it " +
        'on the dev server; a built bundle served by the game server has no such header)',
    );
  }
  const profiler = new Ctor({
    sampleInterval: SAMPLE_INTERVAL_MS,
    maxBufferSize: MAX_BUFFER_SIZE,
  });
  const startedMs = performance.now();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const trace = await profiler.stop();
  const elapsedMs = performance.now() - startedMs;
  // THE REPORTED INTERVAL, NOT THE REQUESTED ONE. Chrome is free to sample
  // more coarsely than asked, and multiplying sample counts by a wish rather
  // than by what happened would misreport every millisecond figure below.
  return summarise(trace, elapsedMs, profiler.sampleInterval || SAMPLE_INTERVAL_MS);
}
