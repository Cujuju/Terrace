// GPU upload byte/call counts, lightweight v1. Scope: GPUQueue.writeBuffer and
// writeTexture only — copyExternalImageToTexture and command-encoder copies are
// not measured. Patched on first enable (see perfHandle.ts); off costs nothing.

export const UPLOAD_KINDS = ['writeBuffer', 'writeTexture'] as const;

export type UploadKind = (typeof UPLOAD_KINDS)[number];

export interface UploadKindTotal {
  readonly kind: UploadKind;
  readonly calls: number;
  readonly bytes: number;
}

export interface UploadWindowTotal {
  readonly bytes: number;
  readonly calls: number;
  /** Calls whose byte size could not be parsed; counted, bytes unknown. */
  readonly unparsedCalls: number;
  readonly byKind: readonly UploadKindTotal[];
}

const WRITE_BUFFER_DATA_ARG = 2;
const WRITE_BUFFER_DATA_OFFSET_ARG = 3;
const WRITE_BUFFER_SIZE_ARG = 4;
const WRITE_TEXTURE_LAYOUT_ARG = 2;
const WRITE_TEXTURE_SIZE_ARG = 3;

const SIZE_TUPLE_HEIGHT_INDEX = 1;
const SIZE_TUPLE_LAYERS_INDEX = 2;

let enabled = false;
let installed = false;
let totalBytes = 0;
let totalCalls = 0;
let unparsedCalls = 0;
const kindCalls: Record<UploadKind, number> = { writeBuffer: 0, writeTexture: 0 };
const kindBytes: Record<UploadKind, number> = { writeBuffer: 0, writeTexture: 0 };

/** Enabling patches the prototypes on first use, so a disabled meter is free. */
export function setUploadMeterEnabled(on: boolean): void {
  if (on) installUploadMeter();
  enabled = on;
}

/** Window totals since the last drain; resets the accumulators. */
export function drainUploadMeter(): UploadWindowTotal {
  const total: UploadWindowTotal = {
    bytes: totalBytes,
    calls: totalCalls,
    unparsedCalls,
    byKind: UPLOAD_KINDS.map((kind) => ({
      kind,
      calls: kindCalls[kind],
      bytes: kindBytes[kind],
    })),
  };
  totalBytes = 0;
  totalCalls = 0;
  unparsedCalls = 0;
  for (const kind of UPLOAD_KINDS) {
    kindCalls[kind] = 0;
    kindBytes[kind] = 0;
  }
  return total;
}

// The call always counts; only its bytes are dropped when unparseable, so an
// upload shape this module cannot size stays visible instead of vanishing.
function record(kind: UploadKind, bytes: number): void {
  totalCalls++;
  kindCalls[kind]++;
  if (!Number.isFinite(bytes) || bytes < 0) {
    unparsedCalls++;
    return;
  }
  totalBytes += bytes;
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

// rowsPerImage is optional and 0 means "unspecified", which WebGPU resolves to
// the copy height — taking it literally would zero the row.
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
  const height = sizeDimension(size, SIZE_TUPLE_HEIGHT_INDEX, 'height');
  const rowsPerImage =
    typeof layout?.rowsPerImage === 'number' && layout.rowsPerImage > 0
      ? layout.rowsPerImage
      : height;
  const layers = sizeDimension(size, SIZE_TUPLE_LAYERS_INDEX, 'depthOrArrayLayers');
  return Math.max(0, bytesPerRow * rowsPerImage * layers);
}

// GPUExtent3D is either a [w, h, layers] tuple or a dict; absent means 1.
function sizeDimension(
  size: unknown,
  index: number,
  field: 'height' | 'depthOrArrayLayers',
): number {
  if (Array.isArray(size)) {
    const value: unknown = size[index];
    return typeof value === 'number' ? value : 1;
  }
  const value: unknown = (size as Record<string, unknown> | undefined)?.[field];
  return typeof value === 'number' ? value : 1;
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

/** Idempotent; called from setUploadMeterEnabled(true), not from boot. */
function installUploadMeter(): void {
  if (installed) return;
  installed = true;
  const queueProto = (
    globalThis as unknown as { GPUQueue?: { prototype: Record<string, unknown> } }
  ).GPUQueue?.prototype;
  patchMethod(queueProto, 'writeBuffer', writeBufferBytes, 'writeBuffer');
  patchMethod(queueProto, 'writeTexture', writeTextureBytes, 'writeTexture');
}
