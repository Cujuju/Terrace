// RESTART AS AN OPERATOR ACTION — "the update button".
//
// WHY THIS EXISTS. Node's ESM module map has no eviction: an imported module is
// permanent for the life of the realm, so the PROCESS is the unit of code
// identity and a restart is the only way new plugin (or core) code becomes
// live. Research: docs/plans/plugin-hot-unload.md §1.2, §3.1, §6 Option A.
// Nothing is lost by it — the existing shutdown path writes the final snapshot,
// the active pointer is deliberately left alone so the same world comes back,
// and every client reconnects silently with its territory intact.
//
// THE EXIT SEQUENCE IS THE WHOLE POINT OF THIS FILE, and it has exactly one
// correct order, verified against @colyseus/core 0.17.50
// (`build/Server.mjs:172-189`):
//
//   1. await gracefullyShutdown(FALSE)   — runs onBeforeShutdown (which stops
//      the tick loop and writes the final snapshot), then the matchmaker and
//      transport teardown, and RETURNS.
//   2. process.exit(TERRACE_RESTART_EXIT_CODE)
//
// The `false` is mandatory, not stylistic: `gracefullyShutdown(exit = true)`
// ends in `process.exit(err && !isDevMode ? 1 : 0)` and never returns, so with
// the default argument step 2 is unreachable and the distinguished exit code
// this whole feature keys on could only ever be 0 or 1.

import { logError, logInfo } from './log.ts';
import type { MessageSink } from './net/message-sink.ts';
import { CLIENTS_ABOVE_WHICH_TO_ANNOUNCE } from './world/world-manager.ts';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * The exit code that means "I was asked to restart; bring me back".
 *
 * 75 is `EX_TEMPFAIL` from BSD `sysexits.h` — "temporary failure, the caller
 * should retry" — which is precisely what a restart request is: this process
 * is not broken and its work is not finished, it simply needs to be run again.
 *
 * WHY NOT SOMETHING ELSE. It must be in 1–255 (anything above wraps), and it
 * must not collide with a code the supervisor already has a meaning for:
 *   0    clean exit — the supervisor tears the stack down (Ctrl-C, `q`);
 *   1    boot failure (index.ts's `main().catch`) — a real crash;
 *   2    conventionally a shell/usage error;
 *   128+N a signalled death (130 SIGINT, 143 SIGTERM), which is what a reaped
 *        process produces and must stay distinguishable from a request.
 * 75 sits clear of all of them and says what it means to anyone who knows
 * sysexits, which is the audience reading a supervisor log.
 */
export const TERRACE_RESTART_EXIT_CODE = 75;

/**
 * The exit code that means "I was asked to restart, AND SO WAS THE CLIENT DEV
 * SERVER beside me; bring us both back".
 *
 * The next code up from TERRACE_RESTART_EXIT_CODE, chosen by the same
 * argument: 1–255, and clear of 0 / 1 / 2 / 128+N. (76 is `EX_PROTOCOL` in
 * sysexits.h; the borrowed meaning stops at 75 — this one is simply "the
 * other restart".) A supervisor that knows only 75 treats 76 as an ordinary
 * exit, which under docker `restart: unless-stopped` and systemd
 * `Restart=always` is still a restart of the one process they run, so the
 * code degrades to a plain server restart where there is no client half.
 *
 * WHY A SECOND CODE AND NOT A FLAG FILE OR A SIGNAL: the exit code is the one
 * channel the server already has to its supervisor, it is read exactly where
 * the relaunch decision is made (run_server.py's wait loop), and it cannot go
 * stale — it exists only in the instant the process ends.
 */
export const TERRACE_STACK_RESTART_EXIT_CODE = 76;

/**
 * What a restart takes down. 'server' is the keyed update button: this process
 * only, the client dev server left running. 'stack' is the keyless dev-loop
 * button (shared/src/protocol.ts's StackRestartRequestMessage): this process
 * AND the client dev server, so client code that changed on disk arrives too.
 */
export type RestartScope = 'server' | 'stack';

/** The exit code that tells the supervisor which scope was asked for. */
export function restartExitCodeFor(scope: RestartScope): number {
  return scope === 'stack' ? TERRACE_STACK_RESTART_EXIT_CODE : TERRACE_RESTART_EXIT_CODE;
}

/** What the restart needs from the process, injected so it can be tested. */
export interface ServerRestartHooks {
  /**
   * `gameServer.gracefullyShutdown(false)` — MUST be the non-exiting form, and
   * MUST resolve (see this file's header for why both halves matter).
   */
  shutdown(): Promise<void>;
  /** Ends the process. Separate from `shutdown` so the order is visible here. */
  exit(code: number): void;
  /**
   * Seconds a restart is announced for when somebody other than the operator
   * is connected; 0 disables announcing. Shares WORLD_SWITCH_COUNTDOWN_S with
   * the world switch on purpose: it is the same courtesy to the same people
   * for the same reason, and two knobs for one decision is two knobs to set
   * inconsistently.
   */
  countdownS: number;
  /**
   * Defers a callback to the next turn of the event loop. Injected rather than
   * called directly so a test can run the restart without a real timer — see
   * `fire` for why the deferral is load-bearing.
   */
  defer(run: () => void): void;
}

/** The transport half, attached by the room exactly as WorldManager's is. */
export interface ServerRestartBridge {
  /** How the notice reaches clients. */
  readonly sink: MessageSink;
  /** Connected clients right now — decides announce-vs-immediate. */
  clientCount(): number;
}

/** What a restart request decided, for the operator's receipt. */
export interface ServerRestartOutcome {
  /** 0 when the process is going down immediately. */
  readonly secondsRemaining: number;
}

/** Why a restart could not be started. */
export type ServerRestartRefusal = 'restartInProgress';

export class ServerRestartService {
  private readonly hooks: ServerRestartHooks;
  private bridge: ServerRestartBridge | null = null;
  /** Non-null between the announcement and the shutdown; also the re-entry guard. */
  private pending: { secondsRemaining: number; timer: NodeJS.Timeout } | null = null;
  /** Set the instant the shutdown is committed to, announced or not. */
  private firing = false;
  /**
   * What the restart in flight takes down; decides the exit code. Held on the
   * service rather than threaded through the countdown, because the countdown
   * is one timer that must not care why it is counting.
   */
  private scope: RestartScope = 'server';

  constructor(hooks: ServerRestartHooks) {
    this.hooks = hooks;
  }

  /** Connects the room's transport and roster. See ServerRestartBridge. */
  attachRoom(bridge: ServerRestartBridge): void {
    this.bridge = bridge;
  }

  /** Disconnects it; a notice then has nowhere to go and is dropped. */
  detachRoom(): void {
    this.bridge = null;
  }

  /**
   * Starts a restart, announcing it first when anybody other than the operator
   * is connected.
   *
   * Returns the receipt synchronously — the shutdown itself is always deferred
   * (see `fire`), so the caller's answer reaches the operator either way.
   */
  request(scope: RestartScope = 'server'): ServerRestartOutcome | ServerRestartRefusal {
    if (this.pending !== null || this.firing) return 'restartInProgress';
    this.scope = scope;

    const countdown = this.hooks.countdownS;
    const others = this.bridge?.clientCount() ?? 0;
    if (countdown <= 0 || others <= CLIENTS_ABOVE_WHICH_TO_ANNOUNCE) {
      // The terminal notice is sent for the unannounced case too, so a client
      // never has to tell "restarting now" from the end of a countdown.
      this.notify(0);
      logInfo('restart requested — shutting down now');
      this.fire();
      return { secondsRemaining: 0 };
    }

    const timer = setInterval(() => {
      this.countDown();
    }, MILLISECONDS_PER_SECOND);
    this.pending = { secondsRemaining: countdown, timer };
    this.notify(countdown);
    logInfo(`restart announced; ${countdown}s`);
    return { secondsRemaining: countdown };
  }

  /** One second of the announced countdown. */
  private countDown(): void {
    if (this.pending === null) return;
    this.pending.secondsRemaining -= 1;
    if (this.pending.secondsRemaining > 0) {
      this.notify(this.pending.secondsRemaining);
      return;
    }

    clearInterval(this.pending.timer);
    this.pending = null;
    // TERMINAL NOTICE FIRST, before the shutdown blocks on writing a snapshot
    // — the same reason the world switch sends its own before swapping: without
    // it every client sits frozen at "in 1s" until the socket closes.
    this.notify(0);
    logInfo('restart countdown finished — shutting down');
    this.fire();
  }

  /**
   * The exit sequence. Deferred by one turn of the event loop, deliberately:
   * the operator's receipt and the notice above are already queued on their
   * sockets, and closing the transport in the same turn would take them with
   * it. This is also the ONLY place `process.exit` is reached from, so the
   * order in this file's header is the order that runs.
   */
  private fire(): void {
    this.firing = true;
    this.hooks.defer(() => {
      void this.shutdownThenExit();
    });
  }

  private async shutdownThenExit(): Promise<void> {
    try {
      await this.hooks.shutdown();
    } catch (error) {
      // A shutdown that threw has already had its snapshot attempt logged by
      // onBeforeShutdown. Exiting anyway is right: the operator asked for a
      // restart, and a process that refuses to go down is worse than one that
      // comes back having lost the last minute of an idle world.
      logError('graceful shutdown before restart failed; exiting anyway', error);
    }
    const code = restartExitCodeFor(this.scope);
    const what = this.scope === 'stack' ? 'this server and its client dev server' : 'this server';
    logInfo(`exiting ${code} so the supervisor restarts ${what}`);
    this.hooks.exit(code);
  }

  /** Tells every connected client, or nobody when no room is attached. */
  private notify(secondsRemaining: number): void {
    this.bridge?.sink.broadcast('serverRestartNotice', {
      type: 'serverRestartNotice',
      secondsRemaining,
    });
  }
}
