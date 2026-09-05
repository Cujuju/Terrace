// music — client half, and client only. There is no server half and no wire
// message: the score is generated on this machine from state this client
// already has, so the server never knows a note was played.
//
// It draws nothing. What it owns is the music bus: it claims the generator lane
// (ClientPluginCtx.audio.setMusicGenerator), runs the composer on core's own
// context, and retargets the mood from gauges its siblings publish.

import { createComposer, type Composer } from './composer/composer.ts';
import type {
  ClientPluginCtx,
  PluginAudio,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { AUDIO_DEBUG } from '../../../client/src/audio/audioDebug.ts';

export const MUSIC_PLUGIN_NAME = 'music';

/**
 * DRAWS NOTHING, so its share of the frame's draw calls is nothing — the honest
 * maximum, exactly as every other plugin's budget is an expression of its caps.
 */
const MUSIC_DRAW_OBJECTS = 0;

/**
 * The score's seed. A constant because ClientPluginCtx exposes no world
 * identity, and the music is not meant to be recognisable per world. Named so a
 * per-world seed is one edit.
 */
const MUSIC_SEED = 1;

/**
 * How often the mood is resampled, milliseconds. The composer's parameters
 * glide with a 1.5 s time constant (~4.5 s to settle), so anything faster is
 * inaudible. A WALL-CLOCK TIMER, never onFrame: no per-frame work for audio.
 */
const MOOD_SAMPLE_MS = 1000;

/**
 * The siblings this plugin reads. DOCUMENTED COPIES of their own gauge keys —
 * plugins address each other by name and never import each other
 * (docs/decisions/plugin-host.md, 2026-09-01). A missing gauge reads null.
 */
const MOOD_GAUGES = {
  dayPhase: { plugin: 'daynight', key: 'phase' },
  rain: { plugin: 'rain', key: 'weightUnderCamera' },
  thunderstorm: { plugin: 'thunderstorm', key: 'weightUnderCamera' },
} as const;

/**
 * Where danger would be read from. NOBODY PUBLISHES IT YET: which plugin owns
 * tension is a sound-design decision (plan §8.6), so the read is wired and
 * returns null until one does.
 */
const TENSION_GAUGE = { plugin: 'monsters', key: 'tension' } as const;

/**
 * The mood when no sibling answers — a documented copy of the composer's own
 * DEFAULT_MOOD (composer.ts), which is not exported. Midday, clear, calm.
 */
const FALLBACK_DAY_PHASE = 0.5;
const FALLBACK_WEATHER = 0;
const FALLBACK_TENSION = 0;

/** Debug only: mood is logged when a component moves at least this far. */
const MOOD_LOG_STEP = 0.05;

/**
 * Module-level singleton, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin, and
 * attach/dispose bracket its whole lifetime.
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
    // START IS CALLED BY CORE, once it is ready to make sound, and never at all
    // if the claim is refused or the machine has no Web Audio.
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
    // Core fades and stops the generator; the host's own release would too.
    audio?.setMusicGenerator(null);
    audio = null;
  },
};
