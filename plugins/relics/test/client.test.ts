// The client half's pure logic. Rendering is verified manually per design §8
// ("Client rendering is verified manually in v1; don't build a headless GL test
// rig"), so what is tested here is everything the meshes are driven FROM: the
// bob/spin maths, the colour mapping, and the click → relic resolution that
// decides whether a press is claimed away from the sculpt brush.

import { describe, expect, it } from 'vitest';
import { SKILLS, type RelicView } from '../protocol.ts';
import {
  GEM_BOB_AMPLITUDE_CELLS,
  GEM_BOB_PERIOD_S,
  GEM_SPIN_TURNS_PER_S,
  RELIC_PICK_RADIUS_CELLS,
  SKILL_KIND_COLOR,
  cooldownLabelSeconds,
  cssColor,
  gemBobOffset,
  gemPhaseFor,
  gemSpinAngle,
  relicColor,
  relicUnderCell,
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
    // Distinct — the whole point is that gems do not bob in lockstep.
    expect(new Set(phases).size).toBe(phases.length);
    // …and stable, so a keepalive re-broadcast does not make a gem jump.
    expect(gemPhaseFor('r3')).toBe(phases[2]);
  });
});

describe('relicUnderCell', () => {
  const relics = [relic('near', 10, 10), relic('far', 40, 40)];

  it('claims a direct hit', () => {
    expect(relicUnderCell(relics, { x: 10, y: 10 })?.id).toBe('near');
  });

  it('claims within the tolerance and not outside it', () => {
    expect(relicUnderCell(relics, { x: 10 + RELIC_PICK_RADIUS_CELLS, y: 10 })?.id).toBe('near');
    expect(relicUnderCell(relics, { x: 10 + RELIC_PICK_RADIUS_CELLS + 1, y: 10 })).toBeNull();
  });

  it('picks the nearest when two are in range', () => {
    const crowded = [relic('a', 10, 10), relic('b', 11, 10)];
    expect(relicUnderCell(crowded, { x: 11, y: 10 })?.id).toBe('b');
    expect(relicUnderCell(crowded, { x: 10, y: 10 })?.id).toBe('a');
  });

  it('claims nothing when there are no relics', () => {
    expect(relicUnderCell([], { x: 10, y: 10 })).toBeNull();
  });
});

describe('cooldownLabelSeconds', () => {
  it('rounds up, so a cooldown never reads 0 while it is still running', () => {
    expect(cooldownLabelSeconds(0.1)).toBe(1);
    expect(cooldownLabelSeconds(29.4)).toBe(30);
    expect(cooldownLabelSeconds(0)).toBe(0);
  });
});
