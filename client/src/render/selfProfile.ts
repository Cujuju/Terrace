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

export interface SelfProfileRow {
  readonly name: string;
  readonly site: string;
  readonly selfSamples: number;
  readonly totalSamples: number;
  readonly selfMs: number;
}

export interface SelfProfileResult {
  readonly durationMs: number;
  readonly sampleIntervalMs: number;
  readonly sampleCount: number;
  readonly truncated: boolean;
  readonly rows: readonly SelfProfileRow[];
}

const SAMPLE_INTERVAL_MS = 1;

const MAX_BUFFER_SIZE = 300_000;

const TOP_ROWS = 40;

function profilerCtor(): ProfilerCtor | null {
  const ctor = (globalThis as unknown as { Profiler?: ProfilerCtor }).Profiler;
  return typeof ctor === 'function' ? ctor : null;
}

export function selfProfileAvailable(): boolean {
  return profilerCtor() !== null;
}

function siteOf(trace: ProfilerTrace, frameIndex: number): string {
  const frame = trace.frames[frameIndex];
  if (frame === undefined) return '';
  const resource =
    frame.resourceId === undefined ? '' : (trace.resources[frame.resourceId] ?? '');
  if (resource === '') return '';
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
  return summarise(trace, elapsedMs, profiler.sampleInterval || SAMPLE_INTERVAL_MS);
}
