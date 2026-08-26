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
//   2. PLUGIN HANDLERS ARE REGISTERED BY TYPE, RESOLVED PER MESSAGE. The set
//      of plugin message types is fixed at boot (the plugin set is), so the
//      registration can happen once; WHICH host answers depends on which world
//      is loaded, so the lookup happens per message — see
//      PluginHost.messageTypesFor.

import { Room, type Client } from '@colyseus/core';
import {
  validateRestorePointsRequest,
  validateRollbackRequest,
  validateWorldAdminRequest,
  type ChunkUnlockMessage,
  type JoinSnapshotMessage,
  type RestorePointListMessage,
  type RollbackResultMessage,
  type TerrainDiffMessage,
  type WorldAdminResultMessage,
  type WorldListMessage,
  type WorldSwitchNoticeMessage,
  type WorldUnloadedMessage,
} from '@terrace/shared';
import { logInfo } from '../log.ts';
import { sanitizePlayerName, sanitizePlayerToken, type Player } from '../player.ts';
import { handleSculptIntent } from '../intent/pipeline.ts';
import { applyInitialUnlockForToken } from '../world/initial-unlock.ts';
import type { WorldAdminService } from '../world/world-admin.ts';
import type { WorldManager } from '../world/world-manager.ts';
import { buildJoinSnapshot } from './join-snapshot.ts';
import { NULL_SINK, type MessageSink } from './message-sink.ts';

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
  'worldSwitchCancel',
] as const;

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
  worldSwitchNotice: WorldSwitchNoticeMessage;
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
  /**
   * Namespaced plugin message types, from PluginHost.messageTypesFor. Passed
   * in rather than read off a host because the room is created before — and
   * may exist without — any world being loaded.
   */
  readonly pluginMessageTypes: readonly string[];
}

/**
 * The process-wide room context. Colyseus's matchmaker constructs rooms itself,
 * so dependencies have to reach them somehow; a module-level binding is honest
 * about the design (one world LIVE per process — §3.2) and, more importantly,
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
    this.context.manager.attachRoom({
      sink: this.createSink(),
      clientCount: () => this.clients.length,
      players: () => this.roster(),
    });

    this.onMessage(SCULPT_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      const player = client.userData?.player;
      // A message can arrive between the socket opening and onJoin completing;
      // without a player there is no intent to attribute, so it is dropped.
      if (!player) return;
      const session = this.context.manager.current;
      // Nothing loaded: a sculpt has no world to land in. Dropped in silence,
      // like every other rejected intent (see the pipeline's comment on why
      // telling a client WHY an intent failed leaks the unlock mask).
      if (session === null) return;
      handleSculptIntent(
        { world: session.world, interceptors: session.host },
        player,
        message,
      );
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

        if (request.type === 'worldList') {
          client.send('worldListing', this.context.admin.list(client.sessionId, request.key));
          return;
        }

        const result = this.context.admin.handle(client.sessionId, request);
        client.send('worldAdminResult', result);
        // A successful action changed what the panel is showing, so the fresh
        // listing rides along rather than making the client ask for it. Only
        // on success, and only for a client that just proved it holds the key
        // — a refusal must not become an oracle for what worlds exist.
        if (result.ok) client.send('worldListing', this.context.admin.listing());
      });
    }

    // Namespaced plugin handlers. Registered once by TYPE at create; the
    // handler is resolved per message against whichever host is current, so a
    // world switch cannot leave a message going to the previous world's
    // plugins (see this file's header).
    for (const type of this.context.pluginMessageTypes) {
      this.onMessage(type, (client: TerraceClient, payload: unknown) => {
        const player = client.userData?.player;
        if (!player) return;
        const handler = this.context.manager.current?.host.handlerFor(type);
        if (handler === undefined) return;
        handler(player, payload);
      });
    }

    const session = this.context.manager.current;
    logInfo(
      session === null
        ? `room "${ROOM_NAME}" created (no world loaded)`
        : `room "${ROOM_NAME}" created (world ${session.world.size}²)`,
    );
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
    // been granted, so there is nothing in its memory to reveal (design §3.4,
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

  override onLeave(client: TerraceClient): void {
    // Failed-attempt records are keyed by connection id, so they are dropped
    // with the connection. BOTH gates, because the two operator keys keep
    // their own lockout state.
    this.context.admin.forgetClient(client.sessionId);
    const session = this.context.manager.current;
    session?.rollback.forgetClient(client.sessionId);

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
