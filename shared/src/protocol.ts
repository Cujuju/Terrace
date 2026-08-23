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
  /** Refused because it would archive the live world; unload or switch first. */
  | 'worldIsActive'
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
  | 'cancelSwitch';

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
 * ONE VALIDATOR FOR ELEVEN MESSAGES, deliberately: every one of them carries
 * the operator key and is refused the same way, so splitting them into eleven
 * near-identical functions would be eleven places for the key check to drift.
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
