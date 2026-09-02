// Colyseus connection: join the world room, route the three terrain messages,
// send sculpt intents.
//
// CRITICAL CODE — this is the client half of the sync contract (design
// doc). Notes on the API, verified against the installed @colyseus/sdk
// 0.17.43 sources (build/Client.d.ts, build/Room.d.ts) rather than from
// memory:
//
//   * The package was renamed colyseus.js → @colyseus/sdk at 0.17; `Client` is
//     an alias of the `ColyseusSDK` class.
//   * `new Client(settings?: string | EndpointSettings)` parses a string with
//     `new URL()` and treats `wss:`/`https:` as secure, so `ws://host:port` is
//     a supported endpoint form.
//   * `joinOrCreate<State>(roomName, options?)` → `Promise<Room>`; it REJECTS
//     if the server is unreachable, which is the case the retry loop below
//     exists for.
//   * `room.onMessage(type, cb)` returns an unsubscribe function.
//   * `room.send(type, payload)` msgpack-encodes the payload.
//   * `room.reconnection` is real, built-in and enabled by default
//     (`ReconnectionOptions.enabled = true`): the SDK retries a dropped
//     socket on its own and fires `onDrop` / `onReconnect` around it. Phase 1
//     deliberately adds NO retry logic on top of that; see RETRY POLICY below.
//   * While the socket is down `room.send()` does NOT fail — it enqueues
//     (Room.mjs:150-151 `if (!this.connection.isOpen) enqueueMessage(...)`)
//     into a ring that silently drops its oldest entry when full
//     (Room.mjs:363-367). Against THIS server those enqueued messages can
//     never be flushed: nothing calls `allowReconnection`, and
//     `TerraceRoom.onLeave` tears the player down synchronously, so the
//     rejoin finds neither a reserved seat nor a live client to match the
//     reconnection token (@colyseus/core Room.mjs:670-687) and throws
//     MATCHMAKE_EXPIRED. `onReconnect` therefore never fires here; the SDK
//     exhausts its retries and fires `onLeave` instead, discarding the room
//     object and everything queued in it. Hence the `dropped` gate below —
//     a send while dropped is a send into a bucket with a hole in it, and
//     must be reported as not sent.
//
// RETRY POLICY. The SDK's automatic reconnection only covers a room that was
// successfully joined. It cannot cover the first connection — if no server is
// listening yet, `joinOrCreate` simply rejects. So this module owns exactly
// one retry loop, for establishing a session, and re-enters it if the SDK
// eventually gives up on a dropped room. Per the project's UI rule, failure is
// never surfaced as a dialog or a retry button: the app boots into an empty
// sea with the HUD's status dot showing "offline", and reconnects silently
// whenever the server appears.

import { Client, type Room } from '@colyseus/sdk';
import type {
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  RestorePointListMessage,
  RollbackResultMessage,
  SculptAppliedMessage,
  SculptDeniedMessage,
  SculptIntent,
  ServerRestartNoticeMessage,
  TerrainDiffMessage,
  WorldAdminRequestMessage,
  WorldAdminResultMessage,
  WorldListMessage,
  WorldPluginListMessage,
  WorldSwitchNoticeMessage,
  WorldUnloadedMessage,
} from '@terrace/shared';
import { ROOM_NAME, SERVER_URL } from '../config.ts';
import { getOrCreatePlayerToken } from '../state/playerToken.ts';
import {
  MSG_CHUNK_UNLOCK,
  MSG_RESTORE_POINT_LIST,
  MSG_RESTORE_POINTS,
  MSG_ROLLBACK,
  MSG_ROLLBACK_RESULT,
  MSG_SCULPT,
  MSG_SCULPT_APPLIED,
  MSG_SCULPT_DENIED,
  MSG_SERVER_RESTART_NOTICE,
  MSG_SNAPSHOT,
  MSG_TERRAIN_DIFF,
  MSG_WORLD_ADMIN_RESULT,
  MSG_WORLD_LISTING,
  MSG_WORLD_PLUGIN_LISTING,
  MSG_WORLD_SWITCH_NOTICE,
  MSG_WORLD_UNLOADED,
} from './messageNames.ts';

/**
 * Backoff bounds for establishing the FIRST connection (and for re-entering
 * after the SDK's own reconnection has given up).
 *
 * 400 ms first retry: during development the usual order is "client already
 * running, server just started", and a sub-half-second reconnect makes that
 * feel automatic rather than like something the user must act on. Doubling to
 * a 5 s ceiling bounds a client left open against a dead server to 12
 * requests a minute — negligible, and still responsive when the server
 * returns. Deliberately independent of the SDK's own defaults, which govern a
 * different situation (a live session that blipped).
 */
const RECONNECT_MIN_DELAY_MS = 400;
const RECONNECT_MAX_DELAY_MS = 5000;
const RECONNECT_BACKOFF_FACTOR = 2;

export type ConnectionStatus =
  /** No session; retrying quietly in the background. */
  | 'offline'
  /** A join attempt is in flight. */
  | 'connecting'
  /** Joined; messages flowing. */
  | 'connected'
  /** Was connected, connection dropped, the SDK is re-establishing it. */
  | 'reconnecting';

/** Where inbound terrain messages go. Implemented by the terrain layer. */
export interface TerrainSink {
  onSnapshot(msg: JoinSnapshotMessage): void;
  onChunkUnlock(msg: ChunkUnlockMessage): void;
  onTerrainDiff(msg: TerrainDiffMessage): void;
  /** A plugin denied our intent with this seq: retire its prediction NOW. */
  onSculptDenied(msg: SculptDeniedMessage): void;
  /**
   * The server applied our intent with this seq and has already sent
   * everything that describes it: retire its prediction NOW. The authoritative
   * result is in the mirror by the time this arrives (see the ordering
   * contract on SculptAppliedMessage), so the swap is invisible.
   */
  onSculptApplied(msg: SculptAppliedMessage): void;
}

/**
 * Where the two operator answers go (world rollback). Separate from
 * TerrainSink because these are not terrain: a restore-point list changes
 * nothing in the world, and the rollback that DOES change it arrives as an
 * ordinary `snapshot` on the terrain sink instead.
 */
export interface OperatorSink {
  onRestorePointList(msg: RestorePointListMessage): void;
  onRollbackResult(msg: RollbackResultMessage): void;
}

/**
 * Where world-management answers go (multi-world, 2026-08-22).
 *
 * SEPARATE FROM OperatorSink even though both are operator traffic, because
 * they are gated by DIFFERENT KEYS and a client may legitimately have one and
 * not the other. Keeping them apart means the world panel cannot accidentally
 * be wired to a rollback key, or vice versa.
 *
 * `onWorldSwitchNotice` and `onWorldUnloaded` are the two that arrive
 * UNSOLICITED, at every client rather than just the operator: a switch
 * countdown and "there is no world" are things a player has to be told even
 * though they never asked for anything.
 */
export interface WorldAdminSink {
  onWorldListing(msg: WorldListMessage): void;
  /** One world's installed/disabled plugins, answering a `worldPluginList`. */
  onWorldPluginListing(msg: WorldPluginListMessage): void;
  onWorldAdminResult(msg: WorldAdminResultMessage): void;
  onWorldSwitchNotice(msg: WorldSwitchNoticeMessage): void;
  onWorldUnloaded(msg: WorldUnloadedMessage): void;
  /**
   * The server process is about to restart. Unsolicited, at every client, for
   * `onWorldSwitchNotice`'s reason: somebody who never pressed anything is
   * about to lose the server for a few seconds and has to be told.
   */
  onServerRestartNotice(msg: ServerRestartNoticeMessage): void;
}

export interface ConnectionOptions {
  sink: TerrainSink;
  /** Optional: a client with no rollback panel needs no operator routing. */
  operator?: OperatorSink;
  /** Optional: a client with no world panel needs no world-admin routing. */
  worldAdmin?: WorldAdminSink;
  onStatus: (status: ConnectionStatus) => void;
  /**
   * Receives every namespaced plugin message (`<plugin>:<type>`, identified
   * by the colon — core message names never contain one). The client plugin
   * host routes these to the plugin that owns the namespace.
   */
  onPluginMessage?: (type: string, payload: unknown) => void;
  /**
   * Receives JoinSnapshotMessage.livePlugins on every snapshot — the plugin
   * set the server is actually running. `undefined` when the server did not
   * say (too old to announce); the client plugin host treats that as "leave
   * what is mounted alone".
   *
   * Separate from the terrain sink because a plugin set is not terrain: it is
   * routed off the same message only because a plugin toggle reopens the world
   * and a reopen is what re-sends that message.
   */
  onLivePlugins?: (names: readonly string[] | undefined) => void;
  /** Overridable for tests / alternate deployments. */
  serverUrl?: string;
  roomName?: string;
}

export interface Connection {
  /**
   * Sends a sculpt intent if a room is joined AND its socket is up; a no-op
   * otherwise, including while the SDK is reconnecting a dropped room (the
   * room object outlives the socket, and a send then is only enqueued into a
   * queue that never flushes — see the module header). Dropping intents while
   * offline is correct — the server is authoritative and there is nothing to
   * replay them against.
   *
   * Returns whether the intent actually went out. This is load-bearing for
   * client-side prediction, not a convenience: a prediction is only ever
   * reconciled by the authoritative diff that answers its intent, so predicting
   * an intent that was never sent would leave the local terrain permanently
   * ahead of the server (until the deadline in terrain/prediction.ts drags it
   * back). The caller predicts if and only if this returns true.
   */
  sendSculpt(intent: SculptIntent): boolean;
  /**
   * Sends an already-namespaced plugin message (`<plugin>:<type>`); a no-op
   * while offline. The client plugin host is the only intended caller — a
   * plugin itself goes through its ctx, which owns the namespacing.
   */
  sendPlugin(type: string, payload: unknown): void;
  /**
   * Asks the server for its restore points (world rollback). No-op while
   * offline, like every other send here — there is nothing to list.
   *
   * The key is passed through on every request rather than exchanged once for
   * a session token: the server holds no per-connection authorisation state
   * beyond a failed-attempt count, which is what keeps the whole gate one
   * comparison in one place (server/src/world/rollback.ts).
   */
  requestRestorePoints(key: string): void;
  /** Asks the server to roll the world back to `toId`. No-op while offline. */
  requestRollback(key: string, toId: number): void;
  /**
   * Sends any world-management request. No-op while offline.
   *
   * ONE METHOD FOR ELEVEN MESSAGES, not eleven wrappers: every one of them is
   * "send this object under its own `type`", so a wrapper per action would be
   * eleven copies of one line — and eleven chances for one of them to send the
   * wrong name. The message is already a validated protocol object built by
   * the panel, and its `type` IS the wire name (see messageNames.ts).
   */
  sendWorldAdmin(message: WorldAdminRequestMessage): void;
  /** Leaves the room and stops retrying. */
  dispose(): void;
}

export function connect(options: ConnectionOptions): Connection {
  const client = new Client(options.serverUrl ?? SERVER_URL);
  const roomName = options.roomName ?? ROOM_NAME;

  let room: Room | null = null;
  // True between the SDK's onDrop and the end of that room's life. The room
  // object outlives the socket, so `room !== null` is NOT evidence that a
  // send reaches the server; this is.
  let dropped = false;
  let disposed = false;
  let retryDelay = RECONNECT_MIN_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (status: ConnectionStatus): void => {
    if (!disposed) options.onStatus(status);
  };

  const scheduleRetry = (): void => {
    if (disposed || retryTimer !== null) return;
    setStatus('offline');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelay = Math.min(
        retryDelay * RECONNECT_BACKOFF_FACTOR,
        RECONNECT_MAX_DELAY_MS,
      );
      void attemptJoin();
    }, retryDelay);
  };

  // THE ONE GATE every sender goes through. Kept as a helper rather than a
  // check repeated in each of the five senders below, because the failure it
  // prevents is silent: a sender that forgets it does not throw, it enqueues
  // into the SDK's ring and looks like it worked.
  //
  // RESIDUAL FAILURE MODE, documented rather than papered over: between the
  // physical link loss and the browser firing the socket's close event,
  // `isOpen` is still true and `dropped` is still false, so sends in that
  // window go into a dead socket and are treated as delivered. Closing it
  // would take a per-intent server ack and a timeout; the window is bounded
  // by the browser's own close detection.
  const live = (): Room | null => (room !== null && !dropped ? room : null);

  const wireRoom = (joined: Room): void => {
    room = joined;
    // A fresh join is the only thing that actually clears this here (see the
    // header: onReconnect cannot fire against this server), so clear it where
    // the new room is adopted, not only where the old one ended.
    dropped = false;
    // Reset the backoff: the next outage should retry promptly again.
    retryDelay = RECONNECT_MIN_DELAY_MS;

    // Terrain routing. Payloads arrive already msgpack-decoded. They are
    // trusted only as far as the shared helpers allow — writeChunkHeights
    // validates the chunk coords, payload length, and every height, and the
    // diff loop bounds-checks each cell's coords and height the same way —
    // so a malformed message cannot corrupt the mirror; mirror.ts catches and
    // drops (with a console warning) any chunk that still fails validation,
    // rather than letting it throw out of this handler.
    joined.onMessage<JoinSnapshotMessage>(MSG_SNAPSHOT, (msg) => {
      options.sink.onSnapshot(msg);
      // AFTER the terrain: a plugin mounting on this message must find the
      // world it is being mounted over already sized and filled, exactly as
      // the server sends the snapshot before it runs onPlayerJoin.
      options.onLivePlugins?.(msg.livePlugins);
    });
    joined.onMessage<ChunkUnlockMessage>(MSG_CHUNK_UNLOCK, (msg) => {
      options.sink.onChunkUnlock(msg);
    });
    joined.onMessage<TerrainDiffMessage>(MSG_TERRAIN_DIFF, (msg) => {
      options.sink.onTerrainDiff(msg);
    });
    joined.onMessage<SculptDeniedMessage>(MSG_SCULPT_DENIED, (msg) => {
      options.sink.onSculptDenied(msg);
    });
    joined.onMessage<SculptAppliedMessage>(MSG_SCULPT_APPLIED, (msg) => {
      options.sink.onSculptApplied(msg);
    });

    // Operator routing (world rollback). Registered unconditionally so the
    // handler set does not depend on which options were passed; with no
    // operator sink the answers are simply dropped, which is the right
    // outcome for a client that never asked.
    joined.onMessage<RestorePointListMessage>(MSG_RESTORE_POINT_LIST, (msg) => {
      options.operator?.onRestorePointList(msg);
    });
    joined.onMessage<RollbackResultMessage>(MSG_ROLLBACK_RESULT, (msg) => {
      options.operator?.onRollbackResult(msg);
    });

    // World-management routing. Registered unconditionally, like the rollback
    // answers above, so the handler set never depends on which options were
    // passed; with no world-admin sink the answers are dropped.
    joined.onMessage<WorldListMessage>(MSG_WORLD_LISTING, (msg) => {
      options.worldAdmin?.onWorldListing(msg);
    });
    joined.onMessage<WorldPluginListMessage>(MSG_WORLD_PLUGIN_LISTING, (msg) => {
      options.worldAdmin?.onWorldPluginListing(msg);
    });
    joined.onMessage<WorldAdminResultMessage>(MSG_WORLD_ADMIN_RESULT, (msg) => {
      options.worldAdmin?.onWorldAdminResult(msg);
    });
    joined.onMessage<WorldSwitchNoticeMessage>(MSG_WORLD_SWITCH_NOTICE, (msg) => {
      options.worldAdmin?.onWorldSwitchNotice(msg);
    });
    joined.onMessage<WorldUnloadedMessage>(MSG_WORLD_UNLOADED, (msg) => {
      options.worldAdmin?.onWorldUnloaded(msg);
    });
    joined.onMessage<ServerRestartNoticeMessage>(MSG_SERVER_RESTART_NOTICE, (msg) => {
      options.worldAdmin?.onServerRestartNotice(msg);
    });

    // Plugin routing. Plugin messages are namespaced `<plugin>:<type>` by the
    // server host, and no core message name contains a colon, so the colon IS
    // the discriminator. The SDK's '*' handler fires for every message
    // (including ones with specific handlers above); the filter keeps core
    // traffic from being delivered twice.
    joined.onMessage('*', (type: string | number, payload: unknown) => {
      if (typeof type === 'string' && type.includes(':')) {
        options.onPluginMessage?.(type, payload);
      }
    });

    // Connection lifecycle. `onDrop`/`onReconnect` bracket the SDK's own
    // automatic reconnection. They move the status dot AND flip the send gate:
    // in between, the room object is still here but the socket is not, and a
    // send would only be enqueued into a queue that never flushes.
    joined.onDrop(() => {
      dropped = true;
      setStatus('reconnecting');
    });
    joined.onReconnect(() => {
      dropped = false;
      setStatus('connected');
    });

    // onLeave fires when the session is finished for good, including after
    // the SDK's reconnection attempts are exhausted. That is the one case
    // where we take the retry loop back over.
    joined.onLeave(() => {
      room = null;
      // Cleared with the room, so a drop that ended in onLeave cannot leave a
      // stale `true` gating the next session's sends.
      dropped = false;
      if (!disposed) scheduleRetry();
    });

    // onError is a server-side room error, not a transport failure; the room
    // stays open, so this only needs to not be silent to a developer.
    joined.onError((code, message) => {
      console.warn(`[terrace] room error ${code}: ${message ?? ''}`);
    });

    setStatus('connected');
  };

  const attemptJoin = async (): Promise<void> => {
    if (disposed || room !== null) return;
    setStatus('connecting');
    try {
      // DURABLE IDENTITY (issue #17): the same opaque token on every join —
      // first connection, reconnect, or a later session on this browser —
      // is what lets the server hand back the same per-player unlock mask.
      // The server sanitizes this defensively (server/src/player.ts) and
      // degrades a bad/missing value to a session-scoped identity, so a
      // malformed token here can never block the join, only cost this
      // session its territory memory.
      // Token acquisition must never kill the join: a throw here used to be
      // swallowed by the catch below as "server not up" and retried forever —
      // an unconditional, silent Offline (the secure-context randomUUID bug,
      // reproduced on LAN-served dev pages). Omitting the token instead lets
      // the server degrade this session to a session-scoped identity: worse
      // (territory memory lost) but connected, and the loss is loggable.
      const joinOptions: { token?: string } = {};
      try {
        joinOptions.token = getOrCreatePlayerToken();
      } catch (error) {
        console.warn('player token unavailable — joining with session-scoped identity', error);
      }
      const joined = await client.joinOrCreate(roomName, joinOptions);
      if (disposed) {
        void joined.leave();
        return;
      }
      wireRoom(joined);
    } catch {
      // Expected whenever the server is not up yet. Deliberately not surfaced
      // to the user: the status dot already says offline and we keep trying.
      scheduleRetry();
    }
  };

  void attemptJoin();

  return {
    sendSculpt(intent: SculptIntent): boolean {
      const open = live();
      if (open === null) return false;
      open.send(MSG_SCULPT, intent);
      return true;
    },
    requestRestorePoints(key: string): void {
      live()?.send(MSG_RESTORE_POINTS, { type: MSG_RESTORE_POINTS, key });
    },
    requestRollback(key: string, toId: number): void {
      live()?.send(MSG_ROLLBACK, { type: MSG_ROLLBACK, key, toId });
    },
    sendWorldAdmin(message: WorldAdminRequestMessage): void {
      live()?.send(message.type, message);
    },
    sendPlugin(type: string, payload: unknown): void {
      // Dropping while offline mirrors sendSculpt: plugin messages are
      // requests against live server state; there is nothing to replay
      // them against after a reconnect.
      live()?.send(type, payload);
    },
    dispose(): void {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      void room?.leave();
      room = null;
    },
  };
}
