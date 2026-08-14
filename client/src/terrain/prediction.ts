// Client-side prediction and reconciliation (design doc §3.3, MVP criterion 2).
//
// CRITICAL CODE — this is the other half of the sync path. The mirror applies
// what the server said; this module makes the local player's own sculpts appear
// instantly and then takes them back out again once the server's version of the
// same edit lands, without a visible snap in the common case.
//
// THE MODEL. Two arrays, one map:
//
//   base      — the authoritative heightmap: ONLY values the server sent.
//   rendered  — `mirror.map.cells`, what the meshes read: base with every
//               still-pending predicted sculpt replayed on top, in order.
//
// Every authoritative message (snapshot, chunkUnlock, terrainDiff) goes through
// `applyAuthoritative`, which rolls the predictions off, lets the mirror apply
// the message to pure authoritative state, snapshots that as the new base, and
// replays whatever predictions are still outstanding. Predictions are therefore
// never mixed into the authoritative record; they only ever sit on top of it.
//
// WHY NOT A SEQUENCE NUMBER. The obvious reconciliation — tag each intent with
// a sequence number and have the server echo it back on the diff that applied
// it — is not available: `shared/src/protocol.ts` is the locked contract and
// `TerrainDiffMessage` carries no correlation id, no sender id, and no ordering
// field. A client literally cannot tell its own diff from another player's. So
// acknowledgement is inferred by VALUE instead (see `isConfirmed`), with a
// deadline as the safety net. Adding `seq` to the protocol is the correct
// long-term fix and would replace `isConfirmed` wholesale.
//
// RECONCILIATION POLICY: a prediction is retired when the authoritative map
// agrees with it (`isConfirmed`), and unconditionally once it is older than
// PREDICTION_TTL_MS. Survivors are replayed, in order, on top of the new base.
//
// RESIDUAL FAILURE MODES — each one resolves within PREDICTION_TTL_MS, none is
// permanent, and none can affect the authoritative state:
//   * DOUBLED EDIT. The server applied our intent, but to a base that had moved
//     under it (an overlapping simultaneous edit, or relaxation fed by locked
//     terrain we have never been sent), so the values differ and the prediction
//     is not recognised as acknowledged. Ours is drawn on top of the server's
//     copy of it until the deadline. See `isConfirmed`.
//   * REJECTED INTENT. The unlock mask or a plugin veto silently drops the
//     intent; no diff ever arrives, and the deadline is the only thing that
//     takes the prediction back off. See PREDICTION_TTL_MS.
//   * MODIFIED INTENT. A plugin rewrites the intent (centre, radius) or the
//     deployment overrides the sculpt amount, so the server's result cannot
//     match ours. Behaves exactly like a rejected intent.
//   * SLOW LINK. Round trips longer than the deadline retire predictions before
//     their diffs arrive, so the brush snaps back and then forward again. The
//     alternative — no deadline — is a local world permanently ahead of the
//     server, which is worse.
//
// Deliberately free of Three.js and DOM references so it is unit-testable
// headless — see test/prediction.test.ts.

import {
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  applySculpt,
  cellIndex,
  chunkIndex,
  sculptOptionsOf,
  validateSculptIntent,
  type SculptIntent,
} from '@terrace/shared';
import { SCULPT_REPEAT_INTERVAL_MS } from '../config.ts';
import { chunksDirtiedByCell, hasChunk, type TerrainMirror } from './mirror.ts';

/**
 * How long a prediction may stay applied without the authoritative state
 * agreeing with it, in milliseconds.
 *
 * This is the deadline on the whole round trip: intent out, up to one server
 * tick of scheduling delay (TICK_HZ 10 → 100 ms, design §3.2), diff back. One
 * second leaves ~900 ms for the network, which covers any link a real-time
 * sculpting session is playable on at all. Past it, the prediction is assumed
 * lost — the server may have rejected the intent outright (locked chunk, a
 * plugin veto: both are answered with silence by design, see the intent
 * pipeline) — and the local view drops back to the truth rather than staying
 * permanently ahead of the server.
 */
export const PREDICTION_TTL_MS = 1000;

/**
 * Cap on simultaneously outstanding predictions. A held brush emits one intent
 * per SCULPT_REPEAT_INTERVAL_MS, so this is exactly "as many intents as can be
 * in flight within the deadline above" — reaching it means the link is slower
 * than the deadline assumes, and the oldest prediction is dropped rather than
 * letting an unbounded stack of unacknowledged edits accumulate on screen.
 */
export const MAX_PENDING_PREDICTIONS = Math.ceil(
  PREDICTION_TTL_MS / SCULPT_REPEAT_INTERVAL_MS,
);

/** One locally applied sculpt awaiting its authoritative counterpart. */
interface PendingPrediction {
  readonly intent: SculptIntent;
  /** Monotonic timestamp of the ORIGINAL prediction; replays do not renew it. */
  readonly createdAtMs: number;
  /** Cell indices changed by the most recent application of this prediction. */
  indices: number[];
  /** Height each of those cells held immediately after that application. */
  after: number[];
}

export interface PredictionStore {
  /**
   * Applies the local player's sculpt immediately, using the same shared math
   * the server will run. Returns the chunk indices whose meshes are now stale.
   * Silently ignores an intent the server would certainly reject (malformed, or
   * centred on a chunk we were never sent) — predicting those would guarantee a
   * snap.
   */
  predict(intent: SculptIntent, nowMs: number): Set<number>;

  /**
   * Runs an authoritative mirror mutation (`applySnapshot`, `applyChunkUnlock`,
   * `applyTerrainDiff`) against authoritative-only state, then re-derives the
   * rendered map. Returns the union of the mutation's stale chunks and any
   * chunk touched by a prediction that was rolled back, retired or replayed.
   */
  applyAuthoritative(
    mutate: (mirror: TerrainMirror) => Set<number>,
    nowMs: number,
  ): Set<number>;

  /**
   * Retires the prediction whose intent carried this seq — the server's
   * sculptDenied nack. This is the fast path that makes a plugin denial
   * (out of mana, on cooldown) read as "the brush stopped" rather than as a
   * one-second rubber-band: without it the denied prediction stays on screen
   * until PREDICTION_TTL_MS. A seq with no pending prediction is a no-op —
   * the deadline or a value-confirmation may legitimately have got there
   * first. Returns stale chunk indices.
   */
  rejectSeq(seq: number): Set<number>;

  /** Drops predictions past PREDICTION_TTL_MS. Returns stale chunk indices. */
  expire(nowMs: number): Set<number>;

  /**
   * Timestamp at which the oldest pending prediction expires, or null when
   * nothing is pending. The caller schedules `expire` for exactly this moment
   * rather than polling.
   */
  nextExpiryAtMs(): number | null;

  pendingCount(): number;

  /** Authoritative (server-sent) height, ignoring predictions. Tests / debug. */
  authoritativeHeightAt(x: number, y: number): number;
}

export function createPredictionStore(mirror: TerrainMirror): PredictionStore {
  const size = mirror.map.size;
  const rendered = mirror.map.cells;
  /**
   * The authoritative copy. Allocated once, alongside the mirror it shadows —
   * 512 KB at a 512² world, the same trivial cost the mirror itself accepts
   * (design §3.4), and it means reconciliation never allocates.
   */
  const base = new Int16Array(rendered);

  let pending: PendingPrediction[] = [];

  /** Chunk index owning a cell. */
  const chunkOfCell = (x: number, y: number): number =>
    chunkIndex(size, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));

  /** Chunk index owning a flat cell index. */
  const chunkOfCellIndex = (i: number): number => {
    const x = i % size;
    return chunkOfCell(x, (i - x) / size);
  };

  /** Marks every chunk whose mesh reads a cell this prediction touched. */
  const addJournalChunks = (p: PendingPrediction, dirty: Set<number>): void => {
    for (const i of p.indices) {
      const x = i % size;
      const y = (i - x) / size;
      for (const idx of chunksDirtiedByCell(size, x, y)) dirty.add(idx);
    }
  };

  /**
   * Applies one prediction to the rendered map and (re)records its journal.
   * The journal is rewritten on every replay because the result depends on the
   * state underneath: the same intent over a changed base changes other cells.
   */
  const applyPrediction = (p: PendingPrediction, dirty: Set<number>): void => {
    const amount = DEFAULT_SCULPT_AMOUNT * p.intent.dir;
    // The intent's tool/profile are resolved by the SAME shared function the
    // server's intent pipeline uses (`sculptOptionsOf`, protocol.ts), so an
    // intent that named neither predicts exactly what the server will apply.
    // Defaulting locally instead would put two copies of "absent means what"
    // in the codebase — the one drift this whole contract exists to prevent.
    const diff = applySculpt(
      mirror.map,
      p.intent.x,
      p.intent.y,
      p.intent.radius,
      amount,
      sculptOptionsOf(p.intent),
    );

    p.indices = [];
    p.after = [];
    for (const cell of diff) {
      p.indices.push(cellIndex(mirror.map, cell.x, cell.y));
      p.after.push(cell.h);
      for (const idx of chunksDirtiedByCell(size, cell.x, cell.y)) dirty.add(idx);
    }
  };

  /** Rolls every prediction off: the rendered map becomes pure authoritative. */
  const restoreToBase = (dirty: Set<number>): void => {
    if (pending.length === 0) return;
    for (const p of pending) addJournalChunks(p, dirty);
    rendered.set(base);
  };

  const replayPending = (dirty: Set<number>): void => {
    for (const p of pending) applyPrediction(p, dirty);
  };

  /**
   * ACKNOWLEDGEMENT BY VALUE. A prediction is treated as acknowledged when the
   * authoritative map already holds exactly the heights that prediction
   * produced, at every cell it changed that the server is allowed to tell us
   * about (cells in chunks we never received are filtered off the wire by the
   * server's mask filter, so they can never confirm anything and are skipped).
   *
   * Why this is safe: the test is precisely "dropping this prediction would
   * change nothing on screen", so retiring it — even on a coincidental match
   * caused by another player's edit — can never itself produce a snap. It is
   * the *false negative* that costs: a prediction the server DID apply, but to
   * a base that had meanwhile moved (an overlapping edit by another player, or
   * relaxation spilling in from a locked chunk whose real heights this client
   * has never seen and predicts as sea level), yields different values, is not
   * recognised, and is replayed on top of the server's own copy of it — a
   * doubled edit that persists until PREDICTION_TTL_MS retires it.
   *
   * A prediction with no comparable cells at all is never confirmed: zero
   * evidence must not read as agreement.
   */
  const isConfirmed = (p: PendingPrediction): boolean => {
    let comparable = 0;
    for (let k = 0; k < p.indices.length; k++) {
      const i = p.indices[k];
      if (!hasChunk(mirror, chunkOfCellIndex(i))) continue;
      if (base[i] !== p.after[k]) return false;
      comparable++;
    }
    return comparable > 0;
  };

  return {
    predict(intent: SculptIntent, nowMs: number): Set<number> {
      const dirty = new Set<number>();

      // Belt and braces against predicting something the server will drop.
      // The same validator the server runs, so the two cannot disagree.
      const validated = validateSculptIntent(intent, size);
      if (validated === null) return dirty;
      // The server rejects an intent whose brush CENTRE is in a locked chunk
      // (intent pipeline step 2). "Locked" on the client is "never received".
      if (!hasChunk(mirror, chunkOfCell(validated.x, validated.y))) return dirty;

      if (pending.length >= MAX_PENDING_PREDICTIONS) {
        // Drop the oldest and re-derive, so the rendered map is exactly
        // base + the predictions we are still willing to show.
        restoreToBase(dirty);
        pending.shift();
        replayPending(dirty);
      }

      const prediction: PendingPrediction = {
        intent: validated,
        createdAtMs: nowMs,
        indices: [],
        after: [],
      };
      pending.push(prediction);
      applyPrediction(prediction, dirty);

      // An edit that changed nothing (fully clamped at MAX_HEIGHT, say) has
      // nothing to reconcile and could never be confirmed — do not keep it.
      if (prediction.indices.length === 0) pending.pop();

      return dirty;
    },

    applyAuthoritative(
      mutate: (m: TerrainMirror) => Set<number>,
      nowMs: number,
    ): Set<number> {
      const dirty = new Set<number>();

      // 1. Predictions off, so the mutation sees only authoritative state...
      restoreToBase(dirty);
      // 2. ...apply it (the mirror's own validated writers do this)...
      for (const idx of mutate(mirror)) dirty.add(idx);
      // 3. ...and record the result as the new authoritative truth. A whole-map
      //    copy (512 KB at 512², ~tens of microseconds) rather than replaying
      //    the mutation's cells into `base` separately: the mutation's return
      //    value is chunk indices, not cells, so re-deriving the cell set here
      //    would mean duplicating the mirror's writers — the exact drift the
      //    single-source-of-truth rule exists to prevent. At the design's
      //    budget of a diff per tick this is far below the frame budget.
      base.set(rendered);

      // 4. Retire what the server has now confirmed or what has run out of
      //    time, then put the survivors back on top. Retiring is not restricted
      //    to a prefix: an old prediction that diverged must not pin newer,
      //    confirmed ones in place — that would double every edit behind it.
      pending = pending.filter(
        (p) => !isConfirmed(p) && nowMs - p.createdAtMs < PREDICTION_TTL_MS,
      );
      replayPending(dirty);

      return dirty;
    },

    rejectSeq(seq: number): Set<number> {
      const dirty = new Set<number>();
      const index = pending.findIndex((p) => p.intent.seq === seq);
      if (index === -1) return dirty;

      restoreToBase(dirty);
      pending.splice(index, 1);
      replayPending(dirty);
      return dirty;
    },

    expire(nowMs: number): Set<number> {
      const dirty = new Set<number>();
      const survivors = pending.filter((p) => nowMs - p.createdAtMs < PREDICTION_TTL_MS);
      if (survivors.length === pending.length) return dirty;

      restoreToBase(dirty);
      pending = survivors;
      replayPending(dirty);
      return dirty;
    },

    nextExpiryAtMs(): number | null {
      // Predictions are pushed in timestamp order, so the head is the oldest.
      return pending.length === 0 ? null : pending[0].createdAtMs + PREDICTION_TTL_MS;
    },

    pendingCount(): number {
      return pending.length;
    },

    authoritativeHeightAt(x: number, y: number): number {
      return base[cellIndex(mirror.map, x, y)];
    },
  };
}
