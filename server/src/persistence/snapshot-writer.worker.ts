// THE SNAPSHOT WRITER THREAD — worker half (issue #273). See snapshot-writer.ts
// for why the write moved off the tick thread at all.
//
// THE BYTES MUST NOT DEPEND ON WHICH THREAD WROTE THEM. That is why this file
// contains no encoding of its own: it calls `writeSnapshot` and `buildThumbnail`,
// the same two functions the synchronous path calls, on a payload the main
// thread assembled the same way. A snapshot written here is byte-identical to
// the one the old inline path would have written for the same world state.
//
// ONE CONNECTION PER DATABASE, CACHED. A world stays loaded for hours and is
// snapshotted every dirty minute; re-opening SQLite for each write would put
// the open back in the cost this change exists to remove. The connection is
// closed when the store that owns it closes — see the 'close' request.
//
// NO SCHEMA WORK HERE, DELIBERATELY. `SnapshotStore.open` has already created
// the file, run the DDL and added every additive column before any write can be
// enqueued against it, so a second connection re-running migrations would be
// pure risk (two writers in ALTER TABLE) for no benefit.

import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import {
  prepareSnapshotWriteStatements,
  writeSnapshot,
  type SnapshotWriteStatements,
} from './snapshot-store.ts';
import { buildThumbnail } from './thumbnail.ts';
import {
  PENDING_JOBS_INDEX,
  type SnapshotWriterReply,
  type SnapshotWriterRequest,
} from './snapshot-writer.ts';

/**
 * How long this connection waits for the main thread's connection to leave
 * SQLite before giving up.
 *
 * BELT AND SUSPENDERS: `SnapshotStore.settle()` already guarantees the two
 * connections are never inside the file at once, so this should never elapse.
 * It is here because the cost of being wrong about that is a thrown
 * SQLITE_BUSY and a lost snapshot, and the cost of the guard is nothing.
 */
const BUSY_TIMEOUT_MS = 5000;

interface OpenDatabase {
  readonly db: Database;
  readonly statements: SnapshotWriteStatements;
}

const open = new Map<string, OpenDatabase>();

function connectionFor(dbPath: string): OpenDatabase {
  const existing = open.get(dbPath);
  if (existing !== undefined) return existing;
  const db = new DatabaseConstructor(dbPath);
  // WAL is a property of the FILE and the main connection already set it; this
  // repeats it so a worker that somehow opened first still gets it. The other
  // two are per-connection and are NOT optional: without foreign_keys the
  // retention prune would orphan every plugin slice and token mask instead of
  // cascading them away.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  const entry: OpenDatabase = { db, statements: prepareSnapshotWriteStatements(db) };
  open.set(dbPath, entry);
  return entry;
}

/** Writes one request; returns the heightmap buffer to hand back, if any. */
function handle(request: SnapshotWriterRequest): ArrayBuffer | undefined {
  if (request.kind === 'close') {
    open.get(request.dbPath)?.db.close();
    open.delete(request.dbPath);
    return undefined;
  }
  const { db, statements } = connectionFor(request.dbPath);
  const { job } = request;
  writeSnapshot(db, statements, request.retention, {
    worldSize: job.worldSize,
    name: job.name,
    cells: job.cells,
    mask: job.mask,
    columnSpans: job.columnSpans,
    slicesJson: job.slicesJson,
    tokenMasks: job.tokenMasks,
    simMillis: job.simMillis,
    genesisMillis: job.genesisMillis,
    // THE THUMBNAIL PASS, moved here whole: it is a full worldSize² read of the
    // heightmap and the single largest non-SQLite cost of a snapshot. The copy
    // it reads is the one the main thread already had to make for the blob, so
    // building it here costs the tick thread nothing at all.
    thumbnail: buildThumbnail(job.cells, job.worldSize),
  });
  // Nothing here refers to it any more; the main thread recycles it rather
  // than faulting in a fresh 8 MB on its next snapshot.
  return job.cells.buffer as ArrayBuffer;
}

/**
 * The shared counter of unfinished requests. THIS THREAD OWNS THE DECREMENT:
 * the main thread's `settle()` parks in `Atomics.wait`, which stops its event
 * loop, so a reply message cannot be what marks work as done — the main thread
 * would never get to read it. See snapshot-writer.ts.
 */
const pending = (workerData as { pending: Int32Array }).pending;

const port = parentPort;
if (port === null) throw new Error('snapshot writer worker started without a parent port');

port.on('message', (request: SnapshotWriterRequest) => {
  // EVERY request is answered and every request decrements the counter,
  // success or failure alike: a swallowed throw here would wedge the next
  // `settle()` forever and lose the error with it.
  let reply: SnapshotWriterReply;
  let transfer: ArrayBuffer[] = [];
  try {
    const cells = handle(request);
    reply = cells === undefined ? { error: null } : { error: null, cells };
    if (cells !== undefined) transfer = [cells];
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  // SETTLE FIRST, THEN REPORT. Releasing a waiting `settle()` before the reply
  // is posted is what makes "settle() returned" mean "the transaction is
  // committed"; the reply that follows carries only the outcome.
  Atomics.sub(pending, PENDING_JOBS_INDEX, 1);
  Atomics.notify(pending, PENDING_JOBS_INDEX);
  port.postMessage(reply, transfer);
});
