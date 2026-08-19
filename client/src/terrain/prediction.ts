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
// RECONCILIATION POLICY, in priority order:
//
//   1. THE SERVER'S ANSWER (`resolveSeq`). Every intent carrying a `seq` is
//      answered exactly once — 'sculptApplied' or 'sculptDenied' — and the
//      answer retires that intent's prediction outright. This is the whole
//      reconciliation in the normal case, and it needs no guessing.
//   2. VALUE AGREEMENT (`isConfirmed`), the fallback for a seq-less intent or
//      a server too old to answer. A prediction whose cells already hold the
//      heights it produced is redundant and is dropped.
//   3. THE DEADLINE (PREDICTION_TTL_MS), the safety net for an intent that is
//      never answered at all (lost packet, silent rejection).
//
// Survivors are replayed, in order, on top of the new base.
//
// WHY THE SERVER'S ANSWER HAD TO EXIST (issue #21). Value agreement was once
// the ONLY mechanism, because `TerrainDiffMessage` carries no correlation id —
// a client cannot tell its own diff from another player's. It works only while
// the client can reproduce the server's arithmetic, and at a territory
// frontier it provably cannot: the shared brush and relaxation math read cells
// in chunks the client was never sent, which its mirror holds at SEA_LEVEL
// (see mirror.ts invariant 2). The prediction therefore never matched, was
// never recognised as acknowledged, and was REPLAYED ON TOP of the server's
// own copy of the same edit for a full second — visibly dragging just-sculpted
// frontier ground down, then snapping it back. `predict` now also refuses the
// predictions it cannot compute exactly (see PREDICTION_HALO_CELLS), so that
// window is not merely short but usually empty.
//
// RESIDUAL FAILURE MODES — none is permanent, and none can affect the
// authoritative state:
//   * SILENTLY REJECTED INTENT. The unlock mask drops the intent, or a plugin
//     rewrites it into something invalid; no diff and no answer ever arrive,
//     and the deadline is the only thing that takes the prediction back off.
//     Unreachable from this client for the mask case — `predict` below refuses
//     any intent whose brush centre is in a chunk we were never sent, and what
//     we were sent is always a subset of what the server's mask allows.
//   * DEEP RELAXATION CASCADE. A stroke whose footprint is entirely on known
//     ground, but whose relaxation cascade travels far enough to read past the
//     frontier anyway, still predicts wrong — the halo guard bounds the brush's
//     own reads, not an arbitrarily long cascade. Bounded to ONE ROUND TRIP by
//     the server's answer instead of to PREDICTION_TTL_MS, and it can no longer
//     double: the prediction comes off when the answer lands.
//   * SLOW LINK. Round trips longer than the deadline retire predictions before
//     their answers arrive, so the brush snaps back and then forward again. The
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
  cellX,
  cellY,
  chunkIndex,
  forEachFootprintOffset,
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

/**
 * How far beyond the brush footprint a prediction is allowed to READ, in cells,
 * before the client declares itself unqualified to predict the stroke at all
 * (issue #21).
 *
 * ONE, because one is exactly the reach of the shared math's neighbour reads:
 * `relaxPair` (heightmap.ts) compares each cell with its 4-neighbours, so
 * running the gradient relaxation over the footprint reads one ring outside it
 * even where nothing there moves. It is not a safety margin and not a tunable —
 * raising it would refuse strokes that are perfectly predictable, and lowering
 * it to zero would re-admit the frontier case this exists to exclude.
 *
 * WHY A READ ACROSS THE FRONTIER IS FATAL rather than merely inaccurate: the
 * mirror holds never-received cells at SEA_LEVEL on purpose (mirror.ts
 * invariant 2 — it is a RENDERING choice, so revealed territory slopes into the
 * sea instead of ending in a floating cliff). Simulation reading that
 * placeholder is reading fiction. Two ways it goes wrong, both observed:
 *   * the relaxation "corrects" a cliff that does not exist, dragging the
 *     client's own frontier column DOWN while the player asked for a raise;
 *   * the level-fill brush (stamp + hard) SURVEYS its whole footprint for the
 *     lowest band present, so a single unseen cell drags the surveyed level to
 *     the sea floor and the entire stroke targets the wrong terrace.
 *
 * The stroke is not lost — it is sent, applied and drawn from the server's
 * authoritative diff one round trip later. Only the local preview is skipped,
 * and only where it would have been wrong.
 */
export const PREDICTION_HALO_CELLS = 1;

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
   *
   * Silently ignores an intent it cannot predict FAITHFULLY: one the server
   * would certainly reject (malformed, or centred on a chunk we were never
   * sent), and one whose math would read cells we were never sent (see
   * PREDICTION_HALO_CELLS). Both would guarantee a wrong preview; the second is
   * the frontier case behind issue #21.
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
   * Retires the prediction whose intent carried this seq — THE SERVER HAS
   * ANSWERED it, either way.
   *
   * ONE METHOD FOR BOTH ANSWERS, because the local consequence is identical:
   * the prediction has done its job and must come off, cleanly, without
   * disturbing the ones around it.
   *   * 'sculptDenied' (a plugin said no — out of mana, on cooldown): the
   *     authoritative map never changed, so retiring makes the brush read as
   *     "it stopped" instead of as a one-second rubber-band.
   *   * 'sculptApplied' (issue #21): the authoritative map ALREADY holds the
   *     server's own version of this edit, because the ack is sent after the
   *     diff on the same connection, so retiring is invisible — and it is what
   *     stops a prediction the client could not compute exactly from being
   *     replayed on top of the server's copy of it.
   *
   * A seq with no pending prediction is a no-op — the deadline or a value
   * confirmation may legitimately have got there first. Returns stale chunk
   * indices.
   */
  resolveSeq(seq: number): Set<number>;

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
  const chunkOfCellIndex = (i: number): number =>
    chunkOfCell(cellX(size, i), cellY(size, i));

  /**
   * True when cell (x,y) either is not part of this world at all, or lives in a
   * chunk the server has sent us.
   *
   * OFF-MAP COUNTS AS KNOWN, and that is not a shortcut: the shared math skips
   * out-of-bounds cells entirely (`forEachFootprintCell` bounds-checks, and
   * `smooth` clamps its bounding box to the map), so nothing off the world edge
   * is ever read. Treating the edge as unknown would silently disable
   * prediction along all four borders of every world.
   */
  const cellIsKnown = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= size || y >= size || hasChunk(mirror, chunkOfCell(x, y));

  /**
   * Whether this brush can be predicted from data we actually hold: every cell
   * the shared math will read — the footprint, plus the PREDICTION_HALO_CELLS
   * ring its relaxation compares against — is in a received chunk.
   *
   * Iterated with `forEachFootprintOffset`, the shared footprint definition the
   * brush itself edits with, so "the cells we check we have" and "the cells the
   * stroke reads" cannot drift apart. Runs at most once per intent (ten a
   * second while a brush is held) over a few hundred offsets.
   */
  const canPredictFaithfully = (cx: number, cy: number, radius: number): boolean => {
    let known = true;
    forEachFootprintOffset(radius, (dx, dy) => {
      if (!known) return;
      const x = cx + dx;
      const y = cy + dy;
      if (
        !cellIsKnown(x, y) ||
        !cellIsKnown(x - PREDICTION_HALO_CELLS, y) ||
        !cellIsKnown(x + PREDICTION_HALO_CELLS, y) ||
        !cellIsKnown(x, y - PREDICTION_HALO_CELLS) ||
        !cellIsKnown(x, y + PREDICTION_HALO_CELLS)
      ) {
        known = false;
      }
    });
    return known;
  };

  /** Marks every chunk whose mesh reads a cell this prediction touched. */
  const addJournalChunks = (p: PendingPrediction, dirty: Set<number>): void => {
    for (const i of p.indices) {
      for (const idx of chunksDirtiedByCell(size, cellX(size, i), cellY(size, i))) dirty.add(idx);
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
   * doubled edit.
   *
   * DEMOTED TO A FALLBACK by issue #21: that false negative is the bug the
   * server's explicit answer (`resolveSeq`) now closes, so this test no longer
   * has to be right for reconciliation to work. It is retained because it is
   * still the only reconciliation available to a seq-less intent or against a
   * server built before the answer contract existed, and because retiring a
   * provably-invisible prediction early costs nothing.
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
      // ...and the server will happily apply an intent whose FOOTPRINT reaches
      // past what we hold, which we cannot reproduce. Send it, draw nothing,
      // and let the authoritative diff show what it did (issue #21).
      if (!canPredictFaithfully(validated.x, validated.y, validated.radius)) return dirty;

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

    resolveSeq(seq: number): Set<number> {
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
