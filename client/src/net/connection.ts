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
import { BOOT_MARKS, markBoot } from '../bootMarks.ts';
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
  MSG_STACK_RESTART,
  MSG_SNAPSHOT,
  MSG_TERRAIN_DIFF,
  MSG_WORLD_ADMIN_RESULT,
  MSG_WORLD_LISTING,
  MSG_WORLD_PLUGIN_LISTING,
  MSG_WORLD_SWITCH_NOTICE,
  MSG_WORLD_UNLOADED,
} from './messageNames.ts';

const RECONNECT_MIN_DELAY_MS = 400;
const RECONNECT_MAX_DELAY_MS = 5000;
const RECONNECT_BACKOFF_FACTOR = 2;

export type ConnectionStatus =
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface TerrainSink {
  onSnapshot(msg: JoinSnapshotMessage): void;
  onChunkUnlock(msg: ChunkUnlockMessage): void;
  onTerrainDiff(msg: TerrainDiffMessage): void;
  onSculptDenied(msg: SculptDeniedMessage): void;
  onSculptApplied(msg: SculptAppliedMessage): void;
}

export interface OperatorSink {
  onRestorePointList(msg: RestorePointListMessage): void;
  onRollbackResult(msg: RollbackResultMessage): void;
}

export interface WorldAdminSink {
  onWorldListing(msg: WorldListMessage): void;
  onWorldPluginListing(msg: WorldPluginListMessage): void;
  onWorldAdminResult(msg: WorldAdminResultMessage): void;
  onWorldSwitchNotice(msg: WorldSwitchNoticeMessage): void;
  onWorldUnloaded(msg: WorldUnloadedMessage): void;
  onServerRestartNotice(msg: ServerRestartNoticeMessage): void;
}

export interface ConnectionOptions {
  sink: () => TerrainSink;
  operator?: OperatorSink;
  worldAdmin?: WorldAdminSink;
  onStatus: (status: ConnectionStatus) => void;
  onPluginMessage?: (type: string, payload: unknown) => void;
  onLivePlugins?: (names: readonly string[] | undefined) => void;
  serverUrl?: string;
  roomName?: string;
}

export interface Connection {
  sendSculpt(intent: SculptIntent): boolean;
  sendPlugin(type: string, payload: unknown): void;
  requestRestorePoints(key: string): void;
  requestRollback(key: string, toId: number): void;
  sendWorldAdmin(message: WorldAdminRequestMessage): void;
  sendStackRestart(): void;
  dispose(): void;
}

export function connect(options: ConnectionOptions): Connection {
  const client = new Client(options.serverUrl ?? SERVER_URL);
  const roomName = options.roomName ?? ROOM_NAME;

  let room: Room | null = null;
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

  const live = (): Room | null => (room !== null && !dropped ? room : null);

  const wireRoom = (joined: Room): void => {
    markBoot(BOOT_MARKS.roomJoined);
    room = joined;
    dropped = false;
    retryDelay = RECONNECT_MIN_DELAY_MS;

    joined.onMessage<JoinSnapshotMessage>(MSG_SNAPSHOT, (msg) => {
      markBoot(BOOT_MARKS.snapshot);
      options.sink().onSnapshot(msg);
      options.onLivePlugins?.(msg.livePlugins);
    });
    joined.onMessage<ChunkUnlockMessage>(MSG_CHUNK_UNLOCK, (msg) => {
      options.sink().onChunkUnlock(msg);
    });
    joined.onMessage<TerrainDiffMessage>(MSG_TERRAIN_DIFF, (msg) => {
      options.sink().onTerrainDiff(msg);
    });
    joined.onMessage<SculptDeniedMessage>(MSG_SCULPT_DENIED, (msg) => {
      options.sink().onSculptDenied(msg);
    });
    joined.onMessage<SculptAppliedMessage>(MSG_SCULPT_APPLIED, (msg) => {
      options.sink().onSculptApplied(msg);
    });

    joined.onMessage<RestorePointListMessage>(MSG_RESTORE_POINT_LIST, (msg) => {
      options.operator?.onRestorePointList(msg);
    });
    joined.onMessage<RollbackResultMessage>(MSG_ROLLBACK_RESULT, (msg) => {
      options.operator?.onRollbackResult(msg);
    });

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

    joined.onMessage('*', (type: string | number, payload: unknown) => {
      if (typeof type === 'string' && type.includes(':')) {
        options.onPluginMessage?.(type, payload);
      }
    });

    joined.onDrop(() => {
      dropped = true;
      setStatus('reconnecting');
    });
    joined.onReconnect(() => {
      dropped = false;
      setStatus('connected');
    });

    joined.onLeave(() => {
      room = null;
      dropped = false;
      if (!disposed) scheduleRetry();
    });

    joined.onError((code, message) => {
      console.warn(`[terrace] room error ${code}: ${message ?? ''}`);
    });

    setStatus('connected');
  };

  const attemptJoin = async (): Promise<void> => {
    if (disposed || room !== null) return;
    setStatus('connecting');
    try {
      const joinOptions: { token?: string } = {};
      try {
        joinOptions.token = getOrCreatePlayerToken();
      } catch (error) {
        console.warn('player token unavailable — joining with session-scoped identity', error);
      }
      markBoot(BOOT_MARKS.joinIssued);
      const joined = await client.joinOrCreate(roomName, joinOptions);
      if (disposed) {
        void joined.leave();
        return;
      }
      wireRoom(joined);
    } catch {
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
    sendStackRestart(): void {
      live()?.send(MSG_STACK_RESTART, { type: MSG_STACK_RESTART });
    },
    sendPlugin(type: string, payload: unknown): void {
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
