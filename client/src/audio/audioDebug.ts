import type { AudioBusName } from '../state/audioPrefs.ts';
import type { AudioGraph } from './audioGraph.ts';

const AUDIO_DEBUG_QUERY_FLAG = 'audioDebug';
const AUDIO_MUSIC_QUERY_FLAG = 'audioMusic';

function queryFlag(name: string): string | null {
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get(name);
  return raw === null || raw === '' ? null : raw;
}

export const AUDIO_DEBUG = queryFlag(AUDIO_DEBUG_QUERY_FLAG) !== null;

export const AUDIO_MUSIC_URL = queryFlag(AUDIO_MUSIC_QUERY_FLAG);

export const AUDIO_DEBUG_WEIGHT_STEP = 0.05;

export const DEV_MUSIC_CLAIMANT = '(dev:audioMusic)';

export type AudioDebugLog = (call: string, fields: Record<string, unknown>) => void;

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
