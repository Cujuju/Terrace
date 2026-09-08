import { describe, expect, it } from 'vitest';
import { generateWorldName, type RandomSource } from '../src/world/world-name.ts';

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
      expect(name).toMatch(/^[A-Za-z]+( [A-Za-z]+)*$/);
      expect(name[0]).toBe(name[0].toUpperCase());
    }
  });

  it('never repeats a compound root against its own qualifier', () => {
    for (let i = 0; i < 2000; i++) {
      expect(generateWorldName().toLowerCase()).not.toMatch(
        /(thorn)\1|(hollow)\2/,
      );
    }
  });

  it('is varied — 200 draws are not the same handful of names', () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) names.add(generateWorldName());
    expect(names.size).toBeGreaterThan(150);
  });

  it('is driven entirely by the injected random source', () => {
    const fixed = (): number => 0;
    expect(generateWorldName(fixed)).toBe(generateWorldName(fixed));
  });

  it('survives a degenerate random source', () => {
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
