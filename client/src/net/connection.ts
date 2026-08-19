// Colyseus connection: join the world room, route the three terrain messages,
// send sculpt intents.
//
// CRITICAL CODE — this is the client half of the sync contract (design doc
// §3.2). Notes on the API, verified against the installed @colyseus/sdk
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
//     (`ReconnectionOptions.enabled = true`): the SDK transparently
//     re-establishes a dropped connection, replaying enqueued messages, and
//     fires `onDrop` / `onReconnect` around it. Phase 1 deliberately adds NO
//     retry logic on top of that; see RETRY POLICY below.
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
  SculptDeniedMessage,
  SculptIntent,
  TerrainDiffMessage,
} from '@terrace/shared';
import { ROOM_NAME, SERVER_URL } from '../config.ts';
import { getOrCreatePlayerToken } from '../state/playerToken.ts';
import {
  MSG_CHUNK_UNLOCK,
  MSG_SCULPT,
  MSG_SCULPT_DENIED,
  MSG_SNAPSHOT,
  MSG_TERRAIN_DIFF,
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
}

export interface ConnectionOptions {
  sink: TerrainSink;
  onStatus: (status: ConnectionStatus) => void;
  /**
   * Receives every namespaced plugin message (`<plugin>:<type>`, identified
   * by the colon — core message names never contain one). The client plugin
   * host routes these to the plugin that owns the namespace.
   */
  onPluginMessage?: (type: string, payload: unknown) => void;
  /** Overridable for tests / alternate deployments. */
  serverUrl?: string;
  roomName?: string;
}

export interface Connection {
  /**
   * Sends a sculpt intent if a room is joined; a no-op otherwise. Dropping
   * intents while offline is correct — the server is authoritative and there
   * is nothing to replay them against.
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
  /** Leaves the room and stops retrying. */
  dispose(): void;
}

export function connect(options: ConnectionOptions): Connection {
  const client = new Client(options.serverUrl ?? SERVER_URL);
  const roomName = options.roomName ?? ROOM_NAME;

  let room: Room | null = null;
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

  const wireRoom = (joined: Room): void => {
    room = joined;
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
    // automatic reconnection, so they only move the status dot — there is
    // nothing for us to do in between.
    joined.onDrop(() => setStatus('reconnecting'));
    joined.onReconnect(() => setStatus('connected'));

    // onLeave fires when the session is finished for good, including after
    // the SDK's reconnection attempts are exhausted. That is the one case
    // where we take the retry loop back over.
    joined.onLeave(() => {
      room = null;
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
      const joined = await client.joinOrCreate(roomName, {
        token: getOrCreatePlayerToken(),
      });
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
      if (room === null) return false;
      room.send(MSG_SCULPT, intent);
      return true;
    },
    sendPlugin(type: string, payload: unknown): void {
      // Dropping while offline mirrors sendSculpt: plugin messages are
      // requests against live server state; there is nothing to replay
      // them against after a reconnect.
      room?.send(type, payload);
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
