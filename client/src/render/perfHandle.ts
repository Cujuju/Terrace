import { createEffect, createRoot, createSignal } from 'solid-js';
import {
  flushFrameStats,
  frameStatsSample,
  setFrameStatsSink,
  type FrameStatsSample,
} from './frameStats.ts';
import { perfOpen, setFrameStats, setPerfOpen } from '../state/hudState.ts';
import { isTextEntry } from '../plugins/kit/textEntry.ts';
import {
  selfProfileAvailable,
  startSelfProfile,
  type SelfProfileResult,
} from './selfProfile.ts';

const PERF_LOG_QUERY_FLAG = 'perflog';
const PERF_TOGGLE_KEY = 'Backquote';

const [logging, setLogging] = createSignal(false);

function queryFlagSet(name: string): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get(name) !== null;
}

function logSample(sample: FrameStatsSample): void {
  console.info(
    `[perf] up=${Math.round(sample.uptimeS)}s frames=${sample.frames} ` +
      `px=${sample.counters.pixelWidth}x${sample.counters.pixelHeight} ` +
      `cam=${sample.counters.cameraDistance.toFixed(0)} ` +
      `tri=${(sample.counters.triangles / 1e6).toFixed(2)}M ` +
      `render=${sample.renderMsP50.toFixed(2)} outside=${sample.outsideMsP50.toFixed(2)} ` +
      `frame=${sample.frameMsP50.toFixed(2)} p99=${sample.frameMsP99.toFixed(2)} ` +
      `gpu=${sample.gpuMsP50 === null ? 'n/a' : sample.gpuMsP50.toFixed(2)} ` +
      `max=${sample.frameMsMax.toFixed(2)} interval=${sample.intervalMsP50.toFixed(2)} ` +
      `draws=${sample.counters.drawCalls} geo=${sample.counters.geometries} ` +
      `tex=${sample.counters.textures} prog=${sample.counters.programs}` +
      sample.plugins.map((p) => ` ${p.name}=${p.msPerFrame.toFixed(2)}`).join(''),
  );
}

function trackReadouts(): () => void {
  return createRoot((dispose) => {
    createEffect(() => {
      const hudWants = perfOpen();
      const logWants = logging();
      if (!hudWants && !logWants) {
        setFrameStatsSink(null);
        setFrameStats(null);
        return;
      }
      setFrameStatsSink((sample) => {
        if (logWants) logSample(sample);
        if (hudWants) setFrameStats(sample);
      });
      flushFrameStats();
    });
    return dispose;
  });
}

export function installPerfHandle(): () => void {
  setLogging(queryFlagSet(PERF_LOG_QUERY_FLAG));
  const disposeReadouts = trackReadouts();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== PERF_TOGGLE_KEY) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextEntry(event.target)) return;
    setPerfOpen(!perfOpen());
  };
  window.addEventListener('keydown', onKeyDown);
  (globalThis as unknown as { __terracePerf: unknown }).__terracePerf = {
    stats: (): FrameStatsSample | null => frameStatsSample(),
    hud: (on?: boolean): boolean => {
      setPerfOpen(on ?? !perfOpen());
      return perfOpen();
    },
    profile: async (seconds = 10): Promise<SelfProfileResult> => {
      const result = await startSelfProfile(seconds * 1000);
      console.info(
        `[perf] profile: ${String(Math.round(result.durationMs))}ms, ` +
          `${String(result.sampleCount)} samples at ${result.sampleIntervalMs}ms` +
          (result.truncated ? ' (TRUNCATED - buffer filled)' : ''),
      );
      console.table(
        result.rows.map((r) => ({
          fn: r.name,
          site: r.site,
          selfMs: Math.round(r.selfMs),
          self: r.selfSamples,
          total: r.totalSamples,
        })),
      );
      return result;
    },
    canProfile: (): boolean => selfProfileAvailable(),
    log: (on?: boolean): boolean => {
      setLogging(on ?? !logging());
      return logging();
    },
  };
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    disposeReadouts();
    setFrameStatsSink(null);
  };
}
