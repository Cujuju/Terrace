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

import { Vector3, type Object3D } from 'three';
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

/**
 * Frames per ablation step. NINETY, not SAMPLE_FRAMES' 240: an ablation run
 * takes one sample per mounted plugin plus a baseline, so the block length is
 * multiplied by ~twenty and a 240-frame block would put the run past ninety
 * seconds of sampling on top of the settle. Ninety frames still resolves a p50
 * and — the number this scenario is actually read for — a GPU-millisecond
 * median, which is far steadier frame to frame than a p99 would be.
 */
const ABLATION_SAMPLE_FRAMES = 90;
/**
 * Frames discarded after a layer's visibility is flipped, before its block is
 * sampled. Hiding a layer retires its draw calls immediately but leaves the
 * previous frames' GPU work in flight, and three re-sorts its render lists on
 * the next frame; sampling into that measures the transition rather than the
 * state. Six frames is under 60 ms at this scene's frame time — cheap enough to
 * pay forty times over, long enough to outlast the queued frames.
 */
const ABLATION_SETTLE_FRAMES = 6;
/**
 * Blocks taken by the `drift` scenario, and the gap between their starts.
 *
 * TWELVE BLOCKS, TWENTY SECONDS APART — four minutes of wall clock. Sized off
 * the effect being chased: an unfrozen ablation run watched its baseline climb
 * from 5.81 to 10.44 ms GPU across roughly three minutes (2026-09-05), so the
 * window has to be at least that long or the trend it exists to show falls off
 * the end of it. Twelve points is enough to tell a straight climb from a step.
 */
const DRIFT_BLOCKS_DEFAULT = 12;
const DRIFT_INTERVAL_MS_DEFAULT = 20000;
/** Page-URL query flags overriding the two above, for long soak runs. */
const DRIFT_BLOCKS_QUERY_FLAG = 'blocks';
const DRIFT_INTERVAL_QUERY_FLAG = 'interval';
/** Frames per drift block — ABLATION_SAMPLE_FRAMES' reasoning, same tradeoff. */
const DRIFT_SAMPLE_FRAMES = 90;
/**
 * Most newly-appeared program cache keys reported, and how much of each.
 *
 * A three cache key is a long concatenation of every parameter that selects a
 * shader variant; the whole set would be tens of kilobytes of JSON for a
 * finding that is legible from the first hundred characters. Forty keys is
 * more than the largest growth observed (88 -> 127 programs over four
 * minutes), so a truncated report cannot hide the tail that matters.
 */
const DRIFT_MAX_NEW_PROGRAMS = 40;
/**
 * How much of a program cache key is reported, as a HEAD and a TAIL with the
 * middle elided.
 *
 * THE TAIL IS THE POINT, learned the hard way (2026-09-05): a first attempt
 * reported the first 160 characters and every new key looked identical, because
 * a three cache key opens with the material type and a long run of parameter
 * booleans that barely vary — and ends with `customProgramCacheKey()`, which is
 * where this codebase's own splices (`|groundShade`, `|revealClip`) append. A
 * head-only view is blind to precisely the suffix that distinguishes one
 * variant from another.
 */
const DRIFT_PROGRAM_KEY_HEAD_CHARS = 40;
const DRIFT_PROGRAM_KEY_TAIL_CHARS = 140;

/** A cache key shortened to its head and its (informative) tail. */
function shortProgramKey(key: string): string {
  if (key.length <= DRIFT_PROGRAM_KEY_HEAD_CHARS + DRIFT_PROGRAM_KEY_TAIL_CHARS) return key;
  return `${key.slice(0, DRIFT_PROGRAM_KEY_HEAD_CHARS)}…[${String(key.length)} chars]…${key.slice(-DRIFT_PROGRAM_KEY_TAIL_CHARS)}`;
}

/**
 * The cache keys of every program the renderer currently holds.
 *
 * `renderer.info.programs` is three's own live list and each entry carries the
 * `cacheKey` it was compiled under, so this names WHICH shader variants exist
 * rather than only how many — the difference between "programs grew by 39" and
 * a finding.
 */
/**
 * Renderable objects and triangles under one scene child.
 *
 * TRIANGLES ARE COUNTED FROM THE GEOMETRY, not from renderer.info: info's count
 * is per-frame and post-culling, so it answers "what was drawn from here this
 * frame" and cannot say whether a rig's CONTENT is growing — which is the whole
 * question a census exists to answer. Instanced meshes multiply by their live
 * `count`, because that is the number that actually grows as a population does.
 */
function censusOf(root: Object3D): {
  objects: number;
  triangles: number;
  materials: number;
  textures: number;
} {
  let objects = 0;
  let triangles = 0;
  // BY IDENTITY, not by count of references: a material shared by forty meshes
  // is one material and one program, and counting it forty times would report
  // sharing as growth — the exact opposite of the finding being chased.
  const materials = new Set<unknown>();
  const textures = new Set<unknown>();
  const noteMaterial = (material: unknown): void => {
    if (material === null || material === undefined) return;
    if (materials.has(material)) return;
    materials.add(material);
    // Every texture-valued property, whatever it is called: three's slot names
    // differ per material type (map, normalMap, alphaMap, emissiveMap, …) and
    // an allow-list here would silently miss whichever one is actually growing.
    for (const value of Object.values(material as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture === true) {
        textures.add(value);
      }
    }
    // Uniform-held textures too: a ShaderMaterial keeps its maps in `uniforms`,
    // where the loop above cannot see them, and this renderer is full of them.
    const uniforms = (material as { uniforms?: Record<string, { value?: unknown }> }).uniforms;
    if (uniforms !== undefined) {
      for (const uniform of Object.values(uniforms)) {
        const value = uniform.value;
        if (value !== null && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture === true) {
          textures.add(value);
        }
      }
    }
  };
  root.traverse((node: Object3D) => {
    const withMaterial = node as Object3D & { material?: unknown };
    const material = withMaterial.material;
    if (Array.isArray(material)) for (const entry of material) noteMaterial(entry);
    else noteMaterial(material);
    const mesh = node as Object3D & {
      isMesh?: boolean;
      isPoints?: boolean;
      isLine?: boolean;
      isInstancedMesh?: boolean;
      count?: number;
      geometry?: { index?: { count: number } | null; attributes?: { position?: { count: number } } };
    };
    if (mesh.isMesh !== true && mesh.isPoints !== true && mesh.isLine !== true) return;
    objects++;
    const geometry = mesh.geometry;
    if (geometry === undefined) return;
    const vertices = geometry.index?.count ?? geometry.attributes?.position?.count ?? 0;
    const instances = mesh.isInstancedMesh === true ? (mesh.count ?? 0) : 1;
    triangles += (vertices / 3) * instances;
  });
  return {
    objects,
    triangles: Math.round(triangles),
    materials: materials.size,
    textures: textures.size,
  };
}

function programCacheKeys(renderer: { info: { programs: unknown } }): string[] {
  const programs = renderer.info.programs;
  if (!Array.isArray(programs)) return [];
  return programs.map((program: unknown) => {
    const key = (program as { cacheKey?: unknown }).cacheKey;
    return typeof key === 'string' ? key : '<no cacheKey>';
  });
}

/** Scene-child name prefix the plugin host gives every plugin layer (host.ts). */
const PLUGIN_LAYER_PREFIX = 'plugin:';
/**
 * Scene-child name prefix a CORE rig uses to opt into the same ablation
 * (render/celestialVoid.ts names both of its children this way). Core's rigs
 * are otherwise anonymous children of the scene, so without a name they can
 * only ever appear inside the unattributable remainder — which is exactly
 * where the celestial void sat until 2026-09-05, invisible to every run.
 */
const CORE_RIG_PREFIX = 'core:';
/** Every scene child the ablation scenario can hide, by name prefix. */
const ABLATABLE_PREFIXES = [PLUGIN_LAYER_PREFIX, CORE_RIG_PREFIX] as const;

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
  /**
   * Upload SHAPES, cumulative over the whole run, keyed `<entry point> <shape>`.
   *
   * WHY SHAPE AND NOT CALL SITE. Every one of these calls is issued from deep
   * inside three's own texture/attribute upload path, so a JS stack names
   * `WebGLTextures.uploadTexture` for all of them and settles nothing — and
   * walking a stack per call would cost more than the call it is attributing.
   * The ARGUMENTS, which are already in hand and free, separate them cleanly:
   * a ranged water-curve upload is one texel row (`32x1`, `waterBands`'s row
   * ranges), a palette or mask re-upload is the whole image (`512x512`), and a
   * per-instance buffer is named by its byte size. Two uploads of the same
   * shape are the same upload for every purpose this report serves.
   *
   * Cumulative rather than per frame: "who issues these" does not vary frame to
   * frame, and a per-frame reset would lose the counts that tell a rare-but-
   * huge shape from a constant small one.
   */
  byShape: new Map<string, { calls: number; ms: number; bytes: number }>(),
};

/** Buckets a byte count to a power of two, so near-identical sizes group. */
function byteBucket(bytes: number): string {
  if (bytes <= 0) return '0B';
  const exponent = Math.ceil(Math.log2(bytes));
  return `<=2^${String(exponent)}B`;
}

function recordUploadShape(key: string, ms: number, bytes: number): void {
  const shape = glUpload.byShape.get(key) ?? { calls: 0, ms: 0, bytes: 0 };
  shape.calls++;
  shape.ms += ms;
  shape.bytes += bytes;
  glUpload.byShape.set(key, shape);
}

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
  // byShape is deliberately NOT reset here; see its doc comment.
}

function installGlUploadAccounting(): void {
  const proto = WebGL2RenderingContext.prototype;
  const viewBytes = (value: unknown): number =>
    value instanceof ArrayBuffer || ArrayBuffer.isView(value)
      ? value.byteLength
      : typeof value === 'number'
        ? value
        : 0;
  const wrap = (
    name: UploadKind,
    sizeOf: (args: unknown[]) => number,
    shapeOf: (args: unknown[], bytes: number) => string,
  ): void => {
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
      recordUploadShape(`${name} ${shapeOf(args, bytes)}`, ms, bytes);
      return result;
    };
  };
  // bufferData(target, sizeOrData, usage[, srcOffset, length])
  wrap('bufferData', (args) => viewBytes(args[1]), (_args, bytes) => byteBucket(bytes));
  // bufferSubData(target, dstOffset, data[, srcOffset, length])
  wrap('bufferSubData', (args) => viewBytes(args[2]), (_args, bytes) => byteBucket(bytes));
  // texSubImage2D(target, level, x, y, w, h, …) — w*h, a volume, not exact bytes.
  wrap(
    'texSubImage2D',
    (args) => (typeof args[4] === 'number' && typeof args[5] === 'number' ? args[4] * args[5] : 0),
    (args) =>
      typeof args[4] === 'number' && typeof args[5] === 'number'
        ? `${String(args[4])}x${String(args[5])}`
        : 'unknown',
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
// GPU TIMING — the one measurement that says whether a slow frame is this
// page's JavaScript or the adapter, and therefore whether any of the CPU
// attribution above names the cause at all. Everything else in this file is a
// wall clock: it cannot tell 6 ms of shading from 6 ms of waiting for it.
//
// WHY THE BRACKET IS TWO CONSECUTIVE SAMPLER TICKS and not a wrap of
// renderer.render: render is called MORE THAN ONCE per frame — celestialVoid.ts
// draws its half-res gas pass into a render target before the main pass — so a
// wrap of it would time one pass and call it the frame. The sampler's own rAF
// callback runs after the viewport's (render/scene.ts's renderFrame re-arms
// itself at the top of its own callback, so it stays ahead of ours in the
// queue), which makes "the commands issued between two of our ticks" exactly
// one frame's GPU work, whatever passes it contains.
//
// A TIME_ELAPSED result arrives some frames after the frame it measures, so the
// last few frames of a block have no GPU number. `gpuFrames` reports how many
// did; it is not silently padded.

/** Nanoseconds per millisecond — the unit TIME_ELAPSED_EXT answers in. */
const NANOSECONDS_PER_MS = 1e6;
/**
 * Most unresolved queries kept before the oldest is dropped.
 *
 * SIXTY-FOUR, measured rather than assumed (2026-09-05). This was 8, on the
 * textbook claim that a TIME_ELAPSED result lands within two or three frames.
 * On this machine's ANGLE/D3D11 backend it does not: at 8 the eviction reached
 * every query before its result did, and a 239-frame block returned exactly ONE
 * GPU sample. The cap's job is only to bound leaked GL objects against a driver
 * that has stopped answering entirely, so it is set far above any real
 * latency — a quarter of a SAMPLE_FRAMES block — rather than at the latency
 * itself.
 */
const MAX_PENDING_GPU_QUERIES = 64;

interface GpuTimer {
  /** True only when the extension exists; every other member is inert without it. */
  readonly supported: boolean;
  /** Closes the query covering the frame just ended and opens the next one. */
  mark(): void;
  /** Stops timing and releases every outstanding query. */
  stop(): void;
  /** Per-frame GPU milliseconds resolved so far, in frame order. */
  samples(): readonly number[];
  /** Frames whose result was thrown away because the GPU clock was disjoint. */
  disjointDrops(): number;
  /**
   * Why no samples, when the extension exists and none arrived. A GL error
   * raised by the FIRST beginQuery is the whole diagnosis in one number, and
   * without it "supported, zero frames" is indistinguishable from a driver
   * that simply never answers. Null once a query has started cleanly.
   */
  startupError(): string | null;
}

/** GL error enum → name, for startupError. Only the codes beginQuery can raise. */
const GL_ERROR_NAMES: Readonly<Record<number, string>> = {
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x0507: 'CONTEXT_LOST_WEBGL',
};

function createGpuTimer(context: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer {
  // The WebGL1 branch is not dead code being tidy: three.js falls back to a
  // WebGL1 context on an adapter or a flag that refuses WebGL2, and the query
  // objects this file uses exist only on WebGL2. Reporting "unsupported" is the
  // honest answer there; calling beginQuery would throw mid-frame.
  const gl = context instanceof WebGL2RenderingContext ? context : null;
  const ext =
    gl === null
      ? null
      : (gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
          TIME_ELAPSED_EXT: number;
          GPU_DISJOINT_EXT: number;
        } | null);
  if (gl === null || ext === null) {
    return {
      supported: false,
      mark: () => {},
      stop: () => {},
      samples: () => [],
      disjointDrops: () => 0,
      startupError: () => (gl === null ? 'not a WebGL2 context' : 'extension absent'),
    };
  }
  const resolved: number[] = [];
  let pending: WebGLQuery[] = [];
  let open: WebGLQuery | null = null;
  let drops = 0;
  let started = false;
  let startupError: string | null = null;

  const closeOpen = (): void => {
    if (open === null) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push(open);
    open = null;
    // Oldest first: a driver that has stopped answering must not grow this
    // list without bound, and the oldest query is the one least worth waiting
    // for.
    while (pending.length > MAX_PENDING_GPU_QUERIES) {
      const dropped = pending.shift();
      if (dropped !== undefined) gl.deleteQuery(dropped);
    }
  };

  const collect = (): void => {
    // READ THE DISJOINT FLAG ONCE PER COLLECT: getParameter CLEARS it, so a
    // read per query would let a disjoint reported against the first query
    // silently validate every later one in the same pass.
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
    const kept: WebGLQuery[] = [];
    for (const query of pending) {
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) {
        kept.push(query);
        continue;
      }
      // A disjoint means the GPU clock was interrupted (a context switch, a
      // power-state change): every result in flight is meaningless, not merely
      // noisy, so it is dropped and counted rather than averaged in.
      if (disjoint) drops++;
      else resolved.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / NANOSECONDS_PER_MS);
      gl.deleteQuery(query);
    }
    pending = kept;
  };

  return {
    supported: true,
    mark(): void {
      // COLLECT BEFORE CLOSING, so a result that has just landed is read on the
      // tick it lands rather than after one more query has been pushed in
      // behind it. With the two the other way round, the eviction inside
      // closeOpen could discard a query whose result was already available.
      collect();
      closeOpen();
      const query = gl.createQuery();
      if (query === null) {
        startupError ??= 'createQuery returned null';
        return;
      }
      // ONLY ON THE FIRST START. getError is a synchronous round trip to the
      // driver and would itself distort a per-frame measurement; one call, once,
      // is the difference between a diagnosis and a shrug.
      if (!started) {
        started = true;
        gl.getError(); // drain anything three left behind, so the read below is ours
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        const code = gl.getError();
        if (code !== 0) {
          startupError = GL_ERROR_NAMES[code] ?? `GL error 0x${code.toString(16)}`;
          gl.deleteQuery(query);
          return;
        }
        open = query;
        return;
      }
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      open = query;
    },
    stop(): void {
      closeOpen();
      collect();
      for (const query of pending) gl.deleteQuery(query);
      pending = [];
    },
    samples: () => resolved,
    disjointDrops: () => drops,
    startupError: () => startupError,
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
  /**
   * GPU milliseconds per frame, or null where EXT_disjoint_timer_query_webgl2
   * is absent. NULL, NEVER ZERO: "the adapter took no time" and "nobody asked
   * the adapter" must not read alike in a report whose whole purpose is to
   * settle which side of the bus a frame was spent on.
   */
  gpuMsMean: number | null;
  gpuMsP50: number | null;
  gpuMsP99: number | null;
  gpuMsMax: number | null;
  /**
   * Whether EXT_disjoint_timer_query_webgl2 was available at all. Reported
   * apart from `gpuFrames`, because "the browser will not time the GPU here"
   * and "the queries did not come back" are different problems with different
   * fixes, and a bare zero cannot tell them apart.
   */
  gpuTimerSupported: boolean;
  /** Null when GPU timing started cleanly; otherwise why it produced nothing. */
  gpuTimerError: string | null;
  /** Frames that produced a GPU result; below `frames` by the queries still in flight. */
  gpuFrames: number;
  /** Results discarded because the GPU clock was disjoint — see createGpuTimer. */
  gpuDisjointDrops: number;
  drawCalls: number;
  drawCallsMax: number;
  triangles: number;
  uploadMsTotal: number;
  uploadMBTotal: number;
  uploadMaxCallMB: number;
  /** Per-frame means, per GL entry point — see glUpload.byKind for why. */
  uploadPerFrameByKind: Record<UploadKind, { calls: number; ms: number; MB: number }>;
  /**
   * Run totals per upload shape, heaviest by total ms first — see
   * glUpload.byShape. This is the field that names WHICH upload a frame spent
   * itself on; the per-kind block above only says which entry point.
   */
  uploadByShape: Record<string, { calls: number; ms: number; MB: number }>;
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
  const gpu = createGpuTimer(renderer.getContext());
  frameCost.clear();
  resetGlUpload();
  // SCOPED TO THIS BLOCK, unlike the run-cumulative map it reads. The probe
  // arms before the settle, and the settle is 45 s of chunk streaming whose
  // uploads dwarf a 240-frame steady-state sample — left uncleared, every
  // shape total would be a report on the load, which is not what any scenario
  // here is measuring.
  glUpload.byShape.clear();
  return {
    tick(): void {
      gpu.mark();
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
      gpu.stop();
      const gpuSorted = gpu.samples().slice().sort((a, b) => a - b);
      // Null the whole GPU group together when there is nothing behind it, so
      // a reader never has to work out whether a zero is a measurement.
      const gpuStat = (pick: (values: readonly number[]) => number): number | null =>
        gpuSorted.length === 0 ? null : pick(gpuSorted);
      const gpuPercentile = (p: number): number =>
        gpuSorted[Math.min(gpuSorted.length - 1, Math.floor(gpuSorted.length * p))] ?? 0;
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
        gpuMsMean: gpuStat((v) => v.reduce((sum, value) => sum + value, 0) / v.length),
        gpuMsP50: gpuStat(() => gpuPercentile(0.5)),
        gpuMsP99: gpuStat(() => gpuPercentile(0.99)),
        gpuMsMax: gpuStat((v) => v[v.length - 1] ?? 0),
        gpuTimerSupported: gpu.supported,
        gpuTimerError: gpu.startupError(),
        gpuFrames: gpuSorted.length,
        gpuDisjointDrops: gpu.disjointDrops(),
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
        uploadByShape: Object.fromEntries(
          [...glUpload.byShape]
            .sort((a, b) => b[1].ms - a[1].ms)
            .map(([key, total]) => [
              key,
              { calls: total.calls, ms: total.ms, MB: total.bytes / 1e6 },
            ]),
        ),
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

/** Resolves after `frames` animation frames, measuring nothing. */
function waitFrames(frames: number): Promise<void> {
  return new Promise((resolve) => {
    let left = frames;
    const tick = (): void => {
      if (--left <= 0) {
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
  /**
   * Stops (or resumes) applying inbound server state — plugin messages,
   * terrain diffs, chunk unlocks. See ablateScenario for why a scenario needs
   * this. Frozen, the client keeps rendering and animating exactly what it
   * already holds, so a measurement compares two visibility states of ONE
   * scene rather than of two worlds a minute apart.
   *
   * CLIENT-SIDE, not a server pause: the server is authoritative and shared,
   * pausing its tick would change what every other session sees, and the drift
   * this exists to stop arrives through these sinks anyway. Nothing is
   * acknowledged differently — the messages are received and dropped, so the
   * connection does not notice and the world resyncs on the next snapshot
   * after the freeze lifts.
   */
  readonly freeze: (on: boolean) => void;
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
 * Steady state at the WORLD-FRAMING pose, with the camera never touched.
 *
 * WHY IT EXISTS BESIDE `idle` (2026-09-05). `idle` and `sculpt` both park at
 * CAMERA_MIN_DISTANCE × STROKE_ZOOM_FACTOR — nose to the ground, where a
 * handful of chunks fill the frame. That is the right pose for judging a
 * sculpt, and the wrong one for judging the frame rate a player actually sees:
 * the wide pose the world opens at holds most of the map in frustum, which is
 * where the draw calls, the plugin populations and the sky all land at once.
 * `idle` measured 2.17 ms on this machine's adapter while the same build was
 * reported at 60–80 fps in play, so the two poses are not the same measurement.
 *
 * The camera is left exactly where render/scene.ts's restoreOrFocus put it —
 * on a bench's throwaway Chrome profile there is no stored pose, so that is
 * focusWorld's deterministic framing of the whole world, identical every run.
 */
const overviewScenario: Scenario = async (ctx) => {
  ctx.beat('parked');
  const sampler = ctx.sampler();
  await sampleFrames(sampler, SAMPLE_FRAMES);
  const { camera, controls } = ctx.viewport;
  return {
    sample: sampler.block(),
    detail: {
      worldSize: ctx.world.worldSize(),
      orbitTarget: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      eye: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    },
  };
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

/**
 * PER-PLUGIN GPU COST, by ablation: hide one plugin's layer, measure, restore.
 *
 * WHY ABLATION AND NOT A TIMER PER LAYER. A GPU timer query brackets a span of
 * the COMMAND STREAM, and every plugin's draws are interleaved with core's
 * inside one `renderer.render` — three orders by material and depth, not by
 * owner. There is no seam to put a query around, short of splitting the frame
 * into a render pass per plugin, which would change the very cost being
 * measured. Removing one layer and re-measuring asks the same question from
 * the outside, and the renderer stays exactly as it ships.
 *
 * WHAT A ROW MEANS: `gpuMsSaved` is the baseline's median GPU millisecond minus
 * this step's. It is a SAVING, not a share — the numbers do not sum to the
 * frame, because hiding two layers that both fill the same pixels saves less
 * than the sum of hiding each. Read it as "what turning this off would buy",
 * which is the decision it exists to inform.
 *
 * Core's own cost is the floor no ablation can reach, reported as `allHidden`:
 * the terrain, water and sky with every plugin layer hidden at once.
 */
const ablateScenario: Scenario = async (ctx) => {
  const layers = ctx.viewport.scene.children.filter((child) =>
    ABLATABLE_PREFIXES.some((prefix) => child.name.startsWith(prefix)),
  );
  /**
   * The rig's name with WHICHEVER prefix it carries removed. Slicing a fixed
   * PLUGIN_LAYER_PREFIX.length was wrong the moment core rigs joined: it ate
   * seven characters off five-character `core:` names and reported the void as
   * "id" and its stars as "id-stars".
   */
  const rigName = (child: { name: string }): string => {
    const prefix = ABLATABLE_PREFIXES.find((candidate) => child.name.startsWith(candidate));
    return prefix === undefined ? child.name : child.name.slice(prefix.length);
  };
  // THE SIMULATION IS FROZEN FOR THE WHOLE RUN. Without it this scenario
  // cannot work: its previous version measured a baseline that drifted from
  // 5.81 to 10.44 ms GPU over one three-minute run (2026-09-05) — a bigger
  // swing than any plugin's whole contribution — because the server keeps
  // ticking and the world keeps growing underneath the measurement. Bracketing
  // each step cancels drift that is LINEAR across that step; it cannot rescue
  // a scene that is a different scene by the end.
  ctx.freeze(true);
  ctx.beat(`ablating-${String(layers.length)}-layers-frozen`);

  /** One block at the current visibility state, after letting it settle. */
  const measure = async (): Promise<FrameBlock> => {
    await waitFrames(ABLATION_SETTLE_FRAMES);
    const sampler = ctx.sampler();
    await sampleFrames(sampler, ABLATION_SAMPLE_FRAMES);
    return sampler.block();
  };

  // THE BASELINE IS RE-MEASURED BETWEEN EVERY STEP, and a step is scored
  // against the MEAN of the baselines either side of it.
  //
  // WHY (measured 2026-09-05, and this scenario's first version got it wrong).
  // With one baseline taken at the start, every later step is compared against
  // a world that no longer exists: the server keeps simulating for the three
  // minutes a full run takes, so fires spread and herds grow underneath the
  // measurement. In that version `chronicle` — which draws nothing — scored a
  // 2.36 ms saving, and nearly every row reported the same ~28 "saved" draw
  // calls, which is the signature of a uniform offset rather than of per-plugin
  // cost. Bracketing each step cancels any drift that is linear across it,
  // which monotonic world growth is.
  //
  // It also yields the noise floor for free: consecutive baselines measure the
  // SAME scene, so the spread between them is exactly the error bar every row
  // below has to clear before it means anything. Reported as `noise` rather
  // than left for the reader to guess.
  const baselines: FrameBlock[] = [await measure()];
  const gpuOf = (block: FrameBlock): number | null => block.gpuMsP50;

  const rows: Record<string, unknown>[] = [];
  for (const layer of layers) {
    const name = rigName(layer);
    if (!layer.visible) {
      // Already hidden by the plugin itself: ablating it would measure nothing
      // and the row would read as "this plugin is free", which is a different
      // claim from "this plugin is not currently drawing".
      rows.push({ plugin: name, skipped: 'already hidden' });
      continue;
    }
    const before = baselines[baselines.length - 1]!;
    layer.visible = false;
    const step = await measure();
    layer.visible = true;
    const after = await measure();
    baselines.push(after);
    ctx.beat(`ablated-${name}`);

    const bracket = (pick: (block: FrameBlock) => number): number =>
      (pick(before) + pick(after)) / 2;
    const beforeGpu = gpuOf(before);
    const afterGpu = gpuOf(after);
    const stepGpu = gpuOf(step);
    rows.push({
      plugin: name,
      gpuMsSaved:
        beforeGpu === null || afterGpu === null || stepGpu === null
          ? null
          : (beforeGpu + afterGpu) / 2 - stepGpu,
      gpuMsP50: stepGpu,
      frameMsSaved: bracket((block) => block.msP50) - step.msP50,
      trianglesSaved: bracket((block) => block.triangles) - step.triangles,
      drawCallsSaved: bracket((block) => block.drawCalls) - step.drawCalls,
    });
  }

  for (const layer of layers) layer.visible = false;
  const allHidden = await measure();
  for (const layer of layers) layer.visible = true;
  ctx.freeze(false);

  // The error bar: how far apart two measurements of the SAME scene landed.
  const baselineGpu = baselines.map(gpuOf).filter((ms): ms is number => ms !== null);
  const steps = baselineGpu.slice(1).map((ms, index) => Math.abs(ms - baselineGpu[index]!));
  const noise = {
    baselineGpuMsMin: baselineGpu.length === 0 ? null : Math.min(...baselineGpu),
    baselineGpuMsMax: baselineGpu.length === 0 ? null : Math.max(...baselineGpu),
    /** Mean absolute gap between consecutive baselines — the per-row error bar. */
    baselineGpuMsMeanStep:
      steps.length === 0 ? null : steps.reduce((sum, ms) => sum + ms, 0) / steps.length,
    baselineDrawCallsMin: Math.min(...baselines.map((block) => block.drawCalls)),
    baselineDrawCallsMax: Math.max(...baselines.map((block) => block.drawCalls)),
  };

  rows.sort((a, b) => Number(b['gpuMsSaved'] ?? -1) - Number(a['gpuMsSaved'] ?? -1));
  return {
    sample: baselines[0]!,
    detail: {
      layers: layers.length,
      baselineBlocks: baselines.length,
      noise,
      ablation: rows,
      allHidden: {
        gpuMsP50: allHidden.gpuMsP50,
        frameMsP50: allHidden.msP50,
        triangles: allHidden.triangles,
        drawCalls: allHidden.drawCalls,
      },
    },
  };
};

/**
 * WHAT GROWS WHILE YOU STAND STILL. One block every DRIFT_INTERVAL_MS for
 * DRIFT_BLOCKS blocks, camera untouched, simulation running.
 *
 * WHY IT EXISTS. Every other scenario here takes ONE block and reports a
 * number, which silently assumes the scene is stationary. It is not: the
 * ablation runs showed the baseline nearly doubling over three minutes with the
 * camera locked, which is a bigger effect than any single rig contributes and
 * is much closer to the complaint that started this work ("we should be at 144,
 * we are getting 60-80") than any per-rig table. A trend cannot be read off
 * single blocks taken minutes apart in different runs, because the world
 * differs between runs too — so the samples have to come from ONE run.
 *
 * The renderer's own resource counters ride along beside the frame time, because
 * "the frame got slower" and "the frame got slower AND the geometry count only
 * ever rises" are different findings: the second names a leak, the first only
 * reports one.
 */
const makeDriftScenario = (freezeSim: boolean): Scenario => async (ctx) => {
  const { renderer } = ctx.viewport;
  const query = new URLSearchParams(location.search);
  const blockCount = Number(query.get(DRIFT_BLOCKS_QUERY_FLAG) ?? DRIFT_BLOCKS_DEFAULT);
  const intervalMs = Number(query.get(DRIFT_INTERVAL_QUERY_FLAG) ?? DRIFT_INTERVAL_MS_DEFAULT);
  // The CONTROL for the `drift` finding. Frozen, no server state reaches the
  // client at all, so anything still growing across the window is grown by the
  // client itself — a leak — and anything that stops growing was the world
  // arriving. One flag is the whole difference between the two readings, so
  // they share a body rather than being two scenarios that could drift apart.
  ctx.freeze(freezeSim);
  const startedAt = performance.now();
  const blocks: Record<string, unknown>[] = [];
  let firstBlock: FrameBlock | null = null;
  let firstKeys: string[] = [];
  let lastKeys: string[] = [];
  for (let index = 0; index < blockCount; index++) {
    const dueAt = startedAt + index * intervalMs;
    const waitMs = dueAt - performance.now();
    if (waitMs > 0) await wait(waitMs);
    const sampler = ctx.sampler();
    await sampleFrames(sampler, DRIFT_SAMPLE_FRAMES);
    const block = sampler.block();
    firstBlock ??= block;
    blocks.push({
      atSeconds: Math.round((performance.now() - startedAt) / 1000),
      gpuMsP50: block.gpuMsP50,
      frameMsP50: block.msP50,
      frameMsP99: block.msP99,
      drawCalls: block.drawCalls,
      triangles: block.triangles,
      uploadMsPerFrame: block.uploadMsTotal / Math.max(1, block.frames),
      // three's own resource counters: the ones that only ever rising would
      // mean something is not being released.
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs === null ? 0 : renderer.info.programs.length,
      // Per block, so the composition of the churn can be compared across the
      // window and not only its total. createSampler clears the shape map per
      // block, so these are this block's uploads alone.
      uploadTopShapes: Object.fromEntries(
        Object.entries(block.uploadByShape)
          .slice(0, 6)
          .map(([key, value]) => [
            key,
            { callsPerFrame: value.calls / block.frames, msPerFrame: value.ms / block.frames },
          ]),
      ),
      // Per-rig content census: which owner's population is growing.
      census: Object.fromEntries(
        ctx.viewport.scene.children
          .filter((child) => ABLATABLE_PREFIXES.some((prefix) => child.name.startsWith(prefix)))
          .map((child) => {
            const prefix = ABLATABLE_PREFIXES.find((candidate) => child.name.startsWith(candidate));
            const counted = censusOf(child);
            return [prefix === undefined ? child.name : child.name.slice(prefix.length), counted];
          }),
      ),
    });
    if (index === 0) firstKeys = programCacheKeys(renderer);
    lastKeys = programCacheKeys(renderer);
    ctx.beat(`drift-${String(index + 1)}-of-${String(blockCount)}`);
  }
  ctx.freeze(false);
  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  return {
    // The FIRST block is the scenario's headline sample: it is the one taken
    // under the same conditions every other scenario reports, so `fpsMean` at
    // the top level stays comparable with them rather than meaning something
    // new only this scenario understands. The loop above always runs at least
    // once (blockCount falls back to a positive literal), so this is set.
    sample: firstBlock!,
    detail: {
      frozen: freezeSim,
      blockCount,
      intervalMs,
      blocks,
      spanSeconds: Number(last['atSeconds']),
      // WHICH programs appeared, not just how many. A key present at the end
      // and absent at the start is a shader variant the running world asked for
      // that the loaded world did not — the actual unit of the growth.
      newPrograms: (() => {
        const before = new Set(firstKeys);
        const added = lastKeys.filter((key) => !before.has(key));
        const counts = new Map<string, number>();
        for (const key of added) {
          const short = shortProgramKey(key);
          counts.set(short, (counts.get(short) ?? 0) + 1);
        }
        return {
          total: added.length,
          distinct: counts.size,
          keys: Object.fromEntries([...counts].slice(0, DRIFT_MAX_NEW_PROGRAMS)),
        };
      })(),
      grew: Object.fromEntries(
        (['gpuMsP50', 'frameMsP50', 'drawCalls', 'triangles', 'geometries', 'textures', 'programs'] as const).map(
          (key) => [key, { from: first[key], to: last[key] }],
        ),
      ),
    },
  };
};

/** The scenario table. One entry, one function — that is the whole extension point. */
const SCENARIOS: Readonly<Record<string, Scenario>> = {
  idle: idleScenario,
  overview: overviewScenario,
  ablate: ablateScenario,
  drift: makeDriftScenario(false),
  'drift-frozen': makeDriftScenario(true),
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

/**
 * The freeze switch shared by the two wrappers below and read by ProbeContext's
 * `freeze`. Module state rather than a parameter because the sinks are wrapped
 * once, at install time, and flipped much later by a scenario.
 */
const frozenState = { on: false };

/**
 * The world sinks that carry WORLD GROWTH, and are therefore the ones a freeze
 * drops. `onSculptDenied` and `onSculptApplied` are deliberately absent: they
 * are verdicts on this client's own stroke, they change no population, and the
 * sculpt scenario needs them to keep arriving while it holds a stroke.
 */
const FREEZABLE_WORLD_SINKS = ['onSnapshot', 'onChunkUnlock', 'onTerrainDiff'] as const;

/** Times the world's message sinks, so a snapshot or a diff names itself. */
function wrapSinkTiming(world: World): void {
  const sink = world as unknown as Record<string, unknown>;
  const freezable = new Set<string>(FREEZABLE_WORLD_SINKS);
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
      if (frozenState.on && freezable.has(name)) return undefined;
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
    // A frozen run drops the payload but still reads the storm list above, so
    // the cyclone scenario can be frozen too without losing the storm it framed.
    if (frozenState.on) return;
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
    freeze: (on: boolean): void => {
      frozenState.on = on;
    },
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
