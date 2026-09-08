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
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  const entry: OpenDatabase = { db, statements: prepareSnapshotWriteStatements(db) };
  open.set(dbPath, entry);
  return entry;
}

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
    thumbnail: buildThumbnail(job.cells, job.worldSize),
  });
  return job.cells.buffer as ArrayBuffer;
}

const pending = (workerData as { pending: Int32Array }).pending;

const port = parentPort;
if (port === null) throw new Error('snapshot writer worker started without a parent port');

port.on('message', (request: SnapshotWriterRequest) => {
  let reply: SnapshotWriterReply;
  let transfer: ArrayBuffer[] = [];
  try {
    const cells = handle(request);
    reply = cells === undefined ? { error: null } : { error: null, cells };
    if (cells !== undefined) transfer = [cells];
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  Atomics.sub(pending, PENDING_JOBS_INDEX, 1);
  Atomics.notify(pending, PENDING_JOBS_INDEX);
  port.postMessage(reply, transfer);
});
