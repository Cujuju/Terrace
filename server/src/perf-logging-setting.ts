import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logWarn } from './log.ts';

const ENV_VAR = 'TERRACE_TICK_TIMING';
const ENV_ON = '1';
const DEFAULT_ENABLED = true;
const SETTING_KEY = 'perfLogging';
const JSON_INDENT = 2;

function readStored(path: string): boolean | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[SETTING_KEY];
    return typeof value === 'boolean' ? value : null;
  } catch (error) {
    logWarn(`ignoring unreadable server settings at ${path}: ${String(error)}`);
    return null;
  }
}

/** Stored on disk; the env var only sets the boot value, in-game changes win after that. */
export class PerfLoggingSetting {
  private readonly path: string;
  private current: boolean;
  readonly source: string;

  constructor(path: string, env: NodeJS.ProcessEnv = process.env) {
    this.path = path;
    const envRaw = env[ENV_VAR];
    if (envRaw !== undefined) {
      this.current = envRaw === ENV_ON;
      this.source = `${ENV_VAR}=${envRaw}`;
    } else {
      this.current = readStored(path) ?? DEFAULT_ENABLED;
      this.source = path;
    }
  }

  get enabled(): boolean {
    return this.current;
  }

  set(enabled: boolean): void {
    this.current = enabled;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify({ [SETTING_KEY]: enabled }, null, JSON_INDENT)}\n`);
  }
}
