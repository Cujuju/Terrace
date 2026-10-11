export interface SailSlots {
  readonly capacity: number;
  readonly drawnCount: number;
  acquire(): number;
  release(slot: number): void;
}

export function createSailSlots(capacity: number): SailSlots {
  const live = new Array<boolean>(capacity).fill(false);
  const free: number[] = [];
  for (let slot = capacity - 1; slot >= 0; slot--) free.push(slot);
  let drawnCount = 0;

  return {
    capacity,

    get drawnCount(): number {
      return drawnCount;
    },

    acquire(): number {
      const slot = free.pop();
      if (slot === undefined) {
        throw new Error(`boat sails: every one of the ${capacity} instance slots is taken`);
      }
      live[slot] = true;
      if (slot >= drawnCount) drawnCount = slot + 1;
      return slot;
    },

    release(slot: number): void {
      if (!(slot >= 0 && slot < capacity && live[slot] === true)) {
        throw new Error(`boat sails: slot ${slot} is not live and cannot be released`);
      }
      live[slot] = false;
      free.push(slot);
      while (drawnCount > 0 && live[drawnCount - 1] === false) drawnCount--;
    },
  };
}
