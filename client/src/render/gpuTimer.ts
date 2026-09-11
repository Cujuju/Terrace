import type { Renderer } from 'three/webgpu';

const MAX_BUFFERED_SAMPLES = 8;

/** Frames per resolve. A resolve costs ~2-3 ms of frame time on WebGPU, so the pool is
 *  drained on a cadence; three reports the window's last frame, so that frame is the sample. */
const RESOLVE_EVERY_FRAMES = 16;

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

// Drains the pool the renderer fills every frame, on a cadence; a concurrent resolver (the
// perf probe) shares the pending resolve, so nothing competes.
export function createGpuTimer(renderer: Renderer): GpuTimer {
  if (!renderer.hasFeature(TIMESTAMP_QUERY_FEATURE)) return UNSUPPORTED;

  let resolved: number[] = [];
  let inFlight = false;
  let framesSinceResolve = 0;

  return {
    supported: true,
    mark(): void {
      framesSinceResolve++;
      if (inFlight || framesSinceResolve < RESOLVE_EVERY_FRAMES) return;
      inFlight = true;
      framesSinceResolve = 0;
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
