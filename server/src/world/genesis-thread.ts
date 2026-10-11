import { Worker } from 'node:worker_threads';
import { logWarn } from '../log.ts';
import { generateFreshGenesisCells } from './genesis.ts';

export interface GenesisThreadRequest {
  readonly size: number;
  readonly seed: number;
}

export type GenesisThreadReply = { readonly cells: ArrayBuffer } | { readonly error: string };

/**
 * A fresh world's heights, generated on a worker thread so the server keeps ticking.
 * Where no worker starts, generates on this thread instead.
 */
export function generateFreshGenesisCellsOffThread(size: number, seed: number): Promise<Int16Array> {
  let worker: Worker;
  try {
    const request: GenesisThreadRequest = { size, seed };
    worker = new Worker(new URL('./genesis.worker.ts', import.meta.url), { workerData: request });
  } catch (error) {
    logWarn(`could not start a genesis thread (${String(error)}); generating on the main thread`);
    return Promise.resolve(generateFreshGenesisCells(size, seed));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      outcome();
    };
    worker.once('message', (reply: GenesisThreadReply) => {
      settle(() => {
        if ('error' in reply) reject(new Error(reply.error));
        else resolve(new Int16Array(reply.cells));
      });
    });
    worker.once('error', (error) => settle(() => reject(error)));
    worker.once('exit', (code) =>
      settle(() => reject(new Error(`genesis thread exited with code ${String(code)} before replying`))),
    );
  });
}
