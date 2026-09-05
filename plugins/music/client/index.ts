// music — client half, and client only. No server half, no wire message: the
// score is generated here, so the server never knows a note was played.
//
// It draws nothing. It claims the generator lane
// (ClientPluginCtx.audio.setMusicGenerator), runs the composer on core's
// context, and retargets the mood from gauges its siblings publish. Plan §8.

import { createComposer, type Composer } from './composer/composer.ts';
import type {
  ClientPluginCtx,
  PluginAudio,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { AUDIO_DEBUG } from '../../../client/src/audio/audioDebug.ts';

export const MUSIC_PLUGIN_NAME = 'music';

/** DRAWS NOTHING, so its share of the frame's draw calls is nothing. */
const MUSIC_DRAW_OBJECTS = 0;

/**
 * The score's seed. Constant: ClientPluginCtx exposes no world identity, and
 * the score is not meant to be per-world. Named so a per-world seed is one edit.
 */
const MUSIC_SEED = 1;

/**
 * Mood resample period, ms. The composer glides over ~4.5 s
 * (MOOD_GLIDE_TIME_CONSTANT_SECONDS), so faster is inaudible. Wall-clock timer,
 * never onFrame.
 */
const MOOD_SAMPLE_MS = 1000;

/**
 * DOCUMENTED COPIES of the siblings' gauge keys: plugins address each other by
 * name, never by import (docs/decisions/plugin-host.md, 2026-09-01).
 */
const MOOD_GAUGES = {
  dayPhase: { plugin: 'daynight', key: 'phase' },
  rain: { plugin: 'rain', key: 'weightUnderCamera' },
  thunderstorm: { plugin: 'thunderstorm', key: 'weightUnderCamera' },
} as const;

/**
 * Where danger would be read from. NOBODY PUBLISHES IT YET — the source is a
 * sound-design decision (plan §8.6), so this reads null and tension stays 0.
 */
const TENSION_GAUGE = { plugin: 'monsters', key: 'tension' } as const;

/**
 * The mood when no sibling answers — a documented copy of the composer's
 * unexported DEFAULT_MOOD. Midday, clear, calm.
 */
const FALLBACK_DAY_PHASE = 0.5;
const FALLBACK_WEATHER = 0;
const FALLBACK_TENSION = 0;

/** Debug only: mood is logged when a component moves at least this far. */
const MOOD_LOG_STEP = 0.05;

/**
 * Module-level singleton, as this repo's other plugins are: the host builds one
 * instance per plugin, and attach/dispose bracket its lifetime.
 */
let composer: Composer | null = null;
let moodTimer: ReturnType<typeof setInterval> | null = null;
let lastLoggedMood: { dayPhase: number; weather: number; tension: number } | null = null;

/** Held so dispose can hand the bus back; null between dispose and attach. */
let audio: PluginAudio | null = null;

function readGauge(ctx: ClientPluginCtx, gauge: { plugin: string; key: string }): number | null {
  return ctx.gauge(gauge.plugin, gauge.key);
}

function sampleMood(ctx: ClientPluginCtx): void {
  const running = composer;
  if (running === null) return;
  const dayPhase = readGauge(ctx, MOOD_GAUGES.dayPhase) ?? FALLBACK_DAY_PHASE;
  // LOUDER OF THE TWO, not the sum: rain under a storm is one sky, not two.
  const weather = Math.max(
    readGauge(ctx, MOOD_GAUGES.rain) ?? FALLBACK_WEATHER,
    readGauge(ctx, MOOD_GAUGES.thunderstorm) ?? FALLBACK_WEATHER,
  );
  const tension = readGauge(ctx, TENSION_GAUGE) ?? FALLBACK_TENSION;
  running.setMood({ dayPhase, weather, tension });

  if (!AUDIO_DEBUG) return;
  const previous = lastLoggedMood;
  const moved =
    previous === null ||
    Math.abs(dayPhase - previous.dayPhase) >= MOOD_LOG_STEP ||
    Math.abs(weather - previous.weather) >= MOOD_LOG_STEP ||
    Math.abs(tension - previous.tension) >= MOOD_LOG_STEP;
  if (!moved) return;
  lastLoggedMood = { dayPhase, weather, tension };
  console.log('[terrace audio] music mood', {
    dayPhase,
    weather,
    tension,
    liveNodeCount: running.stats().liveNodeCount,
    lastTickMilliseconds: running.stats().lastTickMilliseconds,
  });
}

export const clientPlugin: TerraceClientPlugin = {
  name: MUSIC_PLUGIN_NAME,

  drawBudget: MUSIC_DRAW_OBJECTS,

  /** No server half, so the server's live set never names it. */
  clientOnly: true,

  attach(ctx: ClientPluginCtx): void {
    audio = ctx.audio;
    // START IS CALLED BY CORE, and never if the claim is refused.
    ctx.audio.setMusicGenerator((outlet) => {
      const running = createComposer(outlet.context, outlet.destination, MUSIC_SEED);
      composer = running;
      lastLoggedMood = null;
      running.start();
      sampleMood(ctx);
      moodTimer = setInterval(() => {
        sampleMood(ctx);
      }, MOOD_SAMPLE_MS);
      return {
        stop: (fadeSeconds: number): void => {
          if (moodTimer !== null) clearInterval(moodTimer);
          moodTimer = null;
          composer = null;
          running.stop(fadeSeconds);
        },
      };
    });
  },

  dispose(): void {
    // Core fades and stops the generator; the host's release would too.
    audio?.setMusicGenerator(null);
    audio = null;
  },
};
