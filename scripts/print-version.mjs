// Prints the version this commit builds as (server/src/app-version.ts); the release workflow tags with it.
import { appVersion } from '../server/src/app-version.ts';

console.log(appVersion(import.meta.dirname));
