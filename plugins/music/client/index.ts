import { createEffect, createRoot } from 'solid-js';
import { createComposer, type Composer } from './composer/composer.ts';
import { MusicTuningPanel } from './MusicTuningPanel.tsx';
import { musicTuning } from './tuning-state.ts';
import type {
  ClientPluginCtx,
  PluginAudio,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { AUDIO_DEBUG } from '../../../client/src/audio/audioDebug.ts';

export const MUSIC_PLUGIN_NAME = 'music';

const MUSIC_DRAW_OBJECTS = 0;

const MUSIC_SEED = 1;

const MOOD_SAMPLE_MS = 1000;

const MOOD_GAUGES = {
  dayPhase: { plugin: 'daynight', key: 'phase' },
  rain: { plugin: 'rain', key: 'weightUnderCamera' },
  thunderstorm: { plugin: 'thunderstorm', key: 'weightUnderCamera' },
} as const;

const TENSION_GAUGE = { plugin: 'monsters', key: 'tension' } as const;

const FALLBACK_DAY_PHASE = 0.5;
const FALLBACK_WEATHER = 0;
const FALLBACK_TENSION = 0;

const MOOD_LOG_STEP = 0.05;

let composer: Composer | null = null;
let moodTimer: ReturnType<typeof setInterval> | null = null;
let lastLoggedMood: { dayPhase: number; weather: number; tension: number } | null = null;

let disposeTuningEffect: (() => void) | null = null;

let lastLoggedTempoAnchor: number | null = null;

let audio: PluginAudio | null = null;

function readGauge(ctx: ClientPluginCtx, gauge: { plugin: string; key: string }): number | null {
  return ctx.gauge(gauge.plugin, gauge.key);
}

function logTempoAnchor(running: Composer): void {
  const stats = running.stats();
  if (stats.tempoAnchorTime === lastLoggedTempoAnchor) return;
  lastLoggedTempoAnchor = stats.tempoAnchorTime;
  console.log('[terrace audio] music tempo anchor', {
    activeTempoBpm: stats.activeTempoBpm,
    tempoAnchorTime: stats.tempoAnchorTime,
    pendingTempoBpm: stats.pendingTempoBpm,
  });
}

function sampleMood(ctx: ClientPluginCtx): void {
  const running = composer;
  if (running === null) return;
  const dayPhase = readGauge(ctx, MOOD_GAUGES.dayPhase) ?? FALLBACK_DAY_PHASE;
  const weather = Math.max(
    readGauge(ctx, MOOD_GAUGES.rain) ?? FALLBACK_WEATHER,
    readGauge(ctx, MOOD_GAUGES.thunderstorm) ?? FALLBACK_WEATHER,
  );
  const tension = readGauge(ctx, TENSION_GAUGE) ?? FALLBACK_TENSION;
  running.setMood({ dayPhase, weather, tension });

  if (!AUDIO_DEBUG) return;
  logTempoAnchor(running);
  const previous = lastLoggedMood;
  const moved =
    previous === null ||
    Math.abs(dayPhase - previous.dayPhase) >= MOOD_LOG_STEP ||
    Math.abs(weather - previous.weather) >= MOOD_LOG_STEP ||
    Math.abs(tension - previous.tension) >= MOOD_LOG_STEP;
  if (!moved) return;
  lastLoggedMood = { dayPhase, weather, tension };
  const stats = running.stats();
  console.log('[terrace audio] music mood', {
    dayPhase,
    weather,
    tension,
    tempoBpm: stats.activeTempoBpm,
    padToneGain: musicTuning().padToneGain,
    liveNodeCount: stats.liveNodeCount,
    lastTickMilliseconds: stats.lastTickMilliseconds,
  });
}

export const clientPlugin: TerraceClientPlugin = {
  name: MUSIC_PLUGIN_NAME,

  drawBudget: MUSIC_DRAW_OBJECTS,

  clientOnly: true,

  attach(ctx: ClientPluginCtx): void {
    audio = ctx.audio;
    ctx.audio.setMusicGenerator((outlet) => {
      const running = createComposer(outlet.context, outlet.destination, MUSIC_SEED, musicTuning());
      composer = running;
      lastLoggedMood = null;
      lastLoggedTempoAnchor = null;
      running.start();
      sampleMood(ctx);
      moodTimer = setInterval(() => {
        sampleMood(ctx);
      }, MOOD_SAMPLE_MS);
      disposeTuningEffect = createRoot((disposeRoot) => {
        createEffect(() => {
          running.setTuning(musicTuning());
        });
        return disposeRoot;
      });
      return {
        stop: (fadeSeconds: number): void => {
          if (moodTimer !== null) clearInterval(moodTimer);
          moodTimer = null;
          disposeTuningEffect?.();
          disposeTuningEffect = null;
          composer = null;
          running.stop(fadeSeconds);
        },
      };
    });
    ctx.registerHudPanel(MusicTuningPanel, { placement: 'settings' });
  },

  dispose(): void {
    audio?.setMusicGenerator(null);
    audio = null;
    disposeTuningEffect?.();
    disposeTuningEffect = null;
  },
};
