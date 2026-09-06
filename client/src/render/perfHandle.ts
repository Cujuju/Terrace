// The frame meter's three readouts, and the only file that decides when the
// meter publishes anything.
//
// render/frameStats.ts measures unconditionally — it is two clock reads — but
// it publishes only through a sink, and this file owns that sink. Three ways to
// read it, and they exist for three different situations:
//
//   * THE HUD BLOCK (backquote) — "this session feels slower than it did", the
//     numbers wanted live while playing.
//   * `__terracePerf.stats()` — one reading, from a console or a driver, with
//     no HUD and no re-render.
//   * `?perflog=1` (or `__terracePerf.log(true)`) — one line per window into
//     the console, so a two-hour session leaves a decay trace that can be read
//     afterwards without anyone having watched it happen.
//
// NONE OF IT IS DEV-GATED, unlike perfProbe.ts and the `__terrace` handle in
// main.tsx. That is the point: the decay in
// docs/plans/frame-rate-decay-2026-09-05.md §7d took a night of bench runs to
// characterise because it could only be watched in a rig, and §7d's own control
// had to prove the rig was not causing it. This ships, so the next reading can
// come from a normal session.

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
  // `location` is absent in a non-DOM test run; absence means off, never a throw.
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get(name) !== null;
}

/**
 * One window as one line. Fixed field order and two decimals so a session's
 * worth of these can be pasted into a sheet and read as a slope, which is the
 * only form the decay is visible in.
 */
function logSample(sample: FrameStatsSample): void {
  console.info(
    `[perf] up=${Math.round(sample.uptimeS)}s frames=${sample.frames} ` +
      `px=${sample.counters.pixelWidth}x${sample.counters.pixelHeight} ` +
      `render=${sample.renderMsP50.toFixed(2)} outside=${sample.outsideMsP50.toFixed(2)} ` +
      `frame=${sample.frameMsP50.toFixed(2)} p99=${sample.frameMsP99.toFixed(2)} ` +
      `max=${sample.frameMsMax.toFixed(2)} interval=${sample.intervalMsP50.toFixed(2)} ` +
      `draws=${sample.counters.drawCalls} geo=${sample.counters.geometries} ` +
      `tex=${sample.counters.textures} prog=${sample.counters.programs}` +
      // Appended to the SAME line, not logged separately: a soak's value is in
      // pasting its lines into a sheet and reading a slope down each column,
      // and a second line per window breaks that.
      sample.plugins.map((p) => ` ${p.name}=${p.msPerFrame.toFixed(2)}`).join(''),
  );
}

/**
 * Keeps the sink in step with whoever wants windows — installed when a readout
 * is on, removed when none are.
 *
 * AN EFFECT, NOT A CALL EVERY TOGGLE MAKES. The sink was originally refreshed by
 * hand at each toggle site, which meant every new way to open the block — the
 * key, the console handle, and then the HUD button (2026-09-06) — had to
 * remember to refresh it, and a caller that forgot would open a block that
 * displayed nothing at all. Deriving it from `perfOpen()` instead makes
 * `setPerfOpen` sufficient on its own from anywhere, so there is nothing left to
 * forget. Owned by a createRoot because this is not a component: without one the
 * effect would belong to no owner and never be disposed.
 *
 * Removing the sink rather than leaving a no-op in place is what keeps a closed
 * readout free: with no sink a window closes without writing a signal and
 * without formatting a string.
 */
function trackReadouts(): () => void {
  return createRoot((dispose) => {
    createEffect(() => {
      const hudWants = perfOpen();
      const logWants = logging();
      if (!hudWants && !logWants) {
        setFrameStatsSink(null);
        // The block prints from this signal, so a stale sample must not survive
        // its own readout — reopening it should show the next real window, not
        // the last one from minutes ago.
        setFrameStats(null);
        return;
      }
      setFrameStatsSink((sample) => {
        if (logWants) logSample(sample);
        if (hudWants) setFrameStats(sample);
      });
      // AFTER the sink is installed, never before: the flush publishes THROUGH
      // it, so a flush ahead of it would go nowhere and the block would still
      // open empty. This is what makes the readout show numbers on the click
      // rather than up to FRAME_STATS_WINDOW_MS later.
      flushFrameStats();
    });
    return dispose;
  });
}

/**
 * True while the event's target is somewhere text is being typed. Without this
 * the toggle key fires inside the world-name field and every other text input,
 * where a backquote is a character and not a command.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Wires the key, the console handle and the query flag. Called once from
 * main.tsx. Returns the teardown, so a caller that unmounts the client stops
 * publishing with it.
 *
 * THE KEY IS HANDLED HERE, NOT IN ui/Hud.tsx, on purpose: this is a diagnostic
 * rather than a HUD control, and it has to answer whether the HUD is mounted,
 * collapsed, or mid-popup. Hud.tsx's own key handler is a careful chain about
 * which layer Escape closes; a diagnostic toggle has no business inside it.
 */
export function installPerfHandle(): () => void {
  setLogging(queryFlagSet(PERF_LOG_QUERY_FLAG));
  const disposeReadouts = trackReadouts();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== PERF_TOGGLE_KEY) return;
    // Modified backquote belongs to the browser and the OS (Ctrl+` is a
    // terminal in several editors); only the bare key is ours.
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
     * Samples this page's own call stacks for `seconds` and prints them ranked
     * by self time — the one instrument that can name what inside
     * `renderer.render` is growing (render/selfProfile.ts, issue #378).
     *
     * Run it on a page that has ALREADY decayed: a fresh page profiles the
     * thing that is not yet wrong. Leave the tab in the foreground while it
     * runs; Chrome stops sampling a page it considers hidden, exactly as it
     * stops rAF.
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
