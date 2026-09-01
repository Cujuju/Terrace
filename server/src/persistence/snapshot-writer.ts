// THE SNAPSHOT WRITER THREAD — main-thread half (issue #273).
//
// WHY THIS EXISTS. `snapshotIfDirty` used to do the whole write on the tick
// thread: a full worldSize² thumbnail pass, an 8 MB Int16 encode, a
// JSON.stringify per plugin slice, every per-token mask and the retention
// prune, all inside ONE synchronous better-sqlite3 transaction. Nothing
// yields, so the tick loop and every outgoing Colyseus send stop for the
// duration — measured at 25–50 ms per dirty minute with the database on a
// fast filesystem, and 3.5–5.2 SECONDS with it on drvfs (`/mnt/e`), which is
// where DEFAULT_DB_PATH actually puts it on the machine this was measured on.
// That is 35–52 dropped ticks and a multi-second freeze of all sends.
//
// WHAT MOVED AND WHAT DID NOT. The tick thread still pays for COPYING the live
// world, and that part is irreducible: whatever the writer holds must be
// memory the next sculpt cannot reach into, or the snapshot would be torn
// halfway through a stroke. Everything downstream of the copy — thumbnail,
// encode, transaction, prune — happens here.
//
// ONE THREAD FOR THE PROCESS, NOT ONE PER WORLD. A world switch closes a store
// and opens another, and paying ~30 ms of worker startup for each would put
// the cost back on the operator-visible path. The worker keeps one
// better-sqlite3 connection per database path and closes it when its store
// does.
//
// THE BARRIER IS `settle()`. SQLite is happy with two connections on one file
// under WAL, but "happy" is not the bar for the persistence path: a read that
// answered from before a snapshot this process had already decided to write
// would be a rollback list missing its newest entry. So every method of
// SnapshotStore that touches the file settles first, and settling when the
// queue is empty — the overwhelmingly common case — is a single atomic load.

import { Worker } from 'node:worker_threads';
import { logError, logWarn } from '../log.ts';

/**
 * The single Int32 the main thread and the worker share: how many messages the
 * worker has been sent and not yet finished. Index 0 of a one-slot array; named
 * so neither side can drift onto a different slot.
 */
export const PENDING_JOBS_INDEX = 0;
const PENDING_JOBS_SLOTS = 1;
const BYTES_PER_INT32 = 4;

/**
 * How long one `Atomics.wait` inside `settle()` blocks before looking again.
 *
 * A TIMEOUT RATHER THAN AN INDEFINITE WAIT because the thing being waited on
 * is a separate thread that can die: a worker killed by an OOM or an uncaught
 * throw would otherwise wedge the server process forever on shutdown. The
 * 'error'/'exit' handlers below zero the counter, and this timeout is the
 * belt-and-suspenders that bounds the wait even if they somehow do not run.
 * A quarter second is far below any human-noticeable shutdown delay and far
 * above the cost of re-checking.
 */
const SETTLE_POLL_MS = 250;

/**
 * How many heightmap buffers the main thread keeps to hand back to the next
 * snapshot.
 *
 * TWO, because at most two are in play at once: the one the worker still holds
 * and the one being filled for the next write. A FRESH 8 MB allocation costs
 * 4.3 ms of page faults on the tick thread, against 0.7 ms to memcpy into a
 * buffer that has already been touched (measured, 2048², WSL2) — so recycling
 * removes six sevenths of the copy, which is most of what a deferred snapshot
 * still costs the tick. Buffers of the wrong size (a world switch changed it)
 * are dropped rather than kept.
 */
const RECYCLED_HEIGHT_BUFFERS = 2;

/** One snapshot, already detached from the live world, on its way to the worker. */
export interface SnapshotWriteJob {
  readonly worldSize: number;
  readonly name: string;
  /** A COPY of the heightmap: the worker derives both the blob and the thumbnail from it. */
  readonly cells: Int16Array;
  readonly mask: Uint8Array;
  readonly columnSpans: Map<number, Int16Array> | undefined;
  readonly slicesJson: readonly (readonly [string, string])[];
  readonly tokenMasks: Map<string, Uint8Array> | undefined;
  readonly simMillis: number | undefined;
  readonly genesisMillis: number | undefined;
}

/** What the main thread sends the worker. */
export type SnapshotWriterRequest =
  | {
      readonly kind: 'write';
      readonly dbPath: string;
      readonly retention: number;
      readonly job: SnapshotWriteJob;
    }
  | { readonly kind: 'close'; readonly dbPath: string };

/** What the worker sends back — one per request, in order. */
export interface SnapshotWriterReply {
  /** Null on success; the failure's message otherwise. */
  readonly error: string | null;
  /**
   * The heightmap buffer this request was given, handed straight back so the
   * next snapshot can memcpy into warm pages instead of faulting in 8 MB of
   * fresh ones. Absent for a request that carried no heightmap (a 'close'), or
   * for one that failed before it could give the buffer back.
   */
  readonly cells?: ArrayBuffer;
}

/** Called once the worker has finished (or failed) one enqueued snapshot. */
export type SnapshotSettledCallback = (error: string | null) => void;

/**
 * Deep-copies the span side table for handoff. An absent table stays absent —
 * "this caller never carved" and "this world has no layered column" must reach
 * the writer as the same thing they were, see SnapshotInput.columnSpans.
 */
export function copyColumnSpans(
  spans: ReadonlyMap<number, Int16Array> | undefined,
): Map<number, Int16Array> | undefined {
  if (spans === undefined) return undefined;
  const copy = new Map<number, Int16Array>();
  for (const [cell, packed] of spans) copy.set(cell, packed.slice());
  return copy;
}

/** Deep-copies the per-token masks for handoff; see copyColumnSpans. */
export function copyTokenMasks(
  masks: ReadonlyMap<string, Uint8Array> | undefined,
): Map<string, Uint8Array> | undefined {
  if (masks === undefined) return undefined;
  const copy = new Map<string, Uint8Array>();
  for (const [token, mask] of masks) copy.set(token, mask.slice());
  return copy;
}

/**
 * Every ArrayBuffer in a job, so `postMessage` can MOVE them instead of copying
 * them a second time. The buffers were freshly allocated by the copy helpers
 * above and by `saveSnapshotDeferred`, so nothing on this thread still refers
 * to them once they are detached.
 */
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

/** The main-thread handle on the writer thread. */
export class SnapshotWriterThread {
  private readonly worker: Worker;
  private readonly pending: Int32Array;
  /** One entry per in-flight request, shifted in the order the worker replies. */
  private readonly callbacks: (SnapshotSettledCallback | null)[] = [];
  /** Heightmap buffers the worker has finished with. See RECYCLED_HEIGHT_BUFFERS. */
  private readonly recycled: ArrayBuffer[] = [];
  private dead = false;

  constructor(worker: Worker, pending: Int32Array) {
    this.worker = worker;
    this.pending = pending;

    // THE COUNTER IS DECREMENTED BY THE WORKER, NOT HERE, and that is the
    // whole reason `settle()` can work at all: a main thread parked in
    // `Atomics.wait` is not running its event loop, so a 'message' handler is
    // exactly the thing that CANNOT run while somebody is waiting. This
    // handler is only for what the main thread must know afterwards — whether
    // the write failed, and whether the process still owes anything to disk.
    this.worker.on('message', (reply: SnapshotWriterReply) => {
      const callback = this.callbacks.shift() ?? null;
      if (reply.cells !== undefined && this.recycled.length < RECYCLED_HEIGHT_BUFFERS) {
        this.recycled.push(reply.cells);
      }
      // Stop holding the process open once nothing is owed to disk — and keep
      // holding it open while something is, which is what makes a snapshot
      // handed off moments before a clean exit still land.
      if (Atomics.load(this.pending, PENDING_JOBS_INDEX) <= 0) this.worker.unref();
      if (callback !== null) callback(reply.error);
    });

    // A worker that dies takes its queue with it. Zero the counter so no
    // `settle()` can wait on work that will never finish, tell every waiting
    // caller, and mark the thread dead so the store falls back to writing
    // snapshots synchronously rather than silently dropping them.
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

  /**
   * A heightmap-sized buffer for the next snapshot to fill — recycled from a
   * finished write when one of the right size is available, fresh otherwise.
   *
   * The CALLER fills it and hands it straight back through `enqueue`, which
   * transfers it away again; nothing on this thread may keep a reference.
   */
  scratchHeights(cells: number): Int16Array {
    const wanted = cells * Int16Array.BYTES_PER_ELEMENT;
    for (let i = 0; i < this.recycled.length; i++) {
      if (this.recycled[i]!.byteLength !== wanted) continue;
      const [buffer] = this.recycled.splice(i, 1);
      return new Int16Array(buffer!);
    }
    // Nothing of this size — a first write, or a world switch changed the size.
    // Drop what is left rather than keeping buffers for a world that is gone.
    this.recycled.length = 0;
    return new Int16Array(cells);
  }

  /** False once the thread has died; the store then writes inline instead. */
  get alive(): boolean {
    return !this.dead;
  }

  /** Hands one snapshot over. Returns as soon as the buffers have been moved. */
  enqueue(
    dbPath: string,
    retention: number,
    job: SnapshotWriteJob,
    onSettled?: SnapshotSettledCallback,
  ): void {
    this.post({ kind: 'write', dbPath, retention, job }, onSettled ?? null, transferListOf(job));
  }

  /**
   * Closes the worker's connection to one database, once everything queued for
   * it has landed. Blocks until it is closed: the caller is `SnapshotStore.close`,
   * whose whole contract is that the file is no longer open when it returns.
   */
  closeDatabase(dbPath: string): void {
    if (this.dead) return;
    this.post({ kind: 'close', dbPath }, null, []);
    this.settle();
  }

  /** Blocks until the worker has nothing left to do. See this file's header. */
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
    // Count BEFORE posting: a `settle()` racing the post from a later turn of
    // the event loop must already see the work as owed.
    Atomics.add(this.pending, PENDING_JOBS_INDEX, 1);
    this.callbacks.push(onSettled);
    this.worker.ref();
    this.worker.postMessage(request, transfer);
  }
}

let thread: SnapshotWriterThread | null = null;
let startFailed = false;

/**
 * The process-wide writer thread, started on first use — or null when it
 * cannot be started or has died, which every caller must read as "write it
 * inline instead" rather than as "skip the write".
 */
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
    // Idle from birth: an empty queue must never be the reason a server that
    // has been told to stop keeps running.
    worker.unref();
    thread = new SnapshotWriterThread(worker, pending);
    return thread;
  } catch (error) {
    startFailed = true;
    logWarn(`could not start the snapshot writer thread: ${String(error)}`);
    return null;
  }
}
