// GPU time per frame, for the always-on meter.
//
// WHY IT HAD TO EXIST (owner reading, 2026-09-06). The meter said CPU work was
// 4.00 ms while the frame interval sat at 33.30 ms — 30 Hz exactly. CPU-side
// numbers cannot tell "the GPU is taking 33 ms" from "something is pacing
// presentation at 30 Hz", because `renderer.render` returns when commands are
// SUBMITTED, not when they are finished. Without a GPU clock the meter can only
// say "it is not the CPU", which is half a diagnosis and the wrong half to stop
// on.
//
// SAME MECHANISM AS perfProbe.ts's timer, deliberately: EXT_disjoint_timer_query
// _webgl2 is the only GPU clock a browser offers, its results arrive some frames
// after the frame they measure, and a disjoint invalidates everything in flight.
// This is the lean version — no startup-error reporting, no shape attribution —
// because it runs unconditionally and the probe's version does not.
//
// ONE QUERY IN FLIGHT AT A TIME is not a choice: WebGL2 allows exactly one
// active TIME_ELAPSED query per context, so each frame closes the previous
// frame's query before opening its own, and the span measured is mark-to-mark —
// one whole frame of GL work.

/** Nanoseconds per millisecond — the unit TIME_ELAPSED_EXT answers in. */
const NANOSECONDS_PER_MS = 1_000_000;

/**
 * Results still awaiting the driver before the oldest is abandoned.
 *
 * A result normally lands within two or three frames. Eight is slack enough for
 * a stalled pipeline without letting a driver that has stopped answering grow
 * the list forever — and the oldest query is both the most likely to be lost and
 * the least worth waiting for.
 */
const MAX_PENDING_QUERIES = 8;

export interface GpuTimer {
  readonly supported: boolean;
  /** Call once per frame: closes the previous frame's query and opens this one. */
  mark(): void;
  /** Every result that has landed since the last call, in milliseconds. */
  drain(): number[];
}

const UNSUPPORTED: GpuTimer = {
  supported: false,
  mark: () => {},
  drain: () => [],
};

/**
 * The probe's arming flag (perfProbe.ts's PROBE_QUERY_FLAG). Restated rather
 * than imported on purpose: perfProbe.ts is DEV-only and statically eliminated
 * from a production build, and importing it here — from a module that ships —
 * would drag the whole probe into every bundle.
 */
const PROBE_QUERY_FLAG = 'perfprobe';

/**
 * True while client/src/perfProbe.ts is armed and therefore owns the GPU clock.
 *
 * WEBGL2 ALLOWS EXACTLY ONE ACTIVE TIME_ELAPSED QUERY PER CONTEXT. Two timers
 * calling beginQuery against one context is not two measurements, it is one
 * INVALID_OPERATION and two sets of wrong numbers — and the one that would have
 * broken is every `gpu-bench.sh` run, silently, because the probe reports its
 * GPU figure without re-checking that its own beginQuery still succeeded.
 *
 * So the clock has exactly one owner at any moment: the probe during a bench
 * run, this meter otherwise. The HUD reads "unavailable" for the duration of a
 * bench, which is correct — the number is being taken by the instrument that
 * asked for it first, and nobody is reading the HUD during a headless run.
 */
function probeOwnsTheClock(): boolean {
  // `location` is absent in a non-DOM test run; absence means the probe is not
  // armed, never a throw.
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get(PROBE_QUERY_FLAG) !== null;
}

export function createGpuTimer(
  context: WebGLRenderingContext | WebGL2RenderingContext,
): GpuTimer {
  if (probeOwnsTheClock()) return UNSUPPORTED;
  // three falls back to a WebGL1 context on an adapter that refuses WebGL2, and
  // query objects exist only on WebGL2. "Unsupported" is the honest answer;
  // calling beginQuery there would throw mid-frame.
  const gl = context instanceof WebGL2RenderingContext ? context : null;
  const ext =
    gl === null
      ? null
      : (gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
          TIME_ELAPSED_EXT: number;
          GPU_DISJOINT_EXT: number;
        } | null);
  if (gl === null || ext === null) return UNSUPPORTED;

  let resolved: number[] = [];
  let pending: WebGLQuery[] = [];
  let open: WebGLQuery | null = null;

  const collect = (): void => {
    // READ THE DISJOINT FLAG ONCE PER PASS: getParameter CLEARS it, so a read
    // per query would let a disjoint reported against the first silently
    // validate every later one in the same pass.
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
    const kept: WebGLQuery[] = [];
    for (const query of pending) {
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) {
        kept.push(query);
        continue;
      }
      // A disjoint means the GPU clock was interrupted — a context switch, a
      // power-state change. Every result in flight is meaningless rather than
      // merely noisy, so it is dropped, never averaged in.
      if (!disjoint) {
        resolved.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / NANOSECONDS_PER_MS);
      }
      gl.deleteQuery(query);
    }
    pending = kept;
  };

  return {
    supported: true,
    mark(): void {
      // COLLECT BEFORE CLOSING, so a result that has just landed is read on the
      // tick it lands rather than after another query has been pushed in behind
      // it — otherwise the eviction below could discard a query whose result was
      // already available.
      collect();
      if (open !== null) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push(open);
        open = null;
        while (pending.length > MAX_PENDING_QUERIES) {
          const dropped = pending.shift();
          if (dropped !== undefined) gl.deleteQuery(dropped);
        }
      }
      const query = gl.createQuery();
      if (query === null) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      open = query;
    },
    drain(): number[] {
      const out = resolved;
      resolved = [];
      return out;
    },
  };
}
