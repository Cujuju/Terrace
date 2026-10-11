import { resolve } from 'node:path';
import { resolveAppVersion } from './app-version.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export const SERVER_VERSION: string = resolveAppVersion(REPO_ROOT);
