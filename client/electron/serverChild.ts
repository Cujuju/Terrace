// The embedded world server: Terrace's own server, run under Electron's Node as a child and supervised.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import {
  SUPERVISOR_SHUTDOWN_MESSAGE,
  TERRACE_RESTART_EXIT_CODE,
  TERRACE_STACK_RESTART_EXIT_CODE,
} from '../../server/src/supervisor-protocol.ts';
import { clientDist, isPackaged, pluginsDir, serverCwd, serverEntry } from './appEnv.ts';
import { loopbackOrigin, serverIdentityAt } from './serverProbe.ts';

const PORT_POLL_INTERVAL_MS = 250;
/** A large world loads for tens of seconds before the server listens. */
export const SERVER_READY_TIMEOUT_MS = 120_000;
/** The shutdown snapshot of a large world takes seconds; past this the child is killed. */
const GRACEFUL_STOP_TIMEOUT_MS = 15_000;
const MAX_CRASH_RESTARTS = 3;
const CRASH_BACKOFF_MS = 1_000;
/** A server that lived this long was running, not failing at boot: its crash count starts over. */
const CRASH_WINDOW_MS = 60_000;

const WORLDS_DIR_NAME = 'worlds';
const LEGACY_DB_NAME = 'world.db';
const LOG_DIR_NAME = 'logs';
const LOG_FILE_NAME = 'server.log';

export interface ServerLaunch {
  port: number;
  dataDir: string;
  rollbackKey: string;
  worldAdminKey: string;
}

export const serverLogPath = (dataDir: string): string => join(dataDir, LOG_DIR_NAME, LOG_FILE_NAME);

export class ServerSupervisor {
  private proc: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private logPath: string | null = null;
  private crashRestart: NodeJS.Timeout | null = null;
  private listening = false;
  private stopping = false;
  private crashes = 0;

  /** `launch` is read at each start, so a restart picks up changed settings; `onGaveUp` runs once crash restarts are spent. */
  constructor(
    private readonly launch: () => ServerLaunch,
    private readonly onGaveUp: (logPath: string) => void,
  ) {}

  start(): void {
    const { port, dataDir, rollbackKey, worldAdminKey } = this.launch();
    mkdirSync(join(dataDir, LOG_DIR_NAME), { recursive: true });
    const logPath = serverLogPath(dataDir);
    // One app run's output per data folder: truncated when first opened, appended across restarts.
    if (logPath !== this.logPath) {
      this.log?.end();
      this.log = createWriteStream(logPath, { flags: 'w' });
      this.logPath = logPath;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      WORLDS_DIR: join(dataDir, WORLDS_DIR_NAME),
      DB_PATH: join(dataDir, LEGACY_DB_NAME),
      // A key in the environment wins over the saved one.
      ROLLBACK_KEY: process.env['ROLLBACK_KEY'] ?? rollbackKey,
      WORLD_ADMIN_KEY: process.env['WORLD_ADMIN_KEY'] ?? worldAdminKey,
      ...(isPackaged
        ? {
            NODE_ENV: 'production',
            // A packaged build has no git history to derive its build identity from.
            TERRACE_VERSION: app.getVersion(),
            PLUGINS_DIR: pluginsDir,
            CLIENT_DIST_PATH: clientDist,
          }
        : {}),
    };
    const proc = spawn(process.execPath, [serverEntry], {
      cwd: serverCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.proc = proc;
    this.listening = false;
    const startedAt = Date.now();
    proc.stdout?.on('data', (chunk: Buffer) => this.record(chunk, process.stdout));
    proc.stderr?.on('data', (chunk: Buffer) => this.record(chunk, process.stderr));
    proc.once('exit', (code, signal) => {
      this.note(`server exited code=${String(code)} signal=${String(signal)}`);
      this.proc = null;
      this.listening = false;
      if (this.stopping) return;
      if (code === TERRACE_RESTART_EXIT_CODE || code === TERRACE_STACK_RESTART_EXIT_CODE) {
        this.start();
        return;
      }
      if (Date.now() - startedAt >= CRASH_WINDOW_MS) this.crashes = 0;
      if (this.crashes >= MAX_CRASH_RESTARTS) {
        this.onGaveUp(logPath);
        return;
      }
      this.crashes += 1;
      this.note(`restart ${this.crashes}/${MAX_CRASH_RESTARTS} after a crash`);
      this.crashRestart = setTimeout(() => {
        this.crashRestart = null;
        this.start();
      }, CRASH_BACKOFF_MS * this.crashes);
    });
  }

  /** Resolves true once a Terrace server answers on the port; false when none has within the timeout, or this one is not running. */
  async ready(): Promise<boolean> {
    const origin = loopbackOrigin(this.launch().port);
    const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
    while (Date.now() < deadline && !this.stopping) {
      if (this.proc !== null && (await serverIdentityAt(origin)) !== null) {
        this.listening = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
    }
    return false;
  }

  /** Stops the server, letting a listening one write its shutdown snapshot first. */
  async stop(): Promise<void> {
    const proc = this.proc;
    this.stopping = true;
    if (this.crashRestart !== null) clearTimeout(this.crashRestart);
    this.crashRestart = null;
    if (proc !== null) {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      // A server still loading holds nothing unsaved, and has no listener for the request yet.
      if (this.listening && proc.connected) proc.send(SUPERVISOR_SHUTDOWN_MESSAGE);
      else proc.kill();
      const timer = setTimeout(() => proc.kill('SIGKILL'), GRACEFUL_STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
    this.stopping = false;
  }

  async restart(): Promise<void> {
    await this.stop();
    this.crashes = 0;
    this.start();
  }

  /** Ends the log; call once the server has stopped for good. */
  close(): void {
    this.log?.end();
    this.log = null;
    this.logPath = null;
  }

  private record(chunk: Buffer, to: NodeJS.WriteStream): void {
    to.write(chunk);
    this.log?.write(chunk);
  }

  private note(message: string): void {
    this.record(Buffer.from(`${new Date().toISOString()} [desktop] ${message}\n`), process.stdout);
  }
}
