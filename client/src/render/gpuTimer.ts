import type { Renderer } from 'three/webgpu';

const MAX_BUFFERED_SAMPLES = 8;

export const TIMESTAMP_QUERY_FEATURE = 'timestamp-query';

export interface GpuTimer {
  readonly supported: boolean;
  mark(): void;
  drain(): number[];
}

const UNSUPPORTED: GpuTimer = {
  supported: false,
  mark: () => {},
  drain: () => [],
};

const PROBE_QUERY_FLAG = 'perfprobe';

function probeOwnsTheClock(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get(PROBE_QUERY_FLAG) !== null;
}

export function createGpuTimer(renderer: Renderer): GpuTimer {
  if (probeOwnsTheClock()) return UNSUPPORTED;
  if (!renderer.hasFeature(TIMESTAMP_QUERY_FEATURE)) return UNSUPPORTED;

  let resolved: number[] = [];
  let inFlight = false;

  return {
    supported: true,
    mark(): void {
      if (inFlight) return;
      inFlight = true;
      void renderer.resolveTimestampsAsync('render').then(
        (ms) => {
          inFlight = false;
          if (ms === undefined) return;
          resolved.push(ms);
          while (resolved.length > MAX_BUFFERED_SAMPLES) resolved.shift();
        },
        () => {
          inFlight = false;
        },
      );
    },
    drain(): number[] {
      const out = resolved;
      resolved = [];
      return out;
    },
  };
}
