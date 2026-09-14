import { describe, expect, it } from 'vitest';
import { denialHintFor } from '../src/world.ts';

describe('denialHintFor — every sculptDenied selects hint text', () => {
  it('core-locked ground hints locked', () => {
    expect(denialHintFor('locked', undefined)).toBe('locked');
  });

  it('a malformed intent hints locked', () => {
    expect(denialHintFor('malformed', undefined)).toBe('locked');
  });

  it('a plugin rewrite core had to refuse hints locked', () => {
    expect(denialHintFor('plugin-modified-invalid', undefined)).toBe('locked');
    expect(denialHintFor('plugin-modified-invalid', 'centre is locked')).toBe('locked');
  });

  it('a reasonless denial still hints locked — ANY denial pulses', () => {
    expect(denialHintFor(undefined, undefined)).toBe('locked');
  });

  it('a monsters protection denial hints nest', () => {
    expect(denialHintFor('plugin-denied', 'monster occupies the ground')).toBe('nest');
  });

  it('a relics bedrock-ward denial hints ward', () => {
    expect(denialHintFor('plugin-denied', 'warded')).toBe('ward');
  });

  it('a mana denial hints mana-with-cost', () => {
    expect(denialHintFor('plugin-denied', 'insufficient mana')).toBe('mana-with-cost');
  });
});
