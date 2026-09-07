// The frame meter's three readouts, and the only file that decides when the
// meter publishes anything.
//
// render/frameStats.ts measures unconditionally but publishes only through a
// sink this file owns. Three ways to read it:
//
//   * THE HUD BLOCK (backquote) — live numbers while playing.
//   * `__terracePerf.stats()` — one reading, from a console or a driver.
//   * `?perflog=1` (or `__terracePerf.log(true)`) — one line per window to
//     the console, so a long session leaves a decay trace readable afterward.
//
// NOT DEV-GATED, unlike perfProbe.ts and the `__terrace` handle in main.tsx:
// the decay in docs/plans/frame-rate-decay-2026-09-05.md §7d took a night of
// bench runs to characterise and could only be watched in a rig. This ships
// so the next reading can come from a normal session.

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
/** Matches the query-flag convention in perfProbe.ts and audio/audioDebug.ts. */
const PERF_TOGGLE_KEY = 'Backquote';

const [logging, setLogging] = createSignal(false);

function queryFlagSet(name: string): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get(name) !== null;
}

/** One window as one line, fixed field order, so a session's worth can be pasted into a sheet and read as a slope. */
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
      // Same line, not a second one: a soak's value is pasting into a sheet
      // and reading a slope down each column.
      sample.plugins.map((p) => ` ${p.name}=${p.msPerFrame.toFixed(2)}`).join(''),
  );
}

/**
 * Keeps the sink in step with whoever wants windows.
 *
 * An effect, not a call at every toggle site: each new way to open the block
 * (key, console handle, HUD button) would otherwise have to remember to
 * refresh the sink or open showing nothing. Owned by a createRoot since this
 * is not a component. Removing the sink (not a no-op) is what keeps a closed
 * readout free of formatting cost.
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

/** True while typing, so the toggle key doesn't fire as a character inside a text field. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Wires the key, the console handle and the query flag. Called once from
 * main.tsx; returns the teardown.
 *
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
    /** Show or hide the HUD block; no argument toggles it. */
    hud: (on?: boolean): boolean => {
      setPerfOpen(on ?? !perfOpen());
      return perfOpen();
    },
    /**
     * Samples this page's own call stacks for `seconds`, ranked by self time
     * — names what inside `renderer.render` is growing (issue #378). Run on
     * a page that has already decayed; a fresh page profiles the wrong
     * thing. Keep the tab foregrounded — Chrome stops sampling hidden tabs.
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
    /** Whether this page is allowed to profile itself at all. */
    canProfile: (): boolean => selfProfileAvailable(),
    /** Start or stop the per-window console line; no argument toggles it. */
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
