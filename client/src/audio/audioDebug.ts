// The `?audioDebug=1` / `?audioMusic=<url>` dev switches.
//
// SAME CONVENTION AS client/src/perfProbe.ts:45 for `?perfprobe=<scenario>`: a
// module-level flag name, read once at module load, and any non-empty value
// turns it on. Off by default and zero-cost when off — `logAudio` returns on
// its first line and every caller's own thinning is behind `AUDIO_DEBUG`.

import type { AudioBusName } from '../state/audioPrefs.ts';
import type { AudioGraph } from './audioGraph.ts';

const AUDIO_DEBUG_QUERY_FLAG = 'audioDebug';
const AUDIO_MUSIC_QUERY_FLAG = 'audioMusic';

function queryFlag(name: string): string | null {
  // `location` is absent in a non-DOM test run; the switches are a browser
  // affordance and their absence means "off", never a throw.
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get(name);
  return raw === null || raw === '' ? null : raw;
}

/** `?audioDebug=1`: log every call with its bus, gain, position and voice count. */
export const AUDIO_DEBUG = queryFlag(AUDIO_DEBUG_QUERY_FLAG) !== null;

/**
 * `?audioMusic=<url>`: put this URL on the music bus under a synthetic
 * claimant, so the music path is exercised in a build where no plugin claims
 * music yet (plan §2.4 — there is no music consumer in phase 1).
 */
export const AUDIO_MUSIC_URL = queryFlag(AUDIO_MUSIC_QUERY_FLAG);

/**
 * How much an ambience weight must move before `?audioDebug=1` logs it again.
 *
 * A TWENTIETH. `ambience` is contracted to be called every frame, and a weight
 * that drifts continuously (rain does) would otherwise put a line in the
 * console at frame rate and bury the very fade it is there to show. Twenty
 * lines across a full fade in and a full fade out is a readable trace of one.
 * Starts, releases and reaching an exact 0 or 1 are logged whatever this says.
 */
export const AUDIO_DEBUG_WEIGHT_STEP = 0.05;

/**
 * The name core claims the music bus under when `?audioMusic=` is set.
 *
 * PARENTHESISED so it cannot collide with a real plugin name (a plugin name is
 * a wire namespace and those are bare identifiers) and so a refusal warning
 * naming it reads as what it is: the dev switch is holding the bus, not another
 * plugin.
 */
export const DEV_MUSIC_CLAIMANT = '(dev:audioMusic)';

/** What every debug site hands in; the graph-level fields are added here. */
export type AudioDebugLog = (call: string, fields: Record<string, unknown>) => void;

/**
 * Builds the logger. `voiceCount` is a THUNK rather than a number because the
 * pool that answers it is constructed after this is (see createAudioEngine),
 * and because the live count at the moment of the call is the only useful one.
 */
export function createAudioDebugLog(
  graph: AudioGraph | null,
  voiceCount: () => number,
): AudioDebugLog {
  return (call, fields) => {
    if (!AUDIO_DEBUG) return;
    // THE LIVE GAIN OF THE BUS THIS CALL IS ON. Between the voice's own gain
    // (already in `fields`) and the master below, this is the only other factor
    // in how loud the call ends up — so with all three on the line the trace
    // explains a level completely instead of leaving one term out.
    const bus = fields.bus;
    const busGain =
      graph === null || typeof bus !== 'string' || !(bus in graph.buses)
        ? null
        : graph.buses[bus as AudioBusName].gain.value;
    console.log('[terrace audio]', call, {
      ...fields,
      busGain,
      // HOW MUCH THE LIMITER IS TAKING OFF RIGHT NOW, in dB (always ≤ 0). It
      // reads 0 while the limiter is transparent, which is the state it is
      // supposed to be in — so a non-zero value here is the trace saying the
      // output actually reached the ceiling, and is the only way to tell that
      // from outside.
      limiterReductionDb: graph === null ? null : graph.limiter.reduction,
      sfxVoices: voiceCount(),
      // THE MASTER'S LIVE VALUE, on every line. It is the answer to the first
      // question anyone debugging silence asks — the player's own volume and
      // mute reach the graph through exactly this number — and a trace that
      // showed every voice's gain but not the one they all pass through would
      // answer every question but that one.
      master: graph === null ? null : graph.master.gain.value,
      contextState: graph === null ? 'unavailable' : graph.context.state,
    });
  };
}
