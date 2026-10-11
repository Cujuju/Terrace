// Desktop settings on disk, in the app profile: they are read before any world folder is known.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { DEFAULT_DESKTOP_SETTINGS, normalizeDesktopSettings, type DesktopSettings } from './contract.ts';

const SETTINGS_FILE = 'desktop.json';
const JSON_INDENT = 2;

/** A path in the app profile. */
export const profilePath = (...parts: string[]): string => join(app.getPath('userData'), ...parts);

export function readDesktopSettings(): DesktopSettings {
  try {
    return normalizeDesktopSettings(JSON.parse(readFileSync(profilePath(SETTINGS_FILE), 'utf8')));
  } catch {
    // First start, or an unreadable file.
    return DEFAULT_DESKTOP_SETTINGS;
  }
}

export function writeDesktopSettings(settings: DesktopSettings): void {
  try {
    writeFileSync(profilePath(SETTINGS_FILE), JSON.stringify(settings, null, JSON_INDENT));
  } catch (err) {
    console.error('[desktop] settings not saved:', err);
  }
}
