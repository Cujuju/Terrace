import { Vector3, type Object3D } from 'three';
import { CAMERA_MIN_DISTANCE, CELL_WORLD_SIZE, SCULPT_REPEAT_INTERVAL_MS } from './config.ts';
import type { Connection } from './net/connection.ts';
import type { ClientPluginHost } from './plugins/host.ts';
import type { Viewport } from './render/scene.ts';
import type { World } from './world.ts';
import type { SculptIntent } from '@terrace/shared';
import {
  CYCLONE_ALL_MESSAGE,
  CYCLONE_PLUGIN_NAME,
  parseAllPayload,
  type CycloneState,
} from '../../plugins/cyclone/protocol.ts';

const PROBE_QUERY_FLAG = 'perfprobe';
const SETTLE_QUERY_FLAG = 'settle';
const SUPPRESS_UPLOADS_QUERY_FLAG = 'suppressUploads';
const RENDER_SCALE_QUERY_FLAG = 'renderScale';
const NO_INSTRUMENT_QUERY_FLAG = 'noInstrument';

function instrumentationDisabled(): boolean {
  return new URLSearchParams(location.search).get(NO_INSTRUMENT_QUERY_FLAG) === '1';
}
const SETTLE_MS_DEFAULT = 45000;
const SAMPLE_FRAMES = 240;
const SINK_PATH = '/__perf';
const HEARTBEAT_INTERVAL_MS = 5000;

const STROKE_ZOOM_FACTOR = 1.05;
const STROKE_HOLD_MS = 5000;
const STROKE_RADIUS = 4;

const CYCLONE_WAIT_MS = 30000;
const CYCLONE_POLL_MS = 250;
const CYCLONE_FRAME_MARGIN = 1.15;

const ABLATION_SAMPLE_FRAMES = 90;
const ABLATION_SETTLE_FRAMES = 6;
const DRIFT_BLOCKS_DEFAULT = 12;
const DRIFT_INTERVAL_MS_DEFAULT = 20000;
const DRIFT_BLOCKS_QUERY_FLAG = 'blocks';
const DRIFT_INTERVAL_QUERY_FLAG = 'interval';
const DRIFT_SAMPLE_FRAMES = 90;
const DRIFT_MAX_NEW_PROGRAMS = 40;
const DRIFT_PROGRAM_KEY_HEAD_CHARS = 40;
const DRIFT_PROGRAM_KEY_TAIL_CHARS = 140;

function shortProgramKey(key: string): string {
  if (key.length <= DRIFT_PROGRAM_KEY_HEAD_CHARS + DRIFT_PROGRAM_KEY_TAIL_CHARS) return key;
  return `${key.slice(0, DRIFT_PROGRAM_KEY_HEAD_CHARS)}…[${String(key.length)} chars]…${key.slice(-DRIFT_PROGRAM_KEY_TAIL_CHARS)}`;
}

function censusOf(root: Object3D): {
  objects: number;
  triangles: number;
  materials: number;
  textures: number;
  textureSet: Set<unknown>;
} {
  let objects = 0;
  let triangles = 0;
  const materials = new Set<unknown>();
  const textures = new Set<unknown>();
  const noteMaterial = (material: unknown): void => {
    if (material === null || material === undefined) return;
    if (materials.has(material)) return;
    materials.add(material);
    for (const value of Object.values(material as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture === true) {
        textures.add(value);
      }
    }
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
    textureSet: textures,
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

const PLUGIN_LAYER_PREFIX = 'plugin:';
const CORE_RIG_PREFIX = 'core:';
const ABLATABLE_PREFIXES = [PLUGIN_LAYER_PREFIX, CORE_RIG_PREFIX] as const;

const UPLOAD_KINDS = ['bufferData', 'bufferSubData', 'texSubImage2D'] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

const glUpload = {
  ms: 0,
  bytes: 0,
  calls: 0,
  maxBytes: 0,
  byKind: Object.fromEntries(UPLOAD_KINDS.map((kind) => [kind, { calls: 0, ms: 0, bytes: 0 }])) as
    Record<UploadKind, { calls: number; ms: number; bytes: number }>,
  byShape: new Map<string, { calls: number; ms: number; bytes: number }>(),
  byOwner: new Map<string, OwnerUpload>(),
};

interface OwnerUpload {
  calls: number;
  ms: number;
  bytes: number;
  fullCalls: number;
  fullBytes: number;
  arrayBytes: number;
  maxArrayBytes: number;
  maxMs: number;
  slowCalls: number;
  slowMs: number;
}

interface SlowUpload {
  owner: string;
  ms: number;
  bytes: number;
  arrayBytes: number;
  full: boolean;
}

const SLOW_UPLOAD_MS = 1;
const SLOW_UPLOAD_LOG_LIMIT = 40;

let slowUploadLog: SlowUpload[] = [];

const uploadOwners = new WeakMap<ArrayBufferLike, string>();
let uploadOwnerRoot: Object3D | null = null;
let uploadOwnerEpoch = 0;
let uploadOwnerIndexedEpoch = -1;

interface OwnerGeometry {
  attributes?: Record<string, { array?: ArrayBufferView; data?: { array?: ArrayBufferView } }>;
  index?: { array?: ArrayBufferView } | null;
}

function uploadOwnerPath(node: Object3D): string {
  const parts: string[] = [];
  for (let cursor: Object3D | null = node; cursor !== null; cursor = cursor.parent) {
    if (cursor.name !== '') {
      parts.unshift(cursor.name);
      continue;
    }
    const siblings = cursor.parent?.children;
    const at = siblings === undefined ? -1 : siblings.indexOf(cursor);
    parts.unshift(at < 0 ? cursor.type : `${cursor.type}[${String(at)}]`);
  }
  return parts.join('/');
}

// Maps every geometry array's backing buffer to its scene path; re-run at most once per frame.
function indexUploadOwners(): void {
  const root = uploadOwnerRoot;
  if (root === null) return;
  uploadOwnerIndexedEpoch = uploadOwnerEpoch;
  root.traverse((node: Object3D) => {
    const geometry = (node as Object3D & { geometry?: OwnerGeometry }).geometry;
    if (geometry === undefined) return;
    const path = uploadOwnerPath(node);
    const note = (view: ArrayBufferView | undefined, attribute: string): void => {
      if (view === undefined) return;
      uploadOwners.set(view.buffer, `${path}.${attribute} (${String(view.byteLength)}B)`);
    };
    for (const [attribute, value] of Object.entries(geometry.attributes ?? {})) {
      note(value.array ?? value.data?.array, attribute);
    }
    note(geometry.index?.array, 'index');
  });
}

function uploadOwnerOf(view: unknown): string {
  if (!ArrayBuffer.isView(view)) return 'non-view';
  const known = uploadOwners.get(view.buffer);
  if (known !== undefined) return known;
  if (uploadOwnerIndexedEpoch !== uploadOwnerEpoch) indexUploadOwners();
  return uploadOwners.get(view.buffer) ?? `unregistered (${String(view.byteLength)}B)`;
}

function recordUploadOwner(
  owner: string,
  ms: number,
  bytes: number,
  arrayBytes: number,
  full: boolean,
): void {
  const row = glUpload.byOwner.get(owner) ?? {
    calls: 0,
    ms: 0,
    bytes: 0,
    fullCalls: 0,
    fullBytes: 0,
    arrayBytes: 0,
    maxArrayBytes: 0,
    maxMs: 0,
    slowCalls: 0,
    slowMs: 0,
  };
  row.calls++;
  row.ms += ms;
  row.bytes += bytes;
  row.arrayBytes += arrayBytes;
  if (arrayBytes > row.maxArrayBytes) row.maxArrayBytes = arrayBytes;
  if (ms > row.maxMs) row.maxMs = ms;
  if (ms >= SLOW_UPLOAD_MS) {
    row.slowCalls++;
    row.slowMs += ms;
    if (slowUploadLog.length < SLOW_UPLOAD_LOG_LIMIT) {
      slowUploadLog.push({ owner, ms, bytes, arrayBytes, full });
    }
  }
  if (full) {
    row.fullCalls++;
    row.fullBytes += bytes;
  }
  glUpload.byOwner.set(owner, row);
}

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
}

const suppressedUploadShapes = new Set<string>();

const TEX_SUB_IMAGE_SOURCE_FORM_ARGS = 7;
const RGBA_COMPONENTS = 4;
const TEX_FORMAT_COMPONENTS: ReadonlyMap<number, number> = new Map([
  [WebGL2RenderingContext.RGBA, 4],
  [WebGL2RenderingContext.RGB, 3],
  [WebGL2RenderingContext.RG, 2],
  [WebGL2RenderingContext.RED, 1],
  [WebGL2RenderingContext.RGBA_INTEGER, 4],
  [WebGL2RenderingContext.RED_INTEGER, 1],
]);
const TEX_TYPE_BYTES: ReadonlyMap<number, number> = new Map([
  [WebGL2RenderingContext.UNSIGNED_BYTE, 1],
  [WebGL2RenderingContext.HALF_FLOAT, 2],
  [WebGL2RenderingContext.FLOAT, 4],
  [WebGL2RenderingContext.UNSIGNED_INT, 4],
]);

function installGlUploadAccounting(): void {
  const proto = WebGL2RenderingContext.prototype;
  const viewBytes = (value: unknown): number =>
    value instanceof ArrayBuffer || ArrayBuffer.isView(value)
      ? value.byteLength
      : typeof value === 'number'
        ? value
        : 0;
  const elementBytes = (view: unknown): number =>
    ArrayBuffer.isView(view) ? ((view as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) : 1;
  // WebGL2 bufferSubData(target, dstByteOffset, srcData, srcOffset, length); length 0 means to the end.
  const subDataBytes = (args: unknown[]): number => {
    const view = args[2];
    const arrayBytes = viewBytes(view);
    const bpe = elementBytes(view);
    const srcOffset = typeof args[3] === 'number' ? args[3] : 0;
    const length = typeof args[4] === 'number' ? args[4] : 0;
    return length > 0 ? length * bpe : arrayBytes - srcOffset * bpe;
  };
  const wrap = (
    name: UploadKind,
    sizeOf: (args: unknown[]) => number,
    shapeOf: (args: unknown[], bytes: number) => string,
    ownerOf: (args: unknown[], bytes: number, ms: number) => void,
  ): void => {
    const original = proto[name] as (...args: unknown[]) => unknown;
    (proto as unknown as Record<string, unknown>)[name] = function (
      this: WebGL2RenderingContext,
      ...args: unknown[]
    ) {
      const shape = name === 'texSubImage2D' ? shapeOf(args, 0) : '';
      if (shape !== '' && suppressedUploadShapes.has(shape)) {
        recordUploadShape(`${name} ${shape} SUPPRESSED`, 0, 0);
        return undefined;
      }
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
      ownerOf(args, bytes, ms);
      return result;
    };
  };
  wrap(
    'bufferData',
    (args) => viewBytes(args[1]),
    (_args, bytes) => byteBucket(bytes),
    (args, bytes, ms) =>
      recordUploadOwner(`bufferData ${uploadOwnerOf(args[1])}`, ms, bytes, bytes, true),
  );
  wrap('bufferSubData', subDataBytes, (_args, bytes) => byteBucket(bytes), (args, bytes, ms) => {
    const arrayBytes = viewBytes(args[2]);
    const full = args[1] === 0 && bytes === arrayBytes;
    recordUploadOwner(`bufferSubData ${uploadOwnerOf(args[2])}`, ms, bytes, arrayBytes, full);
  });
  // The 7-argument source form has format and type at 4 and 5 and its size on the source;
  // the longer forms carry width and height there instead.
  const texSubImage = (args: unknown[]): { width: number; height: number; bytes: number } => {
    const sourceForm = args.length <= TEX_SUB_IMAGE_SOURCE_FORM_ARGS;
    const source = sourceForm ? (args[6] as { width?: number; height?: number } | undefined) : null;
    const width = sourceForm ? (source?.width ?? 0) : typeof args[4] === 'number' ? args[4] : 0;
    const height = sourceForm ? (source?.height ?? 0) : typeof args[5] === 'number' ? args[5] : 0;
    const format = (sourceForm ? args[4] : args[6]) as number;
    const type = (sourceForm ? args[5] : args[7]) as number;
    const bytesPerPixel =
      (TEX_FORMAT_COMPONENTS.get(format) ?? RGBA_COMPONENTS) * (TEX_TYPE_BYTES.get(type) ?? 1);
    return { width, height, bytes: width * height * bytesPerPixel };
  };
  const texShape = (args: unknown[]): string => {
    const { width, height } = texSubImage(args);
    return `${String(width)}x${String(height)}`;
  };
  wrap(
    'texSubImage2D',
    (args) => texSubImage(args).bytes,
    texShape,
    (args, bytes, ms) =>
      recordUploadOwner(`texSubImage2D ${texShape(args)}`, ms, bytes, bytes, true),
  );
}

const frameCost = new Map<string, number>();

function addCost(key: string, ms: number): void {
  frameCost.set(key, (frameCost.get(key) ?? 0) + ms);
}

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

const NANOSECONDS_PER_MS = 1e6;
const MAX_PENDING_GPU_QUERIES = 64;

interface GpuTimer {
  readonly supported: boolean;
  mark(): void;
  stop(): void;
  samples(): readonly number[];
  disjointDrops(): number;
  startupError(): string | null;
}

const GL_ERROR_NAMES: Readonly<Record<number, string>> = {
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x0507: 'CONTEXT_LOST_WEBGL',
};

function createGpuTimer(context: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer {
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
    while (pending.length > MAX_PENDING_GPU_QUERIES) {
      const dropped = pending.shift();
      if (dropped !== undefined) gl.deleteQuery(dropped);
    }
  };

  const collect = (): void => {
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
    const kept: WebGLQuery[] = [];
    for (const query of pending) {
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) {
        kept.push(query);
        continue;
      }
      if (disjoint) drops++;
      else resolved.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / NANOSECONDS_PER_MS);
      gl.deleteQuery(query);
    }
    pending = kept;
  };

  return {
    supported: true,
    mark(): void {
      collect();
      closeOpen();
      const query = gl.createQuery();
      if (query === null) {
        startupError ??= 'createQuery returned null';
        return;
      }
      if (!started) {
        started = true;
        gl.getError();
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

export interface FrameBlock {
  frames: number;
  fpsMean: number;
  msMean: number;
  msP50: number;
  msP95: number;
  msP99: number;
  fps1pctLow: number;
  msMax: number;
  gpuMsMean: number | null;
  gpuMsP50: number | null;
  gpuMsP99: number | null;
  gpuMsMax: number | null;
  gpuTimerSupported: boolean;
  gpuTimerError: string | null;
  gpuFrames: number;
  gpuDisjointDrops: number;
  drawCalls: number;
  drawCallsMax: number;
  triangles: number;
  uploadMsTotal: number;
  uploadMBTotal: number;
  uploadMaxCallMB: number;
  uploadPerFrameByKind: Record<UploadKind, { calls: number; ms: number; MB: number }>;
  uploadByShape: Record<string, { calls: number; ms: number; MB: number }>;
  uploadByOwner: Record<
    string,
    {
      calls: number;
      ms: number;
      MB: number;
      fullCalls: number;
      fullMB: number;
      arrayMB: number;
      maxArrayMB: number;
      maxMs: number;
      slowCalls: number;
      slowMs: number;
    }
  >;
  slowUploads: SlowUpload[];
  slowBreakdown: Record<string, number>;
  allBreakdown: Record<string, number>;
}

interface Sampler {
  tick(): void;
  block(): FrameBlock;
}

function breakdown(
  intervals: readonly number[],
  costs: readonly Map<string, number>[],
  share: number,
): Record<string, number> {
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
  glUpload.byShape.clear();
  uploadOwnerRoot = viewport.scene;
  const byOwner = new Map<string, OwnerUpload>();
  glUpload.byOwner = byOwner;
  const slowLog: SlowUpload[] = [];
  slowUploadLog = slowLog;
  return {
    tick(): void {
      uploadOwnerEpoch++;
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
      const gpuStat = (pick: (values: readonly number[]) => number): number | null =>
        gpuSorted.length === 0 ? null : pick(gpuSorted);
      const gpuPercentile = (p: number): number =>
        gpuSorted[Math.min(gpuSorted.length - 1, Math.floor(gpuSorted.length * p))] ?? 0;
      const sorted = intervals.slice(1).sort((a, b) => a - b);
      const percentile = (p: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
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
        uploadByOwner: Object.fromEntries(
          [...byOwner]
            .sort((a, b) => b[1].bytes - a[1].bytes)
            .map(([key, total]) => [
              key,
              {
                calls: total.calls,
                ms: total.ms,
                MB: total.bytes / 1e6,
                fullCalls: total.fullCalls,
                fullMB: total.fullBytes / 1e6,
                arrayMB: total.arrayBytes / 1e6,
                maxArrayMB: total.maxArrayBytes / 1e6,
                maxMs: total.maxMs,
                slowCalls: total.slowCalls,
                slowMs: total.slowMs,
              },
            ]),
        ),
        slowUploads: slowLog,
        slowBreakdown: breakdown(intervals, costs, 0.01),
        allBreakdown: breakdown(intervals, costs, 1),
      };
    },
  };
}

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

interface ProbeContext {
  readonly viewport: Viewport;
  readonly world: World;
  readonly connection: Connection;
  readonly cyclones: () => readonly CycloneState[];
  readonly dollyTo: (x: number, y: number, distance: number) => void;
  readonly sampler: () => Sampler;
  readonly freeze: (on: boolean) => void;
  readonly postPartial: (body: Record<string, unknown>) => void;
  readonly beat: (stage: string) => void;
}

interface ScenarioResult {
  readonly sample: FrameBlock;
  readonly detail: Record<string, unknown>;
}

type Scenario = (ctx: ProbeContext) => Promise<ScenarioResult>;

function centreCell(ctx: ProbeContext): { x: number; y: number } {
  const { camera } = ctx.viewport;
  const direction = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const pick = ctx.world.pickCell(camera.position.clone(), direction);
  if (pick === null) throw new Error('no terrain under the screen centre');
  return { x: pick.x, y: pick.y };
}

const idleScenario: Scenario = async (ctx) => {
  const cell = centreCell(ctx);
  ctx.dollyTo(cell.x, cell.y, CAMERA_MIN_DISTANCE * STROKE_ZOOM_FACTOR);
  ctx.beat('parked');
  const sampler = ctx.sampler();
  await sampleFrames(sampler, SAMPLE_FRAMES);
  return { sample: sampler.block(), detail: { cell } };
};

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

const ablateScenario: Scenario = async (ctx) => {
  const layers = ctx.viewport.scene.children.filter((child) =>
    ABLATABLE_PREFIXES.some((prefix) => child.name.startsWith(prefix)),
  );
  const rigName = (child: { name: string }): string => {
    const prefix = ABLATABLE_PREFIXES.find((candidate) => child.name.startsWith(candidate));
    return prefix === undefined ? child.name : child.name.slice(prefix.length);
  };
  ctx.freeze(true);
  ctx.beat(`ablating-${String(layers.length)}-layers-frozen`);

  const measure = async (): Promise<FrameBlock> => {
    await waitFrames(ABLATION_SETTLE_FRAMES);
    const sampler = ctx.sampler();
    await sampleFrames(sampler, ABLATION_SAMPLE_FRAMES);
    return sampler.block();
  };

  const baselines: FrameBlock[] = [await measure()];
  const gpuOf = (block: FrameBlock): number | null => block.gpuMsP50;

  const rows: Record<string, unknown>[] = [];
  for (const layer of layers) {
    const name = rigName(layer);
    if (!layer.visible) {
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

  const baselineGpu = baselines.map(gpuOf).filter((ms): ms is number => ms !== null);
  const steps = baselineGpu.slice(1).map((ms, index) => Math.abs(ms - baselineGpu[index]!));
  const noise = {
    baselineGpuMsMin: baselineGpu.length === 0 ? null : Math.min(...baselineGpu),
    baselineGpuMsMax: baselineGpu.length === 0 ? null : Math.max(...baselineGpu),
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

const makeDriftScenario = (freezeSim: boolean): Scenario => async (ctx) => {
  const { renderer } = ctx.viewport;
  const query = new URLSearchParams(location.search);
  const blockCount = Number(query.get(DRIFT_BLOCKS_QUERY_FLAG) ?? DRIFT_BLOCKS_DEFAULT);
  const intervalMs = Number(query.get(DRIFT_INTERVAL_QUERY_FLAG) ?? DRIFT_INTERVAL_MS_DEFAULT);
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
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs === null ? 0 : renderer.info.programs.length,
      uploadTopShapes: Object.fromEntries(
        Object.entries(block.uploadByShape)
          .slice(0, 6)
          .map(([key, value]) => [
            key,
            { callsPerFrame: value.calls / block.frames, msPerFrame: value.ms / block.frames },
          ]),
      ),
      topCpu: Object.fromEntries(Object.entries(block.allBreakdown).slice(0, 10)),
      sceneNodes: (() => {
        let nodes = 0;
        let groups = 0;
        let invisible = 0;
        ctx.viewport.scene.traverse((node) => {
          nodes++;
          if ((node as { isGroup?: boolean }).isGroup === true) groups++;
          if (!node.visible) invisible++;
        });
        return { nodes, groups, invisible };
      })(),
      censusTexturesReachable: (() => {
        const all = new Set<unknown>();
        for (const child of ctx.viewport.scene.children) {
          if (!ABLATABLE_PREFIXES.some((prefix) => child.name.startsWith(prefix))) continue;
          for (const texture of censusOf(child).textureSet) all.add(texture);
        }
        return all.size;
      })(),
      census: Object.fromEntries(
        ctx.viewport.scene.children
          .filter((child) => ABLATABLE_PREFIXES.some((prefix) => child.name.startsWith(prefix)))
          .map((child) => {
            const prefix = ABLATABLE_PREFIXES.find((candidate) => child.name.startsWith(candidate));
            const counted = censusOf(child);
            return [
              prefix === undefined ? child.name : child.name.slice(prefix.length),
              {
                objects: counted.objects,
                triangles: counted.triangles,
                materials: counted.materials,
                textures: counted.textures,
              },
            ];
          }),
      ),
    });
    if (index === 0) firstKeys = programCacheKeys(renderer);
    lastKeys = programCacheKeys(renderer);
    ctx.postPartial({ blockIndex: index, blockCount, frozen: freezeSim, block: blocks[blocks.length - 1] });
    ctx.beat(`drift-${String(index + 1)}-of-${String(blockCount)}`);
  }
  ctx.freeze(false);
  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  return {
    sample: firstBlock!,
    detail: {
      frozen: freezeSim,
      blockCount,
      intervalMs,
      blocks,
      spanSeconds: Number(last['atSeconds']),
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

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  idle: idleScenario,
  overview: overviewScenario,
  ablate: ablateScenario,
  drift: makeDriftScenario(false),
  'drift-frozen': makeDriftScenario(true),
  sculpt: sculptScenario,
  cyclone: cycloneScenario,
};

function requestedScenario(): string | null {
  const raw = new URLSearchParams(location.search).get(PROBE_QUERY_FLAG);
  return raw === null || raw === '' ? null : raw;
}

export function installPerfProbeEarly(viewport: Viewport): void {
  if (requestedScenario() === null) return;
  if (instrumentationDisabled()) return;
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

const frozenState = { on: false };

const FREEZABLE_WORLD_SINKS = ['onSnapshot', 'onChunkUnlock', 'onTerrainDiff'] as const;

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

  for (const shape of (new URLSearchParams(location.search).get(SUPPRESS_UPLOADS_QUERY_FLAG) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')) {
    suppressedUploadShapes.add(shape);
  }
  const renderScale = Number(
    new URLSearchParams(location.search).get(RENDER_SCALE_QUERY_FLAG) ?? '1',
  );
  if (Number.isFinite(renderScale) && renderScale > 0 && renderScale !== 1) {
    renderer.setPixelRatio(renderer.getPixelRatio() * renderScale);
  }
  if (!instrumentationDisabled()) {
    installGlUploadAccounting();
    wrapSinkTiming(world);
  }

  let storms: readonly CycloneState[] = [];
  const originalRoute = pluginHost.routeMessage.bind(pluginHost);
  pluginHost.routeMessage = (type, payload) => {
    if (type === `${CYCLONE_PLUGIN_NAME}:${CYCLONE_ALL_MESSAGE}`) {
      const parsed = parseAllPayload(payload);
      if (parsed !== null) storms = parsed.storms;
    }
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
      const target = new Vector3(x * CELL_WORLD_SIZE, height, y * CELL_WORLD_SIZE);
      const bearing = camera.position.clone().sub(controls.target).normalize();
      controls.target.copy(target);
      camera.position.copy(target).addScaledVector(bearing, distance);
      controls.update();
    },
    sampler: () => createSampler(viewport),
    freeze: (on: boolean): void => {
      frozenState.on = on;
    },
    postPartial: (body): void => {
      post({
        scenario: name,
        partial: true,
        pixelWidth: renderer.domElement.width,
        pixelHeight: renderer.domElement.height,
        ...body,
      });
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
          pixelWidth: renderer.domElement.width,
          pixelHeight: renderer.domElement.height,
          settleMs,
          cameraDistance: camera.position.distanceTo(controls.target),
          programs: renderer.info.programs === null ? null : renderer.info.programs.length,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          ...result.detail,
          terrainLoad: world.terrainLoadTrace(),
          sample: result.sample,
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
