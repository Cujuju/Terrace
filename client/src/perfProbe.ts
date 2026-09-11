import {
  BufferAttribute,
  Color,
  DoubleSide,
  LinearSRGBColorSpace,
  Mesh,
  NoToneMapping,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { MeshBasicNodeMaterial, type NodeMaterial, type Renderer } from 'three/webgpu';
import { positionWorld, vec3 } from 'three/tsl';
import {
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  POSITION_Y_UNITS_PER_WORLD_UNIT,
} from './render/gpuMesher/gpuChunkAnswer.ts';
import { TIMESTAMP_QUERY_FEATURE } from './render/gpuTimer.ts';
import { clearGroundShade } from './render/groundShade.ts';
import {
  BAND_WORLD_HEIGHT,
  CAMERA_MIN_DISTANCE,
  CELL_WORLD_SIZE,
  SCULPT_REPEAT_INTERVAL_MS,
} from './config.ts';
import type { Connection } from './net/connection.ts';
import type { ClientPluginHost } from './plugins/host.ts';
import {
  AMBIENT_FLOOR_INTENSITY,
  GROUND_BOUNCE_COLOR,
  HEMISPHERE_LIGHT_INTENSITY,
  SKY_COLOR,
  SUN_DIRECTION_NOON,
  SUN_DISTANCE_WORLD_UNITS,
  SUN_LIGHT_INTENSITY,
  type Viewport,
} from './render/scene.ts';
import type { World } from './world.ts';
import { CHUNK_SIZE, chunksPerEdge, type SculptIntent } from '@terrace/shared';
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

const PARITY_HOLD_MS = 20_000;

/** A three.js layer nothing in the app uses (0 is the default; 31 is the last). */
const PARITY_RENDER_LAYER = 31;
const PARITY_SETTLE_FRAMES = 2;

/** `?parityShift=<steps>`: slides the terrain by that many GPU position steps, so a
 *  mesher can be diffed against itself moved below a pixel (gate 1's metric floor). */
const PARITY_SHIFT_QUERY_FLAG = 'parityShift';

/** `?parityQuantize=1`: snaps a float32 arena onto the GPU position grid for the hold, so the
 *  CPU mesh in the GPU's own format measures the storage's pixel cost. */
const PARITY_QUANTIZE_QUERY_FLAG = 'parityQuantize';
const POSITION_COMPONENTS = 3;
const TERRAIN_QUEUE_POLL_MS = 100;
const TERRAIN_QUEUE_TIMEOUT_MS = 180_000;
const HUD_ELEMENT_SELECTOR = '#hud';

/** Bands run negative; the bias puts every one of them inside a byte. */
const BAND_ID_BIAS = 128;
const BYTE_MAX = 255;
const CHUNK_INDEX_BYTE_SPAN = 256;
const CHUNK_WORLD_SPAN = CHUNK_SIZE * CELL_WORLD_SIZE;

/** Pure blue: no chunk index reaches a high byte of 255, so background never reads as terrain. */
const PARITY_BACKGROUND_RGB: readonly [number, number, number] = [0, 0, 1];

/** The sun and the ambient floor are white at noon (scene.ts). */
const NOON_LIGHT_COLOR = 0xffffff;

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

// WebGPURenderer keeps no enumerable program list, so the drift scenario has no keys to diff.
function programCacheKeys(): string[] {
  return [];
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

interface GpuTimer {
  readonly supported: boolean;
  mark(): void;
  stop(): void;
  samples(): readonly number[];
  disjointDrops(): number;
  startupError(): string | null;
}

function createGpuTimer(renderer: Renderer): GpuTimer {
  if (!renderer.hasFeature(TIMESTAMP_QUERY_FEATURE)) {
    return {
      supported: false,
      mark: () => {},
      stop: () => {},
      samples: () => [],
      disjointDrops: () => 0,
      startupError: () => 'timestamp queries unsupported',
    };
  }
  const resolved: number[] = [];
  let inFlight = false;
  let stopped = false;

  return {
    supported: true,
    mark(): void {
      if (stopped || inFlight) return;
      inFlight = true;
      void renderer.resolveTimestampsAsync('render').then(
        (ms) => {
          inFlight = false;
          if (ms !== undefined) resolved.push(ms);
        },
        () => {
          inFlight = false;
        },
      );
    },
    stop(): void {
      stopped = true;
    },
    samples: () => resolved,
    // The timestamp query pool reports no disjoint frames; the counter stays for the report shape.
    disjointDrops: () => 0,
    startupError: () => null,
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
  const gpu = createGpuTimer(renderer);
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
      calls.push(renderer.info.render.drawCalls);
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
      blockyChunks: ctx.world.blockyChunks(),
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
    detail: {
      cell,
      intentsSent: sent,
      idle: idle.block(),
      blockyChunks: ctx.world.blockyChunks(),
      gpuMesher: ctx.world.gpuMesherStats(),
    },
  };
};

async function waitForTerrainDrawn(ctx: ProbeContext): Promise<void> {
  const deadlineMs = performance.now() + TERRAIN_QUEUE_TIMEOUT_MS;
  for (;;) {
    const trace = ctx.world.terrainLoadTrace();
    if (
      trace !== null &&
      trace.queueEmptyAfterMs !== null &&
      ctx.world.pendingTerrainCount() === 0
    ) {
      break;
    }
    if (performance.now() > deadlineMs) {
      throw new Error(`terrain still building after ${String(TERRAIN_QUEUE_TIMEOUT_MS)} ms`);
    }
    await wait(TERRAIN_QUEUE_POLL_MS);
  }
  await waitFrames(PARITY_SETTLE_FRAMES);
}

function isDrawable(node: Object3D): boolean {
  const flags = node as Object3D & {
    isMesh?: boolean;
    isLine?: boolean;
    isPoints?: boolean;
    isSprite?: boolean;
  };
  return (
    flags.isMesh === true ||
    flags.isLine === true ||
    flags.isPoints === true ||
    flags.isSprite === true
  );
}

// Terrain alone, on a background no id can be mistaken for, under pinned noon light: two
// runs of a world must differ only where the meshers do.
function isolateTerrain(ctx: ProbeContext): { restore: () => void } {
  const { scene, lighting, camera } = ctx.viewport;
  const { sun, hemisphere, ambient } = lighting;
  const terrain = new Set<Object3D>(ctx.world.pickables());
  const wasVisible = new Map<Object3D, boolean>();
  scene.traverse((node) => {
    if (!isDrawable(node) || terrain.has(node)) return;
    wasVisible.set(node, node.visible);
    node.visible = false;
  });

  // Objects a plugin creates or re-shows during the hold (weather decks) never join this
  // layer, so the camera cannot see them whatever their visibility.
  const layerMasks = new Map<Object3D, number>();
  const admit = (node: Object3D): void => {
    layerMasks.set(node, node.layers.mask);
    node.layers.enable(PARITY_RENDER_LAYER);
  };
  for (const node of terrain) admit(node);
  admit(sun);
  admit(hemisphere);
  admit(ambient);
  const cameraMask = camera.layers.mask;
  camera.layers.set(PARITY_RENDER_LAYER);

  const shiftSteps = Number(new URLSearchParams(location.search).get(PARITY_SHIFT_QUERY_FLAG) ?? '0');
  const shift = Number.isFinite(shiftSteps) ? shiftSteps / POSITION_XZ_UNITS_PER_WORLD_UNIT : 0;
  const shiftedPositions = new Map<Object3D, Vector3>();
  if (shift !== 0) {
    for (const node of terrain) {
      shiftedPositions.set(node, node.position.clone());
      node.position.x += shift;
      node.position.z += shift;
      node.updateMatrixWorld(true);
    }
  }

  const quantize = new URLSearchParams(location.search).get(PARITY_QUANTIZE_QUERY_FLAG) === '1';
  const unquantized = new Map<BufferAttribute, Float32Array>();
  if (quantize) {
    for (const node of terrain) {
      if (!(node instanceof Mesh)) continue;
      const attribute = node.geometry.getAttribute('position');
      if (!(attribute instanceof BufferAttribute) || !(attribute.array instanceof Float32Array)) continue;
      const array = attribute.array;
      unquantized.set(attribute, array.slice());
      for (let i = 0; i < array.length; i += POSITION_COMPONENTS) {
        array[i] = Math.round(array[i]! * POSITION_XZ_UNITS_PER_WORLD_UNIT) / POSITION_XZ_UNITS_PER_WORLD_UNIT;
        array[i + 1] = Math.round(array[i + 1]! * POSITION_Y_UNITS_PER_WORLD_UNIT) / POSITION_Y_UNITS_PER_WORLD_UNIT;
        array[i + 2] = Math.round(array[i + 2]! * POSITION_XZ_UNITS_PER_WORLD_UNIT) / POSITION_XZ_UNITS_PER_WORLD_UNIT;
      }
      attribute.needsUpdate = true;
    }
  }

  const hud = document.querySelector<HTMLElement>(HUD_ELEMENT_SELECTOR);
  const hudDisplay = hud === null ? null : hud.style.display;
  if (hud !== null) hud.style.display = 'none';

  const background = scene.background;
  const parityBackground = new Color(...PARITY_BACKGROUND_RGB);
  scene.background = parityBackground;

  // Last in the frame set, so it lands after every plugin's handler. The day-night rig
  // retints the lights and copies into the background Color in place (skyRig.ts).
  const unpin = ctx.viewport.onFrame(() => {
    sun.position.set(...SUN_DIRECTION_NOON).normalize().multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
    sun.color.setHex(NOON_LIGHT_COLOR);
    sun.intensity = SUN_LIGHT_INTENSITY;
    hemisphere.color.setHex(SKY_COLOR);
    hemisphere.groundColor.setHex(GROUND_BOUNCE_COLOR);
    hemisphere.intensity = HEMISPHERE_LIGHT_INTENSITY;
    ambient.color.setHex(NOON_LIGHT_COLOR);
    ambient.intensity = AMBIENT_FLOOR_INTENSITY;
    parityBackground.setRGB(...PARITY_BACKGROUND_RGB);
    clearGroundShade();
  });

  return {
    restore(): void {
      unpin();
      scene.background = background;
      if (hud !== null && hudDisplay !== null) hud.style.display = hudDisplay;
      for (const [node, visible] of wasVisible) node.visible = visible;
      camera.layers.mask = cameraMask;
      for (const [node, mask] of layerMasks) node.layers.mask = mask;
      for (const [node, position] of shiftedPositions) node.position.copy(position);
      for (const [attribute, array] of unquantized) {
        (attribute.array as Float32Array).set(array);
        attribute.needsUpdate = true;
      }
    },
  };
}

// R: band id, biased into a byte. G and B: the chunk index, low byte then high, so the
// harness can exempt a blocky chunk pixel by pixel.
function swapBandMaterials(ctx: ProbeContext): () => void {
  const chunkCols = chunksPerEdge(ctx.world.worldSize());
  const bandId = positionWorld.y.div(BAND_WORLD_HEIGHT).round().add(BAND_ID_BIAS).div(BYTE_MAX);
  const chunkId = positionWorld.x
    .div(CHUNK_WORLD_SPAN)
    .floor()
    .add(positionWorld.z.div(CHUNK_WORLD_SPAN).floor().mul(chunkCols));
  const chunkHigh = chunkId.div(CHUNK_INDEX_BYTE_SPAN).floor();
  const chunkLow = chunkId.sub(chunkHigh.mul(CHUNK_INDEX_BYTE_SPAN));
  const colorNode = vec3(bandId, chunkLow.div(BYTE_MAX), chunkHigh.div(BYTE_MAX));

  const swapped: { mesh: Mesh; material: Material | Material[] }[] = [];
  for (const mesh of ctx.world.pickables()) {
    const previous = mesh.material as NodeMaterial;
    const banded = new MeshBasicNodeMaterial({ side: DoubleSide });
    // The arena's vertex layout decodes in positionNode; the band id must read that vertex.
    banded.positionNode = previous.positionNode;
    banded.colorNode = colorNode;
    swapped.push({ mesh, material: mesh.material });
    mesh.material = banded;
  }

  return (): void => {
    for (const entry of swapped) {
      const banded = entry.mesh.material as NodeMaterial;
      entry.mesh.material = entry.material;
      banded.dispose();
    }
  };
}

function parityDetail(ctx: ProbeContext): Record<string, unknown> {
  return {
    blockyChunks: ctx.world.blockyChunks(),
    meshersActive: ctx.world.terrainMesherActive(),
  };
}

const bandParityScenario: Scenario = async (ctx) => {
  await waitForTerrainDrawn(ctx);
  const { renderer } = ctx.viewport;
  const stage = isolateTerrain(ctx);
  const toneMapping = renderer.toneMapping;
  const outputColorSpace = renderer.outputColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.outputColorSpace = LinearSRGBColorSpace;
  const restoreMaterials = swapBandMaterials(ctx);
  await waitFrames(PARITY_SETTLE_FRAMES);
  ctx.beat('band-ready');

  const sampler = ctx.sampler();
  await sampleUntil(sampler, wait(PARITY_HOLD_MS));
  const detail = parityDetail(ctx);

  restoreMaterials();
  renderer.toneMapping = toneMapping;
  renderer.outputColorSpace = outputColorSpace;
  stage.restore();
  return { sample: sampler.block(), detail };
};

const terrainStillScenario: Scenario = async (ctx) => {
  await waitForTerrainDrawn(ctx);
  const stage = isolateTerrain(ctx);
  await waitFrames(PARITY_SETTLE_FRAMES);
  ctx.beat('still-ready');

  const sampler = ctx.sampler();
  await sampleUntil(sampler, wait(PARITY_HOLD_MS));
  const detail = parityDetail(ctx);

  stage.restore();
  return { sample: sampler.block(), detail };
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
      programs: renderer.info.memory.programs,
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
    if (index === 0) firstKeys = programCacheKeys();
    lastKeys = programCacheKeys();
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
  bandParity: bandParityScenario,
  terrainStill: terrainStillScenario,
};

function rendererBackendName(renderer: Renderer): 'webgpu' | 'webgl2' {
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  return backend.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}

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

  // WebGPU exposes no adapter string synchronously; a throwaway GL context still names the device.
  const gpuName = (): string => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl === null) return 'unknown';
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
          programs: renderer.info.memory.programs,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          rendererBackend: rendererBackendName(renderer),
          terrainMesher: world.terrainMesherActive(),
          terrainResidentBytes: world.terrainResidentBytes(),
          gpuMesher: world.gpuMesherStats(),
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
