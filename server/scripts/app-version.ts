// Prints this checkout's version from git alone (ignores TERRACE_VERSION): the value a docker build injects.
import { resolve } from 'node:path';
import { appVersion } from '../src/app-version.ts';

console.log(appVersion(resolve(import.meta.dirname, '..', '..')));
