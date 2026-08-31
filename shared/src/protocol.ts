// Protocol: message types and intent validation.
//
// CRITICAL CODE — validateSculptIntent is the server's first line of defense
// against hostile clients (design §3.2: clients send intents, never heights).
// Every field of an inbound intent is checked for type, integrality, and
// range before any of it touches the world. Plugins add further verdicts
// (mana, cooldowns) AFTER this structural validation passes.

import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from './constants.ts';
import {
  MAX_BAND,
  MIN_BAND,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  TOOLS_WITHOUT_EDGE_PROFILE,
} from './heightmap.ts';
import type {
  CellDiff,
  ResolvedSculptOptions,
  SculptProfile,
  SculptTool,
} from './heightmap.ts';

/**
 * Client → server: "sculpt at (x,y)". Direction only — the sculpt AMOUNT is
 * server configuration (DEFAULT_SCULPT_AMOUNT, modifiable by plugins), never
 * client input, so a hacked client cannot sculpt harder than anyone else.
 *
 * `tool` and `profile` ARE client input: they choose the shape of the edit, not
 * its power. Every combination costs the same and reaches the same cells at the
 * centre, so there is nothing here for a hacked client to gain — a stamp is not
 * a stronger sculpt, it is a differently-shaped one.
 */
export interface SculptIntent {
  type: 'sculpt';
  x: number;
  y: number;
  radius: number;
  /** +1 raise, -1 lower. */
  dir: 1 | -1;
  /**
   * Brush tool: 'stamp' (footprint only) or 'smooth' (footprint + gradient
   * relaxation). Optional — absent means WIRE_DEFAULT_SCULPT_OPTIONS.tool.
   */
  tool?: SculptTool;
  /**
   * Edge profile: 'soft' (linear falloff) or 'hard' (flat across the
   * footprint). Optional — absent means WIRE_DEFAULT_SCULPT_OPTIONS.profile.
   */
  profile?: SculptProfile;
  /**
   * THE DRAG (2026-08-23): the terrace band whose lip the player grabbed. Its
   * presence is what makes this intent a drag rather than a stamp — the stroke
   * fills toward `targetBand · BAND_HEIGHT` instead of one band off the cell
   * under the cursor (shared/heightmap.ts, `SculptAnchor: 'band'`).
   *
   * THE ONE PIECE OF LEVEL INFORMATION A CLIENT MAY SEND, and it is not a
   * height: it names a band the player physically clicked on, which is a fact
   * about their aim that the server cannot recover from the ray alone. It does
   * not weaken "intents, never heights", because the server never acts on the
   * number by itself — `canSpreadBandTo` re-derives from the SERVER's
   * heightmap whether that band is genuinely adjacent to (x, y), and a band
   * that is not makes the whole stroke a no-op. So the worst a hostile client
   * can do with this field is waste its own intent.
   *
   * Optional: absent means a stamp, exactly as before this field existed.
   */
  targetBand?: number;
  /**
   * THE GRASP (2026-08-25, issue #129 step 4.3): the terrace band at which
   * this stroke has hold of the column — which SPAN of a layered cell the
   * player is working on, named by a band rather than by an index.
   *
   * The server resolves band → span from ITS OWN heightmap, through
   * `spanIndexCoveringBand`, and a band that no span covers makes the whole
   * stroke a no-op. So this is safe for exactly the reason `targetBand` above
   * is: the number names a place in the world the player aimed at, never a
   * position in server state.
   *
   * NOT INTERCHANGEABLE WITH `targetBand`: `spanBand` is where the hand is,
   * `targetBand` is where the material goes.
   *
   * A DRAG DOES NOT CARRY THIS ONE, and that is settled rather than pending
   * (owner, 2026-08-27, issue #224 — DESIGN.md, "Why no new field on the
   * wire"). This doc used to say "a drag carries both", and acting on that
   * sentence would break the tool: a pull's `x`/`y` is the CURSOR cell, not the
   * cell whose lip is in the player's hand, so a `spanBand` derived at the
   * sender names a span of the wrong column — and applySculpt's whole-stroke
   * grasp guard then no-ops legitimate pulls over layered ground. The grasp
   * travels as `targetBand` plus the per-cell rule inside `applyDragRegion`
   * (`bandFillAt`): one column covers a band with at most one span, so the band
   * plus the receiver's own map names the grasped span exactly, and a
   * `spanBand` beside it would be the same number twice. The tools that DO
   * carry it are the ones whose x/y IS the cell they act on — the carve, and
   * the brushes over layered ground.
   *
   * Optional: ABSENT MEANS THE TOPMOST SPAN, which is what every intent in
   * existence means today and what every plugin `WorldApi.sculpt` call means.
   *
   * *Rejected: send `TerrainRayPick.spanIndex` itself.* It is a position in a
   * list whose length is server state — one carve by another player between
   * the pick and the apply shifts every index above it, so the same message
   * would mean a different span on each replica, and every index in range is
   * structurally valid so no validator catches it.
   */
  spanBand?: number;
  /**
   * Client-chosen correlation id, echoed back on the server's ANSWER to this
   * intent — SculptAppliedMessage when it was applied, SculptDeniedMessage
   * when a plugin denied it — so the sender can retire the exact client-side
   * prediction that answer refers to.
   *
   * Optional: an intent without one is still valid — it simply cannot be
   * answered by seq, and its prediction falls back to the value/deadline
   * reconciliation in the client's prediction store. That fallback is a
   * heuristic that provably fails at a territory frontier (issue #21), so a
   * client that wants its own edits reconciled exactly must send a seq.
   */
  seq?: number;
}

/**
 * What a PLAYER intent means when it names no tool/profile (decision
 * 2026-08-14, owner-settled).
 *
 * WHY THIS DIFFERS FROM THE LIBRARY DEFAULT. `applySculpt` called with no
 * options runs smooth+soft — it must, or every plugin terraform written before
 * this change would silently re-tune itself (see LIBRARY_DEFAULT_SCULPT_OPTIONS
 * in heightmap.ts). The wire is the opposite problem: it carries what a PLAYER
 * asked for, and the owner's new player-facing feel is the stamp — an edit that
 * changes exactly its footprint. A client too old to send `tool` therefore gets
 * the new default brush, and plugins keep the old one. The two defaults are
 * different on purpose and each is stated exactly once.
 */
export const WIRE_DEFAULT_SCULPT_OPTIONS: ResolvedSculptOptions = {
  tool: 'stamp',
  profile: 'soft',
  // Player sculpts are always band-contained (owner decision 2026-08-19,
  // issue #26): the smooth tool's spill may slope terrain outside the brush
  // but never create or erase a rendered level there. Not a wire field — the
  // intent cannot name it (see sculptOptionsOf below), because containment is
  // a fairness rule, not a brush shape, so it is not the client's to choose.
  spill: 'banded',
  // A stamp by default: no band grabbed, so nothing to drag toward. An intent
  // that carries one flips the anchor to 'band' in sculptOptionsOf below.
  targetBand: null,
  // No span named, which means the topmost one — the only span an unlayered
  // world has, and the surface every tool has always moved.
  spanBand: null,
  // Player sculpts are always locked to the clicked cell's level (owner
  // decision 2026-08-19: the brush periphery must never climb past the level
  // the player pointed at). Not a wire field, same argument as `spill`.
  anchor: 'clicked',
};

/**
 * THE PROFILE A TOOL WITHOUT AN EDGE RUNS AT (owner decision 2026-08-27,
 * issue #225).
 *
 * `hard` because it is the flat one: it spreads the stroke evenly over the
 * region rather than tapering it, which is what both edgeless tools already
 * do by construction (TOOLS_WITHOUT_EDGE_PROFILE in heightmap.ts says why
 * neither can have a cone). Resolving them to it rather than to whatever the
 * intent happened to carry is what keeps the price these options are billed
 * at (plugins/mana/pricing.ts reads options.profile) describing the stroke
 * that actually runs.
 *
 * Named rather than written inline at the resolver so the decision has one
 * statement, and so it cannot be changed without changing the sentence above.
 */
export const EDGELESS_SCULPT_PROFILE: SculptProfile = 'hard';

/**
 * THE NORMALISATION CONTRACT. Turns an intent's optional tool/profile into the
 * concrete options `applySculpt` runs.
 *
 * This is the ONLY place absent-means-what is decided for an intent, and both
 * sides of the prediction contract call it: the server's intent pipeline
 * (server/src/intent/pipeline.ts, step 5) and the client's prediction store
 * (client/src/terrain/prediction.ts). If either one defaulted for itself the
 * two could drift, and a drift here is not a subtle bug — it is the client
 * predicting a spire where the server builds a mound, on every stroke.
 */
export function sculptOptionsOf(intent: SculptIntent): ResolvedSculptOptions {
  const tool = intent.tool ?? WIRE_DEFAULT_SCULPT_OPTIONS.tool;
  // THE BAND IS THE DRAG'S FIELD AND NO OTHER TOOL'S, resolved once, here, so
  // that both of the things a band decides below are decided from a band the
  // TOOL was allowed to name. `validateSculptIntent` already rejects a band
  // carried by anything but a drag, so on the wire path this changes nothing;
  // this is the same rule stated at the point the value becomes options,
  // because the resolver is also reached from intents no validator ever saw —
  // the client's prediction store and its brush preview build their own.
  //
  // BOTH derived fields matter, not just the anchor. The anchor is what buys
  // the whole-way amount in applySculpt (FULL_HEIGHT_SPAN), and a non-drag
  // tool wearing it lifts its whole disc to a height the MESSAGE named; but a
  // band left in place under any OTHER anchor is read by anchoredTargetHeight
  // as the stroke's level outright, ahead of the clicked cell's own band and
  // without even the centre-cell spread check the 'band' anchor gets. Deriving
  // both from one tool-gated value is what makes "clients send intents, never
  // heights" hold here by construction rather than by two guards agreeing.
  //
  // DROPPED rather than rejected, unlike the validator's call on the same
  // combination: a resolver's return type has no way to say no, and every
  // intent that reaches it on the server has already passed that rejection.
  const targetBand =
    tool === 'drag' ? (intent.targetBand ?? null) : WIRE_DEFAULT_SCULPT_OPTIONS.targetBand;
  return {
    tool,
    // AN EDGELESS TOOL'S PROFILE IS DECIDED HERE (issue #225), not honoured
    // and then ignored downstream: the drag would otherwise pull a ragged rim
    // and leave partial-band shelves under the lip it extended, contradicting
    // its own contract. Doing it in this resolver is what makes the server's
    // pipeline and the client's prediction — its only two callers — run the
    // same stroke by construction, and what keeps the mana price computed
    // from these options describing that stroke. An old or hostile client may
    // still send `profile: 'soft'` on a drag or carve; it is normalised away
    // rather than rejected, because the field does not describe those tools
    // at all, so there is nothing there to cheat with.
    profile: TOOLS_WITHOUT_EDGE_PROFILE.includes(tool)
      ? EDGELESS_SCULPT_PROFILE
      : (intent.profile ?? WIRE_DEFAULT_SCULPT_OPTIONS.profile),
    // Deliberately NOT read from the intent: spill containment is fixed
    // policy for player sculpts (issue #26), and so is the clicked-cell
    // anchor (2026-08-19). Both the server pipeline and client prediction
    // resolve through these lines, so both sides run banded+anchored by
    // construction — the same lockstep argument as the doc above.
    spill: WIRE_DEFAULT_SCULPT_OPTIONS.spill,
    // THE ONE ANCHOR THE INTENT DOES DECIDE, and only by carrying a band at
    // all: a drag is a different operation from a stamp, not a differently
    // configured one, so there is no way to ask for the drag anchor without
    // naming the band it drags toward, and no way to name a band without
    // getting the drag anchor. The two cannot be desynchronised.
    anchor: targetBand !== null ? 'band' : WIRE_DEFAULT_SCULPT_OPTIONS.anchor,
    targetBand,
    // The grasp travels through the same single normalisation both replicas
    // run, for the same lockstep reason everything else here does. Absent is
    // null, and null is resolved to the topmost span by the terrain math —
    // never here, which has no map to resolve against.
    spanBand: intent.spanBand ?? null,
  };
}

/**
 * Server → the ORIGINATING client only: a structurally valid intent was denied
 * by a plugin interceptor (mana, cooldowns…), identified by the seq the client
 * put on it.
 *
 * ANTI-CHEAT BOUNDARY — this message exists for plugin denials and for nothing
 * else. Mask rejections (brush centre in a locked chunk) remain answered with
 * silence: they stay indistinguishable from a dropped packet. A client can
 * already tell which chunks it was never sent, so a plugin-denial nack reveals
 * nothing it does not know; a mask nack would additionally confirm the mask's
 * exact behaviour at the boundary, so it is never sent.
 */
export interface SculptDeniedMessage {
  type: 'sculptDenied';
  /** The denied intent's seq, verbatim. */
  seq: number;
}

/**
 * Server → the ORIGINATING client only: the intent carrying this seq WAS
 * applied authoritatively, and every message describing what it did has
 * already been sent on this connection.
 *
 * THE ACKNOWLEDGEMENT CONTRACT (issue #21). This is the other half of
 * SculptDeniedMessage: an intent with a seq gets exactly one answer — applied
 * or denied — and the sender retires the prediction it made for that intent on
 * the answer, instead of GUESSING from the heights in the broadcast diff.
 *
 * Guessing was the bug. A client cannot reproduce the server's result for any
 * edit whose shared math reads terrain the client was never sent (the brush
 * footprint or the gradient relaxation crossing its territory frontier), so
 * its prediction never matched, was never recognised as acknowledged, and was
 * replayed on top of the server's own copy of the same edit until the
 * reconciliation deadline — visibly dragging just-sculpted ground away and
 * then snapping it back a second later.
 *
 * ORDERING, and why it is load-bearing: this message MUST be sent AFTER the
 * terrainDiff carrying the edit and after any chunkUnlock the edit earned, on
 * the same connection. Retiring a prediction before its authoritative
 * replacement has landed would show the pre-sculpt ground for one frame. The
 * server side of that contract is stated and enforced in
 * server/src/intent/pipeline.ts.
 *
 * ANTI-CHEAT NOTE: an ack tells the sender only that its OWN intent landed.
 * Absence of an ack is not a new oracle for the unlock mask — the mask
 * rejection it would have to be distinguished from is already directly
 * observable, because the terrainDiff broadcast filter is union-mask-based
 * (see World.isCellUnlocked, and the fog-of-war follow-up flagged with issue
 * #17): a client that sculpts into a union-unlocked chunk already receives the
 * resulting heights whether or not that chunk is unlocked for it personally.
 */
export interface SculptAppliedMessage {
  type: 'sculptApplied';
  /** The applied intent's seq, verbatim. */
  seq: number;
}

/** Server → clients: cells changed by an applied edit (or plugin terrain op). */
export interface TerrainDiffMessage {
  type: 'terrainDiff';
  cells: CellDiff[];
}

/**
 * Every layered column in one chunk, as a sparse side-channel mirroring
 * `Heightmap.columnSpans` exactly.
 *
 * `at` holds IN-CHUNK cell offsets (the same row-major index `heights` uses),
 * ASCENDING. `runs` holds, for each entry of `at` in the same order,
 * `[spanCount, floor0, ceiling0, floor1, ceiling1, ...]` — the count first so
 * a reader can walk the list without a second length array.
 *
 * A chunk with no layered column omits the field entirely, so the 99.9% case
 * pays ZERO BYTES on the wire, which is the same bargain the in-memory side
 * table strikes. A layered column costs `1 + 2 · spanCount` numbers.
 */
export interface ChunkLayeredSpans {
  at: number[];
  runs: number[];
}

/**
 * One chunk's terrain on the wire (see extractChunkPayload for the shape).
 *
 * `heights` is unchanged: CHUNK_SIZE² topmost ceilings, row-major, and its
 * fixed length is still the structural check that catches a truncated payload.
 *
 * ABSENT MEANS ONE SPAN. A cell not named by `layered.at` is the one-span
 * column `[BEDROCK_FLOOR, h)`, so applying a payload must clear any span list
 * the receiver still holds for the chunk — which `writeChunkHeights` has
 * always done via `resetColumns`, and which is why the spans are applied
 * AFTER the heights rather than beside them.
 */
export interface ChunkPayload {
  cx: number;
  cy: number;
  heights: number[];
  layered?: ChunkLayeredSpans;
}

/** Server → clients: newly unlocked chunks streaming in. */
export interface ChunkUnlockMessage {
  type: 'chunkUnlock';
  chunks: ChunkPayload[];
}

/**
 * Server → one joining client: world geometry plus ONLY the unlocked chunks
 * (anti-cheat by omission — locked terrain is never on the wire).
 *
 * `worldName` and `difficulty` are WORLD IDENTITY, not gameplay: the name is
 * what this world is called (generated once at genesis and persisted with it),
 * and the difficulty is the neutral 1–100 dial core already publishes to
 * plugins as WorldApi.difficulty. Core attaches no mechanic to either — it
 * only tells a joining client which world it is looking at — so carrying them
 * here does not put anything "gamey" in core (design §3.5).
 *
 * Both are OPTIONAL and additive, exactly like SculptIntent's `seq`: a
 * snapshot from a server built before this change is still a valid message,
 * and a client that receives neither simply has nothing to title the world
 * with. Absent means unknown, never a default — a client must not invent a
 * difficulty the server did not state.
 */
export interface JoinSnapshotMessage {
  type: 'snapshot';
  worldSize: number;
  chunks: ChunkPayload[];
  /** This world's name; absent from a pre-2026-08-14 server. */
  worldName?: string;
  /** This world's difficulty rating, 1 (warm) to 100 (punishing). */
  difficulty?: number;
  /**
   * Build identity of the server that sent this snapshot — `<commit
   * count>.<short hash>` derived from git at boot (server/src/version.ts), or
   * an operator's TERRACE_VERSION. DIAGNOSTIC, not gameplay: the client only
   * displays it and compares it against its own bundle stamp
   * (ui/VersionWatermark.tsx) to expose a skewed dev stack — a client and
   * server running different shared/ math preview one stroke and apply
   * another (owner-hit, 2026-08-19). Optional and additive like `worldName`:
   * absent means "server too old to say", never a default.
   */
  serverVersion?: string;
  /**
   * WHICH BUILD THIS CLIENT IS PLAYING AGAINST — a digest over core's stamp,
   * every plugin's stamp, and the served client bundle's asset manifest
   * (server build-identity.ts).
   *
   * WHAT IT IS FOR, and why `serverVersion` cannot do it: a client compares
   * this against the one it joined under and reloads the page ONCE if it
   * differs, which is how a new client bundle actually reaches a browser after
   * an operator restart. `serverVersion` is a git-HEAD stamp, so it is
   * byte-identical across a restart that picked up an uncommitted edit and is
   * the constant `'unversioned'` wherever there is no `.git` — it would fail to
   * fire in both cases the reload exists for.
   *
   * IT MUST NOT CHANGE WHEN NOTHING CHANGED. A restart that picked up no edit
   * carries the same identity, and the client leaves the page alone; a world
   * switch and a rollback re-send this message unchanged for the same reason.
   *
   * Optional and additive like `worldName`: absent means "server too old to
   * say", which a client treats as "leave the page alone" — never as an
   * identity that could differ from the next one.
   */
  buildIdentity?: string;
  /**
   * The plugins this world is actually RUNNING, by name, in the server's load
   * order — the enabled subset of what the server has installed (per-world
   * plugin enablement, 2026-08-25). Core states a fact about its own
   * configuration here; it attaches no mechanic to the names and does not know
   * what any of them do, so this stays as un-gamey as `difficulty` (design
   * §3.5).
   *
   * It rides the snapshot because a toggle REOPENS the live world, and a
   * reopen already re-sends this message to every connected player — so the
   * announcement and the world it describes can never disagree.
   *
   * Optional and additive like `worldName`: absent means "server too old to
   * say", and a client that receives nothing must leave whatever it has
   * running alone rather than reading absence as "no plugins are live".
   */
  livePlugins?: readonly string[];
}

/**
 * Everything a client may send. One message type today: the sculpt intent —
 * position, radius, direction, and (since 2026-08-14) the optional brush tool
 * and edge profile. Fields are added to it ADDITIVELY and optionally, so an
 * older client stays valid; `sculptOptionsOf` states what an omitted field
 * means, once, for every reader.
 */
export type ClientMessage =
  | SculptIntent
  // Operator traffic, not gameplay: the two rollback requests carry a shared
  // secret and are answered to their sender alone (see the WORLD ROLLBACK
  // section at the foot of this file).
  | RestorePointsRequestMessage
  | RollbackRequestMessage;
export type ServerMessage =
  | TerrainDiffMessage
  | ChunkUnlockMessage
  | JoinSnapshotMessage
  | SculptAppliedMessage
  | SculptDeniedMessage
  | RestorePointListMessage
  | RollbackResultMessage;

/**
 * Validates an untrusted inbound sculpt intent. Returns the typed intent, or
 * null if anything is malformed — the caller drops the message (no error
 * reply in v1; a well-behaved client never sends an invalid intent).
 *
 * Deliberately structural only: unlock-mask checks and plugin verdicts
 * (mana, cooldowns) are server pipeline stages, not protocol concerns.
 */
export function validateSculptIntent(
  msg: unknown,
  worldSize: number,
): SculptIntent | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'sculpt') return null;

  const { x, y, radius, dir } = m;
  // Integrality matters: float coordinates would index cells inconsistently
  // between validation and application.
  if (!Number.isInteger(x) || (x as number) < 0 || (x as number) >= worldSize) return null;
  if (!Number.isInteger(y) || (y as number) < 0 || (y as number) >= worldSize) return null;
  if (
    !Number.isInteger(radius) ||
    (radius as number) < MIN_BRUSH_RADIUS ||
    (radius as number) > MAX_BRUSH_RADIUS
  ) {
    return null;
  }
  if (dir !== 1 && dir !== -1) return null;

  // seq is optional and only ever echoed back to its sender, so the only
  // structural demand is that a PRESENT seq is a safe integer — anything else
  // (floats, NaN, objects) is rejected with the whole intent rather than let a
  // hostile value ride along into a server-originated message.
  const { seq } = m;
  if (seq !== undefined && !Number.isSafeInteger(seq)) return null;

  // tool/profile are optional (an older client sends neither) but closed sets:
  // a PRESENT value must be one the terrain math actually implements. Anything
  // else — a typo, a probe, a future value this build has never heard of — is
  // rejected WITH THE WHOLE INTENT rather than silently defaulted, because
  // silently defaulting would apply a differently-shaped edit than the sender
  // predicted and desync its prediction for a full round trip. The valid sets
  // come from heightmap.ts, so adding a tool cannot leave the validator behind.
  const { tool, profile } = m;
  if (tool !== undefined && !SCULPT_TOOLS.includes(tool as SculptTool)) return null;
  // A CARVE ONLY EVER LOWERS (plan D6). The tool removes material and has no
  // meaning in the other direction — "add material to the underside of a roof"
  // is not a gesture this game has — so `dir: 1` beside it is not a legal
  // intent that happens to do nothing. REJECTED WITH THE WHOLE INTENT rather
  // than flipped to -1, which is the same call this validator already makes
  // for an unknown tool: silently reinterpreting an intent applies a
  // differently-shaped edit than its sender predicted and desyncs that
  // prediction for a full round trip. A client whose HUD offers Carve simply
  // does not emit the raise chord for it (client/src/input/sculptInput.ts).
  if (tool === 'carve' && dir === 1) return null;
  if (profile !== undefined && !SCULPT_PROFILES.includes(profile as SculptProfile)) {
    return null;
  }

  // targetBand is optional (a stamp sends none) but, when present, must be a
  // band this world could actually hold. This is the STRUCTURAL check only —
  // it says the number is a band, not that the player may drag it. Whether the
  // band is genuinely adjacent to (x, y) is terrain, so it is re-derived from
  // the server's own heightmap inside the shared math (canSpreadBandTo), which
  // is the same code the client predicted with. Rejected WITH THE WHOLE INTENT
  // rather than dropped, for the same reason a bad tool is: silently turning a
  // drag into a stamp would apply a different edit than the sender predicted.
  const { targetBand } = m;
  if (
    targetBand !== undefined &&
    (!Number.isInteger(targetBand) ||
      (targetBand as number) < MIN_BAND ||
      (targetBand as number) > MAX_BAND)
  ) {
    return null;
  }

  // AND ONLY A DRAG MAY CARRY ONE. sculptOptionsOf mints `anchor: 'band'` for
  // ANY intent that carries a band, and that anchor is also what buys the
  // whole-way amount in applySculpt (FULL_HEIGHT_SPAN). That amount is safe
  // for the drag because applyDragRegion re-asks canSpreadBandTo for every
  // cell it fills; the two brushes the other tools run ask it once, for the
  // stroke centre, so a stamp or smooth wearing this anchor would lift its
  // whole disc to the band the MESSAGE named off a single adjacent cell —
  // final heights chosen by the client, which is exactly what "clients send
  // intents, never heights" forbids. REJECTED WITH THE WHOLE INTENT, the same
  // call the carve's `dir: 1` gets two blocks up, rather than dropping the
  // band and stamping instead: silently reinterpreting an intent applies a
  // differently-shaped edit than its sender predicted.
  //
  // TESTED ON THE RAW FIELD, deliberately: an absent `tool` means stamp
  // (WIRE_DEFAULT_SCULPT_OPTIONS, resolved in sculptOptionsOf), so an intent
  // that omits the tool while carrying a band is rejected here too rather than
  // defaulted into the very combination this rules out. The only legitimate
  // sender writes `tool: 'drag'` beside the band (client/src/input/sculptInput.ts).
  if (targetBand !== undefined && tool !== 'drag') return null;

  // spanBand is optional and, when present, must be a band this world could
  // hold — the same structural check targetBand gets, and for the same reason:
  // it says the number is a band, not that a span is there. WHICH span it names
  // is terrain, re-derived from the server's own heightmap by
  // spanIndexCoveringBand inside the shared math.
  const { spanBand } = m;
  if (
    spanBand !== undefined &&
    (!Number.isInteger(spanBand) ||
      (spanBand as number) < MIN_BAND ||
      (spanBand as number) > MAX_BAND)
  ) {
    return null;
  }

  return {
    type: 'sculpt',
    x: x as number,
    y: y as number,
    radius: radius as number,
    dir,
    ...(tool !== undefined ? { tool: tool as SculptTool } : {}),
    ...(profile !== undefined ? { profile: profile as SculptProfile } : {}),
    ...(targetBand !== undefined ? { targetBand: targetBand as number } : {}),
    ...(spanBand !== undefined ? { spanBand: spanBand as number } : {}),
    ...(seq !== undefined ? { seq: seq as number } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WORLD ROLLBACK (2026-08-21). Restore points — "put the world back the way it
// was at 19:16" — after a bad edit or a misbehaving plugin terraform.
//
// CORE, NOT A PLUGIN, and that is the same call §3.6 already made for
// snapshots: a restore point IS a snapshot, the thing core already writes
// every SNAPSHOT_INTERVAL_S, so listing and re-applying one is persistence
// housekeeping rather than a game mechanic. Nothing here attaches a rule, a
// cost or a reward to rolling back (design §3.5, "nothing gamey in core").
//
// OPERATOR-GATED, NOT PLAYER-GATED. v1 has no accounts (§3.7), so the server
// cannot tell the self-hoster from anyone holding the invite link, and
// rolling the world back is the single most destructive thing it can be asked
// to do. The gate is therefore a shared secret the self-hoster puts in their
// environment (ROLLBACK_KEY) and types into the panel — the same trust model
// as SHARE_URL, and deliberately NOT a new identity system. With no key
// configured the feature is OFF, so a default deployment cannot be rolled
// back by anyone at all.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upper bound on an inbound operator key, in UTF-16 code units. Exists only so
 * a hostile client cannot make the server hold a megabyte string per message;
 * it is not a policy on how long a real key should be.
 */
export const MAX_ROLLBACK_KEY_LENGTH = 256;

/**
 * One restore point a world can be returned to: a snapshot core already wrote,
 * plus the two numbers that let a human RECOGNISE it in a list.
 *
 * `cellsChanged`/`maxCellDelta` are the whole point of the list, not
 * decoration. An ordinary player stroke moves tens of cells; the incident this
 * feature was built for (a relic that terraformed 11,673 cells at once) is
 * obvious at a glance against that baseline and invisible from timestamps
 * alone. Both are measured against the PREVIOUS retained restore point, and
 * both are null for the oldest one — it has no predecessor in the database to
 * be compared with, and inventing a zero there would read as "nothing
 * happened" rather than "not known".
 */
export interface RestorePoint {
  /** Snapshot id; what a rollback request names. */
  id: number;
  /** When it was written, epoch milliseconds. */
  createdAt: number;
  /** Cells whose height differs from the previous restore point, or null. */
  cellsChanged: number | null;
  /** Largest single-cell height difference from the previous point, or null. */
  maxCellDelta: number | null;
  /** True for the newest point — the state the live world was last saved at. */
  isCurrent: boolean;
  /**
   * True when this point is PINNED and therefore exempt from retention
   * (2026-08-22). An ordinary restore point is on its way to being pruned —
   * the newest N are just the ones that have not got there yet — so a moment
   * worth keeping has to be taken out of that window explicitly. See
   * WorldPinRequestMessage and the PINNED_COLUMN comment in snapshot-store.ts.
   */
  pinned: boolean;
}

/** Client → server: "list the restore points". Answered to the sender only. */
export interface RestorePointsRequestMessage {
  type: 'restorePoints';
  /** The operator key; see MAX_ROLLBACK_KEY_LENGTH and the section comment. */
  key: string;
}

/**
 * Why a rollback request was refused. A CLOSED SET, so the panel can say
 * something useful without the server ever composing player-facing prose.
 *
 * `disabled` and `badKey` are deliberately distinguishable: a self-hoster who
 * has not set ROLLBACK_KEY needs to be told THAT, or they will retype a key
 * that was never going to work. This leaks nothing a self-hoster does not
 * already know about their own deployment, and — unlike the sculpt mask
 * rejections, which stay silent on purpose — a restore point is not terrain,
 * so there is no hidden world state for the answer to be an oracle for.
 */
export type RollbackRefusal =
  /** No ROLLBACK_KEY is configured, so the feature is off entirely. */
  | 'disabled'
  /** A key was configured and this is not it. */
  | 'badKey'
  /** Too many wrong keys from this connection; it is being slowed down. */
  | 'throttled'
  /** The named snapshot is not in the database (pruned, or never existed). */
  | 'unknownRestorePoint'
  /** The snapshot belongs to a differently-sized world. */
  | 'sizeMismatch'
  /** The restore was attempted and threw; the world is unchanged. */
  | 'failed';

/** Server → the requesting client only: the restore points, newest first. */
export interface RestorePointListMessage {
  type: 'restorePointList';
  /** Newest first. Empty only on a world that has never been snapshotted. */
  points: RestorePoint[];
  /**
   * How many restore points this server retains, and how often it writes one.
   * Carried so the panel can state the real depth of the safety net ("about
   * 10 minutes") instead of the client guessing from two timestamps.
   */
  retention: number;
  intervalS: number;
  /** Present INSTEAD of a useful list when the request was refused. */
  refused?: RollbackRefusal;
}

/** Client → server: "put the world back to this restore point". */
export interface RollbackRequestMessage {
  type: 'rollback';
  key: string;
  /** The RestorePoint.id to return to. */
  toId: number;
}

/**
 * Server → the requesting client only: what happened.
 *
 * A SUCCESSFUL rollback is also announced to EVERY connected client, but not
 * with this message — they each receive a fresh `snapshot`, which is the
 * message that actually replaces the world they are looking at (the client's
 * rejoin path already handles it). This one is the operator's receipt.
 */
export interface RollbackResultMessage {
  type: 'rollbackResult';
  ok: boolean;
  /** The restore point the world is now at, when `ok`. */
  toId?: number;
  /**
   * Where the pre-rollback world was saved, when `ok`. A rollback is itself
   * undoable: the state being rolled AWAY from is written as a restore point
   * first, so a mis-aimed rollback costs one more click, not the world.
   */
  undoId?: number;
  /** Why it did not happen, when `!ok`. */
  refused?: RollbackRefusal;
}

/**
 * Validates an untrusted operator key. Returns the key, or null when it is
 * missing, not a string, or longer than MAX_ROLLBACK_KEY_LENGTH.
 *
 * Deliberately does NOT trim: a key is a secret, and silently accepting
 * " secret " for "secret" would widen it for no benefit.
 */
function validateRollbackKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_ROLLBACK_KEY_LENGTH) return null;
  return value;
}

/** Validates an inbound restore-point list request; null if malformed. */
export function validateRestorePointsRequest(
  msg: unknown,
): RestorePointsRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'restorePoints') return null;
  const key = validateRollbackKey(m.key);
  if (key === null) return null;
  return { type: 'restorePoints', key };
}

/** Validates an inbound rollback request; null if malformed. */
export function validateRollbackRequest(msg: unknown): RollbackRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'rollback') return null;
  const key = validateRollbackKey(m.key);
  if (key === null) return null;
  // Snapshot ids are SQLite AUTOINCREMENT rowids: positive integers. A float
  // or a negative cannot name a row, so it is rejected with the whole message
  // rather than reaching the query as a value that silently matches nothing.
  const { toId } = m;
  if (!Number.isSafeInteger(toId) || (toId as number) <= 0) return null;
  return { type: 'rollback', key, toId: toId as number };
}

// ─────────────────────────────────────────────────────────────────────────────
// WORLD MANAGEMENT (2026-08-22). Many worlds on one server, one of them live.
//
// WHY THIS EXISTS, stated plainly because it is a correction. Until now a
// world was a ROW: `snapshots` held every world any deployment had ever had,
// distinguished only by a `world_name` column, and retention kept "the newest
// N rows" across the whole table. So a world that stopped being written to was
// evicted by whichever world was written to next — 298 snapshots of one world
// were lost exactly this way (2026-08-22). The fix is not a bigger retention
// number; it is that A WORLD IS A FILE. Each world is its own SQLite database
// under WORLDS_DIR, with its own retention inside it, so no write to world B
// can reach a row belonging to world A. That is a structural guarantee, not a
// carefully-maintained one.
//
// ONE LIVE WORLD PER PROCESS, still (design §3.2, amended not abandoned).
// Loading a world saves and closes the current one before opening the next;
// two worlds are never simulating at once, because every server plugin keeps
// its state at module scope and would silently share it between them
// (issue #78 tracks lifting that).
//
// OPERATOR-GATED BY ITS OWN KEY. Rollback rewinds the live world; this can
// ARCHIVE one. Those are different blast radii, so they get different secrets:
// WORLD_ADMIN_KEY here, ROLLBACK_KEY there (owner decision, 2026-08-22). Both
// run through the same gate implementation — constant-time compare, five
// attempts, then a lockout — so neither can drift into being the weaker one.
//
// NOTHING HERE EVER DELETES A WORLD. `worldArchive` MOVES a world's file into
// the trash folder; `worldPurge` is the only message in this protocol that
// unlinks anything, it names the world it will destroy, and the client must
// echo that world's own name back for it to be honoured.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Longest world name a self-hoster may set, in UTF-16 code units. Generous
 * enough for every shape `generateWorldName` produces ("Isles of Gloamwatch"
 * is 19) plus a self-hoster's own poetry, short enough to render in a list row
 * without truncation being the normal case.
 */
export const MAX_WORLD_NAME_LENGTH = 48;

/**
 * Longest world id. An id is a filesystem slug derived from the name, so this
 * is a filename-length budget, not a naming policy — see slugifyWorldName.
 */
export const MAX_WORLD_ID_LENGTH = 64;

/**
 * Characters a world id may contain: lowercase letters, digits and hyphens.
 *
 * DELIBERATELY NARROW, because an id becomes a PATH. Anything outside this set
 * — a dot, a slash, a NUL, a Windows reserved character, a trailing space — is
 * either a traversal primitive or a filename that behaves differently on two
 * of the three platforms this server runs on. The server derives ids itself
 * (slugifyWorldName) and validates every inbound one against this pattern, so
 * a hostile client cannot name a file outside WORLDS_DIR.
 */
export const WORLD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Edge of a world thumbnail, in pixels.
 *
 * 64 is the largest size that still reads as one glance in a list row, and it
 * is 4 KB of band data per world — small enough that shipping every world's
 * thumbnail with the listing is not worth paginating. It is fixed rather than
 * negotiated because both halves index the same flat array, and a size that
 * travelled would be one more thing for them to disagree about.
 */
export const WORLD_THUMBNAIL_SIZE = 64;

/**
 * One world as the manager panel sees it. Everything here is DERIVED from the
 * world's own file — there is no registry index that could disagree with what
 * is on disk (see server/src/persistence/world-registry.ts).
 */
export interface WorldSummary {
  /** Filesystem slug; the basename of the world's `.db` file. */
  id: string;
  /** The world's own name, from its newest snapshot. */
  name: string;
  /** Cells per edge. Worlds of different sizes coexist happily here. */
  worldSize: number;
  /** Restore points the file currently holds. */
  restorePoints: number;
  /** How many of those are pinned, and therefore exempt from retention. */
  pinnedPoints: number;
  /** When the newest snapshot was written, or null if it has none yet. */
  newestAt: number | null;
  /** Size of the file on disk, in bytes. */
  bytes: number;
  /** True for the world currently loaded and simulating. */
  isActive: boolean;
  /** True for a world sitting in the trash folder, awaiting purge or restore. */
  isArchived: boolean;
  /** When it was archived, for a trash row; absent otherwise. */
  archivedAt?: number;
  /**
   * A top-down picture of the world, for telling one from another at a glance:
   * base64 of a WORLD_THUMBNAIL_SIZE² grid of signed bytes, each the BAND of
   * the mean height under that pixel, row-major.
   *
   * BANDS RATHER THAN COLOURS, because the palette is the client's business —
   * see server/src/persistence/thumbnail.ts. Absent on a world that has not
   * been snapshotted since thumbnails existed and could not be backfilled
   * (the loaded world is left alone until its next snapshot); a reader shows
   * a placeholder rather than treating it as an error.
   */
  thumbnail?: string;

  /**
   * Why this world could not be read, when it could not be. A world whose file
   * is corrupt is LISTED WITH ITS PROBLEM rather than hidden: a world you can
   * see and cannot open is a bug report, and a world that silently vanished
   * from the list is how someone concludes it was deleted.
   */
  unreadable?: string;
}

/** A world switch that has been announced and is counting down. */
export interface WorldSwitchStatus {
  /** The world being switched TO. */
  toId: string;
  toName: string;
  /** Seconds left before the swap; 0 means it is happening now. */
  secondsRemaining: number;
}

/**
 * Why a world-management request was refused. A CLOSED SET, for the same
 * reason RollbackRefusal is one: the panel says something useful without the
 * server ever composing player-facing prose.
 */
export type WorldAdminRefusal =
  /** No WORLD_ADMIN_KEY is configured, so world management is off entirely. */
  | 'disabled'
  /** A key is configured and this is not it. */
  | 'badKey'
  /** Too many wrong keys from this connection; it is being slowed down. */
  | 'throttled'
  /** No world with that id exists in the worlds folder. */
  | 'unknownWorld'
  /** The requested world is already the live one. */
  | 'alreadyActive'
  /** A world of that name/id already exists; nothing was overwritten. */
  | 'nameInUse'
  /** The name is empty, too long, or slugifies to nothing usable. */
  | 'invalidName'
  /**
   * The requested world size is outside this server's bounds, or is not a
   * whole number of chunks. Distinct from 'invalidName' because the operator
   * needs to know WHICH field to fix.
   */
  | 'invalidSize'
  /** The action needs a loaded world and there is none. */
  | 'noWorldLoaded'
  /** Cancel was asked when no switch was counting down. */
  | 'noSwitchPending'
  /** Purge/unarchive was asked of a world that is not in the trash. */
  | 'notArchived'
  /** Purge was asked without the world's own name echoed back exactly. */
  | 'confirmationMismatch'
  /** Another switch is already counting down; cancel it first. */
  | 'switchInProgress'
  /** No plugin of that name is installed on this server. */
  | 'unknownPlugin'
  /**
   * The plugin's new code was rejected and the build that was running still is
   * (issue #198). One name for every step a reload can fail at — the import,
   * the plugin's onWorldCreate, its refusal of its own saved data, or a throw
   * on the first tick — because they are the same fact to an operator: nothing
   * changed, and the server log says which step and why.
   */
  | 'reloadFailed'
  /**
   * The reload failed AND the world could not be reopened over either build,
   * so the server is left with NO world loaded (issue #207). Told apart from
   * `reloadFailed` because that name promises the operator the previous build
   * is still running, and here nothing is: the clients have been told the
   * world is unloaded, and somebody has to load one again.
   */
  | 'reloadLeftNoWorld'
  /**
   * The plugin is installed but declares no such setting, or does not accept
   * that value for it. Its own declaration is the authority — core knows what
   * a key MEANS to nobody — so this is the same class of refusal as a plugin
   * name nothing answers to, told apart because the operator needs to know
   * WHICH half of the pair was wrong.
   */
  | 'unknownSetting'
  /** Refused because it would archive the live world; unload or switch first. */
  | 'worldIsActive'
  /**
   * A restart is already announced and counting down. There is no cancel for
   * it (unlike a world switch): the process is going down either way, so a
   * second press is told the first one is still in hand rather than being
   * allowed to restart the countdown and postpone it indefinitely.
   */
  | 'restartInProgress'
  /** It was attempted and threw. Nothing was destroyed — see the server log. */
  | 'failed';

/** Every world-management action, as one closed set of names. */
export type WorldAdminAction =
  | 'create'
  | 'load'
  | 'unload'
  | 'rename'
  | 'duplicate'
  | 'archive'
  | 'unarchive'
  | 'purge'
  | 'pin'
  | 'cancelSwitch'
  | 'setPlugin'
  | 'configurePlugin'
  | 'reloadPlugin'
  | 'restart';

/** Client → server: "list every world you have". Answered to the sender only. */
export interface WorldListRequestMessage {
  type: 'worldList';
  /** The world-admin key; see MAX_ROLLBACK_KEY_LENGTH for the length bound. */
  key: string;
}

/** Client → server: "make a new world and leave the live one alone". */
export interface WorldCreateRequestMessage {
  type: 'worldCreate';
  key: string;
  /** Optional; the server mints an evocative one when omitted. */
  name?: string;
  /** Optional; falls back to the server's WORLD_SIZE. */
  worldSize?: number;
  /** Optional; falls back to the server's WORLD_DIFFICULTY. */
  difficulty?: number;
  /** Load it immediately after creating it, rather than only creating it. */
  loadNow?: boolean;
}

/** Client → server: "make this world the live one". */
export interface WorldLoadRequestMessage {
  type: 'worldLoad';
  key: string;
  id: string;
}

/**
 * Client → server: "save the live world and close it, leaving none loaded".
 *
 * A server with no world loaded still runs, still serves the client, and still
 * answers world management — it simply has nothing to simulate and nothing to
 * send a joining player. That is a deliberate state, not a broken one: it is
 * what "unload" has to mean for it to be the opposite of "load".
 */
export interface WorldUnloadRequestMessage {
  type: 'worldUnload';
  key: string;
}

/** Client → server: "call this world something else". Never moves its file. */
export interface WorldRenameRequestMessage {
  type: 'worldRename';
  key: string;
  id: string;
  name: string;
}

/** Client → server: "copy this world, byte for byte, under a new name". */
export interface WorldDuplicateRequestMessage {
  type: 'worldDuplicate';
  key: string;
  id: string;
  name?: string;
}

/**
 * Client → server: "move this world to the trash".
 *
 * NOT A DELETE. The file is moved, not unlinked, and it keeps appearing in the
 * archived list until somebody purges it on purpose.
 */
export interface WorldArchiveRequestMessage {
  type: 'worldArchive';
  key: string;
  id: string;
}

/** Client → server: "take this world back out of the trash". */
export interface WorldUnarchiveRequestMessage {
  type: 'worldUnarchive';
  key: string;
  id: string;
}

/**
 * Client → server: "destroy this archived world permanently".
 *
 * THE ONLY MESSAGE IN THIS PROTOCOL THAT DESTROYS A WORLD. `confirmName` must
 * equal the world's own name exactly; a mismatch is refused with
 * 'confirmationMismatch' and nothing is touched. It is deliberately a name and
 * not a yes/no: typing "Frostwick Hollows" is impossible to do by reflex, and
 * a reflexive confirmation is not a confirmation.
 */
export interface WorldPurgeRequestMessage {
  type: 'worldPurge';
  key: string;
  id: string;
  confirmName: string;
}

/**
 * Client → server: "pin this restore point" (or unpin it).
 *
 * A pinned restore point is EXEMPT FROM RETENTION — it survives however many
 * snapshots are written after it, until it is unpinned. This is the per-moment
 * counterpart to the per-world guarantee: a world file cannot be pruned by
 * another world, and a moment inside a world cannot be pruned by later play.
 */
export interface WorldPinRequestMessage {
  type: 'worldPin';
  key: string;
  /** Restore point in the LIVE world; pinning is only offered for it. */
  pointId: number;
  pinned: boolean;
}

/**
 * Client → server: "which plugins does this world run, and which are off?".
 *
 * A SEPARATE REQUEST FROM `worldList`, not a field on the world summary: the
 * disabled set is read out of each world's own file, so folding it into the
 * listing would open every world on disk to answer a question the operator
 * asks about one of them.
 */
export interface WorldPluginListRequestMessage {
  type: 'worldPluginList';
  key: string;
  id: string;
}

/**
 * Client → server: "run (or stop running) this plugin in this world".
 *
 * Applies to ANY world, not only the live one — the enabled set lives in the
 * world file, so a world that is merely sitting on disk can be configured
 * before it is ever loaded. When the world IS live the server reopens it, which
 * carries every connected player across without dropping a socket (issue #166).
 */
export interface WorldPluginSetRequestMessage {
  type: 'worldPluginSet';
  key: string;
  id: string;
  /** Installed plugin name; see PLUGIN_NAME_PATTERN. */
  plugin: string;
  enabled: boolean;
}

/**
 * Client → server: "run this plugin with this setting, in this world".
 *
 * THE DECLARING PLUGIN IS THE AUTHORITY on which keys exist and which values
 * each one takes (server plugins/types.ts's PluginSettingDeclaration). This
 * message carries strings; the server refuses a key or a value that plugin
 * never declared exactly as it refuses a plugin nobody installed, so no
 * vocabulary of any plugin's is written down in core or on the wire.
 *
 * Applies to ANY world, live or merely on disk — the setting lives in the
 * world file — and when the world IS live the server reopens it so the change
 * is in effect, carrying every connected player across (issue #166), the same
 * shape `worldPluginSet` has.
 */
export interface WorldPluginConfigureRequestMessage {
  type: 'worldPluginConfigure';
  key: string;
  id: string;
  /** Installed plugin name; see PLUGIN_NAME_PATTERN. */
  plugin: string;
  /** A key that plugin declared; see PLUGIN_SETTING_TOKEN_PATTERN. */
  setting: string;
  /** One of the values that plugin declared for `setting`. */
  value: string;
}

/**
 * Client → server: "re-import this plugin's server code, without restarting".
 *
 * THE UPDATE BUTTON FOR ONE PLUGIN (issue #198, Option B). The server drops the
 * plugin's old module for a freshly imported one and rebuilds the live world
 * over it, carrying every connected player across exactly as an enablement
 * change does. If the new code fails to import, throws while the world is being
 * built, refuses its own saved data, or throws on its first tick, the old build
 * is put back and the answer is 'reloadFailed' — there is no half-updated state.
 *
 * A PROCESS-WIDE ACT, unlike `worldPluginSet` and `worldPluginConfigure`: a
 * plugin's module is loaded once for the whole server, so a reload changes the
 * code EVERY world runs. `id` is carried only so the refreshed plugin listing
 * comes back for the world whose panel asked, and the server's own answer does
 * not depend on it — the world that is rebuilt is whichever one is live.
 *
 * NOT A REPLACEMENT FOR `serverRestart`: it updates the SERVER half only. A
 * plugin's client half is compiled into the bundle, so the page reloads itself
 * when the build identity moves — which it does on every successful reload.
 */
export interface WorldPluginReloadRequestMessage {
  type: 'worldPluginReload';
  key: string;
  /** The world whose plugin panel asked; see this interface's doc comment. */
  id: string;
  /** Installed plugin name; see PLUGIN_NAME_PATTERN. */
  plugin: string;
}

/**
 * Client → server: "restart this server process".
 *
 * THE UPDATE BUTTON. A new version of a plugin's (or core's) code is on disk
 * and the operator wants it live; the process is the unit of code identity in
 * Node (the ESM module map has no eviction), so a restart is how new code
 * arrives — see docs/plans/plugin-hot-unload.md §3.1. Nothing is lost by it:
 * the shutdown path writes the final snapshot, the active pointer is left
 * alone so the same world comes back, and every client reconnects silently
 * with its territory intact.
 *
 * GATED BY THE SAME KEY, AND IN THE SAME UNION, as every other world-admin
 * action — it is the operator's process, and the blast radius (a few seconds
 * of downtime, nothing destroyed) sits below `worldPurge`'s. It carries no id
 * because it is not about one world: whichever world is live comes back.
 *
 * Whether the process actually returns is the SUPERVISOR's business, not the
 * protocol's: the server exits with a distinguished code and docker,
 * systemd or run_server.py brings it back.
 */
export interface ServerRestartRequestMessage {
  type: 'serverRestart';
  key: string;
}

/** Client → server: "call off the switch that is counting down". */
export interface WorldSwitchCancelRequestMessage {
  type: 'worldSwitchCancel';
  key: string;
}

/** Server → the requesting client only: every world this server has. */
export interface WorldListMessage {
  type: 'worldListing';
  /** Live worlds, newest-played first. */
  worlds: WorldSummary[];
  /** Trash: archived worlds awaiting purge or restore. */
  archived: WorldSummary[];
  /** Id of the loaded world, or null when none is loaded. */
  activeId: string | null;
  /** Present while a switch is counting down. */
  pending?: WorldSwitchStatus;
  /** Present INSTEAD of a useful listing when the request was refused. */
  refused?: WorldAdminRefusal;
}

/**
 * One plugin setting as the panel sees it: who declared it, what it accepts,
 * and what this world is running.
 *
 * THE PANEL RENDERS THIS GENERICALLY — a control per row, labelled by `key`,
 * offering `values`. It must not learn what any of these strings mean; that a
 * settlement model can be `life` or `populous` is structures' declaration
 * travelling through, not a list core keeps.
 *
 * `value` is the EFFECTIVE one: the world's row when it has one, otherwise the
 * plugin's own default, so the control always shows what is actually running
 * rather than an empty box for an unconfigured world.
 */
export interface WorldPluginSetting {
  plugin: string;
  key: string;
  values: string[];
  value: string;
}

/**
 * Server → the requesting client only: one world's plugin enablement.
 *
 * `installed` is every plugin this SERVER has discovered; `disabled` is the
 * subset this WORLD does not run. The disabled set is sent rather than the
 * enabled one because that is what the world file records — a plugin installed
 * after the world was last opened is enabled in it without anything having been
 * written (see snapshot-store.ts, issue #165).
 */
export interface WorldPluginListMessage {
  type: 'worldPluginListing';
  /** The world these lists describe. */
  id: string;
  /** Every plugin installed on this server, in load order. */
  installed: string[];
  /** Those of `installed` this world has switched off. */
  disabled: string[];
  /**
   * Every setting the installed plugins declare, with the value in force for
   * this world. Empty when no installed plugin declares one.
   */
  settings: WorldPluginSetting[];
  /**
   * Which BUILD of each installed plugin is running, keyed by plugin name —
   * `<package version>+<derived>` (server plugins/plugin-version.ts).
   *
   * WHY THE OPERATOR NEEDS IT: after updating one plugin and restarting, this
   * is how they confirm the code they edited is the code that booted. Every
   * installed plugin has an entry, disabled ones included: a disabled plugin's
   * module is still loaded, and "which version is on disk" is a question about
   * the server, not about this world.
   *
   * DIAGNOSTIC, like `serverVersion` on the join snapshot — core attaches no
   * mechanic to it.
   */
  versions: Record<string, string>;
  /** Present INSTEAD of useful lists when the request was refused. */
  refused?: WorldAdminRefusal;
}

/** Server → the requesting client only: what happened to one request. */
export interface WorldAdminResultMessage {
  type: 'worldAdminResult';
  action: WorldAdminAction;
  ok: boolean;
  /** The world the action landed on, when there was one. */
  id?: string;
  /**
   * Where an archived world's file was moved to, on a successful archive.
   * Stated so the answer to "where did my world go" is on screen rather than
   * in a log the operator would have to know to read.
   */
  archivedPath?: string;
  /** Why it did not happen, when `!ok`. */
  refused?: WorldAdminRefusal;
}

/**
 * Server → EVERY client: a world switch was announced and is counting down.
 *
 * WHY A COUNTDOWN AND NOT AN INSTANT SWAP. With one player — the operator —
 * there is nobody to warn and the swap is immediate. With others connected,
 * yanking the ground out from under someone mid-sculpt is hostile, so the
 * switch is announced, counted down, and only then applied. `cancelled` ends
 * the countdown with the world unchanged.
 */
export interface WorldSwitchNoticeMessage {
  type: 'worldSwitchNotice';
  toId: string;
  toName: string;
  secondsRemaining: number;
  /** True on the message that calls the whole thing off. */
  cancelled?: boolean;
}

/**
 * Server → EVERY client: the server process is about to restart.
 *
 * THE SWITCH NOTICE'S SHAPE, for the switch notice's reason: with the operator
 * alone there is nobody to warn and the restart is immediate; the moment
 * somebody else is connected, taking the server out from under them mid-sculpt
 * is hostile, so it is announced and counted down first.
 *
 * `secondsRemaining: 0` means "now" — sent both as the terminal message of a
 * countdown and as the only message of an unannounced restart, so a client
 * never has to tell those two apart. There is no `cancelled` counterpart:
 * unlike a world switch, a restart has no cancel action (see
 * 'restartInProgress').
 *
 * A client's own response is a page reload once the server is back, and only
 * if the build it comes back on differs — see the client's reload gate.
 */
export interface ServerRestartNoticeMessage {
  type: 'serverRestartNotice';
  secondsRemaining: number;
}

/**
 * Server → EVERY client: there is no world loaded right now.
 *
 * Sent on unload, so a client stops rendering a world the server has closed.
 * A client that receives this has nothing to draw until a `snapshot` arrives.
 */
export interface WorldUnloadedMessage {
  type: 'worldUnloaded';
}

/** Every client → server world-management message. */
export type WorldAdminRequestMessage =
  | WorldListRequestMessage
  | WorldCreateRequestMessage
  | WorldLoadRequestMessage
  | WorldUnloadRequestMessage
  | WorldRenameRequestMessage
  | WorldDuplicateRequestMessage
  | WorldArchiveRequestMessage
  | WorldUnarchiveRequestMessage
  | WorldPurgeRequestMessage
  | WorldPinRequestMessage
  | WorldPluginListRequestMessage
  | WorldPluginSetRequestMessage
  | WorldPluginConfigureRequestMessage
  | WorldPluginReloadRequestMessage
  | ServerRestartRequestMessage
  | WorldSwitchCancelRequestMessage;

/**
 * Turns a world name into a filesystem-safe id.
 *
 * SHARED, not server-only, because the panel previews the id a name will
 * produce before the operator commits to it — and a preview computed by
 * different code from the real thing is a preview that lies. The server still
 * validates the result (WORLD_ID_PATTERN) rather than trusting any id a
 * client sends: this function is a convenience, never a security boundary.
 *
 * Returns an empty string for a name with nothing slug-able in it (all
 * punctuation, all emoji); callers treat that as 'invalidName'.
 */
export function slugifyWorldName(name: string): string {
  const slug = name
    .normalize('NFKD')
    // Strip combining marks so "Åsgard" becomes "asgard", not "sgard".
    // Written as escapes, not literal combining characters, so the source is
    // readable in an editor that would otherwise stack them on the bracket.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    // Leading/trailing hyphens would make a filename that starts with '-',
    // which every CLI in the world treats as a flag.
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, MAX_WORLD_ID_LENGTH);
}

/** Validates an untrusted world id; null when it could not be one. */
export function validateWorldId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_WORLD_ID_LENGTH) return null;
  if (!WORLD_ID_PATTERN.test(value)) return null;
  return value;
}

/**
 * Longest plugin name the protocol will carry.
 *
 * A plugin name is a directory name and a message namespace, never prose, so
 * the bound only has to sit past any plausible one; it exists so a megabyte of
 * string cannot be handed to a regular expression.
 */
export const MAX_PLUGIN_NAME_LENGTH = 64;

/**
 * Characters a plugin name may contain: lowercase alphanumerics with inner
 * dashes.
 *
 * SHARED RATHER THAN SERVER-ONLY because the name is a MESSAGE NAMESPACE
 * (`<plugin>:<type>`) and a snapshot key, which makes it protocol. Boot
 * validates every discovered plugin against it (server plugins/discovery.ts)
 * and the validator below checks every one that arrives off the wire.
 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validates an untrusted plugin name; null when it could not be one. */
export function validatePluginName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_PLUGIN_NAME_LENGTH) return null;
  if (!PLUGIN_NAME_PATTERN.test(value)) return null;
  return value;
}

/**
 * Longest a setting key or one of its values may be on the wire.
 *
 * Both are identifiers a plugin author wrote into a declaration, never prose,
 * so one bound past any plausible one covers both — its job is to keep a
 * megabyte of string away from the regular expression below, exactly as
 * MAX_PLUGIN_NAME_LENGTH does for a plugin name.
 */
export const MAX_PLUGIN_SETTING_TOKEN_LENGTH = 64;

/**
 * The shape of a setting key and of a setting value: the plugin-name shape,
 * restated for the same reason it holds there — these strings are stored as
 * SQLite keys and rendered into a panel, so lowercase alphanumerics with inner
 * dashes keeps them free of anything a store, a log line or a label has to
 * escape. A plugin whose vocabulary needs prose wants a label, not a value.
 */
export const PLUGIN_SETTING_TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validates an untrusted setting key or value; null when it could not be one. */
export function validatePluginSettingToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_PLUGIN_SETTING_TOKEN_LENGTH) return null;
  if (!PLUGIN_SETTING_TOKEN_PATTERN.test(value)) return null;
  return value;
}

/**
 * Validates an untrusted world name; null when it could not be one.
 *
 * Trims, unlike the key validator: a name is a label a human typed, and
 * " Frostwick " is the same world as "Frostwick" to everyone but a string
 * comparison. A key is a secret and gets the opposite treatment, for the
 * reason stated on validateRollbackKey.
 */
export function validateWorldName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WORLD_NAME_LENGTH) return null;
  // Control characters would render as nothing and could smuggle a newline
  // into a log line; a name is display text, so they are rejected outright.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validates any inbound world-management message; null if malformed.
 *
 * ONE VALIDATOR FOR EVERY WORLD-ADMIN MESSAGE, deliberately: every one of them
 * carries the operator key and is refused the same way, so splitting them into
 * a function apiece would be that many places for the key check to drift.
 * The per-action fields are checked in the one switch below.
 */
export function validateWorldAdminRequest(msg: unknown): WorldAdminRequestMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;

  // The key check is FIRST and identical for every action — see the doc above.
  const key = typeof m.key === 'string' ? m.key : null;
  if (key === null || key.length === 0 || key.length > MAX_ROLLBACK_KEY_LENGTH) return null;

  switch (m.type) {
    case 'worldList':
      return { type: 'worldList', key };

    case 'worldUnload':
      return { type: 'worldUnload', key };

    case 'worldSwitchCancel':
      return { type: 'worldSwitchCancel', key };

    // No fields beyond the key: a restart is not about a world, and the code
    // the process comes back on is whatever is on disk — nothing a client
    // could name.
    case 'serverRestart':
      return { type: 'serverRestart', key };

    case 'worldCreate': {
      const request: WorldCreateRequestMessage = { type: 'worldCreate', key };
      if (m.name !== undefined) {
        const name = validateWorldName(m.name);
        if (name === null) return null;
        request.name = name;
      }
      if (m.worldSize !== undefined) {
        // Bounds are the server's (config.ts owns WORLD_SIZE's range); the
        // protocol only insists it is a positive integer, so a float or a
        // string never reaches the allocator.
        if (!Number.isSafeInteger(m.worldSize) || (m.worldSize as number) <= 0) return null;
        request.worldSize = m.worldSize as number;
      }
      if (m.difficulty !== undefined) {
        if (!Number.isSafeInteger(m.difficulty)) return null;
        request.difficulty = m.difficulty as number;
      }
      if (m.loadNow !== undefined) {
        if (typeof m.loadNow !== 'boolean') return null;
        request.loadNow = m.loadNow;
      }
      return request;
    }

    case 'worldLoad':
    case 'worldArchive':
    case 'worldUnarchive': {
      const id = validateWorldId(m.id);
      if (id === null) return null;
      return { type: m.type, key, id };
    }

    case 'worldRename': {
      const id = validateWorldId(m.id);
      const name = validateWorldName(m.name);
      if (id === null || name === null) return null;
      return { type: 'worldRename', key, id, name };
    }

    case 'worldDuplicate': {
      const id = validateWorldId(m.id);
      if (id === null) return null;
      const request: WorldDuplicateRequestMessage = { type: 'worldDuplicate', key, id };
      if (m.name !== undefined) {
        const name = validateWorldName(m.name);
        if (name === null) return null;
        request.name = name;
      }
      return request;
    }

    case 'worldPurge': {
      const id = validateWorldId(m.id);
      if (id === null) return null;
      // The confirmation is compared against the world's real name by the
      // server; here it need only BE a string of plausible length. It is not
      // run through validateWorldName, because a world whose stored name has
      // somehow drifted outside those rules must still be purgeable by
      // echoing whatever it actually says.
      if (typeof m.confirmName !== 'string' || m.confirmName.length > MAX_WORLD_NAME_LENGTH) {
        return null;
      }
      return { type: 'worldPurge', key, id, confirmName: m.confirmName };
    }

    case 'worldPluginList': {
      const id = validateWorldId(m.id);
      if (id === null) return null;
      return { type: 'worldPluginList', key, id };
    }

    case 'worldPluginReload': {
      const id = validateWorldId(m.id);
      const plugin = validatePluginName(m.plugin);
      if (id === null || plugin === null) return null;
      return { type: 'worldPluginReload', key, id, plugin };
    }

    case 'worldPluginSet': {
      const id = validateWorldId(m.id);
      const plugin = validatePluginName(m.plugin);
      if (id === null || plugin === null) return null;
      if (typeof m.enabled !== 'boolean') return null;
      return { type: 'worldPluginSet', key, id, plugin, enabled: m.enabled };
    }

    case 'worldPluginConfigure': {
      const id = validateWorldId(m.id);
      const plugin = validatePluginName(m.plugin);
      const setting = validatePluginSettingToken(m.setting);
      const value = validatePluginSettingToken(m.value);
      if (id === null || plugin === null || setting === null || value === null) return null;
      // WELL-FORMED IS ALL THIS LAYER CAN SAY. Whether the plugin declares this
      // key, and whether it accepts this value, is a question only the plugin's
      // own declaration answers — checked by the server (world-manager.ts) and
      // refused as 'unknownSetting'. Shared code cannot know: it has no plugins.
      return { type: 'worldPluginConfigure', key, id, plugin, setting, value };
    }

    case 'worldPin': {
      // Snapshot ids are SQLite AUTOINCREMENT rowids: positive integers.
      if (!Number.isSafeInteger(m.pointId) || (m.pointId as number) <= 0) return null;
      if (typeof m.pinned !== 'boolean') return null;
      return { type: 'worldPin', key, pointId: m.pointId as number, pinned: m.pinned };
    }

    default:
      return null;
  }
}
