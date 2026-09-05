// previewMusic.ts — THROWAWAY preview harness for the procedural composer in
// plugins/music/client/composer/. Reached only through preview-music.html;
// not part of the shipped app, not registered in plugins/registry.ts.
//
// IT EXISTS FOR TWO JOBS THIS BOX CANNOT DO ANY OTHER WAY.
//
// 1. LISTENING. WSL has no audio output, so the realtime half of this page is
//    for a human on a machine that does: three mood sliders, a seed, start and
//    stop, and a live readout of the composer's node count and scheduler tick
//    cost — the two numbers the brief asks to be reported.
// 2. VERIFYING. `?render=<seconds>` renders that many seconds through an
//    OfflineAudioContext and prints a digest of the resulting PCM — the
//    artefact the orchestrator checks, since nobody here can listen.
//
//    IT RENDERS TWICE AND REPORTS THE DIFFERENCE, and the reason is a measured
//    fact rather than caution: on chrome-headless-shell 1234, two renders of
//    the IDENTICAL score are not bit-identical. They diverge from the second
//    sample onward by up to 2e-6 in amplitude — about -114 dBFS, still some
//    54 dB under 16-bit's least significant bit, i.e. the renderer's own float
//    summation noise. A hash taken over per-sample int16 values therefore
//    flips whenever any one of a quarter-million samples happens to sit on a
//    rounding boundary, which it did: the same 5 s of seed 1 hashed 229c9f94
//    and de7f7f83 on consecutive runs. A bare oscillator with no other nodes
//    hashed identically across renders, which is what places the noise in the
//    renderer's mixing rather than in this composer.
//
//    So the digest is taken over BLOCK RMS, where the noise averages out far
//    below the quantisation step, and the page also prints the max sample
//    difference between its two renders. Between them they answer both
//    questions honestly: "is this the same music" (the digest) and "how far
//    from bit-exact is this machine" (the difference).
//
//   ?render=<seconds>   render offline and print the PCM digest, then stop
//   ?seed=<integer>     composer seed (default 1)
//   ?day=<0..1>         dayPhase   (default 0.5, noon)
//   ?weather=<0..1>     weather    (default 0)
//   ?tension=<0..1>     tension    (default 0)
//
// A screenshot or scraping driver waits for `window.__previewReady === true`,
// which is set once the render digest has been printed (render mode) or the
// controls are wired (realtime mode).

import {
  createComposer,
  renderComposition,
  type ComposerMood,
} from '../../plugins/music/client/composer/composer.ts';

/** Sample rate of the offline render. 48 kHz is the rate every current browser
 * uses for its realtime context on this hardware, so the offline render
 * exercises the same resampling-free path the player will hear. It is also
 * part of the digest's identity: a digest is only comparable to another taken
 * at the same rate, which is why this is fixed here and not read from
 * anywhere. */
const RENDER_SAMPLE_RATE_HZ = 48000;

/** Channels rendered offline. The composer is mono — no panner anywhere in
 * voices.ts — so a second channel would be a byte-identical copy and would
 * only double the hashing work. */
const RENDER_CHANNELS = 1;

/** Longest offline render the page will accept, in seconds. Five minutes at
 * 48 kHz is ~57 MB of float samples; past that a typo in the query string
 * turns into a tab crash rather than an error message. */
const MAX_RENDER_SECONDS = 300;

/** Full-scale value of a signed 16-bit sample. Block RMS values are quantised
 * onto this grid before hashing: 16 bits is finer than any playback path
 * resolves, so a digest at this resolution still catches any real change to a
 * note, a gain or an envelope. */
const INT16_FULL_SCALE = 32767;

/** Samples per block in the digest. 4096 at 48 kHz is ~85 ms — short enough
 * that a single missing or moved melody note changes at least one block's RMS
 * by orders of magnitude more than the quantisation step, long enough that the
 * renderer's ~1e-6 float noise averages away well below it. Measured stable:
 * five 20 s renders across two browser processes produced one digest per
 * (seed, mood) and no mismatch. */
const DIGEST_BLOCK_FRAMES = 4096;

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/** Byte mask, for feeding a 16-bit sample to FNV-1a one byte at a time. */
const BYTE_MASK = 0xff;

/** Bits in a byte — the shift that takes a 16-bit sample's high byte. */
const BITS_PER_BYTE = 8;

/** Radix and width of the printed digest: eight hex digits for 32 bits. */
const HASH_RADIX = 16;
const HASH_DIGITS = 8;

/** Decimal places in the slider readouts and the reported tick cost. */
const READOUT_DECIMALS = 2;

/** How often the realtime readout refreshes, in milliseconds. 200 ms is fast
 * enough to watch the node count breathe with the chord crossfade and slow
 * enough that the readout itself never shows up in the tick cost it reports. */
const READOUT_INTERVAL_MS = 200;

/** Fade applied by the Stop button, in seconds. Long enough to hear the fade
 * as deliberate rather than as a cut. */
const STOP_FADE_SECONDS = 2;

/**
 * FNV-1a over the int16-quantised RMS of each DIGEST_BLOCK_FRAMES block of one
 * channel of PCM.
 *
 * FNV rather than a cryptographic digest because the question is "is this the
 * same music", not "did an adversary change it", and because SubtleCrypto is
 * async and only available on secure origins — which a LAN dev server is not.
 *
 * RESIDUAL, NAMED: an RMS digest is blind to a change that moves energy around
 * inside one 85 ms block without changing its total — swapping the order of
 * two simultaneous voices, say. Nothing the composer can do produces that (a
 * different note is a different frequency, and every envelope is longer than a
 * block), and the alternative — a per-sample hash — is not stable on this
 * renderer at all, which is a worse failure: it reports a difference that is
 * not there.
 */
function digestSamples(samples: Float32Array): string {
  let hash = FNV_OFFSET_BASIS;
  for (let start = 0; start < samples.length; start += DIGEST_BLOCK_FRAMES) {
    const end = Math.min(start + DIGEST_BLOCK_FRAMES, samples.length);
    let sumOfSquares = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      sumOfSquares += sample * sample;
    }
    const rms = Math.sqrt(sumOfSquares / (end - start));
    const quantised = Math.round(Math.min(1, rms) * INT16_FULL_SCALE);
    hash = Math.imul(hash ^ (quantised & BYTE_MASK), FNV_PRIME);
    hash = Math.imul(hash ^ ((quantised >> BITS_PER_BYTE) & BYTE_MASK), FNV_PRIME);
  }
  return (hash >>> 0).toString(HASH_RADIX).padStart(HASH_DIGITS, '0');
}

/** Largest absolute difference between two renders, sample for sample. */
function maxAbsoluteDifference(first: Float32Array, second: Float32Array): number {
  let largest = 0;
  const shared = Math.min(first.length, second.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = Math.abs((first[index] ?? 0) - (second[index] ?? 0));
    if (difference > largest) largest = difference;
  }
  return largest;
}

/** Reads a query parameter as a number, falling back when absent or unparsable. */
function numberParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Marks the page ready for a driver that is waiting to read it. */
function markReady(): void {
  (window as unknown as { __previewReady?: boolean }).__previewReady = true;
}

/** The element lookups this page needs, or null if the document is not ours. */
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`preview-music.html is missing #${id}`);
  return found as T;
}

async function renderMode(seconds: number, seed: number, mood: ComposerMood): Promise<void> {
  const clamped = Math.min(Math.max(seconds, 0), MAX_RENDER_SECONDS);
  const frames = Math.round(clamped * RENDER_SAMPLE_RATE_HZ);

  const renderOnce = async (): Promise<Float32Array> => {
    const context = new OfflineAudioContext(RENDER_CHANNELS, frames, RENDER_SAMPLE_RATE_HZ);
    renderComposition(context, context.destination, seed, mood, clamped);
    const buffer = await context.startRendering();
    return buffer.getChannelData(0);
  };

  const first = await renderOnce();
  const second = await renderOnce();
  const digest = digestSamples(first);
  const repeatDigest = digestSamples(second);
  const report = [
    `render ${clamped} s @ ${RENDER_SAMPLE_RATE_HZ} Hz`,
    `seed ${seed}`,
    `mood day=${mood.dayPhase} weather=${mood.weather} tension=${mood.tension}`,
    `frames ${first.length}`,
    `pcm-digest ${digest}`,
    `repeat-digest ${repeatDigest} (${digest === repeatDigest ? 'match' : 'MISMATCH'})`,
    `repeat-max-abs-diff ${maxAbsoluteDifference(first, second).toExponential(2)}`,
  ].join('\n');
  element('render').textContent = report;
  element('readout').textContent = 'offline render complete';
  console.log(report);
  markReady();
}

function realtimeMode(seed: number, initial: ComposerMood): void {
  const day = element<HTMLInputElement>('day');
  const weather = element<HTMLInputElement>('weather');
  const tension = element<HTMLInputElement>('tension');
  const seedInput = element<HTMLInputElement>('seed');
  const readout = element('readout');

  day.value = String(initial.dayPhase);
  weather.value = String(initial.weather);
  tension.value = String(initial.tension);
  seedInput.value = String(seed);

  let context: AudioContext | null = null;
  let composer: ReturnType<typeof createComposer> | null = null;

  const mood = (): ComposerMood => ({
    dayPhase: Number(day.value),
    weather: Number(weather.value),
    tension: Number(tension.value),
  });

  const showMood = (): void => {
    element('day-value').textContent = Number(day.value).toFixed(READOUT_DECIMALS);
    element('weather-value').textContent = Number(weather.value).toFixed(READOUT_DECIMALS);
    element('tension-value').textContent = Number(tension.value).toFixed(READOUT_DECIMALS);
  };

  for (const slider of [day, weather, tension]) {
    slider.addEventListener('input', () => {
      showMood();
      composer?.setMood(mood());
    });
  }
  showMood();

  element('start').addEventListener('click', () => {
    if (composer !== null) return;
    // Created inside the click: an AudioContext constructed outside a user
    // gesture starts suspended in every current browser, and this page has no
    // host to unlock it later.
    context = new AudioContext();
    void context.resume();
    composer = createComposer(context, context.destination, Number(seedInput.value));
    composer.setMood(mood());
    composer.start();
  });

  element('stop').addEventListener('click', () => {
    composer?.stop(STOP_FADE_SECONDS);
    composer = null;
  });

  setInterval(() => {
    if (composer === null || context === null) {
      readout.textContent = 'idle';
      return;
    }
    const stats = composer.stats();
    readout.textContent = [
      `state ${context.state}`,
      `clock ${context.currentTime.toFixed(READOUT_DECIMALS)} s`,
      `live nodes ${stats.liveNodeCount}`,
      `last tick ${stats.lastTickMilliseconds.toFixed(READOUT_DECIMALS)} ms`,
    ].join('   ');
  }, READOUT_INTERVAL_MS);

  markReady();
}

const params = new URLSearchParams(window.location.search);
const seed = numberParam(params, 'seed', 1);
const mood: ComposerMood = {
  dayPhase: numberParam(params, 'day', 0.5),
  weather: numberParam(params, 'weather', 0),
  tension: numberParam(params, 'tension', 0),
};
const renderSeconds = params.get('render');
if (renderSeconds === null) {
  realtimeMode(seed, mood);
} else {
  void renderMode(Number(renderSeconds), seed, mood);
}
