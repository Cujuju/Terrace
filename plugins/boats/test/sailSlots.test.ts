import { describe, expect, it } from 'vitest';
import { createSailSlots } from '../client/sailSlots.ts';

const TEST_CAPACITY = 4;

describe('the sail slot pool', () => {
  it('gives every live boat a slot of its own', () => {
    const slots = createSailSlots(TEST_CAPACITY);
    const held = [slots.acquire(), slots.acquire(), slots.acquire()];
    expect(new Set(held).size).toBe(held.length);
  });

  it('reuses a released slot instead of consuming a fresh one', () => {
    const slots = createSailSlots(TEST_CAPACITY);
    const first = slots.acquire();
    const second = slots.acquire();
    slots.release(first);
    expect(slots.acquire()).toBe(first);
    expect(second).not.toBe(first);
  });

  it('never hands out more than its capacity, and says so rather than overrunning', () => {
    const slots = createSailSlots(TEST_CAPACITY);
    for (let i = 0; i < TEST_CAPACITY; i++) slots.acquire();
    expect(() => slots.acquire()).toThrow(/slots is taken/);
  });

  it('draws nothing once every slot is released', () => {
    const slots = createSailSlots(TEST_CAPACITY);
    const held = [slots.acquire(), slots.acquire(), slots.acquire()];
    expect(slots.drawnCount).toBe(held.length);
    for (const slot of held) slots.release(slot);
    expect(slots.drawnCount).toBe(0);
  });

  it('keeps the drawn prefix over every live slot, whatever order they leave in', () => {
    const slots = createSailSlots(TEST_CAPACITY);
    const first = slots.acquire();
    const middle = slots.acquire();
    const last = slots.acquire();
    slots.release(middle);
    expect(slots.drawnCount).toBeGreaterThan(last);
    slots.release(last);
    expect(slots.drawnCount).toBe(first + 1);
  });

  it('refuses to release a slot that is not live', () => {
    const slots = createSailSlots(TEST_CAPACITY);
    const slot = slots.acquire();
    slots.release(slot);
    expect(() => slots.release(slot)).toThrow(/not live/);
    expect(() => slots.release(TEST_CAPACITY)).toThrow(/not live/);
  });
});
