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
  type TerrainDiffMessage,
} from '@terrace/shared';
import { DRAG_INTENTS_PER_TICK, SCULPT_REPEAT_INTERVAL_MS } from '../config.ts';
import {
  applyTerrainDiff,
  chunksDirtiedByCell,
  hasChunk,
  type CellWriteSink,
  type TerrainMirror,
} from './mirror.ts';

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
 * Cap on simultaneously outstanding predictions: "as many intents as can be in
 * flight within the deadline above". Reaching it means the link is slower than
 * the deadline assumes, and the oldest prediction is dropped rather than
 * letting an unbounded stack of unacknowledged edits accumulate on screen.
 *
 * ONE TICK IS NOT ONE INTENT (2026-08-23, the drag tool). A held brush still
 * emits one intent per SCULPT_REPEAT_INTERVAL_MS, but a drag is driven by
 * pointer motion rather than the timer and emits once per cursor cell change,
 * up to DRAG_INTENTS_PER_TICK of them in the same span. The cap is the product
 * because it is the same sentence it always was — ticks in the deadline, times
 * intents per tick — and stating it any other way would make a drag start
 * evicting its own live predictions the moment the player moved quickly.
 */
export const MAX_PENDING_PREDICTIONS =
  Math.ceil(PREDICTION_TTL_MS / SCULPT_REPEAT_INTERVAL_MS) * DRAG_INTENTS_PER_TICK;

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
 *   * the level-fill brush (the hard profile) used to SURVEY its whole
 *     footprint for the lowest band, so a single unseen cell dragged the
 *     level to the sea floor and the entire stroke targeted the wrong
 *     terrace. (Since the clicked-cell anchor, 2026-08-19, a player fill
 *     targets the centre's band instead — but the fill still WRITES into
 *     unseen footprint cells at their placeholder heights, which is fiction
 *     in the mirror all the same.)
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
  /**
   * Whether that application involved a LAYERED COLUMN at all — either it
   * left one standing, or it changed a cell the authoritative base holds a
   * span list for.
   *
   * RECORDED AT APPLY TIME, and that is the whole point: `isConfirmed` runs
   * after `restoreToBase` has already rolled this prediction off, so by then
   * a split this prediction CREATED is gone from the live table and the
   * question is unanswerable. Asking while the prediction's own effect is
   * still standing is the only moment the answer exists.
   */
  touchedLayeredColumn: boolean;
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
   * `applyAuthoritative` for the ONE authoritative message that writes cells
   * rather than whole chunks — the server's terrain diff, the hot path.
   *
   * ITS OWN METHOD, not a `mutate` closure the caller writes, because the
   * saving depends on the mirror's writer reporting the cells it touches
   * (`CellWriteSink`) and a closure is exactly the place that reporting gets
   * forgotten. A forgotten sink is silent: the reconciliation stays correct
   * and simply re-patches every chunk the diff mentions, at ~25 ms a sculpt on
   * a developed world. So the wiring is not offered as an option — the diff
   * path is this method, and `applyAuthoritative` is the chunk-level path
   * (snapshot, chunk unlock, dev fixtures) whose indices pass through
   * unfiltered by design.
   */
  applyCellDiff(msg: TerrainDiffMessage, nowMs: number): Set<number>;

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

/**
 * The one empty span snapshot, shared by every base that holds no layered
 * column. Never written to — snapshots are only ever READ (`restoreBaseSpans`
 * copies out of them, `isConfirmed` probes them) and the live table is
 * mutated in place instead — so sharing it is what makes the un-carved world's
 * reconciliation allocate nothing.
 */
const EMPTY_SPAN_SNAPSHOT: ReadonlyMap<number, Int16Array> = new Map();

export function createPredictionStore(mirror: TerrainMirror): PredictionStore {
  const size = mirror.map.size;
  const rendered = mirror.map.cells;
  /**
   * The authoritative copy. Allocated once, alongside the mirror it shadows —
   * 512 KB at a 512² world, the same trivial cost the mirror itself accepts
   * (design §3.4), and it means reconciliation never allocates.
   */
  const base = new Int16Array(rendered);

  /**
   * The base's SPAN side table, snapshotted alongside the height copy above
   * and restored with it. Heights alone are not the whole authoritative
   * state any more: a predicted carve can split a column into two spans, and
   * a rollback that reset only `cells` would leave that split standing on
   * top of authoritative heights after reconciliation — the mirror holding
   * one player's predicted cave over the server's re-merged world, which is
   * exactly the divergence this module exists to prevent.
   *
   * Values are COPIED Int16Arrays, never aliased ones: a replay (or the
   * shared sculpt math itself) writes through `map.columnSpans`' backing
   * stores via `setColumn`, and an alias would let the next prediction
   * mutate the saved base out from under us.
   */
  let baseSpans = EMPTY_SPAN_SNAPSHOT;

  /**
   * Copies the live span table as the new base. FREE while nobody has
   * carved: `columnSpans.size === 0` is the overwhelmingly common case (the
   * table holds only columns with more than one span), so it returns the
   * shared empty map and allocates nothing at all — this runs once per
   * authoritative message, and the module's per-reconciliation cost must not
   * grow for every player who never touches the carve tool.
   */
  const snapshotBaseSpans = (): void => {
    const live = mirror.map.columnSpans;
    if (live.size === 0) {
      baseSpans = EMPTY_SPAN_SNAPSHOT;
      return;
    }
    const snapshot = new Map<number, Int16Array>();
    for (const [i, packed] of live) snapshot.set(i, new Int16Array(packed));
    baseSpans = snapshot;
  };

  /**
   * Puts the live span table back to the base's, copying values for the same
   * aliasing reason as above. The both-empty check first keeps the common
   * world free: no clear, no iteration, nothing written.
   */
  const restoreBaseSpans = (): void => {
    const live = mirror.map.columnSpans;
    if (live.size === 0 && baseSpans.size === 0) return;
    live.clear();
    for (const [i, packed] of baseSpans) live.set(i, new Int16Array(packed));
  };

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

  // ── Net-of-call change tracking ─────────────────────────────────────────
  //
  // WHY NET, AND WHY NOT PER WRITE. A reconciliation is three steps — roll the
  // predictions off, apply the authoritative message, replay the survivors —
  // and a correctly predicted sculpt writes each of its cells TWICE inside
  // that: once back to base, once with the server's identical value. Every
  // per-write test calls both writes a change, so the echo of an edit the
  // client already drew re-patched every chunk it mentioned: 26 ms of contour
  // marching, eight times a second, to redraw exactly what was on screen.
  // Comparing the cell's value at the START of the call with its value at the
  // END is the only test that can answer "did the screen change".
  //
  // WHAT IS COMPARED: height OR SPAN LIST. A carve arrives as a diff entry
  // whose `h` is unchanged and whose `spans` are not (mirror.ts's
  // applyTerrainDiff), and the mesh reads spans as well as heights
  // (sampleRenderBandSolid; capEmission's buried-floor band). A heights-only
  // compare would leave a freshly cut cave mouth undrawn.
  //
  // WHICH CELLS ARE COMPARED — a bounded candidate set, never the map:
  //   * every pending prediction's journal cell, noted AT ENTRY. `rendered`
  //     differs from `base` at exactly these cells, so noting them is what
  //     makes the "before" of every other cell readable from `base`.
  //   * every cell an authoritative writer is about to write (its
  //     `CellWriteSink` report), noted BEFORE the write, because `base` is
  //     overwritten with the post-mutation state further down the call and
  //     the outgoing value would be gone.
  //   * every journal cell of the predictions as REPLAYED, which is not a
  //     subset of the entry journals: the same intent over a moved base can
  //     change a different cell. These need no note — an unnoted cell was
  //     written by neither of the two cases above, so its start-of-call value
  //     IS its `base` value, which still stands.
  //
  // The scratch is reused across calls: this runs on every authoritative
  // message and must not allocate per sculpt.
  const noteSlotOf = new Map<number, number>();
  const noteHeight: number[] = [];
  const noteSpans: (Int16Array | undefined)[] = [];
  const candidates = new Set<number>();

  /** Records a cell's start-of-call rendered state, once, and candidates it. */
  const noteCell: CellWriteSink = (i: number): void => {
    candidates.add(i);
    if (noteSlotOf.has(i)) return;
    noteSlotOf.set(i, noteHeight.length);
    noteHeight.push(rendered[i]);
    // COPIED, not aliased, for the same reason `snapshotBaseSpans` copies: the
    // shared math writes through the live table's backing stores. Free while
    // nobody has carved, which is the overwhelmingly common world.
    const live = mirror.map.columnSpans;
    const packed = live.size === 0 ? undefined : live.get(i);
    noteSpans.push(packed === undefined ? undefined : new Int16Array(packed));
  };

  /** Opens a change pass. Must run BEFORE the call mutates anything. */
  const beginChangePass = (): void => {
    noteSlotOf.clear();
    noteHeight.length = 0;
    noteSpans.length = 0;
    candidates.clear();
    for (const p of pending) for (const i of p.indices) noteCell(i);
  };

  const spansEqual = (
    a: Int16Array | undefined,
    b: Int16Array | undefined,
  ): boolean => {
    if (a === undefined || b === undefined) return a === b;
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
    return true;
  };

  /**
   * Closes the pass: every candidate whose rendered state moved marks the
   * chunks that READ it — through `chunksDirtiedByCell`, never by the cell's
   * own chunk, because a chunk's border wall reads the first row/column of the
   * next chunk and missing that is precisely how seam cracks appear.
   */
  const collectChanged = (dirty: Set<number>): void => {
    const live = mirror.map.columnSpans;
    for (const i of candidates) {
      const slot = noteSlotOf.get(i);
      const beforeHeight = slot === undefined ? base[i] : noteHeight[slot];
      let changed = beforeHeight !== rendered[i];
      if (!changed) {
        const beforeSpans = slot === undefined ? baseSpans.get(i) : noteSpans[slot];
        changed = !spansEqual(beforeSpans, live.get(i));
      }
      if (!changed) continue;
      for (const idx of chunksDirtiedByCell(mirror, cellX(size, i), cellY(size, i))) {
        dirty.add(idx);
      }
    }
  };

  /**
   * Applies one prediction to the rendered map and (re)records its journal.
   * The journal is rewritten on every replay because the result depends on the
   * state underneath: the same intent over a changed base changes other cells.
   */
  const applyPrediction = (p: PendingPrediction): void => {
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
    // Asked here, while this prediction's effect is still on the mirror: the
    // live table therefore holds any split it just made, and `baseSpans` holds
    // any split it just removed. Both make the prediction unconfirmable by
    // height (see isConfirmed). Two size checks cover an un-carved world, so
    // the ordinary player pays nothing.
    const live = mirror.map.columnSpans;
    const anyLayered = live.size !== 0 || baseSpans.size !== 0;
    p.touchedLayeredColumn = false;
    for (const cell of diff) {
      const i = cellIndex(mirror.map, cell.x, cell.y);
      p.indices.push(i);
      p.after.push(cell.h);
      if (anyLayered && (live.has(i) || baseSpans.has(i))) p.touchedLayeredColumn = true;
      // A CANDIDATE, not a dirty chunk: whether this cell's rendered state
      // actually moved across the whole call is `collectChanged`'s question.
      candidates.add(i);
    }
  };

  /** Rolls every prediction off: the rendered map becomes pure authoritative. */
  const restoreToBase = (): void => {
    if (pending.length === 0) return;
    // Safe to skip the span table too when nothing is pending: every path
    // that empties `pending` passes through here FIRST, so a zero-pending
    // store always has the base's span table standing already. (The one
    // writer that bypasses it, the dropped no-op prediction in `predict`,
    // changed no cells and so created no split.)
    rendered.set(base);
    restoreBaseSpans();
  };

  const replayPending = (): void => {
    for (const p of pending) applyPrediction(p);
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
   *
   * Nor is a prediction that TOUCHED A LAYERED COLUMN confirmed by heights,
   * even matching ones: two different span lists can share a topmost ceiling
   * (a column whose roof got a window cut under it stands at the same
   * `cells[i]`), so value agreement there would retire a prediction whose
   * SPAN structure the server never applied — a hole the client drew shut.
   * "Touched" is a flag the prediction RECORDED WHEN IT WAS APPLIED, not a
   * probe of the tables now: by the time this runs the prediction has been
   * rolled off, so a split it created is already gone and probing here would
   * confirm exactly the case it is meant to refuse. See
   * `PendingPrediction.touchedLayeredColumn`. Such a prediction still
   * reconciles through its ack (`resolveSeq`, the primary path since issue
   * #21) or falls to the deadline; this fallback simply refuses to guess.
   */
  const isConfirmed = (p: PendingPrediction): boolean => {
    if (p.touchedLayeredColumn) return false;
    let comparable = 0;
    for (let k = 0; k < p.indices.length; k++) {
      const i = p.indices[k];
      if (!hasChunk(mirror, chunkOfCellIndex(i))) continue;
      if (base[i] !== p.after[k]) return false;
      comparable++;
    }
    return comparable > 0;
  };

  /**
   * The reconciliation both authoritative entry points share: predictions off,
   * mutation, new base, retire, replay, compare.
   *
   * The mutation's OWN returned indices pass through UNFILTERED and are unioned
   * with the compare's answer. That is not laziness — `applyChunkPayload`'s
   * indices (the chunk plus its −x/−y/−xy back-neighbours) are dirty because a
   * chunk crossed into `received`, and that changes what `renderSampleCell`
   * resolves the neighbours' border samples to even when not one cell value
   * moved. There is no cell compare that could see it.
   */
  const reconcile = (
    mutate: (m: TerrainMirror) => Set<number>,
    nowMs: number,
  ): Set<number> => {
    const dirty = new Set<number>();

    beginChangePass();
    // 1. Predictions off, so the mutation sees only authoritative state...
    restoreToBase();
    // 2. ...apply it (the mirror's own validated writers do this)...
    for (const idx of mutate(mirror)) dirty.add(idx);
    // 3. ...and record the result as the new authoritative truth. A whole-map
    //    copy (512 KB at 512², ~tens of microseconds) rather than replaying
    //    the mutation's cells into `base` separately: the mutation's return
    //    value is chunk indices, not cells, so re-deriving the cell set here
    //    would mean duplicating the mirror's writers — the exact drift the
    //    single-source-of-truth rule exists to prevent. At the design's
    //    budget of a diff per tick this is far below the frame budget.
    //    The span side table is snapshotted with it, so the base stays the
    //    COMPLETE column state (see `snapshotBaseSpans`) — free until
    //    someone has actually carved a layer.
    base.set(rendered);
    snapshotBaseSpans();

    // 4. Retire what the server has now confirmed or what has run out of
    //    time, then put the survivors back on top. Retiring is not restricted
    //    to a prefix: an old prediction that diverged must not pin newer,
    //    confirmed ones in place — that would double every edit behind it.
    pending = pending.filter(
      (p) => !isConfirmed(p) && nowMs - p.createdAtMs < PREDICTION_TTL_MS,
    );
    replayPending();

    // 5. And only now, with the rendered map final, ask what actually moved.
    collectChanged(dirty);
    return dirty;
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

      // Opened after the refusals above, which mutate nothing, and before
      // anything below, which all do.
      beginChangePass();

      if (pending.length >= MAX_PENDING_PREDICTIONS) {
        // Drop the oldest and re-derive, so the rendered map is exactly
        // base + the predictions we are still willing to show.
        restoreToBase();
        pending.shift();
        replayPending();
      }

      const prediction: PendingPrediction = {
        intent: validated,
        createdAtMs: nowMs,
        indices: [],
        after: [],
        // Overwritten by the applyPrediction below, which is the only thing
        // that can answer it; false until then, matching the empty journal.
        touchedLayeredColumn: false,
      };
      pending.push(prediction);
      applyPrediction(prediction);

      // An edit that changed nothing (fully clamped at MAX_HEIGHT, say) has
      // nothing to reconcile and could never be confirmed — do not keep it.
      if (prediction.indices.length === 0) pending.pop();

      collectChanged(dirty);
      return dirty;
    },

    applyAuthoritative(
      mutate: (m: TerrainMirror) => Set<number>,
      nowMs: number,
    ): Set<number> {
      return reconcile(mutate, nowMs);
    },

    applyCellDiff(msg: TerrainDiffMessage, nowMs: number): Set<number> {
      // The sink is wired HERE, once, rather than by every caller — see the
      // interface note. `applyTerrainDiff` returns an empty set when it is
      // given one, so the whole dirty answer comes from the net compare.
      return reconcile((m) => applyTerrainDiff(m, msg, noteCell), nowMs);
    },

    resolveSeq(seq: number): Set<number> {
      const dirty = new Set<number>();
      const index = pending.findIndex((p) => p.intent.seq === seq);
      if (index === -1) return dirty;

      beginChangePass();
      restoreToBase();
      pending.splice(index, 1);
      replayPending();
      collectChanged(dirty);
      return dirty;
    },

    expire(nowMs: number): Set<number> {
      const dirty = new Set<number>();
      const survivors = pending.filter((p) => nowMs - p.createdAtMs < PREDICTION_TTL_MS);
      if (survivors.length === pending.length) return dirty;

      beginChangePass();
      restoreToBase();
      pending = survivors;
      replayPending();
      collectChanged(dirty);
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
