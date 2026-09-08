import { logError, logInfo } from './log.ts';
import type { MessageSink } from './net/message-sink.ts';
import { CLIENTS_ABOVE_WHICH_TO_ANNOUNCE } from './world/world-manager.ts';

const MILLISECONDS_PER_SECOND = 1000;

export const TERRACE_RESTART_EXIT_CODE = 75;

export const TERRACE_STACK_RESTART_EXIT_CODE = 76;

export type RestartScope = 'server' | 'stack';

export function restartExitCodeFor(scope: RestartScope): number {
  return scope === 'stack' ? TERRACE_STACK_RESTART_EXIT_CODE : TERRACE_RESTART_EXIT_CODE;
}

export interface ServerRestartHooks {
  shutdown(): Promise<void>;
  exit(code: number): void;
  countdownS: number;
  defer(run: () => void): void;
}

export interface ServerRestartBridge {
  readonly sink: MessageSink;
  clientCount(): number;
}

export interface ServerRestartOutcome {
  readonly secondsRemaining: number;
}

export type ServerRestartRefusal = 'restartInProgress';

export class ServerRestartService {
  private readonly hooks: ServerRestartHooks;
  private bridge: ServerRestartBridge | null = null;
  private pending: { secondsRemaining: number; timer: NodeJS.Timeout } | null = null;
  private firing = false;
  private scope: RestartScope = 'server';

  constructor(hooks: ServerRestartHooks) {
    this.hooks = hooks;
  }

  attachRoom(bridge: ServerRestartBridge): void {
    this.bridge = bridge;
  }

  detachRoom(): void {
    this.bridge = null;
  }

  request(scope: RestartScope = 'server'): ServerRestartOutcome | ServerRestartRefusal {
    if (this.pending !== null || this.firing) return 'restartInProgress';
    this.scope = scope;

    const countdown = this.hooks.countdownS;
    const others = this.bridge?.clientCount() ?? 0;
    if (countdown <= 0 || others <= CLIENTS_ABOVE_WHICH_TO_ANNOUNCE) {
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

  private countDown(): void {
    if (this.pending === null) return;
    this.pending.secondsRemaining -= 1;
    if (this.pending.secondsRemaining > 0) {
      this.notify(this.pending.secondsRemaining);
      return;
    }

    clearInterval(this.pending.timer);
    this.pending = null;
    this.notify(0);
    logInfo('restart countdown finished — shutting down');
    this.fire();
  }

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
      logError('graceful shutdown before restart failed; exiting anyway', error);
    }
    const code = restartExitCodeFor(this.scope);
    const what = this.scope === 'stack' ? 'this server and its client dev server' : 'this server';
    logInfo(`exiting ${code} so the supervisor restarts ${what}`);
    this.hooks.exit(code);
  }

  private notify(secondsRemaining: number): void {
    this.bridge?.sink.broadcast('serverRestartNotice', {
      type: 'serverRestartNotice',
      secondsRemaining,
    });
  }
}
