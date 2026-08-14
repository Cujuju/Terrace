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
   * Client-chosen correlation id, echoed back on SculptDeniedMessage so the
   * sender can retire the exact client-side prediction a denial refers to.
   * Optional: an intent without one is still valid — it simply cannot be
   * nacked by seq, and its prediction falls back to the value/deadline
   * reconciliation in the client's prediction store.
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
 */
export interface JoinSnapshotMessage {
  type: 'snapshot';
  worldSize: number;
  chunks: ChunkPayload[];
}

/**
 * Everything a client may send. One message type today: the sculpt intent —
 * position, radius, direction, and (since 2026-08-14) the optional brush tool
 * and edge profile. Fields are added to it ADDITIVELY and optionally, so an
 * older client stays valid; `sculptOptionsOf` states what an omitted field
 * means, once, for every reader.
 */
export type ClientMessage = SculptIntent;
export type ServerMessage =
  | TerrainDiffMessage
  | ChunkUnlockMessage
  | JoinSnapshotMessage
  | SculptDeniedMessage;

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
