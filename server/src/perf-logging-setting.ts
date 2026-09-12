import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logWarn } from './log.ts';

const ENV_VAR = 'TERRACE_TICK_TIMING';
const ENV_ON = '1';
const ENV_OFF = '0';
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

/** Stored choice, overridable by the env var. `live` is fixed at boot; `enabled` follows writes. */
export class PerfLoggingSetting {
  private readonly path: string;
  private readonly envOverride: boolean | null;
  private stored: boolean;
  readonly live: boolean;

  constructor(path: string, env: NodeJS.ProcessEnv = process.env) {
    this.path = path;
    const envRaw = env[ENV_VAR];
    this.envOverride = envRaw === undefined ? null : envRaw === ENV_ON;
    this.stored = readStored(path) ?? DEFAULT_ENABLED;
    this.live = this.envOverride ?? this.stored;
  }

  get enabled(): boolean {
    return this.envOverride ?? this.stored;
  }

  describe(): string {
    if (this.envOverride !== null) {
      return `${ENV_VAR}=${this.envOverride ? ENV_ON : ENV_OFF} overrides ${this.path}`;
    }
    return this.path;
  }

  set(enabled: boolean): void {
    this.stored = enabled;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify({ [SETTING_KEY]: enabled }, null, JSON_INDENT)}\n`);
  }
}
