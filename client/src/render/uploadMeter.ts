// Global + by-kind GPU upload byte counts, lightweight v1. No per-owner
// indexing, no timing calls: one branch per upload. Accumulates only while
// enabled (see perfHandle.ts).

export const UPLOAD_KINDS = [
  'writeBuffer',
  'writeTexture',
  'bufferData',
  'bufferSubData',
  'texSubImage2D',
] as const;

export type UploadKind = (typeof UPLOAD_KINDS)[number];

export interface UploadKindTotal {
  readonly kind: UploadKind;
  readonly calls: number;
  readonly bytes: number;
}

export interface UploadWindowTotal {
  readonly bytes: number;
  readonly calls: number;
  readonly byKind: readonly UploadKindTotal[];
}

const WRITE_BUFFER_DATA_ARG = 2;
const WRITE_BUFFER_DATA_OFFSET_ARG = 3;
const WRITE_BUFFER_SIZE_ARG = 4;
const WRITE_TEXTURE_LAYOUT_ARG = 2;
const WRITE_TEXTURE_SIZE_ARG = 3;

const TEX_SUB_IMAGE_SOURCE_FORM_ARGS = 7;
const RGBA_COMPONENTS = 4;
// WebGL2 enum values; kept local so this module needs no GL import.
const TEX_FORMAT_COMPONENTS: ReadonlyMap<number, number> = new Map([
  [0x1908, 4], // RGBA
  [0x1907, 3], // RGB
  [0x8227, 2], // RG
  [0x1903, 1], // RED
  [0x8d99, 4], // RGBA_INTEGER
  [0x8d94, 1], // RED_INTEGER
]);
const TEX_TYPE_BYTES: ReadonlyMap<number, number> = new Map([
  [0x1401, 1], // UNSIGNED_BYTE
  [0x140b, 2], // HALF_FLOAT
  [0x1406, 4], // FLOAT
  [0x1405, 4], // UNSIGNED_INT
]);

let enabled = false;
let installed = false;
let totalBytes = 0;
let totalCalls = 0;
const kindCalls: Record<UploadKind, number> = {
  writeBuffer: 0,
  writeTexture: 0,
  bufferData: 0,
  bufferSubData: 0,
  texSubImage2D: 0,
};
const kindBytes: Record<UploadKind, number> = {
  writeBuffer: 0,
  writeTexture: 0,
  bufferData: 0,
  bufferSubData: 0,
  texSubImage2D: 0,
};

export function setUploadMeterEnabled(on: boolean): void {
  enabled = on;
}

/** Window totals since the last drain; resets the accumulators. */
export function drainUploadMeter(): UploadWindowTotal {
  const total: UploadWindowTotal = {
    bytes: totalBytes,
    calls: totalCalls,
    byKind: UPLOAD_KINDS.map((kind) => ({
      kind,
      calls: kindCalls[kind],
      bytes: kindBytes[kind],
    })),
  };
  totalBytes = 0;
  totalCalls = 0;
  for (const kind of UPLOAD_KINDS) {
    kindCalls[kind] = 0;
    kindBytes[kind] = 0;
  }
  return total;
}

function record(kind: UploadKind, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  totalBytes += bytes;
  totalCalls++;
  kindCalls[kind]++;
  kindBytes[kind] += bytes;
}

function viewBytes(value: unknown): number {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === 'number') return value;
  return 0;
}

function bytesPerElementOf(view: unknown): number {
  if (ArrayBuffer.isView(view)) {
    return (view as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === undefined
      ? 1
      : Number((view as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT) || 1;
  }
  return 1;
}

// GPUQueue.writeBuffer(buffer, bufferOffset, data, dataOffset?, size?): size
// and dataOffset are in elements for typed arrays, bytes for ArrayBuffers.
function writeBufferBytes(args: readonly unknown[]): number {
  const data = args[WRITE_BUFFER_DATA_ARG];
  const arrayBytes = viewBytes(data);
  const bpe = bytesPerElementOf(data);
  const dataOffset =
    typeof args[WRITE_BUFFER_DATA_OFFSET_ARG] === 'number'
      ? (args[WRITE_BUFFER_DATA_OFFSET_ARG] as number)
      : 0;
  const size = args[WRITE_BUFFER_SIZE_ARG];
  const bytes =
    typeof size === 'number' ? size * bpe : arrayBytes - dataOffset * bpe;
  return Math.max(0, bytes);
}

function writeTextureBytes(args: readonly unknown[]): number {
  const layout = args[WRITE_TEXTURE_LAYOUT_ARG] as
    | { bytesPerRow?: unknown; rowsPerImage?: unknown }
    | undefined;
  const size = args[WRITE_TEXTURE_SIZE_ARG] as
    | { width?: unknown; height?: unknown; depthOrArrayLayers?: unknown }
    | readonly unknown[]
    | undefined;
  const bytesPerRow =
    typeof layout?.bytesPerRow === 'number' ? layout.bytesPerRow : 0;
  const height = Array.isArray(size)
    ? typeof size[1] === 'number'
      ? (size[1] as number)
      : 1
    : typeof (size as { height?: unknown } | undefined)?.height === 'number'
      ? ((size as { height?: unknown }).height as number)
      : 1;
  const rowsPerImage =
    typeof layout?.rowsPerImage === 'number' ? layout.rowsPerImage : height;
  const layers = Array.isArray(size)
    ? typeof size[2] === 'number'
      ? (size[2] as number)
      : 1
    : typeof (size as { depthOrArrayLayers?: unknown } | undefined)?.depthOrArrayLayers ===
        'number'
      ? ((size as { depthOrArrayLayers?: unknown }).depthOrArrayLayers as number)
      : 1;
  return Math.max(0, bytesPerRow * rowsPerImage * layers);
}

// WebGL2 bufferSubData(target, dstByteOffset, srcData, srcOffset?, length?);
// length 0/absent means to the end of the source.
function bufferSubDataBytes(args: readonly unknown[]): number {
  const view = args[2];
  const arrayBytes = viewBytes(view);
  const bpe = bytesPerElementOf(view);
  const srcOffset = typeof args[3] === 'number' ? (args[3] as number) : 0;
  const length = typeof args[4] === 'number' ? (args[4] as number) : 0;
  return Math.max(0, length > 0 ? length * bpe : arrayBytes - srcOffset * bpe);
}

// The short (source-element) form carries format/type at 4/5 with the size on
// the source; the longer forms carry width/height there instead.
function texSubImageBytes(args: readonly unknown[]): number {
  const sourceForm = args.length <= TEX_SUB_IMAGE_SOURCE_FORM_ARGS;
  if (sourceForm) {
    const source = args[6] as { width?: unknown; height?: unknown } | undefined;
    const width = typeof source?.width === 'number' ? source.width : 0;
    const height = typeof source?.height === 'number' ? source.height : 0;
    const format = args[4] as number;
    const type = args[5] as number;
    const bytesPerPixel =
      (TEX_FORMAT_COMPONENTS.get(format) ?? RGBA_COMPONENTS) *
      (TEX_TYPE_BYTES.get(type) ?? 1);
    return Math.max(0, width * height * bytesPerPixel);
  }
  const width = typeof args[4] === 'number' ? (args[4] as number) : 0;
  const height = typeof args[5] === 'number' ? (args[5] as number) : 0;
  const format = args[6] as number;
  const type = args[7] as number;
  const bytesPerPixel =
    (TEX_FORMAT_COMPONENTS.get(format) ?? RGBA_COMPONENTS) *
    (TEX_TYPE_BYTES.get(type) ?? 1);
  return Math.max(0, width * height * bytesPerPixel);
}

type PatchedThis = unknown;

function patchMethod(
  holder: Record<string, unknown> | undefined,
  name: string,
  sizeOf: (args: readonly unknown[]) => number,
  kind: UploadKind,
): void {
  if (holder === undefined) return;
  const original = holder[name];
  if (typeof original !== 'function') return;
  const wrapped = function (this: PatchedThis, ...args: unknown[]): unknown {
    if (!enabled) {
      return (original as (...callArgs: unknown[]) => unknown).apply(this, args);
    }
    const result = (original as (...callArgs: unknown[]) => unknown).apply(this, args);
    record(kind, sizeOf(args));
    return result;
  };
  Object.defineProperty(wrapped, 'name', { value: `uploadMetered(${name})` });
  holder[name] = wrapped;
}

/** Idempotent: safe to call on every boot; patches prototypes once. */
export function installUploadMeter(): void {
  if (installed) return;
  installed = true;
  const queueProto = (
    globalThis as unknown as { GPUQueue?: { prototype: Record<string, unknown> } }
  ).GPUQueue?.prototype;
  patchMethod(queueProto, 'writeBuffer', writeBufferBytes, 'writeBuffer');
  patchMethod(queueProto, 'writeTexture', writeTextureBytes, 'writeTexture');
  const glProto = (
    globalThis as unknown as {
      WebGL2RenderingContext?: { prototype: Record<string, unknown> };
    }
  ).WebGL2RenderingContext?.prototype;
  patchMethod(glProto, 'bufferData', (args) => viewBytes(args[1]), 'bufferData');
  patchMethod(glProto, 'bufferSubData', bufferSubDataBytes, 'bufferSubData');
  patchMethod(glProto, 'texSubImage2D', texSubImageBytes, 'texSubImage2D');
}
