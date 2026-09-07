// Which instance of the fleet's one sail InstancedMesh a given boat writes.
//
// A separate module because it is the CONTRACT the instanced sail rests on and
// it needs no three.js to state: hand out a slot nobody holds, take it back on
// dispose, and report the prefix of the buffer that still has to be drawn. Get
// this wrong and a sunk boat leaves its sail hanging over the water.

/** A fixed-capacity pool of instance slots. */
export interface SailSlots {
  /** The capacity handed to createSailSlots — the pool never exceeds it. */
  readonly capacity: number;
  /**
   * Instances the mesh must draw: every live slot is strictly below this, so
   * `InstancedMesh.count` set to it draws every sail afloat and nothing above
   * the last one. It falls back as the top slots are released.
   */
  readonly drawnCount: number;
  /** A slot no live boat holds. Throws when the pool is full. */
  acquire(): number;
  /** Returns a live slot to the pool. Throws for a slot that is not live. */
  release(slot: number): void;
}

export function createSailSlots(capacity: number): SailSlots {
  const live = new Array<boolean>(capacity).fill(false);
  // Seeded descending so the first acquisitions come back 0, 1, 2, … — a
  // cold-start fleet then occupies the tightest possible drawn prefix.
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
      // Walk the top down past every slot that is now free. Bounded by the
      // capacity and paid only when a boat leaves, not per frame.
      while (drawnCount > 0 && live[drawnCount - 1] === false) drawnCount--;
    },
  };
}
