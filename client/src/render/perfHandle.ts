// Not dev-gated, unlike perfProbe.ts and main.tsx's `__terrace`: the decay in
// docs/plans/frame-rate-decay-2026-09-05.md §7d took a night of bench runs to
// characterise, and the next reading should come from a normal session.

import { createEffect, createRoot, createSignal } from 'solid-js';
import {
  flushFrameStats,
  frameStatsSample,
  setFrameStatsSink,
  type FrameStatsSample,
} from './frameStats.ts';
import { perfOpen, setFrameStats, setPerfOpen } from '../state/hudState.ts';
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

/** One window per line, fixed field order, so a soak pastes into a sheet and reads as a slope down each column. */
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

/**
 * An effect, not a call at every toggle site: each new way to open the block
 * would otherwise have to remember to refresh the sink or open showing nothing.
 */
function trackReadouts(): () => void {
  return createRoot((dispose) => {
    createEffect(() => {
      const hudWants = perfOpen();
      const logWants = logging();
      if (!hudWants && !logWants) {
        setFrameStatsSink(null);
        // A reopened block must show the next real window, not a stale one.
        setFrameStats(null);
        return;
      }
      setFrameStatsSink((sample) => {
        if (logWants) logSample(sample);
        if (hudWants) setFrameStats(sample);
      });
      // After the sink installs, never before, or the flush goes nowhere and
      // the block opens empty instead of showing numbers immediately.
      flushFrameStats();
    });
    return dispose;
  });
}

/** So the bare toggle key types a character in a text field instead of firing. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The key is handled here, not in ui/Hud.tsx: this is a diagnostic, not a HUD
 * control, and Hud.tsx's own Escape-key chain has no business inside it.
 */
export function installPerfHandle(): () => void {
  setLogging(queryFlagSet(PERF_LOG_QUERY_FLAG));
  const disposeReadouts = trackReadouts();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== PERF_TOGGLE_KEY) return;
    // Modified backquote belongs to the browser/OS (Ctrl+` opens a terminal
    // in several editors); only the bare key is ours.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextEntry(event.target)) return;
    setPerfOpen(!perfOpen());
  };
  window.addEventListener('keydown', onKeyDown);
  (globalThis as unknown as { __terracePerf: unknown }).__terracePerf = {
    /** The last closed window, or null before the first one closes. */
    stats: (): FrameStatsSample | null => frameStatsSample(),
    hud: (on?: boolean): boolean => {
      setPerfOpen(on ?? !perfOpen());
      return perfOpen();
    },
    /**
     * Names what inside `renderer.render` is growing (#378). Run on a page that
     * has already decayed, foregrounded — Chrome stops sampling hidden tabs.
     */
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
