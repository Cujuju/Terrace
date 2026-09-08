import {
  createComposer,
  renderComposition,
  type ComposerMood,
} from '../../plugins/music/client/composer/composer.ts';

const RENDER_SAMPLE_RATE_HZ = 48000;

const RENDER_CHANNELS = 1;

const MAX_RENDER_SECONDS = 300;

const INT16_FULL_SCALE = 32767;

const DIGEST_BLOCK_FRAMES = 4096;

const FNV_OFFSET_BASIS = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

const BYTE_MASK = 0xff;

const BITS_PER_BYTE = 8;

const HASH_RADIX = 16;
const HASH_DIGITS = 8;

const READOUT_DECIMALS = 2;

const READOUT_INTERVAL_MS = 200;

const STOP_FADE_SECONDS = 2;

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

function maxAbsoluteDifference(first: Float32Array, second: Float32Array): number {
  let largest = 0;
  const shared = Math.min(first.length, second.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = Math.abs((first[index] ?? 0) - (second[index] ?? 0));
    if (difference > largest) largest = difference;
  }
  return largest;
}

function numberParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function markReady(): void {
  (window as unknown as { __previewReady?: boolean }).__previewReady = true;
}

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
