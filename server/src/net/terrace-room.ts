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

import { Room, type Client } from 'colyseus';
import type {
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  TerrainDiffMessage,
} from '@terrace/shared';
import { logInfo } from '../log.ts';
import { sanitizePlayerName, type Player } from '../player.ts';
import type { PluginHost } from '../plugins/host.ts';
import { handleSculptIntent } from '../intent/pipeline.ts';
import { collectUnlockedChunkPayloads } from '../world/mask-filter.ts';
import type { World } from '../world/world.ts';
import { NULL_SINK, type MessageSink } from './message-sink.ts';

/** The matchmaking name clients join. Agreed with the Phase 1 client agent. */
export const ROOM_NAME = 'world';

/** Wire name of the one client → server core message. */
export const SCULPT_MESSAGE_TYPE = 'sculpt';

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
  override onJoin(client: TerraceClient, options?: { name?: unknown }): void {
    const player: Player = {
      id: client.sessionId,
      name: sanitizePlayerName(options?.name, client.sessionId),
    };
    client.userData = { player };
    this.context.world.addPlayer(player);

    // ANTI-CHEAT: the join snapshot carries ONLY unlocked chunks. A client is
    // never sent terrain it has not been granted, so there is nothing in its
    // memory to reveal (design §3.4, "anti-cheat by omission").
    // World IDENTITY rides along with the geometry: the name and the difficulty
    // rating are both constant for the life of the world, so the join snapshot
    // is the only message that ever needs to carry them (design 2026-08-14).
    const snapshot: JoinSnapshotMessage = {
      type: 'snapshot',
      worldSize: this.context.world.size,
      worldName: this.context.world.name,
      difficulty: this.context.world.difficulty,
      chunks: collectUnlockedChunkPayloads(this.context.world),
    };
    client.send('snapshot', snapshot);

    // Only AFTER the snapshot: a plugin's onPlayerJoin may broadcast or unlock
    // chunks, and the new client must already be sized to receive that.
    this.context.host.playerJoined(player);
    logInfo(`player "${player.name}" joined (${snapshot.chunks.length} chunks sent)`);
  }

  override onLeave(client: TerraceClient): void {
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
