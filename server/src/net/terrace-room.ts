import { CloseCode, ErrorCode, Room, isDevMode } from '@colyseus/core';
import {
  PERF_HITCH_MESSAGE_TYPE,
  PERF_LOGGING_MESSAGE_TYPE,
  PERF_LOGGING_STATE_MESSAGE_TYPE,
  validatePerfHitch,
  STACK_RESTART_MESSAGE_TYPE,
  validatePerfLoggingRequest,
  type PerfLoggingStateMessage,
  validateStackRestartRequest,
  validateWorldAdminRequest,
} from '@terrace/shared';
import { logError, logInfo } from '../log.ts';
import { sanitizePlayerName, sanitizePlayerToken, type Player } from '../player.ts';
import { applyInitialUnlockForToken } from '../world/initial-unlock.ts';
import { perfLogLine } from '../perf-log.ts';
import { setTickTimingEnabled } from '../tick-timing.ts';
import { containWorldAdminMessage } from '../world/world-admin.ts';
import { buildJoinSnapshot } from './join-snapshot.ts';
import { isPluginMessageType, routePluginMessage } from './plugin-message-routing.ts';
import { NULL_SINK, type MessageSink } from './message-sink.ts';
import { SculptRateLimiter } from './sculpt-rate-limit.ts';
import {
  LogThrottle,
  ROOM_FAILURE_LOG_INTERVAL_MS,
  containRoomMessage,
} from './contain-message.ts';
import {
  ROOM_NAME,
  RESTORE_POINTS_MESSAGE_TYPE,
  ROLLBACK_MESSAGE_TYPE,
  SCULPT_MESSAGE_TYPE,
  WORLD_ADMIN_MESSAGE_TYPES,
  boundRoomContext,
  type RoomContext,
  type TerraceClient,
} from './room-contract.ts';
import { handleSculptMessage, refuseSculptMessage } from './room-sculpt-handler.ts';
import {
  handleRestorePointsMessage,
  handleRollbackMessage,
  refuseRestorePointsMessage,
  refuseRollbackMessage,
} from './room-rollback-handlers.ts';
import { answerWorldAdminMessage } from './room-world-admin-handler.ts';

export {
  ROOM_NAME,
  SCULPT_MESSAGE_TYPE,
  RESTORE_POINTS_MESSAGE_TYPE,
  ROLLBACK_MESSAGE_TYPE,
  WORLD_ADMIN_MESSAGE_TYPES,
  bindRoomContext,
} from './room-contract.ts';
export type {
  RoomContext,
  TerraceClient,
  TerraceServerMessages,
} from './room-contract.ts';

const UNREGISTERED_MESSAGE_REASON_PREFIX = 'room onMessage for ';
const HITCH_PREFIX = '[hitch]';
const HITCH_MS_DECIMALS = 1;
/** Hitch lines share the main perf-stamp cadence; per-event would flood. */
const HITCH_REPORT_INTERVAL_MS = 10_000;

interface HitchSummary {
  count: number;
  worstMs: number;
  typicalMs: number;
}

export class TerraceRoom extends Room<{ client: TerraceClient }> {
  private context!: RoomContext;

  private readonly sculptRate = new SculptRateLimiter();

  private readonly hitchByPlayer = new Map<string, HitchSummary>();

  private hitchReport: ReturnType<typeof setInterval> | undefined;

  private readonly pluginRewriteLog = new LogThrottle(ROOM_FAILURE_LOG_INTERVAL_MS);

  override onCreate(): void {
    const context = boundRoomContext();
    if (context === null) {
      throw new Error('room created before bindRoomContext() — boot order bug');
    }
    this.context = context;

    this.autoDispose = false;

    this.patchRate = null;

    const sink = this.createSink();
    this.context.manager.attachRoom({
      sink,
      clientCount: () => this.clients.length,
      players: () => this.roster(),
    });
    this.context.restart.attachRoom({ sink, clientCount: () => this.clients.length });

    this.registerMessages();

    const session = this.context.manager.current;
    logInfo(
      session === null
        ? `room "${ROOM_NAME}" created (no world loaded)`
        : `room "${ROOM_NAME}" created (world ${session.world.size}²)`,
    );
  }

  private registerMessages(): void {
    const sculptDeps = {
      manager: this.context.manager,
      rate: this.sculptRate,
      rewriteLog: this.pluginRewriteLog,
    };
    this.containedMessage(
      SCULPT_MESSAGE_TYPE,
      (client, message) => handleSculptMessage(sculptDeps, client, message),
      (client, message) => refuseSculptMessage(sculptDeps, client, message),
    );

    const rollbackDeps = { manager: this.context.manager };
    this.containedMessage(
      RESTORE_POINTS_MESSAGE_TYPE,
      (client, message) => handleRestorePointsMessage(rollbackDeps, client, message),
      (client) => refuseRestorePointsMessage(client),
    );

    this.containedMessage(
      ROLLBACK_MESSAGE_TYPE,
      (client, message) => handleRollbackMessage(rollbackDeps, client, message),
      (client) => refuseRollbackMessage(client),
    );

    this.containedMessage(STACK_RESTART_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      if (validateStackRestartRequest(message) === null) return;
      logInfo(`stack restart requested by ${client.sessionId}`);
      this.context.restart.request('stack');
    });

    this.containedMessage(PERF_LOGGING_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
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

    this.containedMessage(PERF_HITCH_MESSAGE_TYPE, (client: TerraceClient, message: unknown) => {
      if (!this.context.perfLogging.enabled) return;
      const hitch = validatePerfHitch(message);
      if (hitch === null) return;
      const player = client.userData?.player;
      if (!player) return;
      const summary = this.hitchByPlayer.get(player.name) ?? {
        count: 0,
        worstMs: 0,
        typicalMs: hitch.typicalMs,
      };
      summary.count += 1;
      summary.worstMs = Math.max(summary.worstMs, hitch.intervalMs);
      summary.typicalMs = hitch.typicalMs;
      this.hitchByPlayer.set(player.name, summary);
    });

    const adminDeps = { manager: this.context.manager, admin: this.context.admin };
    for (const type of WORLD_ADMIN_MESSAGE_TYPES) {
      // containWorldAdminMessage answers in each request's own refusal shape,
      // including for the async paths this wrapper cannot see.
      this.containedMessage(type, (client: TerraceClient, message: unknown) => {
        const request = validateWorldAdminRequest(message);
        if (request === null) return;

        void containWorldAdminMessage(
          request,
          (reply) => client.send(reply.type, reply),
          () => answerWorldAdminMessage(adminDeps, client, request),
        );
      });
    }

    const anyMessageLog = new LogThrottle(ROOM_FAILURE_LOG_INTERVAL_MS);
    this.onMessage('*', (client: TerraceClient, type: string | number, payload: unknown) => {
      containRoomMessage(String(type), anyMessageLog, () => {
        if (!isPluginMessageType(type)) {
          this.rejectUnregisteredMessage(client, type);
          return;
        }
        const player = client.userData?.player;
        if (!player) return;
        routePluginMessage(() => this.context.manager.current?.host ?? null, player, type, payload);
      });
    });
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

  /** Every room handler is registered here, so no throw of theirs can reach the process. */
  private containedMessage(
    type: string,
    handle: (client: TerraceClient, message: unknown) => void,
    refuse?: (client: TerraceClient, message: unknown) => void,
  ): void {
    const throttle = new LogThrottle(ROOM_FAILURE_LOG_INTERVAL_MS);
    this.onMessage(type, (client: TerraceClient, message: unknown) => {
      containRoomMessage(
        type,
        throttle,
        () => handle(client, message),
        refuse === undefined ? undefined : () => refuse(client, message),
      );
    });
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
    if (this.hitchReport !== undefined) clearInterval(this.hitchReport);
    this.hitchReport = undefined;
  }

  private reportHitches(): void {
    for (const [name, summary] of this.hitchByPlayer) {
      perfLogLine(
        `${HITCH_PREFIX} ${name} ${summary.count} gaps, ` +
          `worst ${summary.worstMs.toFixed(HITCH_MS_DECIMALS)}ms ` +
          `(typical ${summary.typicalMs.toFixed(HITCH_MS_DECIMALS)}ms)`,
      );
    }
    this.hitchByPlayer.clear();
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
