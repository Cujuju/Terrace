import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { stamp } from './log-timestamps.ts';
import { logInfo, logWarn } from './log.ts';

let stream: WriteStream | null = null;

/** Truncates per boot so the file only ever holds this run. Lines also go to stdout. */
export function openPerfLog(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    stream = createWriteStream(path, { flags: 'w' });
    stream.on('error', (error) => {
      logWarn(`performance log stopped: ${String(error)}`);
      stream = null;
    });
    logInfo(`performance log: ${path}`);
  } catch (error) {
    logWarn(`could not open the performance log at ${path}: ${String(error)}`);
    stream = null;
  }
}

export function perfLogLine(text: string): void {
  logInfo(text);
  stream?.write(`${stamp()} ${text}\n`);
}

export function closePerfLog(): void {
  stream?.end();
  stream = null;
}
