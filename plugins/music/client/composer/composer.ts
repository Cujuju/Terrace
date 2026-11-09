import { createEngine, TEARDOWN_SLACK_SECONDS } from './engine.ts';
import { DEFAULT_DAY_PHASE, type ComposerMood } from './theory.ts';
import { DEFAULT_TUNING, type ComposerTuning } from './tuning.ts';

export type { ComposerMood } from './theory.ts';
export type { ComposerTuning } from './tuning.ts';

const SCHEDULER_TICK_MS = 250;
const SCHEDULE_AHEAD_SECONDS = 1.5;
const START_LEAD_SECONDS = 0.12;
const MILLISECONDS_PER_SECOND = 1000;

export interface ComposerStats {
  readonly liveNodeCount: number;
  readonly lastTickMilliseconds: number;
  readonly activeTempoBpm: number;
  readonly tempoAnchorTime: number;
  readonly pendingTempoBpm: number | null;
}

export interface Composer {
  start(): void;
  stop(fadeSeconds: number): void;
  setMood(mood: ComposerMood): void;
  setTuning(tuning: ComposerTuning): void;
  stats(): ComposerStats;
}

const DEFAULT_MOOD: ComposerMood = { dayPhase: DEFAULT_DAY_PHASE, weather: 0, tension: 0 };

/** Clock the host can time and auto-clear; defaults to globals. */
export interface ComposerClock {
  setInterval(handler: () => void, ms: number): () => void;
  setTimeout(handler: () => void, ms: number): () => void;
}

const GLOBAL_CLOCK: ComposerClock = {
  setInterval: (handler, ms) => {
    const id = setInterval(handler, ms);
    return () => clearInterval(id);
  },
  setTimeout: (handler, ms) => {
    const id = setTimeout(handler, ms);
    return () => clearTimeout(id);
  },
};

export function createComposer(
  context: AudioContext,
  destination: AudioNode,
  seed: number,
  tuning: ComposerTuning = DEFAULT_TUNING,
  clock: ComposerClock = GLOBAL_CLOCK,
): Composer {
  const engine = createEngine(context, destination, seed, DEFAULT_MOOD, tuning);
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  let lastTickMilliseconds = 0;

  const tick = (): void => {
    const began = performance.now();
    engine.pumpUntil(context.currentTime + SCHEDULE_AHEAD_SECONDS, context.currentTime);
    lastTickMilliseconds = performance.now() - began;
  };

  return {
    start(): void {
      if (cancelTimer !== null || stopped) return;
      engine.begin(context.currentTime + START_LEAD_SECONDS);
      tick();
      cancelTimer = clock.setInterval(tick, SCHEDULER_TICK_MS);
    },
    stop(fadeSeconds: number): void {
      if (stopped) return;
      stopped = true;
      if (cancelTimer !== null) {
        cancelTimer();
        cancelTimer = null;
      }
      const stopTime = engine.end(context.currentTime, fadeSeconds);
      const disposeDelayMs =
        (stopTime - context.currentTime + TEARDOWN_SLACK_SECONDS) * MILLISECONDS_PER_SECOND;
      clock.setTimeout(() => engine.dispose(), disposeDelayMs);
    },
    setMood(mood: ComposerMood): void {
      engine.setMood(mood, context.currentTime);
    },
    setTuning(next: ComposerTuning): void {
      engine.setTuning(next, context.currentTime);
    },
    stats: (): ComposerStats => ({
      liveNodeCount: engine.liveNodeCount(),
      lastTickMilliseconds,
      activeTempoBpm: engine.activeTempoBpm(),
      tempoAnchorTime: engine.tempoAnchorTime(),
      pendingTempoBpm: engine.pendingTempoBpm(),
    }),
  };
}

export function renderComposition(
  context: BaseAudioContext,
  destination: AudioNode,
  seed: number,
  mood: ComposerMood,
  seconds: number,
): void {
  const engine = createEngine(context, destination, seed, mood, DEFAULT_TUNING);
  engine.begin(0);
  engine.pumpUntil(seconds);
}
