// THE WORLD MANAGER — which world is loaded, and how one becomes another.
//
// CRITICAL CODE. Loading a world closes the one that is live, so this file
// owns the moment at which a world stops being in memory. Its guarantees:
//
//   1. THE OUTGOING WORLD IS SAVED BEFORE IT IS CLOSED, unconditionally, and a
//      failure to save ABORTS the switch. A world is never closed on the hope
//      that its last snapshot was recent enough.
//   2. THE SWAP IS SYNCHRONOUS. From the first byte written for the outgoing
//      world to the last client re-snapshotted, nothing else runs — no tick,
//      no timer, no message. JavaScript's single thread is what makes that
//      true, and it is why there is no "swapping" flag to forget to check.
//   3. NOBODY IS LEFT LOOKING AT A WORLD THAT IS NO LONGER LOADED. Every
//      connected player is re-added to the incoming world, re-seeded, and sent
//      a fresh join snapshot before the switch returns.
//   4. A FAILED LOAD LEAVES NO WORLD LOADED, NEVER A HALF-LOADED ONE. If the
//      incoming world cannot be opened, the server ends up with nothing live
//      and says so, because the alternative — reopening the outgoing world and
//      pretending — hides a corrupt file until it is the only file left.
//
// WHY A COUNTDOWN EXISTS. With the operator alone on the server there is
// nobody to warn, and the swap is immediate. With others connected, pulling
// the ground out from under someone mid-sculpt is hostile, so the switch is
// announced, counted down (WORLD_SWITCH_COUNTDOWN_S), and only then applied —
// and it can be called off during the count.

import type { MessageSink } from '../net/message-sink.ts';
import type { WorldSwitchStatus } from '@terrace/shared';
import { buildJoinSnapshot } from '../net/join-snapshot.ts';
import { logError, logInfo, logWarn } from '../log.ts';
import type { Player } from '../player.ts';
import { applyInitialUnlockForToken } from './initial-unlock.ts';
import {
  closeSession,
  createWorldFile,
  openSession,
  snapshotIfDirty,
  type SessionDeps,
  type WorldSession,
} from './session.ts';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Connected clients above which a switch is announced and counted down rather
 * than applied at once.
 *
 * ONE, not zero: the operator who pressed the button is themselves a connected
 * client, and counting down at them — while they watch the panel they just
 * used — is a delay with no audience. The moment a SECOND person is present,
 * somebody who did not press the button is about to lose their view, and that
 * is exactly who the announcement is for.
 */
const CLIENTS_ABOVE_WHICH_TO_ANNOUNCE = 1;

/** What the manager needs from the Colyseus room, without importing Colyseus. */
export interface RoomBridge {
  /** How the live world reaches clients; re-attached to every new session. */
  readonly sink: MessageSink;
  /** Connected clients right now — decides announce-vs-immediate. */
  clientCount(): number;
  /**
   * Everyone connected, from the ROOM's own record rather than from a World.
   *
   * THE ROOM IS THE ROSTER, and it has to be: a player can connect while no
   * world is loaded at all, in which case there is no World holding them and
   * nothing to carry into the world that is loaded next. Reading the roster
   * from the outgoing world would silently strand exactly those players.
   */
  players(): readonly Player[];
}

export interface WorldManagerDeps extends SessionDeps {
  /** WORLD_SWITCH_COUNTDOWN_S; 0 disables announcements entirely. */
  readonly switchCountdownS: number;
}

/** Why a load could not even be attempted. Widened into WorldAdminRefusal. */
export type LoadRefusal = 'unknownWorld' | 'alreadyActive' | 'switchInProgress' | 'failed';

/** A switch that has been announced and is counting down. */
interface PendingSwitch {
  readonly toId: string;
  readonly toName: string;
  secondsRemaining: number;
  readonly timer: NodeJS.Timeout;
}

export class WorldManager {
  private readonly deps: WorldManagerDeps;
  private session: WorldSession | null = null;
  private bridge: RoomBridge | null = null;
  private pending: PendingSwitch | null = null;

  constructor(deps: WorldManagerDeps) {
    this.deps = deps;
  }

  /** The loaded world, or null when none is. */
  get current(): WorldSession | null {
    return this.session;
  }

  /** Id of the loaded world, or null. */
  get activeId(): string | null {
    return this.session?.id ?? null;
  }

  /** The switch counting down right now, if there is one. */
  get pendingSwitch(): WorldSwitchStatus | null {
    if (this.pending === null) return null;
    return {
      toId: this.pending.toId,
      toName: this.pending.toName,
      secondsRemaining: this.pending.secondsRemaining,
    };
  }

  /**
   * Connects the room. Attaching also (re-)points the LIVE world at the
   * room's sink, so a room created after a world was already loaded — the
   * normal boot order — starts receiving that world's broadcasts.
   */
  attachRoom(bridge: RoomBridge): void {
    this.bridge = bridge;
    this.session?.world.setSink(bridge.sink);
  }

  /** Disconnects the room; the live world stops broadcasting anywhere. */
  detachRoom(nullSink: MessageSink): void {
    this.bridge = null;
    this.session?.world.setSink(nullSink);
  }

  /**
   * One simulation step. A no-op with no world loaded, which is what lets the
   * tick loop keep running across an unload — the loop is a property of the
   * process, not of any particular world.
   */
  tick(dt: number): void {
    // The world clock advances inside host.tick — see PluginHost.tick for why
    // it belongs with the thing that runs the simulation rather than here.
    this.session?.host.tick(dt);
  }

  /** Writes a snapshot of the live world if it changed. */
  snapshotIfDirty(): boolean {
    if (this.session === null) return false;
    return snapshotIfDirty(this.session);
  }

  /**
   * Loads the world named by the active pointer, if there is one.
   *
   * DOES NOT INVENT A WORLD when the pointer is missing or stale. Booting with
   * no world loaded is a state the server supports and reports; generating
   * fresh terrain instead is how a self-hoster ends up staring at an empty map
   * (see ACTIVE_POINTER_FILE). The first-run case — no worlds at all — is
   * handled by the boot path in index.ts, which creates one explicitly.
   */
  loadFromPointer(): boolean {
    const id = this.deps.registry.readActive();
    if (id === null) return false;
    try {
      this.openInto(id);
      return true;
    } catch (error) {
      logError(`could not load world "${id}" from the active pointer`, error);
      return false;
    }
  }

  /**
   * Creates a world without disturbing the live one. Returns its id, or null
   * when no usable id could be derived from the name.
   */
  createWorld(name: string, worldSize: number, difficulty: number): string | null {
    const id = this.deps.registry.uniqueIdFor(name);
    if (id === null) return null;
    createWorldFile(this.deps, id, name, worldSize, difficulty);
    return id;
  }

  /**
   * Makes a world live, either at once or after an announced countdown.
   *
   * Returns what it decided, so the operator's panel can say "switching in
   * 10s" rather than guessing which behaviour it got.
   */
  requestLoad(id: string): { mode: 'immediate' | 'countdown'; secondsRemaining: number } | LoadRefusal {
    if (!this.deps.registry.has(id)) return 'unknownWorld';
    if (this.session?.id === id) return 'alreadyActive';
    if (this.pending !== null) return 'switchInProgress';

    const countdown = this.deps.switchCountdownS;
    const others = this.bridge?.clientCount() ?? 0;
    if (countdown <= 0 || others <= CLIENTS_ABOVE_WHICH_TO_ANNOUNCE) {
      try {
        this.openInto(id);
      } catch (error) {
        logError(`loading world "${id}" failed`, error);
        return 'failed';
      }
      return { mode: 'immediate', secondsRemaining: 0 };
    }

    this.announceSwitch(id, countdown);
    return { mode: 'countdown', secondsRemaining: countdown };
  }

  /** Calls off a counting-down switch. Returns false when none was running. */
  cancelSwitch(): boolean {
    if (this.pending === null) return false;
    const { toId, toName, timer } = this.pending;
    clearInterval(timer);
    this.pending = null;
    this.broadcast('worldSwitchNotice', {
      type: 'worldSwitchNotice',
      toId,
      toName,
      secondsRemaining: 0,
      cancelled: true,
    });
    logInfo(`world switch to "${toId}" was cancelled`);
    return true;
  }

  /**
   * Saves and closes the live world, leaving none loaded.
   *
   * A running server with no world is a supported state: it still serves the
   * client, still answers world management, and simply has nothing to
   * simulate. Clients are told, so they stop drawing a world the server has
   * closed.
   */
  unload(): boolean {
    if (this.session === null) return false;
    const closing = this.session;
    this.session = null;
    try {
      closeSession(closing);
    } catch (error) {
      logError(`saving world "${closing.id}" while unloading it failed`, error);
    }
    this.deps.registry.writeActive(null);
    this.broadcast('worldUnloaded', { type: 'worldUnloaded' });
    logInfo(`world "${closing.id}" unloaded; no world is live`);
    return true;
  }

  /**
   * Final save on process shutdown. Separate from `unload` because it must NOT
   * clear the active pointer: the whole point of shutting down cleanly is that
   * the next boot comes back to the same world.
   */
  shutdown(): boolean {
    if (this.session === null) return false;
    this.cancelSwitch();
    const closing = this.session;
    this.session = null;
    return closeSession(closing);
  }

  /**
   * THE SWAP. See this file's four guarantees; the steps below are them.
   *
   * Synchronous from start to finish, deliberately — no `await`, no callback,
   * nothing that yields the thread — so there is no instant at which a tick,
   * a message or a timer can observe a half-swapped process.
   */
  private openInto(id: string): void {
    const outgoing = this.session;

    // STEP 1 — remember who is here. From the ROOM, not from the outgoing
    // world: a player who connected while nothing was loaded exists in the
    // room and in no World at all, and must still be carried in (see
    // RoomBridge.players).
    const players: readonly Player[] = this.bridge?.players() ?? [];

    // STEP 2 — save the outgoing world, and ABORT if that fails. The world
    // stays loaded and untouched; the operator sees a refusal and still has
    // their world. Closing anyway would trade a failed switch for a lost hour.
    if (outgoing !== null) {
      try {
        snapshotIfDirty(outgoing);
      } catch (error) {
        logError(`refusing to switch: could not save world "${outgoing.id}"`, error);
        throw error;
      }
    }

    // STEP 3 — from here the outgoing world is gone. `this.session` is cleared
    // FIRST so that if step 4 throws, the process is left with no world loaded
    // rather than with a session whose store has been closed underneath it.
    this.session = null;
    if (outgoing !== null) {
      try {
        outgoing.store.close();
      } catch (error) {
        logWarn(`closing world "${outgoing.id}" reported: ${String(error)}`);
      }
    }

    // STEP 4 — open the incoming world. A throw here leaves nothing loaded,
    // which is honest and recoverable; the operator can load something else.
    const incoming = openSession(this.deps, id);
    this.session = incoming;
    this.deps.registry.writeActive(id);

    // STEP 5 — reconnect the transport before anybody is told anything.
    if (this.bridge !== null) incoming.world.setSink(this.bridge.sink);

    // STEP 6 — carry the connected players across. Each is re-added to the
    // NEW world and given their home square there; a token that has never
    // played this world gets one for the first time, and a returning token
    // finds the territory it already had (World.seedChunkForToken is
    // idempotent). Same call, same reason, as TerraceRoom.onJoin.
    for (const player of players) {
      incoming.world.addPlayer(player);
      applyInitialUnlockForToken(incoming.world, player.token);
    }

    // STEP 7 — hand every player the world they are now in, then let the
    // plugins meet them. Snapshot FIRST and plugin-join second, matching the
    // ordering contract in TerraceRoom.onJoin: a plugin's onPlayerJoin may
    // broadcast or unlock chunks, and a client must already be sized for the
    // new world before that arrives.
    for (const player of players) {
      incoming.world.sendTo(player.id, buildJoinSnapshot(incoming.world, player.token));
    }
    for (const player of players) {
      incoming.host.playerJoined(player);
    }

    logInfo(
      `world "${id}" is live (${incoming.world.size}², "${incoming.world.name}")` +
        (outgoing === null ? '' : ` — previous world "${outgoing.id}" saved and closed`),
    );
  }

  /** Starts the announced countdown to a switch. */
  private announceSwitch(id: string, seconds: number): void {
    const summary = this.deps.registry.summaryFor(id, this.activeId);
    const toName = summary?.name ?? id;

    const tick = (): void => {
      if (this.pending === null) return;
      this.pending.secondsRemaining -= 1;

      if (this.pending.secondsRemaining > 0) {
        this.broadcast('worldSwitchNotice', {
          type: 'worldSwitchNotice',
          toId: this.pending.toId,
          toName: this.pending.toName,
          secondsRemaining: this.pending.secondsRemaining,
        });
        return;
      }

      // Time is up. Clear `pending` BEFORE the swap so a failure inside it
      // cannot leave a countdown that has already fired still showing.
      clearInterval(this.pending.timer);
      const target = this.pending.toId;
      this.pending = null;
      try {
        this.openInto(target);
      } catch (error) {
        logError(`announced switch to "${target}" failed`, error);
      }
    };

    const timer = setInterval(tick, MILLISECONDS_PER_SECOND);
    this.pending = { toId: id, toName, secondsRemaining: seconds, timer };

    this.broadcast('worldSwitchNotice', {
      type: 'worldSwitchNotice',
      toId: id,
      toName,
      secondsRemaining: seconds,
    });
    logInfo(`world switch to "${id}" announced; ${seconds}s`);
  }

  /** Broadcasts through the room, or drops the message when none is attached. */
  private broadcast(type: string, payload: unknown): void {
    this.bridge?.sink.broadcast(type, payload);
  }
}
