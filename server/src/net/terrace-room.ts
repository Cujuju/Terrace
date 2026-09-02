// The Colyseus adapter. Deliberately THIN: it translates connections and
// messages, and holds no game logic — everything it calls (the intent pipeline,
// the mask filter, the plugin host) is Colyseus-free and unit-tested without a
// network. If logic starts accumulating here, it belongs in the World layer.
//
// Verified against colyseus 0.17.10 / @colyseus/core 0.17.50:
//  - Room<{ state, metadata, client }> replaced Room<State, Metadata>;
//  - Client<{ userData, auth, messages }> replaced Client<UserData, AuthData>;
//  - onMessage(type, cb) supports MULTIPLE handlers per type and returns an
//    unbind function (0.17 change — re-registering no longer replaces);
//  - onMessage('*', cb) is supported and its callback takes (client, type,
//    message): Room.d.ts:437 declares the overload, and Room.mjs `_onMessage`
//    (lines 994-1000) emits to '*' ONLY when no handler is registered for the
//    incoming type, falling back to `__no_message_handler` when neither exists;
//  - onLeave's second parameter is a close `code`, not `consented`;
//  - message payloads are encoded with MsgPack by the transport, so we hand it
//    plain protocol objects and never serialize by hand.
//
// THE ROOM OUTLIVES EVERY WORLD (multi-world, 2026-08-22). It used to hold a
// World, a PluginHost and a RollbackService directly, because there was exactly
// one of each for the life of the process. All three are now replaced whenever
// an operator loads a different world, and there may be NONE of them at all
// (a server with nothing loaded is a supported state). So the room holds a
// WorldManager and reads through it on every message. Two consequences worth
// stating, because both were bugs waiting to happen:
//
//   1. NOTHING IS CAPTURED. Every handler below reaches the world via
//      `this.manager` at call time. A handler that closed over a World would
//      keep sculpting the world the operator just left.
//   2. PLUGIN MESSAGES ARE ROUTED PER MESSAGE, BY NOBODY'S LIST (issue #197).
//      One Colyseus wildcard registration covers every `<plugin>:<type>`; both
//      WHICH host answers and WHETHER the type exists at all are asked of the
//      live host as each message arrives — see net/plugin-message-routing.ts.

import { CloseCode, ErrorCode, Room, isDevMode, type Client } from '@colyseus/core';
import {
  validateRestorePointsRequest,
  validateRollbackRequest,
  validateWorldAdminRequest,
  type ChunkUnlockMessage,
  type JoinSnapshotMessage,
  type RestorePointListMessage,
  type RollbackResultMessage,
  type ServerRestartNoticeMessage,
  type TerrainDiffMessage,
  type WorldAdminRequestMessage,
  type WorldAdminResultMessage,
  type WorldListMessage,
  type WorldPluginListMessage,
  type WorldSwitchNoticeMessage,
  type WorldUnloadedMessage,
} from '@terrace/shared';
import { logInfo, logWarn } from '../log.ts';
import { sanitizePlayerName, sanitizePlayerToken, type Player } from '../player.ts';
import { handleSculptIntent } from '../intent/pipeline.ts';
import { applyInitialUnlockForToken } from '../world/initial-unlock.ts';
import type { ServerRestartService } from '../restart.ts';
import { containWorldAdminMessage, type WorldAdminService } from '../world/world-admin.ts';
import type { WorldManager } from '../world/world-manager.ts';
import { buildJoinSnapshot } from './join-snapshot.ts';
import { isPluginMessageType, routePluginMessage } from './plugin-message-routing.ts';
import { NULL_SINK, type MessageSink } from './message-sink.ts';
import { SculptRateLimiter } from './sculpt-rate-limit.ts';

/** The matchmaking name clients join. Agreed with the Phase 1 client agent. */
export const ROOM_NAME = 'world';

/** Wire name of the one client → server core GAMEPLAY message. */
export const SCULPT_MESSAGE_TYPE = 'sculpt';

/**
 * Wire names of the client → server core OPERATOR messages. The first two are
 * world rollback (2026-08-21); the rest are world management (2026-08-22) and
 * are gated by a DIFFERENT key — see world/world-admin.ts.
 */
export const RESTORE_POINTS_MESSAGE_TYPE = 'restorePoints';
export const ROLLBACK_MESSAGE_TYPE = 'rollback';

/**
 * Every world-management message type, as the wire names clients send.
 *
 * A LIST RATHER THAN A PREFIX MATCH, so an unknown `world*` message is dropped
 * by Colyseus's own routing instead of reaching a validator that has to decide
 * what it was meant to be.
 */
export const WORLD_ADMIN_MESSAGE_TYPES = [
  'worldList',
  'worldCreate',
  'worldLoad',
  'worldUnload',
  'worldRename',
  'worldDuplicate',
  'worldArchive',
  'worldUnarchive',
  'worldPurge',
  'worldPin',
  'worldPluginList',
  'worldPluginSet',
  'worldPluginConfigure',
  'worldPluginAct',
  'worldPluginReload',
  'serverRestart',
  'worldSwitchCancel',
] as const;

/**
 * What the client is told about a message type no handler claims — worded as
 * Colyseus words it (@colyseus/core 0.17.50 Room.mjs line 96), because this is
 * the framework's own rejection, reproduced rather than replaced. See
 * TerraceRoom.rejectUnregisteredMessage.
 */
const UNREGISTERED_MESSAGE_REASON_PREFIX = 'room onMessage for ';

/**
 * How long one logged plugin-rewrite failure suppresses the next line.
 *
 * The failure is per SCULPT: a broken plugin produces one for every stroke of
 * every affected player, which unthrottled is a log flood that buries the
 * thing it is reporting. Ten seconds is short enough that the line reappears
 * while the operator is still looking (a held stroke is over in a second or
 * two, so a repeat proves the plugin is still broken rather than echoing one
 * old event) and long enough that a busy world logs it a handful of times a
 * minute, not hundreds.
 */
const PLUGIN_REWRITE_FAILURE_LOG_INTERVAL_MS = 10_000;

/**
 * Server → client message map. The Colyseus message name is the payload's own
 * `type` literal from shared/src/protocol.ts, and the payload is the whole
 * protocol object — one name, one shape, no server-only wrapper to drift.
 * The index signature covers namespaced plugin messages (`<plugin>:<type>`).
 */
export interface TerraceServerMessages {
  snapshot: JoinSnapshotMessage;
  terrainDiff: TerrainDiffMessage;
  chunkUnlock: ChunkUnlockMessage;
  restorePointList: RestorePointListMessage;
  rollbackResult: RollbackResultMessage;
  worldListing: WorldListMessage;
  worldAdminResult: WorldAdminResultMessage;
  worldPluginListing: WorldPluginListMessage;
  worldSwitchNotice: WorldSwitchNoticeMessage;
  serverRestartNotice: ServerRestartNoticeMessage;
  worldUnloaded: WorldUnloadedMessage;
  [pluginMessage: string]: unknown;
}

export type TerraceClient = Client<{
  userData: { player: Player };
  messages: TerraceServerMessages;
}>;

/** Everything the room needs from the process. */
export interface RoomContext {
  /** Owns which world is loaded and how one becomes another. */
  readonly manager: WorldManager;
  /** Owns the world-admin key and every world-management action. */
  readonly admin: WorldAdminService;
  /** Owns the restart countdown and the exit sequence. */
  readonly restart: ServerRestartService;
}

/**
 * The process-wide room context. Colyseus's matchmaker constructs rooms itself,
 * so dependencies have to reach them somehow; a module-level binding is honest
 * about the design (one world LIVE per process) and, more importantly,
 * it is NOT the room's `options` object. Room options are `merge({},
 * clientOptions, handlerOptions)` in @colyseus/core 0.17.50 — server defaults
 * win today, but the manager must not travel on any channel a client can write
 * to at all.
 */
let processRoomContext: RoomContext | null = null;

/** Called once during boot, before the server starts listening. */
export function bindRoomContext(context: RoomContext): void {
  processRoomContext = context;
}

export class TerraceRoom extends Room<{ client: TerraceClient }> {
  private context!: RoomContext;

  /**
   * The inbound sculpt brake, keyed by connection id — see
   * net/sculpt-rate-limit.ts for what it protects and why the room owns it
   * (the connection is the room's, and the check happens before there is a
   * world or an intent to attribute the message to).
   *
   * ON THE ROOM, NOT THE SESSION: it must survive a world switch, because the
   * socket does. A limiter that died with the world would hand a flooding
   * client a fresh bucket every time an operator loaded one.
   */
  private readonly sculptRate = new SculptRateLimiter();

  /**
   * When the last plugin-rewrite failure was logged — see
   * PLUGIN_REWRITE_FAILURE_LOG_INTERVAL_MS. Starts at negative infinity so the
   * very first failure always logs, whatever the process clock reads.
   */
  private lastPluginRewriteLogMs = Number.NEGATIVE_INFINITY;

  override onCreate(): void {
    if (processRoomContext === null) {
      throw new Error('room created before bindRoomContext() — boot order bug');
    }
    this.context = processRoomContext;

    // Exactly one room lives for the whole process lifetime. Disposing it when
    // the last player leaves would tear down the sink and re-create the room on
    // the next join for no benefit — the World, not the room, owns the state,
    // and with multi-world the room is also the PLAYER ROSTER a world switch
    // carries across (see RoomBridge.players).
    this.autoDispose = false;

    // No Colyseus schema state exists in Phase 1 (decision Q7: terrain never
    // travels as schema), so there is nothing to patch on an interval.
    this.patchRate = null;

    // Hand the manager this room's transport and roster. It re-attaches the
    // sink to every world it loads from here on.
    const sink = this.createSink();
    this.context.manager.attachRoom({
      sink,
      clientCount: () => this.clients.length,
      players: () => this.roster(),
    });
    // The restart needs the same two things for the same reason the switch
    // does — somebody to warn, and a count that decides whether to warn at all
    // — and neither exists before a room does.
    this.context.restart.attachRoom({ sink, clientCount: () => this.clients.length });

    this.onMessage(SCULPT_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      // RATE LIMIT FIRST, before the player lookup and before the message is
      // parsed: a socket over its budget must cost the server nothing but this
      // check. Dropped in silence, like every other rejected intent below.
      if (!this.sculptRate.allow(client.sessionId)) return;
      const player = client.userData?.player;
      // A message can arrive between the socket opening and onJoin completing;
      // without a player there is no intent to attribute, so it is dropped.
      if (!player) return;
      const session = this.context.manager.current;
      // Nothing loaded: a sculpt has no world to land in. Dropped in silence,
      // like every other rejected intent (see the pipeline's comment on why
      // telling a client WHY an intent failed leaks the unlock mask).
      if (session === null) return;
      const outcome = handleSculptIntent(
        { world: session.world, interceptors: session.host },
        player,
        message,
      );
      // THE ONLY REJECTION WORTH A LOG LINE. A plugin that rewrites an intent
      // into something core has to refuse turns every affected player's
      // sculpting into a no-op, and nothing else says so anywhere: the sender
      // gets a bare nack that names no reason (pipeline.ts), and the operator
      // watching a world where sculpting stopped working has nothing to grep
      // for. The other three reasons are deliberately NOT logged — a plugin
      // deny is ordinary play (mana refusing an unaffordable stroke), and
      // 'malformed'/'locked' come from untrusted input, so logging them would
      // hand any socket a log-flood lever.
      if (!outcome.applied && outcome.reason === 'plugin-modified-invalid') {
        this.notePluginRewriteFailure(outcome.detail);
      }
    });

    // OPERATOR MESSAGES. Deliberately NOT routed through the intent pipeline:
    // they are not intents, they carry no player attribution beyond the
    // connection they arrived on, and — unlike a sculpt — they are always
    // answered, because the operator needs to be told why a refusal happened.
    //
    // A player object is not required for any of them: the gate is the key,
    // not the identity, and demanding a joined player would only add a way for
    // the panel to fail silently. The CONNECTION id is what the failed-attempt
    // throttle is keyed by, and that exists from the moment the socket does.
    this.onMessage(RESTORE_POINTS_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      const request = validateRestorePointsRequest(message);
      if (request === null) return; // malformed: dropped, like every bad message
      const session = this.context.manager.current;
      if (session === null) {
        // No world, no restore points. An empty list with no refusal is the
        // truthful answer: the key was never even examined.
        client.send('restorePointList', {
          type: 'restorePointList',
          points: [],
          retention: 0,
          intervalS: 0,
        });
        return;
      }
      client.send(
        'restorePointList',
        session.rollback.listRestorePoints(client.sessionId, request.key),
      );
    });

    this.onMessage(ROLLBACK_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      const request = validateRollbackRequest(message);
      if (request === null) return;
      const session = this.context.manager.current;
      if (session === null) {
        client.send('rollbackResult', {
          type: 'rollbackResult',
          ok: false,
          refused: 'failed',
        });
        return;
      }
      const result = session.rollback.rollback(
        client.sessionId,
        request.key,
        request.toId,
      );
      // The receipt goes to the operator; every OTHER client learns about a
      // successful rollback from the fresh snapshot the service already sent
      // them (RollbackService step 8).
      client.send('rollbackResult', result);
    });

    // WORLD MANAGEMENT. One registration per type, one handler shape: the
    // service decides everything, including whether the key was any good.
    for (const type of WORLD_ADMIN_MESSAGE_TYPES) {
      this.onMessage(type, (client: TerraceClient, message: unknown) => {
        const request = validateWorldAdminRequest(message);
        if (request === null) return;

        // ONE CONTAINMENT FOR THE WHOLE RESPONSE (issue #210). The action is
        // already contained by the service; the LISTING REFRESHES below are
        // not, and they do filesystem and SQLite work. Colyseus dispatches
        // handlers unguarded, so a throw here would exit the process — see
        // containWorldAdminMessage for why this is a wrapper and not five
        // `.catch`es. It never rejects, hence `void`.
        void containWorldAdminMessage(
          request,
          (reply) => client.send(reply.type, reply),
          () => this.answerWorldAdminMessage(client, request),
        );
      });
    }

    // Namespaced plugin messages. ONE wildcard registration for all of them,
    // because the deliverable set must not be snapshotted here (issue #197):
    // the room outlives every world AND every plugin reload, so both the host
    // that answers and the types it claims are asked for per message — see
    // net/plugin-message-routing.ts.
    //
    // The wildcard cannot swallow a core message: Colyseus reaches '*' only
    // for a type with no handler of its own, and every core type above is
    // registered by name (see this file's header).
    this.onMessage('*', (client: TerraceClient, type: string | number, payload: unknown) => {
      if (!isPluginMessageType(type)) {
        this.rejectUnregisteredMessage(client, type);
        return;
      }
      const player = client.userData?.player;
      // As for sculpt: a message can arrive between the socket opening and
      // onJoin completing, and without a player there is nobody to attribute
      // it to.
      if (!player) return;
      routePluginMessage(() => this.context.manager.current?.host ?? null, player, type, payload);
    });

    const session = this.context.manager.current;
    logInfo(
      session === null
        ? `room "${ROOM_NAME}" created (no world loaded)`
        : `room "${ROOM_NAME}" created (world ${session.world.size}²)`,
    );
  }

  /**
   * The whole answer to one world-admin message: the action, then the listing
   * refreshes that ride along with it.
   *
   * A METHOD RATHER THAN AN INLINE HANDLER BODY so it has exactly one caller —
   * containWorldAdminMessage, in onCreate — and therefore exactly one place
   * where a throw or a rejection out of any of it can escape. Returning the
   * reload's promise instead of voiding it is what puts the async path under
   * the same containment as the synchronous one.
   */
  private answerWorldAdminMessage(
    client: TerraceClient,
    request: WorldAdminRequestMessage,
  ): void | Promise<void> {
    if (request.type === 'worldList') {
      client.send('worldListing', this.context.admin.list(client.sessionId, request.key));
      return;
    }

    if (request.type === 'worldPluginList') {
      client.send(
        'worldPluginListing',
        this.context.admin.plugins(client.sessionId, request.key, request.id),
      );
      return;
    }

    // THE ONE ACTION THAT AWAITS (issue #198): a reload imports code, so it
    // cannot be answered on this turn of the event loop. Its receipt and
    // the refreshed listings are sent from the promise, in the same order
    // and for the same reasons as the synchronous path below.
    if (request.type === 'worldPluginReload') {
      return this.context.admin
        .reloadPlugin(client.sessionId, request)
        .then((reloaded) => {
          client.send('worldAdminResult', reloaded);
          if (!reloaded.ok) return;
          client.send('worldPluginListing', this.context.admin.pluginListing(request.id));
          client.send('worldListing', this.context.admin.listing());
        });
    }

    const result = this.context.admin.handle(client.sessionId, request);
    client.send('worldAdminResult', result);
    // A toggle changed the very lists the plugin panel is showing, so the
    // fresh set rides along on success for the same reason the world
    // listing does below — and only on success, so a refusal never becomes
    // an oracle for which plugins this server runs.
    if (
      result.ok &&
      (request.type === 'worldPluginSet' || request.type === 'worldPluginConfigure')
    ) {
      client.send('worldPluginListing', this.context.admin.pluginListing(request.id));
    }
    // A successful action changed what the panel is showing, so the fresh
    // listing rides along rather than making the client ask for it. Only
    // on success, and only for a client that just proved it holds the key
    // — a refusal must not become an oracle for what worlds exist. A plugin
    // ACTION changes no listing at all (it is an event, not a file), so it
    // is spared the worlds-directory read the refresh costs.
    if (result.ok && request.type !== 'worldPluginAct') {
      client.send('worldListing', this.context.admin.listing());
    }
  }

  /**
   * What a message type nobody registered gets: exactly what Colyseus itself
   * would have done before the wildcard above existed.
   *
   * A '*' handler REPLACES the framework's `__no_message_handler` fallback
   * (@colyseus/core 0.17.50 Room.mjs lines 994-1000: '*' is consulted first,
   * and the fallback only when there is no '*'), so registering the wildcard
   * would silently turn a hostile or broken client's unknown-type spam from a
   * disconnect into a free no-op. This keeps that behaviour rather than
   * relaxing it as a side effect of issue #197: an error in dev mode so the
   * developer sees the typo, a disconnect otherwise (Room.mjs lines 94-103).
   */
  private rejectUnregisteredMessage(client: TerraceClient, type: string | number): void {
    const reason = `${UNREGISTERED_MESSAGE_REASON_PREFIX}"${type}" not registered.`;
    if (isDevMode) {
      client.error(ErrorCode.INVALID_PAYLOAD, reason);
    } else {
      client.leave(CloseCode.WITH_ERROR, reason);
    }
  }

  /**
   * ORDERING CONTRACT: 'snapshot' MUST be the first message a joining client
   * receives. It carries worldSize, so a client cannot size its local mirror —
   * and therefore cannot place a chunk — before it arrives; a 'chunkUnlock' or
   * 'terrainDiff' that overtook it would be dropped, and that terrain would
   * silently never render.
   *
   * That contract holds because of a fact verified in @colyseus/core 0.17.50
   * (`Room.mjs` `_onJoin`): the framework does `this.clients.push(client)` and
   * only THEN `await this.onJoin(...)`. From the push to the send below there
   * is no `await`, so no timer callback — notably the process tick loop, which
   * can broadcast a plugin's chunkUnlock — can interleave and reach a client
   * that has not yet been sized.
   *
   * The `: void` return type is therefore LOAD-BEARING, not decoration: it
   * narrows the base class's `void | Promise<any>`, so making this method
   * `async` (or awaiting anything before the send) is a compile error rather
   * than a silent, timing-dependent bug in the client's renderer.
   */
  override onJoin(client: TerraceClient, options?: { name?: unknown; token?: unknown }): void {
    const player: Player = {
      id: client.sessionId,
      // DURABLE IDENTITY (issue #17): a client-generated opaque token, sent as
      // a join option, sanitized exactly like the display name below — bad
      // input degrades to a session-scoped fallback rather than blocking the
      // join. This is what per-player unlock masks are keyed by, so it must
      // be resolved before anything below reads it.
      token: sanitizePlayerToken(options?.token, client.sessionId),
      name: sanitizePlayerName(options?.name, client.sessionId),
    };
    // Recorded on the CONNECTION first, and unconditionally: this is the
    // roster a world switch carries across, and a player who joins while
    // nothing is loaded has to be in it (see RoomBridge.players).
    client.userData = { player };

    const session = this.context.manager.current;
    if (session === null) {
      // Nothing to render yet. The client is told so explicitly rather than
      // left waiting on a snapshot that is not coming; when a world is loaded
      // it will receive one without having to reconnect.
      client.send('worldUnloaded', { type: 'worldUnloaded' });
      logInfo(`player "${player.name}" joined; no world is loaded`);
      return;
    }

    session.world.addPlayer(player);

    // Every token starts in the same home square, and this has to land BEFORE
    // the snapshot below is built: a RETURNING token already has these bits
    // set (see World.seedChunkForToken), so this only ever adds anything for
    // a token this world has never seen.
    applyInitialUnlockForToken(session.world, player.token);

    // ANTI-CHEAT: the join snapshot carries ONLY chunks unlocked FOR THIS
    // TOKEN (issue #17 decision 2) — never the union of everything anyone has
    // ever unlocked, or one adventurous player's progress would leak into
    // every other join. A client is never sent terrain it has not personally
    // been granted, so there is nothing in its memory to reveal (design doc,
    // "anti-cheat by omission").
    // World IDENTITY rides along with the geometry: the name and the difficulty
    // rating are both constant for the life of the world, so the join snapshot
    // is the only message that ever needs to carry them (design 2026-08-14).
    const snapshot = buildJoinSnapshot(session.world, session.host, player.token);
    client.send('snapshot', snapshot);

    // Only AFTER the snapshot: a plugin's onPlayerJoin may broadcast or unlock
    // chunks, and the new client must already be sized to receive that.
    session.host.playerJoined(player);
    logInfo(`player "${player.name}" joined (${snapshot.chunks.length} chunks sent)`);
  }

  /**
   * Reports a plugin's invalid `modify`, at most once per
   * PLUGIN_REWRITE_FAILURE_LOG_INTERVAL_MS.
   *
   * WARN, not ERROR: core handled it correctly (the intent was refused and the
   * sender was told), and the thing that needs fixing is in a plugin.
   */
  private notePluginRewriteFailure(detail?: string): void {
    const nowMs = Date.now();
    if (nowMs - this.lastPluginRewriteLogMs < PLUGIN_REWRITE_FAILURE_LOG_INTERVAL_MS) return;
    this.lastPluginRewriteLogMs = nowMs;
    logWarn(
      'a plugin rewrote a sculpt intent into one core had to refuse ' +
        `(${detail ?? 'failed re-validation'}); those players cannot sculpt until it is fixed`,
    );
  }

  override onLeave(client: TerraceClient): void {
    // Failed-attempt records are keyed by connection id, so they are dropped
    // with the connection. BOTH gates, because the two operator keys keep
    // their own lockout state.
    this.context.admin.forgetClient(client.sessionId);
    const session = this.context.manager.current;
    session?.rollback.forgetClient(client.sessionId);
    // Same reasoning for the sculpt bucket: keyed by connection id, so it is
    // dropped with the connection and the map stays bounded by the roster.
    this.sculptRate.forgetClient(client.sessionId);

    const player = session?.world.removePlayer(client.sessionId);
    if (player) {
      session?.host.playerLeft(player);
      logInfo(`player "${player.name}" left`);
    }
  }

  override onDispose(): void {
    // Detach the world from a room that no longer exists, so any later
    // broadcast (e.g. from a plugin tick) is a no-op instead of a throw.
    this.context.manager.detachRoom(NULL_SINK);
    this.context.restart.detachRoom();
  }

  /** Everyone connected, as the manager's roster. See RoomBridge.players. */
  private roster(): readonly Player[] {
    const players: Player[] = [];
    for (const client of this.clients) {
      const player = (client as TerraceClient).userData?.player;
      if (player) players.push(player);
    }
    return players;
  }

  /** Bridges the World's transport-agnostic sink onto this room. */
  private createSink(): MessageSink {
    return {
      broadcast: (type: string, payload: unknown): void => {
        this.broadcast(type, payload);
      },
      sendTo: (playerId: string, type: string, payload: unknown): void => {
        // Silently ignores an unknown id: the player may have just left, and a
        // plugin should not have to race the disconnect.
        this.clients.getById(playerId)?.send(type, payload);
      },
    };
  }
}
