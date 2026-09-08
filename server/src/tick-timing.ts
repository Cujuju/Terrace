import { logInfo } from './log.ts';

const TICK_TIMING_ENV_VAR = 'TERRACE_TICK_TIMING';
const TICK_TIMING_ENABLED_VALUE = '1';
const SAMPLE_RING_CAPACITY = 1024;
const TICK_TIMING_REPORT_INTERVAL_MS = 10_000;
const P99_QUANTILE = 0.99;
const MS_DECIMALS = 1;
const PERCENT_DECIMALS = 1;
const PERCENT_SCALE = 100;
const MILLISECONDS_PER_SECOND = 1000;
const REPORT_PREFIX = '[tick]';
const PHASE_COLUMN_WIDTH = 24;
const PLUGIN_PHASE_PREFIX = 'plugin:';

export const TICK_TOTAL_PHASE = 'total';

export const tickTimingEnabled: boolean =
  process.env[TICK_TIMING_ENV_VAR] === TICK_TIMING_ENABLED_VALUE;

interface PhaseStats {
  count: number;
  totalMs: number;
  maxMs: number;
  readonly samples: Float64Array;
  writeIndex: number;
  sampleCount: number;
}

const phases = new Map<string, PhaseStats>();

function statsFor(phase: string): PhaseStats {
  const existing = phases.get(phase);
  if (existing !== undefined) return existing;
  const created: PhaseStats = {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    samples: new Float64Array(SAMPLE_RING_CAPACITY),
    writeIndex: 0,
    sampleCount: 0,
  };
  phases.set(phase, created);
  return created;
}

function record(phase: string, elapsedMs: number): void {
  const stats = statsFor(phase);
  stats.count += 1;
  stats.totalMs += elapsedMs;
  if (elapsedMs > stats.maxMs) stats.maxMs = elapsedMs;
  stats.samples[stats.writeIndex] = elapsedMs;
  stats.writeIndex = (stats.writeIndex + 1) % SAMPLE_RING_CAPACITY;
  if (stats.sampleCount < SAMPLE_RING_CAPACITY) stats.sampleCount += 1;
}

export function timePhase<T>(phase: string, run: () => T): T {
  if (!tickTimingEnabled) return run();
  const startedMs = performance.now();
  try {
    return run();
  } finally {
    record(phase, performance.now() - startedMs);
  }
}

export function timePluginPhase<T>(pluginName: string, run: () => T): T {
  if (!tickTimingEnabled) return run();
  return timePhase(`${PLUGIN_PHASE_PREFIX}${pluginName}`, run);
}

function quantileMs(stats: PhaseStats, quantile: number): number {
  const used = stats.sampleCount;
  if (used === 0) return 0;
  const sorted = stats.samples.slice(0, used).sort();
  const rank = Math.min(used - 1, Math.max(0, Math.ceil(quantile * used) - 1));
  return sorted[rank];
}

function formatMs(ms: number): string {
  return `${ms.toFixed(MS_DECIMALS)}ms`;
}

function phaseRow(phase: string, stats: PhaseStats): string {
  const avgMs = stats.count === 0 ? 0 : stats.totalMs / stats.count;
  return (
    `${REPORT_PREFIX}   ${phase.padEnd(PHASE_COLUMN_WIDTH)}` +
    ` p99 ${formatMs(quantileMs(stats, P99_QUANTILE))}` +
    ` max ${formatMs(stats.maxMs)}` +
    ` avg ${formatMs(avgMs)}  n=${stats.count}`
  );
}

function resetWindow(stats: PhaseStats): void {
  stats.count = 0;
  stats.totalMs = 0;
  stats.maxMs = 0;
}

export interface TickTimingReport {
  stop(): void;
}

export interface TickTimingReportDeps {
  readonly tickHz: number;
  worldSize(): number | null;
}

export function startTickTimingReport(deps: TickTimingReportDeps): TickTimingReport | null {
  if (!tickTimingEnabled) return null;

  const tickIntervalMs = MILLISECONDS_PER_SECOND / deps.tickHz;
  let worldLineWritten = false;

  const emit = (): void => {
    const total = phases.get(TICK_TOTAL_PHASE);
    if (total === undefined || total.count === 0) return;

    if (!worldLineWritten) {
      const size = deps.worldSize();
      if (size !== null) {
        logInfo(`${REPORT_PREFIX} world ${size}² = ${size * size} heightmap cells`);
        worldLineWritten = true;
      }
    }

    const utilPercent = (total.totalMs / total.count / tickIntervalMs) * PERCENT_SCALE;
    logInfo(
      `${REPORT_PREFIX} interval ${formatMs(tickIntervalMs)} | ticks ${total.count}` +
        ` | total p99 ${formatMs(quantileMs(total, P99_QUANTILE))}` +
        ` max ${formatMs(total.maxMs)} util ${utilPercent.toFixed(PERCENT_DECIMALS)}%`,
    );
    for (const [phase, stats] of phases) {
      if (phase === TICK_TOTAL_PHASE || stats.count === 0) continue;
      logInfo(phaseRow(phase, stats));
    }
    for (const stats of phases.values()) resetWindow(stats);
  };

  const timer = setInterval(emit, TICK_TIMING_REPORT_INTERVAL_MS);
  timer.unref();
  logInfo(
    `${REPORT_PREFIX} timing is on (${TICK_TIMING_ENV_VAR}=${TICK_TIMING_ENABLED_VALUE}); ` +
      `reporting every ${TICK_TIMING_REPORT_INTERVAL_MS / MILLISECONDS_PER_SECOND}s`,
  );

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
