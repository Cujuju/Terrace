// THE REAL-GPU FRAME BENCHMARK, page side. DEV-ONLY and inert without the
// `?perfprobe=<scenario>` query flag; `scripts/gpu-bench.md` is the operator's
// half of this file.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE PAGE MEASURES ITSELF instead of being driven over CDP.
//
// Only Windows-side Chrome has this machine's discrete GPU: every browser
// inside WSL2 renders on SwiftShader (no /dev/dri), where triangles cost
// everything and draw calls cost nothing — the exact tradeoff most of this
// renderer's work turns on, inverted. So the measuring browser is on the
// Windows side, and only ONE direction of the WSL2 NAT boundary is open
// without firewall changes: Windows → WSL localhost. An inbound CDP socket
// from WSL to Windows times out. Hence: the page runs the scenario itself and
// POSTs one JSON line to the dev server's `/__perf` sink (client/vite.config.ts).
//
// WHY IT IS COMMITTED. This lived as `.gpu-perf/perf-probe.patch`, an
// uncommitted patch applied at measurement time; five days after it was written
// it no longer applied to `client/src/main.tsx`. A probe that has to be
// re-ported by hand before every measurement is a probe nobody runs. This one
// is ordinary source, held to the same typecheck as the rest of the client, and
// `import.meta.env.DEV` is statically false in a production build, so the whole
// thing — every call below and this module with it — is eliminated there.
//
// ADDING A SCENARIO is one function plus one entry in SCENARIOS.

import { Vector3 } from 'three';
import { CAMERA_MIN_DISTANCE, CELL_WORLD_SIZE, SCULPT_REPEAT_INTERVAL_MS } from './config.ts';
import type { Connection } from './net/connection.ts';
import type { ClientPluginHost } from './plugins/host.ts';
import type { Viewport } from './render/scene.ts';
import type { World } from './world.ts';
import type { SculptIntent } from '@terrace/shared';
// The one plugin folder this file names, and it names it through the plugin's
// own wire contract rather than by repeating `'cyclone:all'` as a string — the
// same coupling client/src/plugins/registry.ts already has to every plugin.
import {
  CYCLONE_ALL_MESSAGE,
  CYCLONE_PLUGIN_NAME,
  parseAllPayload,
  type CycloneState,
} from '../../plugins/cyclone/protocol.ts';

/** Page-URL query flag that arms this file, valued with a SCENARIOS key. */
const PROBE_QUERY_FLAG = 'perfprobe';
/** Page-URL query flag overriding SETTLE_MS_DEFAULT, in milliseconds. */
const SETTLE_QUERY_FLAG = 'settle';
/**
 * How long the page is left alone before a scenario starts, in milliseconds.
 *
 * FORTY-FIVE SECONDS, measured rather than guessed: a default 2048-cell world
 * streams ~400 chunks in, and Vite's dependency optimiser reloads the page once
 * on a cold profile — which restarts everything, including this timer. A
 * scenario that began before both had settled would be measuring the load, not
 * the frame.
 */
const SETTLE_MS_DEFAULT = 45000;
/**
 * Frames in a steady-state sample. 240 frames is ~1.7 s at the 140 fps bar and
 * ~0.35 s at the ~700 fps this scene reaches with vsync off — long enough for a
 * p99 to mean something, short enough that a run is not dominated by waiting.
 */
const SAMPLE_FRAMES = 240;
/** Where the sample is POSTed; see client/vite.config.ts's sink plugin. */
const SINK_PATH = '/__perf';
/** Seconds between liveness heartbeats, so a hung run is distinguishable from a crash. */
const HEARTBEAT_INTERVAL_MS = 5000;

/** Just outside the orbit controls' floor, so the clamp does not fight the dolly. */
const STROKE_ZOOM_FACTOR = 1.05;
/** The held-stroke length the `.gpu-perf/results/*.json` numbers were taken at. */
const STROKE_HOLD_MS = 5000;
/** Brush radius those same numbers were taken at (~37 cells, 1–2 chunks). */
const STROKE_RADIUS = 4;

/**
 * How long the cyclone scenario waits for the server's first `cyclone:all`
 * carrying a storm, in milliseconds. Thirty seconds against a 200 ms broadcast
 * interval: if nothing has arrived by then, `CYCLONE_DEV_FORCE=1` was not set
 * or the storm is outside the client's revealed territory (that broadcast is
 * fog-of-war filtered — see plugins/cyclone/protocol.ts), and the run should
 * fail loudly rather than report an empty sky as a cyclone measurement.
 */
const CYCLONE_WAIT_MS = 30000;
/** Poll period while waiting for that first storm, in milliseconds. */
const CYCLONE_POLL_MS = 250;
/**
 * How much wider than the storm's own disc the camera frames, as a multiple of
 * its radius. 1.15 — the whole deck plus a margin, so the measurement includes
 * the rim tiers rather than a crop of the eyewall, and so a run cannot
 * accidentally frame a different fraction of the storm than the run it is being
 * compared against.
 */
const CYCLONE_FRAME_MARGIN = 1.15;

// ─────────────────────────────────────────────────────────────────────────────
// GL UPLOAD ACCOUNTING — wraps the page's WebGL2 buffer/texture uploads so a
// frame's synchronous driver-copy time and byte volume can be read beside that
// frame's length. Read and reset once per sampled frame.

/** The three upload entry points wrapped below, counted apart. */
const UPLOAD_KINDS = ['bufferData', 'bufferSubData', 'texSubImage2D'] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

const glUpload = {
  ms: 0,
  bytes: 0,
  calls: 0,
  maxBytes: 0,
  /**
   * Per entry point, because "a lot of bytes" and "a lot of calls" are
   * different bugs with different fixes: one buffer of a megabyte and a
   * thousand of a kilobyte cost nothing alike, and neither looks like a texture
   * re-upload. Without this split the sink reports an upload cost that names
   * nothing.
   */
  byKind: Object.fromEntries(UPLOAD_KINDS.map((kind) => [kind, { calls: 0, ms: 0, bytes: 0 }])) as
    Record<UploadKind, { calls: number; ms: number; bytes: number }>,
};

function resetGlUpload(): void {
  glUpload.ms = 0;
  glUpload.bytes = 0;
  glUpload.calls = 0;
  glUpload.maxBytes = 0;
  for (const kind of UPLOAD_KINDS) {
    glUpload.byKind[kind].calls = 0;
    glUpload.byKind[kind].ms = 0;
    glUpload.byKind[kind].bytes = 0;
  }
}

function installGlUploadAccounting(): void {
  const proto = WebGL2RenderingContext.prototype;
  const viewBytes = (value: unknown): number =>
    value instanceof ArrayBuffer || ArrayBuffer.isView(value)
      ? value.byteLength
      : typeof value === 'number'
        ? value
        : 0;
  const wrap = (name: UploadKind, sizeOf: (args: unknown[]) => number): void => {
    const original = proto[name] as (...args: unknown[]) => unknown;
    (proto as unknown as Record<string, unknown>)[name] = function (
      this: WebGL2RenderingContext,
      ...args: unknown[]
    ) {
      const started = performance.now();
      const result = original.apply(this, args);
      const ms = performance.now() - started;
      const bytes = sizeOf(args);
      glUpload.ms += ms;
      glUpload.bytes += bytes;
      glUpload.calls++;
      if (bytes > glUpload.maxBytes) glUpload.maxBytes = bytes;
      const kind = glUpload.byKind[name];
      kind.calls++;
      kind.ms += ms;
      kind.bytes += bytes;
      return result;
    };
  };
  // bufferData(target, sizeOrData, usage[, srcOffset, length])
  wrap('bufferData', (args) => viewBytes(args[1]));
  // bufferSubData(target, dstOffset, data[, srcOffset, length])
  wrap('bufferSubData', (args) => viewBytes(args[2]));
  // texSubImage2D(target, level, x, y, w, h, …) — w*h, a volume, not exact bytes.
  wrap('texSubImage2D', (args) =>
    typeof args[4] === 'number' && typeof args[5] === 'number' ? args[4] * args[5] : 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-CALLBACK ATTRIBUTION. Installed BEFORE createWorld so every onFrame
// handler — core's and every plugin's — registers through the timing wrapper
// and is named by its registration site, which is how a frame's length is split
// into handlers / render / message handling / unaccounted.

const frameCost = new Map<string, number>();

function addCost(key: string, ms: number): void {
  frameCost.set(key, (frameCost.get(key) ?? 0) + ms);
}

/** The first stack frame outside this file — i.e. whoever registered the callback. */
function siteOf(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(2);
  const hit = lines.find((line) => !/perfProbe\.ts/.test(line)) ?? lines[0] ?? '?';
  return hit
    .replace(/^\s*at\s+/, '')
    .replace(/https?:\/\/[^/]+\//, '')
    .replace(/\?[^:]*:/, ':');
}

function timed<A extends unknown[]>(key: string, fn: (...args: A) => unknown) {
  return (...args: A): unknown => {
    const started = performance.now();
    try {
      return fn(...args);
    } finally {
      addCost(key, performance.now() - started);
    }
  };
}

/**
 * Everything the frame wrappers cannot see: timers, foreign rAF callbacks and
 * message handlers (Worker answers, the WebSocket, MessagePorts), each keyed by
 * its registration site so a hot one names itself.
 *
 * This monkey-patches page globals, which is why the whole module is DEV-only
 * and every entry point returns before touching anything unless the query flag
 * named a scenario.
 */
function installTaskTiming(): void {
  const global = globalThis as unknown as Record<string, unknown>;
  for (const name of ['setTimeout', 'setInterval'] as const) {
    const original = global[name] as (
      fn: (...args: unknown[]) => unknown,
      ms?: number,
      ...rest: unknown[]
    ) => number;
    global[name] = (fn: unknown, ms?: number, ...rest: unknown[]): number =>
      typeof fn === 'function'
        ? original(
            timed(`${name} ${siteOf()}`, fn as (...args: unknown[]) => unknown),
            ms,
            ...rest,
          )
        : original(fn as never, ms, ...rest);
  }
  const originalRaf = global['requestAnimationFrame'] as (fn: (t: number) => void) => number;
  global['requestAnimationFrame'] = (fn: (t: number) => void): number =>
    originalRaf(timed(`raf ${siteOf()}`, fn) as (t: number) => void);
  const originalAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: unknown,
    options?: unknown,
  ): void {
    if (type === 'message' && typeof listener === 'function') {
      const label =
        this instanceof Worker
          ? 'Worker'
          : this instanceof WebSocket
            ? 'WebSocket'
            : this instanceof MessagePort
              ? 'MessagePort'
              : 'message';
      return originalAdd.call(
        this,
        type,
        timed(`${label} ${siteOf()}`, listener as (...args: unknown[]) => unknown) as EventListener,
        options as AddEventListenerOptions,
      );
    }
    return originalAdd.call(
      this,
      type,
      listener as EventListener,
      options as AddEventListenerOptions,
    );
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SAMPLE.

export interface FrameBlock {
  frames: number;
  fpsMean: number;
  msMean: number;
  msP50: number;
  msP95: number;
  msP99: number;
  /** 1 % low = 1000 / the p99 frame interval. */
  fps1pctLow: number;
  msMax: number;
  drawCalls: number;
  drawCallsMax: number;
  triangles: number;
  uploadMsTotal: number;
  uploadMBTotal: number;
  uploadMaxCallMB: number;
  /** Per-frame means, per GL entry point — see glUpload.byKind for why. */
  uploadPerFrameByKind: Record<UploadKind, { calls: number; ms: number; MB: number }>;
  /** Mean ms per attribution key over the slowest 1 % of frames, sorted desc. */
  slowBreakdown: Record<string, number>;
  /** Mean ms per attribution key over every frame, sorted desc. */
  allBreakdown: Record<string, number>;
}

interface Sampler {
  tick(): void;
  block(): FrameBlock;
}

/** Mean ms per key over the slowest `share` of frames (share = 1 → all frames). */
function breakdown(
  intervals: readonly number[],
  costs: readonly Map<string, number>[],
  share: number,
): Record<string, number> {
  // Frame 0 has no previous tick to be an interval from, hence the slice(1).
  const ranked = intervals
    .map((_, index) => index)
    .slice(1)
    .sort((a, b) => intervals[b]! - intervals[a]!);
  const count = Math.max(1, Math.floor(ranked.length * share));
  const top = ranked.slice(0, count);
  const summed = new Map<string, number>();
  for (const index of top) {
    for (const [key, ms] of costs[index] ?? []) summed.set(key, (summed.get(key) ?? 0) + ms);
  }
  const out: Record<string, number> = {
    'frame ms': top.reduce((sum, index) => sum + intervals[index]!, 0) / count,
  };
  for (const [key, ms] of [...summed].sort((a, b) => b[1] - a[1])) out[key] = ms / count;
  return out;
}

function createSampler(viewport: Viewport): Sampler {
  const { renderer } = viewport;
  const intervals: number[] = [];
  const calls: number[] = [];
  const triangles: number[] = [];
  const uploadMs: number[] = [];
  const uploadBytes: number[] = [];
  const costs: Map<string, number>[] = [];
  const uploadByKind = Object.fromEntries(
    UPLOAD_KINDS.map((kind) => [kind, { calls: 0, ms: 0, bytes: 0 }]),
  ) as Record<UploadKind, { calls: number; ms: number; bytes: number }>;
  let maxCallBytes = 0;
  let last = performance.now();
  frameCost.clear();
  resetGlUpload();
  return {
    tick(): void {
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      calls.push(renderer.info.render.calls);
      triangles.push(renderer.info.render.triangles);
      uploadMs.push(glUpload.ms);
      uploadBytes.push(glUpload.bytes);
      if (glUpload.maxBytes > maxCallBytes) maxCallBytes = glUpload.maxBytes;
      for (const kind of UPLOAD_KINDS) {
        uploadByKind[kind].calls += glUpload.byKind[kind].calls;
        uploadByKind[kind].ms += glUpload.byKind[kind].ms;
        uploadByKind[kind].bytes += glUpload.byKind[kind].bytes;
      }
      frameCost.set('gl upload (inside render)', glUpload.ms);
      costs.push(new Map(frameCost));
      frameCost.clear();
      resetGlUpload();
    },
    block(): FrameBlock {
      const sorted = intervals.slice(1).sort((a, b) => a - b);
      const percentile = (p: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
      // The MEDIAN of a per-frame counter, not its mean: the counter is an
      // integer that steps when a chunk streams in, and a median names the
      // steady state instead of averaging across the step.
      const median = (values: number[]): number =>
        values.slice(1).sort((a, b) => b - a)[Math.floor(values.length / 2)] ?? 0;
      return {
        frames: sorted.length,
        fpsMean: 1000 / mean,
        msMean: mean,
        msP50: percentile(0.5),
        msP95: percentile(0.95),
        msP99: percentile(0.99),
        fps1pctLow: 1000 / percentile(0.99),
        msMax: sorted[sorted.length - 1] ?? 0,
        drawCalls: median(calls),
        drawCallsMax: Math.max(0, ...calls),
        triangles: median(triangles),
        uploadMsTotal: uploadMs.reduce((a, b) => a + b, 0),
        uploadMBTotal: uploadBytes.reduce((a, b) => a + b, 0) / 1e6,
        uploadMaxCallMB: maxCallBytes / 1e6,
        uploadPerFrameByKind: Object.fromEntries(
          UPLOAD_KINDS.map((kind) => [
            kind,
            {
              calls: uploadByKind[kind].calls / Math.max(1, intervals.length),
              ms: uploadByKind[kind].ms / Math.max(1, intervals.length),
              MB: uploadByKind[kind].bytes / 1e6 / Math.max(1, intervals.length),
            },
          ]),
        ) as Record<UploadKind, { calls: number; ms: number; MB: number }>,
        slowBreakdown: breakdown(intervals, costs, 0.01),
        allBreakdown: breakdown(intervals, costs, 1),
      };
    },
  };
}

/** Resolves once `frames` frames have been sampled. */
function sampleFrames(sampler: Sampler, frames: number): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0;
    const tick = (): void => {
      sampler.tick();
      if (++seen >= frames) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Samples every frame until `stop` resolves, then resolves itself. */
function sampleUntil(sampler: Sampler, stop: Promise<void>): Promise<void> {
  let running = true;
  const tick = (): void => {
    sampler.tick();
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return stop.then(() => {
    running = false;
  });
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

// ─────────────────────────────────────────────────────────────────────────────
// THE SCENARIOS.

interface ProbeContext {
  readonly viewport: Viewport;
  readonly world: World;
  readonly connection: Connection;
  /** The storms the cyclone plugin's own broadcast last carried; see installPerfProbe. */
  readonly cyclones: () => readonly CycloneState[];
  /** Points the orbit at a cell and pulls the camera back to `distance` world units. */
  readonly dollyTo: (x: number, y: number, distance: number) => void;
  readonly sampler: () => Sampler;
  readonly beat: (stage: string) => void;
}

interface ScenarioResult {
  /** The block the run is judged on; its fpsMean is copied to the report's top level. */
  readonly sample: FrameBlock;
  /** Scenario-specific fields merged into the report. */
  readonly detail: Record<string, unknown>;
}

type Scenario = (ctx: ProbeContext) => Promise<ScenarioResult>;

/** The cell under the screen centre — where `idle` and `sculpt` both park. */
function centreCell(ctx: ProbeContext): { x: number; y: number } {
  const { camera } = ctx.viewport;
  const direction = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const pick = ctx.world.pickCell(camera.position.clone(), direction);
  if (pick === null) throw new Error('no terrain under the screen centre');
  return { x: pick.x, y: pick.y };
}

/** Steady state at stroke zoom: what every other scenario's cost is added on top of. */
const idleScenario: Scenario = async (ctx) => {
  const cell = centreCell(ctx);
  ctx.dollyTo(cell.x, cell.y, CAMERA_MIN_DISTANCE * STROKE_ZOOM_FACTOR);
  ctx.beat('parked');
  const sampler = ctx.sampler();
  await sampleFrames(sampler, SAMPLE_FRAMES);
  return { sample: sampler.block(), detail: { cell } };
};

/**
 * A held radius-4 stroke at stroke zoom — one intent every
 * SCULPT_REPEAT_INTERVAL_MS, send-then-predict exactly as main.tsx's `send`
 * does, for STROKE_HOLD_MS. Kept bit-for-bit in shape so its numbers stay
 * comparable with `.gpu-perf/results/*.json`.
 */
const sculptScenario: Scenario = async (ctx) => {
  const cell = centreCell(ctx);
  ctx.dollyTo(cell.x, cell.y, CAMERA_MIN_DISTANCE * STROKE_ZOOM_FACTOR);
  ctx.beat('parked');
  const idle = ctx.sampler();
  await sampleFrames(idle, SAMPLE_FRAMES);
  ctx.beat('idle-done');

  const stroke = ctx.sampler();
  let sent = 0;
  let sequence = 0;
  const send = (): void => {
    const intent: SculptIntent = {
      type: 'sculpt',
      x: cell.x,
      y: cell.y,
      radius: STROKE_RADIUS,
      dir: 1,
      seq: sequence++,
    };
    if (!ctx.connection.sendSculpt(intent)) return;
    sent++;
    ctx.world.predictSculpt(intent);
  };
  send();
  const timer = window.setInterval(send, SCULPT_REPEAT_INTERVAL_MS);
  await sampleUntil(stroke, wait(STROKE_HOLD_MS));
  window.clearInterval(timer);
  return {
    sample: stroke.block(),
    detail: { cell, intentsSent: sent, idle: idle.block() },
  };
};

/**
 * The cyclone tower (#305): the camera parked on a forced storm's eye, framing
 * the whole deck, sampling steady state. Needs the server started with
 * `CYCLONE_DEV_FORCE=1` (plugins/cyclone/server/dev.ts), which puts one frozen,
 * full-strength cyclone over the open water nearest the world centre.
 */
const cycloneScenario: Scenario = async (ctx) => {
  const deadline = performance.now() + CYCLONE_WAIT_MS;
  let storm: CycloneState | undefined;
  for (;;) {
    storm = ctx.cyclones()[0];
    if (storm !== undefined) break;
    if (performance.now() > deadline) {
      throw new Error(
        `no ${CYCLONE_PLUGIN_NAME}:${CYCLONE_ALL_MESSAGE} storm within ${String(CYCLONE_WAIT_MS)} ms — ` +
          'start the server with CYCLONE_DEV_FORCE=1',
      );
    }
    await wait(CYCLONE_POLL_MS);
  }
  // Frame the disc: at the camera's vertical field of view, this is the
  // distance at which a sphere of the storm's radius (times the margin) fills
  // the frame height. The eye's own cell is the orbit target, so the sample is
  // reproducible from the storm's broadcast numbers alone.
  const { camera } = ctx.viewport;
  const halfFovRadians = (camera.fov * Math.PI) / 360;
  const radiusWorldUnits = storm.radius * CELL_WORLD_SIZE;
  const distance = (radiusWorldUnits * CYCLONE_FRAME_MARGIN) / Math.tan(halfFovRadians);
  ctx.dollyTo(storm.x, storm.y, distance);
  ctx.beat('parked');
  const sampler = ctx.sampler();
  await sampleFrames(sampler, SAMPLE_FRAMES);
  return {
    sample: sampler.block(),
    detail: {
      storm: {
        id: storm.id,
        x: storm.x,
        y: storm.y,
        radiusCells: storm.radius,
        intensity: storm.intensity,
        ...(storm.name === undefined ? {} : { name: storm.name }),
      },
      framedRadiusWorldUnits: radiusWorldUnits,
    },
  };
};

/** The scenario table. One entry, one function — that is the whole extension point. */
const SCENARIOS: Readonly<Record<string, Scenario>> = {
  idle: idleScenario,
  sculpt: sculptScenario,
  cyclone: cycloneScenario,
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTALLATION.

/** The scenario this page URL asked for, or null when the probe is not armed. */
function requestedScenario(): string | null {
  const raw = new URLSearchParams(location.search).get(PROBE_QUERY_FLAG);
  return raw === null || raw === '' ? null : raw;
}

/**
 * The half that must run BEFORE createWorld, so the frame-cost wrappers are in
 * place when core's and every plugin's frame handlers register. Inert unless the
 * page URL named a scenario.
 */
export function installPerfProbeEarly(viewport: Viewport): void {
  if (requestedScenario() === null) return;
  installTaskTiming();
  const originalOnFrame = viewport.onFrame.bind(viewport);
  (viewport as { onFrame: Viewport['onFrame'] }).onFrame = (handler, phase) => {
    const key = `frame ${phase ?? 'draw'} ${siteOf()}`;
    return originalOnFrame((dt) => {
      const started = performance.now();
      handler(dt);
      addCost(key, performance.now() - started);
    }, phase);
  };
  const { renderer } = viewport;
  const originalRender = renderer.render.bind(renderer);
  renderer.render = ((...args: Parameters<typeof originalRender>) => {
    const started = performance.now();
    const out = originalRender(...args);
    addCost('renderer.render', performance.now() - started);
    return out;
  }) as typeof renderer.render;
}

/** Times the world's message sinks, so a snapshot or a diff names itself. */
function wrapSinkTiming(world: World): void {
  const sink = world as unknown as Record<string, unknown>;
  for (const name of [
    'onSnapshot',
    'onChunkUnlock',
    'onTerrainDiff',
    'onSculptDenied',
    'onSculptApplied',
  ] as const) {
    const fn = sink[name];
    if (typeof fn !== 'function') continue;
    sink[name] = (...args: unknown[]) => {
      const started = performance.now();
      const out = (fn as (...a: unknown[]) => unknown).apply(world, args);
      addCost(`msg ${name}`, performance.now() - started);
      return out;
    };
  }
  const originalPredict = world.predictSculpt.bind(world);
  world.predictSculpt = (intent) => {
    const started = performance.now();
    originalPredict(intent);
    addCost('predictSculpt', performance.now() - started);
  };
}

/**
 * Arms the probe. Inert unless the page URL named a scenario; an unknown
 * scenario name POSTs an error naming the ones that exist rather than hanging.
 *
 * `pluginHost.routeMessage` is wrapped rather than the cyclone plugin being
 * asked for its state: the storm list a plugin holds is its own business, and
 * the wire form of it is already public (shared/src/rotatingStormWire.ts). The
 * wrap is read-through — every message still reaches the host untouched.
 */
export function installPerfProbe(deps: {
  viewport: Viewport;
  world: World;
  connection: Connection;
  pluginHost: ClientPluginHost;
}): void {
  const name = requestedScenario();
  if (name === null) return;
  const { viewport, world, connection, pluginHost } = deps;
  const { renderer, camera, controls } = viewport;

  const post = (body: unknown): void => {
    void fetch(SINK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  const beat = (stage: string): void => post({ scenario: name, heartbeat: stage });

  const scenario = SCENARIOS[name];
  if (scenario === undefined) {
    post({ scenario: name, error: `unknown scenario; known: ${Object.keys(SCENARIOS).join(', ')}` });
    return;
  }

  installGlUploadAccounting();
  wrapSinkTiming(world);

  let storms: readonly CycloneState[] = [];
  const originalRoute = pluginHost.routeMessage.bind(pluginHost);
  pluginHost.routeMessage = (type, payload) => {
    if (type === `${CYCLONE_PLUGIN_NAME}:${CYCLONE_ALL_MESSAGE}`) {
      const parsed = parseAllPayload(payload);
      if (parsed !== null) storms = parsed.storms;
    }
    originalRoute(type, payload);
  };

  const gpuName = (): string => {
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return String(
      debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
  };

  const ctx: ProbeContext = {
    viewport,
    world,
    connection,
    cyclones: () => storms,
    dollyTo: (x, y, distance): void => {
      const height = world.terrainHeightAt(Math.round(x), Math.round(y)) ?? 0;
      // Cell → world: the inverse of terrain/picking.ts's worldPointToCell.
      const target = new Vector3(x * CELL_WORLD_SIZE, height, y * CELL_WORLD_SIZE);
      // The BEARING is whatever the camera already has. A bench run always
      // starts from a fresh Chrome profile (scripts/gpu-bench.sh), so there is
      // no stored pose and render/scene.ts's restoreOrFocus has framed the
      // world deterministically — the same bearing every run, without this
      // file inventing one of its own.
      const bearing = camera.position.clone().sub(controls.target).normalize();
      controls.target.copy(target);
      camera.position.copy(target).addScaledVector(bearing, distance);
      controls.update();
    },
    sampler: () => createSampler(viewport),
    beat,
  };

  const settleMs = Number(
    new URLSearchParams(location.search).get(SETTLE_QUERY_FLAG) ?? SETTLE_MS_DEFAULT,
  );
  beat('armed');
  let heartbeats = 0;
  window.setInterval(() => beat(`alive-${String(++heartbeats)}`), HEARTBEAT_INTERVAL_MS);

  window.setTimeout(() => {
    beat('settled');
    scenario(ctx)
      .then((result) => {
        post({
          scenario: name,
          gpu: gpuName(),
          clientVersion: __CLIENT_VERSION__,
          pixelRatio: renderer.getPixelRatio(),
          settleMs,
          cameraDistance: camera.position.distanceTo(controls.target),
          programs: renderer.info.programs === null ? null : renderer.info.programs.length,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          ...result.detail,
          sample: result.sample,
          // Top level so the bench script can poll for the one number the
          // project bar is written in, without parsing the whole report.
          fpsMean: result.sample.fpsMean,
        });
      })
      .catch((error: unknown) => {
        post({
          scenario: name,
          error: String(error),
          stack: error instanceof Error ? error.stack : null,
        });
      });
  }, settleMs);
}
