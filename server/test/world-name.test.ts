// World-name generator tests.
//
// The generator is random by design, so these assert its CONTRACT — a non-empty,
// printable, plausibly-named string in every template, for any random source a
// caller could hand it — rather than particular names. A test that pinned exact
// output would fail the moment a word is added to a list, which is the one kind
// of change this file should welcome.

import { describe, expect, it } from 'vitest';
import { generateWorldName, type RandomSource } from '../src/world/world-name.ts';

/** Draws every list position in turn, so all four templates are exercised. */
function cyclingSource(step: number): RandomSource {
  let n = 0;
  return () => {
    const value = (n * step) % 1;
    n++;
    return value;
  };
}

describe('generateWorldName', () => {
  it('produces a non-empty, trimmed, printable name', () => {
    for (let i = 0; i < 500; i++) {
      const name = generateWorldName();
      expect(name.length).toBeGreaterThan(0);
      expect(name).toBe(name.trim());
      // Letters, spaces and nothing else: no undefined, no punctuation, no
      // stray double spaces from a template that lost a word.
      expect(name).toMatch(/^[A-Za-z]+( [A-Za-z]+)*$/);
      expect(name[0]).toBe(name[0].toUpperCase());
    }
  });

  it('never repeats a compound root against its own qualifier', () => {
    // "Thornthorn" / "Hollowhollow" are the only pairings the lists can produce
    // that read as a bug; the generator steps past them.
    for (let i = 0; i < 2000; i++) {
      expect(generateWorldName().toLowerCase()).not.toMatch(
        /(thorn)\1|(hollow)\2/,
      );
    }
  });

  it('is varied — 200 draws are not the same handful of names', () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) names.add(generateWorldName());
    // Loose on purpose: this asserts the lists are actually being sampled, not
    // a particular collision rate.
    expect(names.size).toBeGreaterThan(150);
  });

  it('is driven entirely by the injected random source', () => {
    const fixed = (): number => 0;
    // Same source, same draw: nothing else feeds the generator.
    expect(generateWorldName(fixed)).toBe(generateWorldName(fixed));
  });

  it('survives a degenerate random source', () => {
    // A source at the open end of the range (or a broken one) must not index
    // past a list and put "undefined" in somebody's permanent world name.
    for (const source of [(): number => 1, (): number => Number.NaN, (): number => -1]) {
      const name = generateWorldName(source);
      expect(name).not.toMatch(/undefined|NaN/);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('reaches every template shape', () => {
    const shapes = new Set<string>();
    for (const step of [0.017, 0.13, 0.37, 0.61]) {
      const source = cyclingSource(step);
      for (let i = 0; i < 400; i++) {
        const name = generateWorldName(source);
        if (name.startsWith('The ')) shapes.add('epithet');
        else if (name.includes(' of ')) shapes.add('possessive');
        else if (name.includes(' ')) shapes.add('compound+landform');
        else shapes.add('compound');
      }
    }
    expect(shapes.size).toBe(4);
  });
});
