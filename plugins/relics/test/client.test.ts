import { describe, expect, it } from 'vitest';
import { Ray, Sphere, Vector3 } from 'three';
import { SKILLS, type RelicView } from '../protocol.ts';
import {
  GEM_BOB_AMPLITUDE_CELLS,
  GEM_BOB_PERIOD_S,
  GEM_SPIN_TURNS_PER_S,
  SKILL_KIND_COLOR,
  cooldownLabelSeconds,
  cssColor,
  gemBobOffset,
  gemPhaseFor,
  gemSpinAngle,
  relicColor,
  relicOnRay,
} from '../client/gems.ts';

function relic(id: string, x: number, y: number): RelicView {
  return { id, x, y, skill: 'quake' };
}

describe('relic colour', () => {
  it('is one colour per category, and every category has one', () => {
    const colors = new Set(Object.values(SKILL_KIND_COLOR));
    expect(colors.size).toBe(Object.keys(SKILL_KIND_COLOR).length);

    for (const skill of SKILLS) {
      expect(relicColor(skill.id)).toBe(SKILL_KIND_COLOR[skill.kind]);
    }
  });

  it('renders as a six-digit CSS hex, including dark colours', () => {
    expect(cssColor(0x4fc3f7)).toBe('#4fc3f7');
    expect(cssColor(0x00ff00)).toBe('#00ff00');
    expect(cssColor(0)).toBe('#000000');
  });
});

describe('gem animation', () => {
  it('bobs within its amplitude and returns to where it started each period', () => {
    for (let t = 0; t < GEM_BOB_PERIOD_S * 3; t += 0.05) {
      expect(Math.abs(gemBobOffset(t, 0))).toBeLessThanOrEqual(GEM_BOB_AMPLITUDE_CELLS + 1e-9);
    }
    expect(gemBobOffset(0, 0)).toBeCloseTo(gemBobOffset(GEM_BOB_PERIOD_S, 0), 9);
  });

  it('spins at the configured rate', () => {
    const oneTurn = 1 / GEM_SPIN_TURNS_PER_S;
    expect(gemSpinAngle(oneTurn, 0) - gemSpinAngle(0, 0)).toBeCloseTo(Math.PI * 2, 9);
  });

  it('gives adjacent relic ids well-separated phases, stably', () => {
    const phases = ['r1', 'r2', 'r3', 'r4', 'r5'].map(gemPhaseFor);
    for (const phase of phases) {
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(GEM_BOB_PERIOD_S);
    }
    expect(new Set(phases).size).toBe(phases.length);
    expect(gemPhaseFor('r3')).toBe(phases[2]);
  });
});

describe('relicOnRay', () => {
  const alongX = new Ray(new Vector3(0, 0, 0), new Vector3(1, 0, 0));
  const hitbox = (id: string, x: number, y = 0, radius = 1) => ({
    relic: relic(id, 0, 0),
    sphere: new Sphere(new Vector3(x, y, 0), radius),
  });

  it('picks the gem the ray passes through, and nothing it misses', () => {
    expect(relicOnRay(alongX, [hitbox('hit', 10)], Infinity)?.id).toBe('hit');
    expect(relicOnRay(alongX, [hitbox('miss', 10, 5)], Infinity)).toBeNull();
    expect(relicOnRay(alongX, [], Infinity)).toBeNull();
  });

  it('picks the nearer of two gems on the ray', () => {
    expect(relicOnRay(alongX, [hitbox('far', 20), hitbox('near', 10)], Infinity)?.id).toBe('near');
  });

  it('ignores a gem hidden behind the ground', () => {
    expect(relicOnRay(alongX, [hitbox('behind', 10)], 5)).toBeNull();
    expect(relicOnRay(alongX, [hitbox('before', 10)], 15)?.id).toBe('before');
  });

  it('ignores a gem behind the camera', () => {
    expect(relicOnRay(alongX, [hitbox('behind', -10)], Infinity)).toBeNull();
  });
});

describe('cooldownLabelSeconds', () => {
  it('rounds up, so a cooldown never reads 0 while it is still running', () => {
    expect(cooldownLabelSeconds(0.1)).toBe(1);
    expect(cooldownLabelSeconds(29.4)).toBe(30);
    expect(cooldownLabelSeconds(0)).toBe(0);
  });
});
