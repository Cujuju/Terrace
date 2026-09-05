// The procedural music composer: a self-contained generative score on plain
// Web Audio.
//
// WHAT IT KNOWS. An AudioContext, a destination node and a seed. Nothing else
// — no plugin ctx, no host, no Three.js, no HUD, no DOM. Phase 2b wires it to
// the audio host's music bus and feeds it a mood from daynight and the weather
// plugins; until then it must compile and run against Web Audio alone, which
// is also what makes it renderable offline and therefore verifiable.
//
// HOW TIME WORKS. Every event is scheduled on the AUDIO clock, never the frame
// clock. A setInterval tick (SCHEDULER_TICK_MS) schedules everything that
// falls inside the next SCHEDULE_AHEAD_SECONDS and then goes back to sleep —
// the standard Web Audio lookahead scheduler. There is no requestAnimationFrame
// and no per-frame work of any kind, which is the only way a background score
// can be free against this project's 7 ms frame budget (docs/DESIGN.md).
//
// HOW DETERMINISM WORKS. All randomness comes from createPrng(seed), and the
// draws are consumed in a fixed order that does NOT depend on when a tick
// fires: exactly two draws per melody subdivision, whether or not a note
// sounds. So the same seed and the same mood timeline always produce the same
// NOTE STREAM — the same notes, at the same times, with the same envelopes.
// renderComposition() below renders that stream offline so it can be checked.
//
// WHAT DETERMINISM DOES *NOT* MEAN HERE, measured 2026-09-04 on
// chrome-headless-shell 1234: two offline renders of the identical score are
// not bit-identical. Over 20 s renders they differed by up to 2e-6 in sample
// amplitude (~-114 dBFS, still ~54 dB under 16-bit's least significant bit),
// from the second sample onward — the renderer's own floating-point summation,
// not anything this module controls. So the verification artefact is a digest
// insensitive to that noise, plus a directly measured difference between two
// renders — see client/src/previewMusic.ts, which owns both.
//
// HOW MOOD WORKS. Continuous parameters (the low-pass cutoff, the drone gain)
// are GLIDED with setTargetAtTime, so they can be retargeted at any instant
// without a click. Discrete musical choices (major or minor) are sampled only
// at a chord boundary, so the key never jumps mid-bar.

import { createPrng } from './prng.ts';
import {
  BEATS_PER_CHORD,
  chordNotes,
  melodyEvent,
  MELODY_OFFBEAT_DENSITY_FACTOR,
  MELODY_SUBDIVISIONS_PER_BEAT,
  moodParameters,
  ROOT_MIDI_NOTE,
  SECONDS_PER_BEAT,
  type ComposerMood,
  type MoodParameters,
} from './theory.ts';
import { createVoicePool, schedulePadChord, schedulePluck, startDrone } from './voices.ts';

export type { ComposerMood } from './theory.ts';

/** How often the lookahead scheduler wakes, in milliseconds. 250 ms is four
 * wakes a second: far under SCHEDULE_AHEAD_SECONDS, so a tick delayed by a
 * busy main thread (a chunk rebuild, a GC) still lands with a full second of
 * scheduled audio in front of it and cannot cause a gap. */
const SCHEDULER_TICK_MS = 250;

/** How far ahead of the audio clock each tick schedules, in seconds. 1.5 s is
 * six times the tick period — the margin that absorbs main-thread stalls —
 * while still being short enough that a mood change is heard within about a
 * bar and a half rather than at some arbitrary later time. */
const SCHEDULE_AHEAD_SECONDS = 1.5;

/** Delay between start() and the first note, in seconds. Scheduling AT
 * currentTime is scheduling in the past by the time the call returns (the
 * audio clock advances during it), which Web Audio handles by firing the event
 * immediately — i.e. with the attack truncated. 120 ms is inaudible as a delay
 * and is well clear of one render quantum at any supported sample rate. */
const START_LEAD_SECONDS = 0.12;

/** Fade-in applied to the composer's own output at start(), in seconds. The
 * pad already has a 3 s attack, so this exists only to keep the very first
 * sample from being a step; 0.4 s covers it with no audible ramp of its own. */
const START_FADE_SECONDS = 0.4;

/** The composer's output level, below unity so the pad, melody and drone at
 * their simultaneous peaks leave headroom for whatever bus it is mixed into. */
const OUTPUT_LEVEL = 0.85;

/** Time constant of the mood glides, in seconds. setTargetAtTime reaches ~95 %
 * of its target in three time constants, so 1.5 s here means a mood change
 * takes about 4.5 s to complete: slower than a weather front arrives, which is
 * the point — the music must never be heard tracking a number. */
const MOOD_GLIDE_TIME_CONSTANT_SECONDS = 1.5;

/** Resonance of the mood low-pass. 0.7 is just below Butterworth (0.707): a
 * flat passband with no peak at the corner, so sweeping the cutoff changes
 * brightness and never whistles. */
const FILTER_RESONANCE_Q = 0.7;

/** Slack after a fade before the voices are stopped and the chain is taken
 * apart, in seconds. The fade is on the audio clock and the teardown timer is
 * on the wall clock; 100 ms is far more than that skew and guarantees nothing
 * is cut while still audible. */
const TEARDOWN_SLACK_SECONDS = 0.1;

/** Milliseconds in a second — for the one place a wall-clock timer is derived
 * from an audio-clock duration. */
const MILLISECONDS_PER_SECOND = 1000;

/** What the preview page reports; diagnostics only, never used by the music. */
export interface ComposerStats {
  /** AudioNodes the voice pool currently holds. Must stay bounded. */
  readonly liveNodeCount: number;
  /** Wall-clock cost of the most recent scheduler tick, in milliseconds. */
  readonly lastTickMilliseconds: number;
}

/** A running generative score. */
export interface Composer {
  /** Begin scheduling from the context's current time. Idempotent. */
  start(): void;
  /** Ramp everything to silence over `fadeSeconds` then release all nodes.
   * Idempotent, and terminal: a stopped composer does not restart. */
  stop(fadeSeconds: number): void;
  /** Retarget the mood; parameters glide, never step (no clicks, no key jumps
   * mid-bar). Safe before start() and after stop(). */
  setMood(mood: ComposerMood): void;
  /** Live diagnostics. Additive to the phase-2a brief's interface, for the
   * preview page's node-count and tick-cost readouts. */
  stats(): ComposerStats;
}

/** The mood a composer holds until told otherwise: midday, clear, calm. */
const DEFAULT_MOOD: ComposerMood = { dayPhase: 0.5, weather: 0, tension: 0 };

/**
 * The part that is shared by the realtime composer and the offline render: the
 * node chain, the note stream, and a `pumpUntil` that schedules every event
 * starting before a given audio time. It has no timer of its own — who calls
 * pumpUntil, and how often, is the only difference between the two modes.
 */
function createEngine(
  context: BaseAudioContext,
  destination: AudioNode,
  seed: number,
  initialMood: ComposerMood,
) {
  const prng = createPrng(seed);
  const pool = createVoicePool();

  const outputGain = context.createGain();
  outputGain.connect(destination);

  const moodFilter = context.createBiquadFilter();
  moodFilter.type = 'lowpass';
  moodFilter.Q.value = FILTER_RESONANCE_Q;
  moodFilter.connect(outputGain);

  let mood: ComposerMood = initialMood;
  let droneGain: GainNode | null = null;
  let startTime = 0;
  /** Beats scheduled so far; the scheduler's whole position in the score. */
  let nextBeatIndex = 0;
  /** Major or minor, sampled at the last chord boundary and held until the
   * next one so the melody's scale always agrees with the chord under it. */
  let activeMinor = false;
  /** Last melody pitch, so the next pick never repeats it. */
  let previousMelodyNote: number | null = null;

  /** Applies the continuous half of a mood. `glide` is false only at the very
   * first application, where there is no previous value to glide from. */
  const applyMoodParameters = (
    parameters: MoodParameters,
    atTime: number,
    glide: boolean,
  ): void => {
    if (glide) {
      moodFilter.frequency.setTargetAtTime(
        parameters.filterCutoffHz,
        atTime,
        MOOD_GLIDE_TIME_CONSTANT_SECONDS,
      );
      droneGain?.gain.setTargetAtTime(
        parameters.droneGain,
        atTime,
        MOOD_GLIDE_TIME_CONSTANT_SECONDS,
      );
      return;
    }
    moodFilter.frequency.setValueAtTime(parameters.filterCutoffHz, atTime);
    droneGain?.gain.setValueAtTime(parameters.droneGain, atTime);
  };

  return {
    setMood(next: ComposerMood, atTime: number): void {
      mood = next;
      applyMoodParameters(moodParameters(mood), atTime, true);
    },

    /** Opens the chain at `atTime` and starts the always-on drone voice. */
    begin(atTime: number): void {
      startTime = atTime;
      outputGain.gain.setValueAtTime(0, atTime);
      outputGain.gain.linearRampToValueAtTime(OUTPUT_LEVEL, atTime + START_FADE_SECONDS);
      droneGain = startDrone(context, pool, moodFilter, ROOT_MIDI_NOTE, atTime);
      applyMoodParameters(moodParameters(mood), atTime, false);
    },

    /** Schedules every event whose start time is before `horizon`. */
    pumpUntil(horizon: number): void {
      while (startTime + nextBeatIndex * SECONDS_PER_BEAT < horizon) {
        const beatIndex = nextBeatIndex;
        nextBeatIndex += 1;
        const beatTime = startTime + beatIndex * SECONDS_PER_BEAT;
        const parameters = moodParameters(mood);

        if (beatIndex % BEATS_PER_CHORD === 0) {
          // The one place mode is decided, and it is a chord boundary by
          // construction: this is what "no key jumps mid-bar" means.
          activeMinor = parameters.minor;
          const chordIndex = beatIndex / BEATS_PER_CHORD;
          schedulePadChord(
            context,
            pool,
            moodFilter,
            chordNotes(chordIndex, activeMinor),
            beatTime,
          );
        }

        // The melody's scale follows the chord's mode, not the instantaneous
        // one; its density and octave follow the mood immediately, because
        // neither can produce a discontinuity in anything already sounding.
        const melodyParameters: MoodParameters = { ...parameters, minor: activeMinor };
        const subdivisionSeconds = SECONDS_PER_BEAT / MELODY_SUBDIVISIONS_PER_BEAT;
        for (let sub = 0; sub < MELODY_SUBDIVISIONS_PER_BEAT; sub += 1) {
          // BOTH draws happen unconditionally. That is what keeps the random
          // stream a function of the seed alone: a denser mood then plays MORE
          // of the same underlying sequence rather than a different one.
          const gate = prng.next();
          const pick = prng.next();
          const density =
            melodyParameters.melodyDensity * (sub === 0 ? 1 : MELODY_OFFBEAT_DENSITY_FACTOR);
          if (gate >= density) continue;
          const event = melodyEvent(pick, melodyParameters, previousMelodyNote);
          previousMelodyNote = event.note;
          schedulePluck(
            context,
            pool,
            moodFilter,
            event.note,
            event.velocity,
            beatTime + sub * subdivisionSeconds,
          );
        }
      }
    },

    /** Fades the output to silence over `fadeSeconds` and stops every voice. */
    end(atTime: number, fadeSeconds: number): number {
      const fadeEnd = atTime + Math.max(fadeSeconds, 0);
      outputGain.gain.cancelScheduledValues(atTime);
      outputGain.gain.setValueAtTime(outputGain.gain.value, atTime);
      outputGain.gain.linearRampToValueAtTime(0, fadeEnd);
      const stopTime = fadeEnd + TEARDOWN_SLACK_SECONDS;
      pool.stopAll(stopTime);
      return stopTime;
    },

    /** Takes the fixed part of the chain apart. Called after every voice has
     * been stopped; the voices themselves are released by the pool. */
    dispose(): void {
      moodFilter.disconnect();
      outputGain.disconnect();
    },

    liveNodeCount: (): number => pool.liveNodeCount(),
  };
}

/**
 * Creates a composer that plays continuously into `destination` until stopped.
 *
 * The context is NOT resumed here: unlocking a suspended AudioContext needs a
 * user gesture and belongs to whoever owns the page's input (the audio host in
 * phase 2b, the preview page today). A composer started against a suspended
 * context simply produces nothing until it resumes, with no error and no lost
 * position — the audio clock does not advance while suspended.
 */
export function createComposer(
  context: AudioContext,
  destination: AudioNode,
  seed: number,
): Composer {
  const engine = createEngine(context, destination, seed, DEFAULT_MOOD);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let lastTickMilliseconds = 0;

  const tick = (): void => {
    const began = performance.now();
    engine.pumpUntil(context.currentTime + SCHEDULE_AHEAD_SECONDS);
    lastTickMilliseconds = performance.now() - began;
  };

  return {
    start(): void {
      if (timer !== null || stopped) return;
      engine.begin(context.currentTime + START_LEAD_SECONDS);
      tick();
      timer = setInterval(tick, SCHEDULER_TICK_MS);
    },
    stop(fadeSeconds: number): void {
      if (stopped) return;
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      const stopTime = engine.end(context.currentTime, fadeSeconds);
      const disposeDelayMs =
        (stopTime - context.currentTime + TEARDOWN_SLACK_SECONDS) * MILLISECONDS_PER_SECOND;
      setTimeout(() => engine.dispose(), disposeDelayMs);
    },
    setMood(mood: ComposerMood): void {
      engine.setMood(mood, context.currentTime);
    },
    stats: (): ComposerStats => ({
      liveNodeCount: engine.liveNodeCount(),
      lastTickMilliseconds,
    }),
  };
}

/**
 * Schedules `seconds` of music into an offline context in a single pass, at a
 * fixed mood. THE VERIFICATION PATH: an OfflineAudioContext renders faster than
 * realtime, so it is how "the same seed writes the same music" is checked on a
 * box with no audio output. See this file's header for the one way in which
 * that is not bit-exactness.
 *
 * Realtime and offline share every line of the note stream — the only
 * difference is that here `pumpUntil` is called once with the whole duration
 * as its horizon instead of repeatedly with a lookahead, because an offline
 * context's clock does not advance until rendering starts.
 */
export function renderComposition(
  context: BaseAudioContext,
  destination: AudioNode,
  seed: number,
  mood: ComposerMood,
  seconds: number,
): void {
  // The mood is passed as the engine's INITIAL mood rather than set after
  // construction: setMood glides, and a glide starting at time 0 would leave
  // the first seconds of every render sweeping up from the default mood
  // instead of sitting at the requested one.
  const engine = createEngine(context, destination, seed, mood);
  engine.begin(0);
  engine.pumpUntil(seconds);
}
