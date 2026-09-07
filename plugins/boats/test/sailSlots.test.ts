// The contract the fleet's one sail InstancedMesh rests on. No three.js here on
// purpose: the pool is the rule, and the rule is about reuse, exhaustion and
// which prefix of the buffer still has to be drawn.

import { describe, expect, it } from 'vitest';
import { createSailSlots } from '../client/sailSlots.ts';

/** Small enough to exhaust in a test, large enough to release from the middle. */
const TEST_CAPACITY = 4;

describe('the sail slot pool', () => {
  it('gives every live boat a slot of its own', () => {
    const slots = createSailSlots(TEST_CAPACITY);
    const held = [slots.acquire(), slots.acquire(), slots.acquire()];
    expect(new Set(held).size).toBe(held.length);
  });

  it('reuses a released slot instead of consuming a fresh one', () => {
    // Fleets churn: a boat sinks every fight. Without reuse a long session
    // would walk off the end of the mesh with most of it parked.
    const slots = createSailSlots(TEST_CAPACITY);
    const first = slots.acquire();
    const second = slots.acquire();
    slots.release(first);
    expect(slots.acquire()).toBe(first);
    expect(second).not.toBe(first);
  });

  it('never hands out more than its capacity, and says so rather than overrunning', () => {
    // Writing past the capacity is a silent out-of-bounds into the instance
    // buffer, so the pool refuses instead.
    const slots = createSailSlots(TEST_CAPACITY);
    for (let i = 0; i < TEST_CAPACITY; i++) slots.acquire();
    expect(() => slots.acquire()).toThrow(/slots is taken/);
  });

  it('draws nothing once every slot is released', () => {
    // drawnCount IS what InstancedMesh.count is set to, so a pool that never
    // fell back would keep submitting the sails of a fleet that had all sunk.
    const slots = createSailSlots(TEST_CAPACITY);
    const held = [slots.acquire(), slots.acquire(), slots.acquire()];
    expect(slots.drawnCount).toBe(held.length);
    for (const slot of held) slots.release(slot);
    expect(slots.drawnCount).toBe(0);
  });

  it('keeps the drawn prefix over every live slot, whatever order they leave in', () => {
    // Releasing from the MIDDLE cannot shrink the prefix — the slot above is
    // still afloat and must still be drawn.
    const slots = createSailSlots(TEST_CAPACITY);
    const first = slots.acquire();
    const middle = slots.acquire();
    const last = slots.acquire();
    slots.release(middle);
    expect(slots.drawnCount).toBeGreaterThan(last);
    slots.release(last);
    // Only the bottom slot is live now, so the prefix covers it and no more.
    expect(slots.drawnCount).toBe(first + 1);
  });

  it('refuses to release a slot that is not live', () => {
    // A double dispose would otherwise put the same slot in the pool twice and
    // hand it to two boats at once.
    const slots = createSailSlots(TEST_CAPACITY);
    const slot = slots.acquire();
    slots.release(slot);
    expect(() => slots.release(slot)).toThrow(/not live/);
    expect(() => slots.release(TEST_CAPACITY)).toThrow(/not live/);
  });
});
