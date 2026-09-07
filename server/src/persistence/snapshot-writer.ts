
import { Worker } from 'node:worker_threads';
import { logError, logWarn } from '../log.ts';

export const PENDING_JOBS_INDEX = 0;
const PENDING_JOBS_SLOTS = 1;
const BYTES_PER_INT32 = 4;
const SETTLE_POLL_MS = 250;

const RECYCLED_HEIGHT_BUFFERS = 2;
export interface SnapshotWriteJob {
  readonly worldSize: number;
  readonly name: string;
  readonly cells: Int16Array;
  readonly mask: Uint8Array;
  readonly columnSpans: Map<number, Int16Array> | undefined;
  readonly slicesJson: readonly (readonly [string, string])[];
  readonly tokenMasks: Map<string, Uint8Array> | undefined;
  readonly simMillis: number | undefined;
  readonly genesisMillis: number | undefined;
}
export type SnapshotWriterRequest =
  | {
      readonly kind: 'write';
      readonly dbPath: string;
      readonly retention: number;
      readonly job: SnapshotWriteJob;
    }
  | { readonly kind: 'close'; readonly dbPath: string };

export interface SnapshotWriterReply {
  readonly error: string | null;
  readonly cells?: ArrayBuffer;
}
export type SnapshotSettledCallback = (error: string | null) => void;
export function copyColumnSpans(
  spans: ReadonlyMap<number, Int16Array> | undefined,
): Map<number, Int16Array> | undefined {
  if (spans === undefined) return undefined;
  const copy = new Map<number, Int16Array>();
  for (const [cell, packed] of spans) copy.set(cell, packed.slice());
  return copy;
}
export function copyTokenMasks(
  masks: ReadonlyMap<string, Uint8Array> | undefined,
): Map<string, Uint8Array> | undefined {
  if (masks === undefined) return undefined;
  const copy = new Map<string, Uint8Array>();
  for (const [token, mask] of masks) copy.set(token, mask.slice());
  return copy;
}
function transferListOf(job: SnapshotWriteJob): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [job.cells.buffer as ArrayBuffer, job.mask.buffer as ArrayBuffer];
  if (job.columnSpans !== undefined) {
    for (const packed of job.columnSpans.values()) buffers.push(packed.buffer as ArrayBuffer);
  }
  if (job.tokenMasks !== undefined) {
    for (const mask of job.tokenMasks.values()) buffers.push(mask.buffer as ArrayBuffer);
  }
  return buffers;
}
export class SnapshotWriterThread {
  private readonly worker: Worker;
  private readonly pending: Int32Array;
  private readonly callbacks: (SnapshotSettledCallback | null)[] = [];
  private readonly recycled: ArrayBuffer[] = [];
  private dead = false;
  constructor(worker: Worker, pending: Int32Array) {
    this.worker = worker;
    this.pending = pending;
    this.worker.on('message', (reply: SnapshotWriterReply) => {
      const callback = this.callbacks.shift() ?? null;
      if (reply.cells !== undefined && this.recycled.length < RECYCLED_HEIGHT_BUFFERS) {
        this.recycled.push(reply.cells);
      }
      if (Atomics.load(this.pending, PENDING_JOBS_INDEX) <= 0) this.worker.unref();
      if (callback !== null) callback(reply.error);
    });
    const die = (reason: string): void => {
      if (this.dead) return;
      this.dead = true;
      logError(`snapshot writer thread stopped (${reason}); writing snapshots inline`);
      Atomics.store(this.pending, PENDING_JOBS_INDEX, 0);
      Atomics.notify(this.pending, PENDING_JOBS_INDEX);
      for (const callback of this.callbacks.splice(0)) callback?.(reason);
    };
    this.worker.on('error', (error: Error) => {
      die(error.message);
    });
    this.worker.on('exit', (code: number) => {
      die(`exit code ${String(code)}`);
    });
  }

  scratchHeights(cells: number): Int16Array {
    const wanted = cells * Int16Array.BYTES_PER_ELEMENT;
    for (let i = 0; i < this.recycled.length; i++) {
      if (this.recycled[i]!.byteLength !== wanted) continue;
      const [buffer] = this.recycled.splice(i, 1);
      return new Int16Array(buffer!);
    }
    this.recycled.length = 0;
    return new Int16Array(cells);
  }
  get alive(): boolean {
    return !this.dead;
  }

  enqueue(
    dbPath: string,
    retention: number,
    job: SnapshotWriteJob,
    onSettled?: SnapshotSettledCallback,
  ): void {
    this.post({ kind: 'write', dbPath, retention, job }, onSettled ?? null, transferListOf(job));
  }
  closeDatabase(dbPath: string): void {
    if (this.dead) return;
    this.post({ kind: 'close', dbPath }, null, []);
    this.settle();
  }
  settle(): void {
    for (;;) {
      const left = Atomics.load(this.pending, PENDING_JOBS_INDEX);
      if (left <= 0) return;
      Atomics.wait(this.pending, PENDING_JOBS_INDEX, left, SETTLE_POLL_MS);
    }
  }
  private post(
    request: SnapshotWriterRequest,
    onSettled: SnapshotSettledCallback | null,
    transfer: ArrayBuffer[],
  ): void {
    Atomics.add(this.pending, PENDING_JOBS_INDEX, 1);
    this.callbacks.push(onSettled);
    this.worker.ref();
    this.worker.postMessage(request, transfer);
  }
}

let thread: SnapshotWriterThread | null = null;
let startFailed = false;
export function snapshotWriterThread(): SnapshotWriterThread | null {
  if (startFailed) return null;
  if (thread !== null) return thread.alive ? thread : null;
  try {
    const pending = new Int32Array(
      new SharedArrayBuffer(PENDING_JOBS_SLOTS * BYTES_PER_INT32),
    );
    const worker = new Worker(new URL('./snapshot-writer.worker.ts', import.meta.url), {
      workerData: { pending },
    });

    worker.unref();
    thread = new SnapshotWriterThread(worker, pending);
    return thread;
  } catch (error) {
    startFailed = true;
    logWarn(`could not start the snapshot writer thread: ${String(error)}`);
    return null;
  }
}
