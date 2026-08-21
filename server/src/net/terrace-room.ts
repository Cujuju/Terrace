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

import { Room, type Client } from '@colyseus/core';
import {
  validateRestorePointsRequest,
  validateRollbackRequest,
  type ChunkUnlockMessage,
  type JoinSnapshotMessage,
  type RestorePointListMessage,
  type RollbackResultMessage,
  type TerrainDiffMessage,
} from '@terrace/shared';
import { logInfo } from '../log.ts';
import { sanitizePlayerName, sanitizePlayerToken, type Player } from '../player.ts';
import type { PluginHost } from '../plugins/host.ts';
import { handleSculptIntent } from '../intent/pipeline.ts';
import { applyInitialUnlockForToken } from '../world/initial-unlock.ts';
import type { RollbackService } from '../world/rollback.ts';
import type { World } from '../world/world.ts';
import { buildJoinSnapshot } from './join-snapshot.ts';
import { NULL_SINK, type MessageSink } from './message-sink.ts';

/** The matchmaking name clients join. Agreed with the Phase 1 client agent. */
export const ROOM_NAME = 'world';

/** Wire name of the one client → server core GAMEPLAY message. */
export const SCULPT_MESSAGE_TYPE = 'sculpt';

/**
 * Wire names of the two client → server core OPERATOR messages (world
 * rollback, 2026-08-21). Both carry the operator key and are answered to their
 * sender alone; neither touches the intent pipeline.
 */
export const RESTORE_POINTS_MESSAGE_TYPE = 'restorePoints';
export const ROLLBACK_MESSAGE_TYPE = 'rollback';

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
  [pluginMessage: string]: unknown;
}

export type TerraceClient = Client<{
  userData: { player: Player };
  messages: TerraceServerMessages;
}>;

/** Everything the room needs from the process. */
export interface RoomContext {
  readonly world: World;
  readonly host: PluginHost;
  /** Owns the operator gate and the rewind itself; see world/rollback.ts. */
  readonly rollback: RollbackService;
}

/**
 * The process-wide room context. Colyseus's matchmaker constructs rooms itself,
 * so dependencies have to reach them somehow; a module-level binding is honest
 * about the design (one world per process — §3.2) and, more importantly, it is
 * NOT the room's `options` object. Room options are `merge({}, clientOptions,
 * handlerOptions)` in @colyseus/core 0.17.50 — server defaults win today, but
 * the World and the plugin host must not travel on any channel a client can
 * write to at all.
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

    // One world per process (design §3.2), so exactly one room lives for the
    // whole process lifetime. Disposing it when the last player leaves would
    // tear down the sink and re-create the room on the next join for no
    // benefit — the World, not the room, owns the state.
    this.autoDispose = false;

    // No Colyseus schema state exists in Phase 1 (decision Q7: terrain never
    // travels as schema), so there is nothing to patch on an interval.
    this.patchRate = null;

    this.context.world.setSink(this.createSink());

    this.onMessage(SCULPT_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      const player = client.userData?.player;
      // A message can arrive between the socket opening and onJoin completing;
      // without a player there is no intent to attribute, so it is dropped.
      if (!player) return;
      handleSculptIntent(
        { world: this.context.world, interceptors: this.context.host },
        player,
        message,
      );
      // Rejections are intentionally silent — see the pipeline's comment on why
      // telling a client *why* an intent failed leaks the unlock mask.
    });

    // OPERATOR MESSAGES (world rollback). Deliberately NOT routed through the
    // intent pipeline: they are not intents, they carry no player attribution
    // beyond the connection they arrived on, and — unlike a sculpt — they are
    // always answered, because the operator needs to be told why a refusal
    // happened (see RollbackService.listRestorePoints).
    //
    // A player object is not required for either: the gate is the key, not the
    // identity, and demanding a joined player would only add a way for the
    // panel to fail silently. The CONNECTION id is what the failed-attempt
    // throttle is keyed by, and that exists from the moment the socket does.
    this.onMessage(RESTORE_POINTS_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      const request = validateRestorePointsRequest(message);
      if (request === null) return; // malformed: dropped, like every bad message
      client.send(
        'restorePointList',
        this.context.rollback.listRestorePoints(client.sessionId, request.key),
      );
    });

    this.onMessage(ROLLBACK_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      const request = validateRollbackRequest(message);
      if (request === null) return;
      const result = this.context.rollback.rollback(
        client.sessionId,
        request.key,
        request.toId,
      );
      // The receipt goes to the operator; every OTHER client learns about a
      // successful rollback from the fresh snapshot the service already sent
      // them (RollbackService step 7).
      client.send('rollbackResult', result);
    });

    // Namespaced plugin handlers. Registered once at create; the plugin set is
    // fixed at boot, so there is no need to unbind.
    for (const [type, handler] of this.context.host.messageHandlers()) {
      this.onMessage(type, (client: TerraceClient, payload: unknown) => {
        const player = client.userData?.player;
        if (!player) return;
        handler(player, payload);
      });
    }

    logInfo(`room "${ROOM_NAME}" created (world ${this.context.world.size}²)`);
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
    client.userData = { player };
    this.context.world.addPlayer(player);

    // Every token starts in the same home square, and this has to land BEFORE
    // the snapshot below is built: a RETURNING token already has these bits
    // set (see World.seedChunkForToken), so this only ever adds anything for
    // a token this world has never seen.
    applyInitialUnlockForToken(this.context.world, player.token);

    // ANTI-CHEAT: the join snapshot carries ONLY chunks unlocked FOR THIS
    // TOKEN (issue #17 decision 2) — never the union of everything anyone has
    // ever unlocked, or one adventurous player's progress would leak into
    // every other join. A client is never sent terrain it has not personally
    // been granted, so there is nothing in its memory to reveal (design §3.4,
    // "anti-cheat by omission").
    // World IDENTITY rides along with the geometry: the name and the difficulty
    // rating are both constant for the life of the world, so the join snapshot
    // is the only message that ever needs to carry them (design 2026-08-14).
    // Built by the shared builder, not inline: a rollback hands every client
    // this same message, and two hand-rolled copies of "which chunks may this
    // token see" is how a server starts leaking terrain (net/join-snapshot.ts).
    const snapshot = buildJoinSnapshot(this.context.world, player.token);
    client.send('snapshot', snapshot);

    // Only AFTER the snapshot: a plugin's onPlayerJoin may broadcast or unlock
    // chunks, and the new client must already be sized to receive that.
    this.context.host.playerJoined(player);
    logInfo(`player "${player.name}" joined (${snapshot.chunks.length} chunks sent)`);
  }

  override onLeave(client: TerraceClient): void {
    // The failed-attempt record is keyed by connection id, so it is dropped
    // with the connection — see RollbackService.forgetClient.
    this.context.rollback.forgetClient(client.sessionId);
    const player = this.context.world.removePlayer(client.sessionId);
    if (player) {
      this.context.host.playerLeft(player);
      logInfo(`player "${player.name}" left`);
    }
  }

  override onDispose(): void {
    // Detach the world from a room that no longer exists, so any later
    // broadcast (e.g. from a plugin tick) is a no-op instead of a throw.
    this.context.world.setSink(NULL_SINK);
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
