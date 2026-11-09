import { describe, expect, it } from 'vitest';
import { createPrng } from '../client/composer/prng.ts';
import { moodParameters, secondsPerChord } from '../client/composer/theory.ts';
import { DEFAULT_TUNING } from '../client/composer/tuning.ts';
import { createVoicePool, schedulePadChord, schedulePluck } from '../client/composer/voices.ts';
import { createHarness, RecordingAudioContext, RecordingNode } from './support/recordingAudio.ts';

describe('music scheduling contracts', () => {
  it('uses the dawn-based clock for noon and midnight settings', () => {
    const atPhase = (dayPhase: number) => moodParameters({ dayPhase, weather: 0, tension: 0 }, DEFAULT_TUNING);
    expect(atPhase(0.25).filterCutoffHz).toBe(DEFAULT_TUNING.filterDayCutoffHz);
    expect(atPhase(0.75).filterCutoffHz).toBe(DEFAULT_TUNING.filterNightCutoffHz);
    expect(atPhase(0.25).melodyDensity).toBeGreaterThan(atPhase(0.75).melodyDensity);
    expect(atPhase(0).filterCutoffHz).toBeCloseTo(atPhase(0.5).filterCutoffHz);
  });

  it('skips exactly the consumed random draws, including full generator cycles', () => {
    const draws = 10_000;
    const stepped = createPrng(1);
    const skipped = createPrng(1);
    for (let draw = 0; draw < draws; draw++) stepped.next();
    skipped.skip(draws);
    expect(skipped.next()).toBe(stepped.next());
    const cycle = 2 ** 32;
    const afterCycle = createPrng(1);
    afterCycle.skip(cycle + draws);
    const afterDraws = createPrng(1);
    afterDraws.skip(draws);
    expect(afterCycle.next()).toBe(afterDraws.next());
  });

  it('bounds resumed voices by the playback window instead of the missed duration', () => {
    const normal = createHarness();
    let normalMaximumNodes = normal.composer.stats().liveNodeCount;
    const seconds = 60;
    const ticksPerSecond = 4;
    for (let tick = 1; tick <= seconds * ticksPerSecond; tick++) {
      normal.tick(tick / ticksPerSecond);
      normalMaximumNodes = Math.max(normalMaximumNodes, normal.composer.stats().liveNodeCount);
    }
    const secondsPerYear = 365 * 24 * 60 * 60;
    for (const delay of [60, 600, 3600, secondsPerYear]) {
      const resumed = createHarness();
      const firstNewNode = resumed.context.nodes.length;
      resumed.tick(delay);
      const newSources = resumed.context.nodes.slice(firstNewNode).filter((node) => node.kind === 'oscillator');
      expect(newSources.length).toBeGreaterThan(0);
      expect(newSources.every((node) => node.startTime! >= delay && node.stopTime! > delay)).toBe(true);
      expect(resumed.composer.stats().liveNodeCount).toBeLessThanOrEqual(normalMaximumNodes);
    }
  });

  it('retains pending tempo and chord anchors when the scheduler misses their boundary', () => {
    const normal = createHarness();
    const resumed = createHarness();
    const tuning = { ...DEFAULT_TUNING, tempoBpm: 80, melodyDensityScale: 0 };
    normal.context.advance(2);
    resumed.context.advance(2);
    normal.composer.setTuning(tuning);
    resumed.composer.setTuning(tuning);
    const resumedTime = 61;
    for (let time = 2; time <= resumedTime; time += 0.25) normal.tick(time);
    resumed.tick(resumedTime);
    expect(resumed.composer.stats().activeTempoBpm).toBe(80);
    expect(resumed.composer.stats().tempoAnchorTime).toBe(normal.composer.stats().tempoAnchorTime);
    expect(resumed.composer.stats().tempoAnchorTime).toBeCloseTo(0.12 + secondsPerChord(DEFAULT_TUNING.tempoBpm));
    const futureNotes = (context: RecordingAudioContext) => context.nodes
      .filter((node) => node.kind === 'oscillator' && node.startTime! > resumedTime)
      .map((node) => [node.startTime, node.frequency.events[0]?.value]);
    expect(futureNotes(resumed.context).length).toBeGreaterThan(0);
    expect(futureNotes(resumed.context)).toEqual(futureNotes(normal.context));
  });

  it('retains still-audible off-beat tails when skipping older beats', () => {
    const tuning = { ...DEFAULT_TUNING, tempoBpm: 96, padReleaseSeconds: 0.2,
      pluckDurationSeconds: 6, melodyDensityScale: 2, offbeatDensityFactor: 1 };
    for (const resumedTime of [60, 60.1, 60.2, 60.3, 60.4, 60.5]) {
      const normal = createHarness(tuning);
      const resumed = createHarness(tuning);
      for (let time = 0.25; time < resumedTime; time += 0.25) normal.tick(time);
      normal.tick(resumedTime);
      resumed.tick(resumedTime);
      const activeTailEnds = (context: RecordingAudioContext) => context.nodes
        .filter((node) => node.kind === 'oscillator' && node.startTime! <= resumedTime &&
          (node.destination?.gain.events.at(-1)?.time ?? 0) > resumedTime)
        .map((node) => node.stopTime).sort();
      expect(activeTailEnds(resumed.context)).toEqual(activeTailEnds(normal.context));
    }
  });

  it('clamps a long pad attack to the chord and keeps automation chronological', () => {
    const context = new RecordingAudioContext();
    const destination = new RecordingNode('destination').asAudioNode();
    schedulePadChord(context.asAudioContext(), createVoicePool(), destination, destination, [45], 0,
      { holdSeconds: 5, attackSeconds: 6, releaseSeconds: 0.2, detuneCents: 7 });
    expect(context.nodes[0]?.gain.events).toEqual([
      { kind: 'set', value: 0, time: 0 },
      { kind: 'linear', value: 1, time: 5 },
      { kind: 'linear', value: 0, time: 5.2 },
    ]);
  });

  it('rejects expired voices before allocating and resumes a chord at its current envelope', () => {
    const context = new RecordingAudioContext();
    context.advance(6);
    const destination = new RecordingNode('destination').asAudioNode();
    const shape = { holdSeconds: 5, attackSeconds: 3, releaseSeconds: 2, detuneCents: 7 };
    schedulePadChord(context.asAudioContext(), createVoicePool(), destination, destination, [45], -5, shape);
    schedulePluck(context.asAudioContext(), createVoicePool(), destination, 69, 1, 0,
      { durationSeconds: 3, silentFloorGain: 0.0001 });
    expect(context.nodes).toHaveLength(0);
    schedulePadChord(context.asAudioContext(), createVoicePool(), destination, destination, [45], 0, shape);
    expect(context.nodes[0]?.gain.events).toEqual([
      { kind: 'set', value: 0.5, time: 6 },
      { kind: 'linear', value: 0, time: 7 },
    ]);
    expect(context.nodes.filter((node) => node.kind === 'oscillator').every((node) => node.startTime === 6)).toBe(true);
  });
});
