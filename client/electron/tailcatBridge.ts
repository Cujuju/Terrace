// The tailcat helper (tools/tailcat-bridge) as a child: sharing this machine's world at a tailcat address.
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { bridgePath } from './appEnv.ts';
import type { TailcatShare } from './contract.ts';

/** Estimate: a DERP map fetch, relay pick and connect on a slow link, with margin. */
const BRIDGE_READY_TIMEOUT_MS = 30_000;
/** How much of the helper's stderr a failure quotes. */
const STDERR_TAIL_CHARS = 500;

interface Bridge {
  proc: ChildProcess;
  /** The helper's one ready line. */
  ready: Record<string, unknown>;
}

/**
 * Starts the helper and waits for its ready line. stdin stays open: the helper exits when
 * it closes, so it dies with this process.
 */
function spawnBridge(args: string[]): Promise<Bridge> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bridgePath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const settle = (err: Error | null, ready?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err !== null) {
        proc.kill();
        reject(err);
      } else resolve({ proc, ready: ready ?? {} });
    };
    const timer = setTimeout(() => settle(new Error('The tailcat helper did not start in time.')), BRIDGE_READY_TIMEOUT_MS);
    proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS); });
    proc.once('error', (err: NodeJS.ErrnoException) =>
      settle(new Error(err.code === 'ENOENT' ? `The tailcat helper is missing at ${bridgePath}.` : err.message)),
    );
    proc.once('exit', (code) => settle(new Error(`The tailcat helper exited (code ${String(code)}). ${stderr}`.trim())));
    if (proc.stdout === null) return settle(new Error('The tailcat helper has no output.'));
    createInterface({ input: proc.stdout }).once('line', (line) => {
      let ready: Record<string, unknown>;
      try {
        ready = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return settle(new Error(`The tailcat helper said: ${line}`));
      }
      if (typeof ready['error'] === 'string') return settle(new Error(ready['error']));
      settle(null, ready);
    });
  });
}

/** Shares the local server over tailcat while wanted. The key file keeps the address across runs. */
export class TailcatHost {
  private share: TailcatShare = { phase: 'off' };
  private running: { proc: ChildProcess; port: number } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly keyFile: string;
  private readonly onChange: () => void;

  constructor(keyFile: string, onChange: () => void) {
    this.keyFile = keyFile;
    this.onChange = onChange;
  }

  current(): TailcatShare {
    return this.share;
  }

  /** Shares `port` when `want`, else stops; a changed port restarts the helper. */
  sync(want: boolean, port: number): Promise<void> {
    return this.enqueue(async () => {
      if (!want) return this.stopNow();
      if (this.running?.port === port && this.share.phase === 'ready') return;
      this.stopNow();
      await this.startNow(port);
    });
  }

  /** A fresh key, so a fresh address: nobody holding the old one can connect. */
  rotate(port: number): Promise<void> {
    return this.enqueue(async () => {
      this.stopNow();
      rmSync(this.keyFile, { force: true });
      await this.startNow(port);
    });
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopNow());
  }

  private enqueue(run: () => void | Promise<void>): Promise<void> {
    const task = this.queue.then(run);
    this.queue = task.catch(() => {});
    return task;
  }

  private set(share: TailcatShare): void {
    this.share = share;
    this.onChange();
  }

  private async startNow(port: number): Promise<void> {
    this.set({ phase: 'starting' });
    let bridge: Bridge;
    try {
      bridge = await spawnBridge(['host', `--local-port=${String(port)}`, `--key-file=${this.keyFile}`]);
    } catch (err) {
      return this.set({ phase: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
    const address = bridge.ready['address'];
    if (typeof address !== 'string') {
      bridge.proc.kill();
      return this.set({ phase: 'failed', message: 'The tailcat helper gave no address.' });
    }
    const running = { proc: bridge.proc, port };
    this.running = running;
    bridge.proc.once('exit', (code) => {
      if (this.running !== running) return;
      this.running = null;
      this.set({ phase: 'failed', message: `The tailcat helper stopped (code ${String(code)}).` });
    });
    this.set({ phase: 'ready', address });
  }

  private stopNow(): void {
    const running = this.running;
    this.running = null;
    running?.proc.kill();
    if (this.share.phase !== 'off') this.set({ phase: 'off' });
  }
}
