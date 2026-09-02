// THE DEV FORCE SWITCH: `<PLUGIN>_DEV_FORCE=1`, read once at world creation.
//
// WHY IT EXISTS. Several plugins simulate something a player meets a few times
// an hour somewhere on a 512-world-unit map, and an agent — or an owner — who
// wants to LOOK at one has no way to be standing under it. "I could not catch
// it" is not a verification, so each of those plugins offers an environment
// switch that parks one of its things over the middle of the world and holds it
// there until the process ends.
//
// ENVIRONMENT ONLY, and read exactly once at world creation. Not a setting, not
// a message, not an intent: a knob that can make one player's world strange
// forever is a knob that has to be an operator decision made before the server
// starts, and reading it once means a running world cannot change character
// underneath the people in it.
//
// WHAT MOVED HERE AND WHAT DID NOT. Only the READING of the flag — the name of
// the variable, the trimming, and what counts as "on". What each plugin DOES
// while forced is the plugin's own, and so is the log line it writes.
//
// UNSET OR UNRECOGNISED IS OFF, and unrecognised is off LOUDLY at the caller's
// discretion: this returns a boolean and never throws, because a diagnostic aid
// that could stop a server booting would be worse than the thing it diagnoses.

/** How a plugin's dev switch is spelled once the plugin's name is uppercased. */
export const DEV_FORCE_ENV_SUFFIX = '_DEV_FORCE';

/**
 * The environment variable a plugin's dev switch is read from — its name
 * uppercased, plus the suffix. Named once so a log line and the reader agree.
 */
export function devForceEnvName(pluginName: string): string {
  return `${pluginName.toUpperCase()}${DEV_FORCE_ENV_SUFFIX}`;
}

/**
 * The values that turn the switch on.
 *
 * `1` is the documented spelling and the one every rig uses; `true`, `yes` and
 * `on` are accepted because this is typed by hand at a shell prompt and a person
 * who wrote one of them meant the same thing. Anything else — including `0`,
 * `false` and an empty string — is off, so `X_DEV_FORCE=0` reads the way a
 * person expects rather than as "any value at all means on".
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Is `<envName>` asking this plugin to force its thing? Case-insensitive and
 * trimmed, for the shell-prompt reason above.
 */
export function readDevForce(envName: string, env: Record<string, string | undefined>): boolean {
  const raw = env[envName]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  return TRUTHY.has(raw);
}
