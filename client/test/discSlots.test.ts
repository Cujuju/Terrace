import { describe, expect, it } from 'vitest';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { createMassSlots } from '../src/plugins/kit/discSlots.ts';
import { discKindDrawObjects } from '../src/plugins/kit/discKindRigs.ts';
import { HAZE_DECK_DRAW_OBJECTS } from '../src/plugins/kit/hazeDeck.ts';
import { CUMULUS_DECK_DRAW_OBJECTS } from '../src/plugins/kit/cumulusDeck.ts';
import { PRECIPITATION_FIELD_DRAW_OBJECTS } from '../src/plugins/kit/precipitationField.ts';

const disc = (intensity: number) => ({ id: 1, x: 2, y: 3, radius: 4, intensity, vx: 5, vy: 6 });

describe('createMassSlots', () => {
  it('claims slots up to the ceiling and answers -1 past it', () => {
    const slots = createMassSlots(2);
    expect([slots.claim(), slots.claim(), slots.claim()]).toEqual([0, 1, -1]);
  });

  it('reports lit while any slot has intensity, in world units', () => {
    const slots = createMassSlots(2);
    expect(slots.update(0, disc(0.5))).toBe(true);
    expect(slots.massXZ[0]!.x).toBe(2 * CELL_WORLD_SIZE);
    expect(slots.massSize[0]!.x).toBe(4 * CELL_WORLD_SIZE);
    expect(slots.massVelocity[0]!.y).toBe(6 * CELL_WORLD_SIZE);
    expect(slots.update(1, disc(1))).toBe(true);
    expect(slots.park(0)).toBe(true);
    expect(slots.park(0)).toBe(true);
    expect(slots.update(1, disc(0))).toBe(false);
  });

  it('ignores an unclaimed slot and clears everything on reset', () => {
    const slots = createMassSlots(1);
    expect(slots.update(-1, disc(1))).toBe(false);
    slots.update(0, disc(1));
    slots.reset();
    expect(slots.massSize[0]!.y).toBe(0);
    expect(slots.claim()).toBe(0);
  });
});

describe('discKindDrawObjects', () => {
  it('counts one draw per deck a kind owns', () => {
    expect(discKindDrawObjects({ deck: null, profile: null })).toBe(HAZE_DECK_DRAW_OBJECTS);
    const deck = { puffSizeFraction: 0.1, color: 0 };
    const profile = {
      form: 'streak' as const,
      count: 1,
      fallSpeed: 1,
      streakLength: 1,
      spriteSize: 0,
      opacity: 1,
      color: 0,
      swayWorldUnits: 0,
      swayHz: 0,
      innerRadiusFraction: 0,
    };
    expect(discKindDrawObjects({ deck, profile })).toBe(
      HAZE_DECK_DRAW_OBJECTS + CUMULUS_DECK_DRAW_OBJECTS + PRECIPITATION_FIELD_DRAW_OBJECTS,
    );
  });
});
