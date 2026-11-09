import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPERVISOR_SHUTDOWN_MESSAGE, TERRACE_RESTART_EXIT_CODE } from '../../server/src/supervisor-protocol.ts';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), probe: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ mkdirSync: vi.fn(), createWriteStream: () => ({ write: vi.fn(), end: vi.fn() }) }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));
vi.mock('../electron/appEnv.ts', () => ({ clientDist: '', isPackaged: false, pluginsDir: '', serverCwd: '', serverEntry: '' }));
vi.mock('../electron/serverProbe.ts', () => ({ loopbackOrigin: (port: number) => `http://localhost:${port}`, probeServer: mocks.probe }));
import { ServerSupervisor } from '../electron/serverChild.ts';

class Child extends EventEmitter {
  pid = 1;
  connected = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  send = vi.fn((_message: string, done: (error: Error | null) => void) => done(null));
  kill = vi.fn();
}
let children: Child[];
let supervisor: ServerSupervisor;
const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new Child(); children.push(child); return child as unknown as ChildProcess;
  });
  mocks.probe.mockReset().mockResolvedValue({ kind: 'terrace' });
  supervisor = new ServerSupervisor(() => ({ port: 2567, dataDir: 'test', rollbackKey: '', worldAdminKey: '' }), vi.fn());
});
afterEach(() => { supervisor.close(); vi.useRealTimers(); });

describe('serialized server generations', () => {
  it('requests a graceful snapshot from an automatic replacement without a ready() call', async () => {
    await supervisor.start();
    expect(await supervisor.ready()).toBe(true);
    children[0].emit('exit', TERRACE_RESTART_EXIT_CODE, null);
    await settle();
    expect(children).toHaveLength(2);
    const stop = supervisor.stop();
    await settle();
    expect(children[1].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
    expect(children[1].kill).not.toHaveBeenCalled();
    children[1].emit('exit', 0, null);
    await stop;
  });

  it('coalesces overlapping restarts and idempotent starts into one replacement', async () => {
    await Promise.all([supervisor.start(), supervisor.start()]);
    const first = supervisor.restart();
    const second = supervisor.restart();
    expect(second).toBe(first);
    await settle();
    expect(children[0].send).toHaveBeenCalledTimes(1);
    children[0].emit('exit', 0, null);
    await Promise.all([first, second]);
    expect(children).toHaveLength(2);
    const stop = supervisor.stop();
    await settle(); children[1].emit('exit', 0, null); await stop;
  });

  it('requests shutdown IPC from a crash-recovery child before readiness polling', async () => {
    await supervisor.start();
    children[0].emit('exit', 1, null);
    await vi.runOnlyPendingTimersAsync();
    expect(children).toHaveLength(2);
    const stop = supervisor.stop();
    await settle();
    expect(children[1].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
    expect(children[1].kill).not.toHaveBeenCalled();
    children[1].emit('exit', 0, null);
    await stop;
  });

  it('a stop arriving during restart prevents the replacement', async () => {
    await supervisor.start();
    const restart = supervisor.restart();
    await settle();
    const stop = supervisor.stop();
    children[0].emit('exit', 0, null);
    await Promise.all([restart, stop]);
    expect(children).toHaveLength(1);
  });

  it('rejects readiness belonging to a child that exited during the probe', async () => {
    await supervisor.start();
    let answer!: (result: { kind: 'terrace' }) => void;
    mocks.probe.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const ready = supervisor.ready();
    await settle();
    children[0].emit('exit', TERRACE_RESTART_EXIT_CODE, null);
    const stop = supervisor.stop();
    answer({ kind: 'terrace' });
    await vi.runAllTimersAsync();
    await stop;
    expect(await ready).toBe(false);
  });

  it('uses the bounded kill fallback when connected IPC never completes shutdown', async () => {
    await supervisor.start();
    const stop = supervisor.stop();
    await settle();
    await vi.runOnlyPendingTimersAsync();
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    children[0].emit('exit', null, 'SIGKILL');
    await stop;
  });
});
