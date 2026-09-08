const NANOSECONDS_PER_MS = 1_000_000;

const MAX_PENDING_QUERIES = 8;

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

export function createGpuTimer(
  context: WebGLRenderingContext | WebGL2RenderingContext,
): GpuTimer {
  if (probeOwnsTheClock()) return UNSUPPORTED;
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
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
    const kept: WebGLQuery[] = [];
    for (const query of pending) {
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) {
        kept.push(query);
        continue;
      }
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
