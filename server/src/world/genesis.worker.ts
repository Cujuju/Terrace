import { parentPort, workerData } from 'node:worker_threads';
import { generateFreshGenesisCells } from './genesis.ts';
import type { GenesisThreadReply, GenesisThreadRequest } from './genesis-thread.ts';

const { size, seed } = workerData as GenesisThreadRequest;
let reply: GenesisThreadReply;
let transfer: ArrayBuffer[] = [];
try {
  const cells = generateFreshGenesisCells(size, seed);
  reply = { cells: cells.buffer as ArrayBuffer };
  transfer = [cells.buffer as ArrayBuffer];
} catch (error) {
  reply = { error: error instanceof Error ? error.message : String(error) };
}
parentPort?.postMessage(reply, transfer);
