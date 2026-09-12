import { CloseCode, ErrorCode, Room, isDevMode, type Client } from '@colyseus/core';
import {
  PERF_HITCH_MESSAGE_TYPE,
  PERF_LOGGING_MESSAGE_TYPE,
  PERF_LOGGING_STATE_MESSAGE_TYPE,
  validatePerfHitch,
  STACK_RESTART_MESSAGE_TYPE,
  validatePerfLoggingRequest,
  type PerfLoggingStateMessage,
  validateRestorePointsRequest,
  validateRollbackRequest,
  validateStackRestartRequest,
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
import { logError, logInfo, logWarn } from '../log.ts';
import { sanitizePlayerName, sanitizePlayerToken, type Player } from '../player.ts';
import { handleSculptIntent } from '../intent/pipeline.ts';
import { applyInitialUnlockForToken } from '../world/initial-unlock.ts';
import type { ServerRestartService } from '../restart.ts';
import type { PerfLoggingSetting } from '../perf-logging-setting.ts';
import { perfLogLine } from '../perf-log.ts';
import { setTickTimingEnabled } from '../tick-timing.ts';
import { containWorldAdminMessage, type WorldAdminService } from '../world/world-admin.ts';
import type { WorldManager } from '../world/world-manager.ts';
import { buildJoinSnapshot, buildShowAllSnapshot } from './join-snapshot.ts';
import { isPluginMessageType, routePluginMessage } from './plugin-message-routing.ts';
import { NULL_SINK, type MessageSink } from './message-sink.ts';
import { SculptRateLimiter } from './sculpt-rate-limit.ts';

export const ROOM_NAME = 'world';

export const SCULPT_MESSAGE_TYPE = 'sculpt';

export const RESTORE_POINTS_MESSAGE_TYPE = 'restorePoints';
export const ROLLBACK_MESSAGE_TYPE = 'rollback';

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
  'worldView',
] as const;

const UNREGISTERED_MESSAGE_REASON_PREFIX = 'room onMessage for ';
const HITCH_PREFIX = '[hitch]';
const HITCH_MS_DECIMALS = 1;

const PLUGIN_REWRITE_FAILURE_LOG_INTERVAL_MS = 10_000;

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
  perfLoggingState: PerfLoggingStateMessage;
  [pluginMessage: string]: unknown;
}

export type TerraceClient = Client<{
  userData: { player: Player };
  messages: TerraceServerMessages;
}>;

export interface RoomContext {
  readonly manager: WorldManager;
  readonly admin: WorldAdminService;
  readonly restart: ServerRestartService;
  readonly perfLogging: PerfLoggingSetting;
}

let processRoomContext: RoomContext | null = null;

export function bindRoomContext(context: RoomContext): void {
  processRoomContext = context;
}

export class TerraceRoom extends Room<{ client: TerraceClient }> {
  private context!: RoomContext;

  private readonly sculptRate = new SculptRateLimiter();

  private lastPluginRewriteLogMs = Number.NEGATIVE_INFINITY;

  override onCreate(): void {
    if (processRoomContext === null) {
      throw new Error('room created before bindRoomContext() — boot order bug');
    }
    this.context = processRoomContext;

    this.autoDispose = false;

    this.patchRate = null;

    const sink = this.createSink();
    this.context.manager.attachRoom({
      sink,
      clientCount: () => this.clients.length,
      players: () => this.roster(),
    });
    this.context.restart.attachRoom({ sink, clientCount: () => this.clients.length });

    this.onMessage(SCULPT_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      if (!this.sculptRate.allow(client.sessionId)) return;
      const player = client.userData?.player;
      if (!player) return;
      const session = this.context.manager.current;
      if (session === null) return;
      const outcome = handleSculptIntent(
        { world: session.world, interceptors: session.host },
        player,
        message,
      );
      if (!outcome.applied && outcome.reason === 'plugin-modified-invalid') {
        this.notePluginRewriteFailure(outcome.detail);
      }
    });

    this.onMessage(RESTORE_POINTS_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      const request = validateRestorePointsRequest(message);
      if (request === null) return;
      const session = this.context.manager.current;
      if (session === null) {
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

    this.onMessage(STACK_RESTART_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      if (validateStackRestartRequest(message) === null) return;
      logInfo(`stack restart requested by ${client.sessionId}`);
      this.context.restart.request('stack');
    });

    this.onMessage(PERF_LOGGING_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      const request = validatePerfLoggingRequest(message);
      if (request === null) return;
      const { perfLogging } = this.context;
      try {
        perfLogging.set(request.enabled);
      } catch (error) {
        logError('could not store the performance logging setting', error);
        return;
      }
      logInfo(`performance logging ${request.enabled ? 'enabled' : 'disabled'} by ${client.sessionId}`);
      setTickTimingEnabled(request.enabled);
      this.broadcast(PERF_LOGGING_STATE_MESSAGE_TYPE, this.perfLoggingState());
    });

    this.onMessage(PERF_HITCH_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      if (!this.context.perfLogging.enabled) return;
      const hitch = validatePerfHitch(message);
      if (hitch === null) return;
      const player = client.userData?.player;
      if (!player) return;
      perfLogLine(
        `${HITCH_PREFIX} ${player.name} frame gap ${hitch.intervalMs.toFixed(HITCH_MS_DECIMALS)}ms` +
          ` (typical ${hitch.typicalMs.toFixed(HITCH_MS_DECIMALS)}ms)`,
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
      client.send('rollbackResult', result);
    });

    for (const type of WORLD_ADMIN_MESSAGE_TYPES) {
      this.onMessage(type, (client: TerraceClient, message: unknown) => {
        const request = validateWorldAdminRequest(message);
        if (request === null) return;

        void containWorldAdminMessage(
          request,
          (reply) => client.send(reply.type, reply),
          () => this.answerWorldAdminMessage(client, request),
        );
      });
    }

    this.onMessage('*', (client: TerraceClient, type: string | number, payload: unknown) => {
      if (!isPluginMessageType(type)) {
        this.rejectUnregisteredMessage(client, type);
        return;
      }
      const player = client.userData?.player;
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

  private answerWorldAdminMessage(
    client: TerraceClient,
    request: WorldAdminRequestMessage,
  ): void | Promise<void> {
    if (request.type === 'worldList') {
      client.send('worldListing', this.context.admin.list(client.sessionId, request.key));
      return;
    }

    if (request.type === 'worldView') {
      const refusal = this.context.admin.authorize(client.sessionId, request.key);
      if (refusal !== null) {
        client.send('worldAdminResult', {
          type: 'worldAdminResult',
          action: 'view',
          ok: false,
          refused: refusal,
        });
        return;
      }
      const session = this.context.manager.current;
      const player = client.userData?.player;
      if (session === null || player === undefined) {
        client.send('worldAdminResult', {
          type: 'worldAdminResult',
          action: 'view',
          ok: false,
          refused: 'failed',
        });
        return;
      }
      const snapshot =
        request.scope === 'all'
          ? buildShowAllSnapshot(session.world, session.host)
          : buildJoinSnapshot(session.world, session.host, player.token);
      client.send('snapshot', snapshot);
      client.send('worldAdminResult', {
        type: 'worldAdminResult',
        action: 'view',
        ok: true,
        detail: request.scope,
      });
      logInfo(
        `player "${player.name}" set world view to ${request.scope} ` +
          `(${snapshot.chunks.length} chunks sent)`,
      );
      return;
    }

    if (request.type === 'worldPluginList') {
      client.send(
        'worldPluginListing',
        this.context.admin.plugins(client.sessionId, request.key, request.id),
      );
      return;
    }

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
    if (
      result.ok &&
      (request.type === 'worldPluginSet' || request.type === 'worldPluginConfigure')
    ) {
      client.send('worldPluginListing', this.context.admin.pluginListing(request.id));
    }
    if (result.ok && request.type !== 'worldPluginAct') {
      client.send('worldListing', this.context.admin.listing());
    }
  }

  private rejectUnregisteredMessage(client: TerraceClient, type: string | number): void {
    const reason = `${UNREGISTERED_MESSAGE_REASON_PREFIX}"${type}" not registered.`;
    if (isDevMode) {
      client.error(ErrorCode.INVALID_PAYLOAD, reason);
    } else {
      client.leave(CloseCode.WITH_ERROR, reason);
    }
  }

  override onJoin(client: TerraceClient, options?: { name?: unknown; token?: unknown }): void {
    const player: Player = {
      id: client.sessionId,
      token: sanitizePlayerToken(options?.token, client.sessionId),
      name: sanitizePlayerName(options?.name, client.sessionId),
    };
    client.userData = { player };
    client.send(PERF_LOGGING_STATE_MESSAGE_TYPE, this.perfLoggingState());

    const session = this.context.manager.current;
    if (session === null) {
      client.send('worldUnloaded', { type: 'worldUnloaded' });
      logInfo(`player "${player.name}" joined; no world is loaded`);
      return;
    }

    session.world.addPlayer(player);

    applyInitialUnlockForToken(session.world, player.token);

    const snapshot = buildJoinSnapshot(session.world, session.host, player.token);
    client.send('snapshot', snapshot);

    session.host.playerJoined(player);
    logInfo(`player "${player.name}" joined (${snapshot.chunks.length} chunks sent)`);
  }

  private perfLoggingState(): PerfLoggingStateMessage {
    const { perfLogging } = this.context;
    return { type: PERF_LOGGING_STATE_MESSAGE_TYPE, enabled: perfLogging.enabled };
  }

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
    this.context.admin.forgetClient(client.sessionId);
    const session = this.context.manager.current;
    session?.rollback.forgetClient(client.sessionId);
    this.sculptRate.forgetClient(client.sessionId);

    const player = session?.world.removePlayer(client.sessionId);
    if (player) {
      session?.host.playerLeft(player);
      logInfo(`player "${player.name}" left`);
    }
  }

  override onDispose(): void {
    this.context.manager.detachRoom(NULL_SINK);
    this.context.restart.detachRoom();
  }

  private roster(): readonly Player[] {
    const players: Player[] = [];
    for (const client of this.clients) {
      const player = (client as TerraceClient).userData?.player;
      if (player) players.push(player);
    }
    return players;
  }

  private createSink(): MessageSink {
    return {
      broadcast: (type: string, payload: unknown): void => {
        this.broadcast(type, payload);
      },
      sendTo: (playerId: string, type: string, payload: unknown): void => {
        this.clients.getById(playerId)?.send(type, payload);
      },
    };
  }
}
