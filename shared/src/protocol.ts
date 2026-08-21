// Protocol: message types and intent validation.
//
// CRITICAL CODE — validateSculptIntent is the server's first line of defense
// against hostile clients (design §3.2: clients send intents, never heights).
// Every field of an inbound intent is checked for type, integrality, and
// range before any of it touches the world. Plugins add further verdicts
// (mana, cooldowns) AFTER this structural validation passes.

import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from './constants.ts';
import { SCULPT_PROFILES, SCULPT_TOOLS } from './heightmap.ts';
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
  // Player sculpts are always locked to the clicked cell's level (owner
  // decision 2026-08-19: the brush periphery must never climb past the level
  // the player pointed at). Not a wire field, same argument as `spill`.
  anchor: 'clicked',
};

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
  return {
    tool: intent.tool ?? WIRE_DEFAULT_SCULPT_OPTIONS.tool,
    profile: intent.profile ?? WIRE_DEFAULT_SCULPT_OPTIONS.profile,
    // Deliberately NOT read from the intent: spill containment is fixed
    // policy for player sculpts (issue #26), and so is the clicked-cell
    // anchor (2026-08-19). Both the server pipeline and client prediction
    // resolve through these lines, so both sides run banded+anchored by
    // construction — the same lockstep argument as the doc above.
    spill: WIRE_DEFAULT_SCULPT_OPTIONS.spill,
    anchor: WIRE_DEFAULT_SCULPT_OPTIONS.anchor,
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

/** One chunk's heights on the wire (see extractChunkHeights for the shape). */
export interface ChunkPayload {
  cx: number;
  cy: number;
  heights: number[];
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
  if (profile !== undefined && !SCULPT_PROFILES.includes(profile as SculptProfile)) {
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
