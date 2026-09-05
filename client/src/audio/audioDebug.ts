// The `?audioDebug=1` / `?audioMusic=<url>` dev switches, matching the
// query-flag convention in client/src/perfProbe.ts:45.

import type { AudioBusName } from '../state/audioPrefs.ts';
import type { AudioGraph } from './audioGraph.ts';

const AUDIO_DEBUG_QUERY_FLAG = 'audioDebug';
const AUDIO_MUSIC_QUERY_FLAG = 'audioMusic';

function queryFlag(name: string): string | null {
  // `location` is absent in a non-DOM test run; absence means off, never a throw.
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get(name);
  return raw === null || raw === '' ? null : raw;
}

/** Log every call with its bus, gain, position and voice count. */
export const AUDIO_DEBUG = queryFlag(AUDIO_DEBUG_QUERY_FLAG) !== null;

/** Exercises the music path in a build where no plugin claims music yet. */
export const AUDIO_MUSIC_URL = queryFlag(AUDIO_MUSIC_QUERY_FLAG);

/**
 * Weight change needed before an ambience call logs again. `ambience` is called
 * every frame; unthinned it writes at frame rate and buries the fade it shows.
 */
export const AUDIO_DEBUG_WEIGHT_STEP = 0.05;

/** Parenthesised so it cannot collide with a plugin name in a refusal warning. */
export const DEV_MUSIC_CLAIMANT = '(dev:audioMusic)';

export type AudioDebugLog = (call: string, fields: Record<string, unknown>) => void;

/**
 * `voiceCount` is a thunk because the pool that answers it is constructed after
 * this is, and because only the count at the moment of the call is useful.
 */
export function createAudioDebugLog(
  graph: AudioGraph | null,
  voiceCount: () => number,
): AudioDebugLog {
  return (call, fields) => {
    if (!AUDIO_DEBUG) return;
    const bus = fields.bus;
    const busGain =
      graph === null || typeof bus !== 'string' || !(bus in graph.buses)
        ? null
        : graph.buses[bus as AudioBusName].gain.value;
    // Voice gain, bus gain and master are every factor in the level.
    // `reduction` is 0 while the limiter is transparent; non-zero means the
    // output hit the ceiling.
    console.log('[terrace audio]', call, {
      ...fields,
      busGain,
      limiterReductionDb: graph === null ? null : graph.limiter.reduction,
      sfxVoices: voiceCount(),
      master: graph === null ? null : graph.master.gain.value,
      contextState: graph === null ? 'unavailable' : graph.context.state,
    });
  };
}
