// The dev override: WEATHER_DEV_FORCE=rain|snow|fog|storm.
//
// WHY IT EXISTS. Weather is a handful of discs drifting over a 512-world-unit
// map; even after the 2026-08-28 coverage retune a given spot is under a system
// about a fifth of the time, and the kind that turns up is the kind the weights
// drew. So an agent — or an owner — who wants to LOOK at snow has no way to be
// standing under snow, and "I could not catch it" is not a verification. This
// parks one system of the named kind over the middle of the world and holds it
// there until the process ends.
//
// ENVIRONMENT ONLY, and read exactly once at world creation. Not a setting, not
// a message, not an intent: a knob that can make one player's world rain
// forever is a knob that has to be an operator decision made before the server
// starts, and reading it once means a running world's weather cannot change
// character underneath the people in it.
//
// IT CHANGES THE WORLD, NOT JUST THE PICTURE. A parked system never drifts,
// ages or dies, so `precipitationAt` reports full intensity over the central
// disc for as long as the process lives: fire cannot start there (it
// extinguishes on wetness) and mudslides soak continuously. An agent
// photographing rain with this set and wondering why the torch does nothing
// is looking at this paragraph (review 2026-08-28).
//
// UNSET OR UNRECOGNISED IS OFF, LOUDLY. A typo (`WEATHER_DEV_FORCE=rainy`)
// warns and runs ordinary weather rather than failing the boot: this is a
// diagnostic aid, and one that could stop a server booting would be worse than
// the thing it diagnoses.

import { logWarn } from '../../../server/src/log.ts';
// Type-erased at runtime except for logWarn, which is core's own logger — the
// same one every plugin in this repo writes its boot lines through.
import { WEATHER_KINDS, type WeatherKind } from '../protocol.ts';

/** The environment variable, named once so the log line and the reader agree. */
export const WEATHER_DEV_FORCE_ENV = 'WEATHER_DEV_FORCE';

/**
 * The kind named by `env`, or null when the override is off.
 *
 * Case-insensitive and trimmed, because this is typed by hand at a shell
 * prompt; validated against WEATHER_KINDS rather than against a list restated
 * here, so a new kind is forceable the day it exists.
 */
export function readForcedWeatherKind(env: NodeJS.ProcessEnv): WeatherKind | null {
  const raw = env[WEATHER_DEV_FORCE_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return null;

  const kind = WEATHER_KINDS.find((candidate) => candidate === raw);
  if (kind === undefined) {
    logWarn(
      `[weather] ${WEATHER_DEV_FORCE_ENV}="${raw}" is not one of ` +
        `${WEATHER_KINDS.join('|')} — running ordinary weather`,
    );
    return null;
  }
  return kind;
}
