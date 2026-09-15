import type { PluginActionOutcome, PluginActionSite } from '../types.ts';
import type { DiscSystem, DiscSystems } from './discSystems.ts';

export interface DiscSummonSpec {
  readonly systems: DiscSystems;
  readonly worldSize: number;
  readonly site: PluginActionSite;
  readonly forcedEnv: string;
  readonly ceiling: number;
  readonly noun: string;
}

// The one summon rule every disc kind shares: a parked (dev-forced) sky and a
// full sky refuse with their own messages; the kind names and broadcasts the birth.
export function summonDisc(spec: DiscSummonSpec): DiscSystem | PluginActionOutcome {
  if (spec.systems.isForced()) {
    return {
      ok: false,
      detail: `${spec.forcedEnv} is set — the sky is parked; unset it and restart`,
    };
  }
  if (!Number.isFinite(spec.site.x) || !Number.isFinite(spec.site.y)) {
    return { ok: false, detail: 'that is not a place in this world' };
  }
  const system = spec.systems.spawnAt(spec.worldSize, spec.site.x, spec.site.y);
  if (system === null) {
    return { ok: false, detail: `${spec.ceiling} ${spec.noun} are already in the sky` };
  }
  return system;
}

export function isRefusal(result: DiscSystem | PluginActionOutcome): result is PluginActionOutcome {
  return 'ok' in result;
}
