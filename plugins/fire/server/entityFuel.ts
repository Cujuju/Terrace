// The registry for FLAMMABLE THINGS THAT MOVE — ./fuel.ts's inverted dependency
// applied to creatures, boats and anything else that will not hold still.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A SECOND REGISTRY AND NOT A FIELD ON THE FIRST.
//
// A cell fuel answers ONE question — "what is standing here" — and a fire built
// on it needs nothing else ever again: the cell cannot move, so the fire's
// position is settled at ignition and its whole life is one number counting up.
//
// A moving thing breaks that in a way no extra field repairs. Its fire has to
// ask WHERE IT IS every tick, it has to survive the thing being removed by
// something else entirely (an animal dies of old age mid-burn), and what it
// consumes at the end is not a cell but an individual. Bolting those three onto
// CellFuel would make every static source implement callbacks it can never use,
// and would leave `fire` unable to tell, from a registration alone, which kind
// of fire it was about to start.
//
// So: two registries, one flame. What they share is the burn — the clock, the
// intensity curve, the look — and that is deliberately all they share.
// ─────────────────────────────────────────────────────────────────────────────

/** What burning one of a source's individuals amounts to. */
export interface EntityFuel {
  /** How long it burns, in simulated seconds, from catching to dead. */
  readonly burnSeconds: number;
  /** Flame size in world units — ./fuel.ts's CellFuel.height, same meaning. */
  readonly height: number;
}

/**
 * One plugin's declaration of which of its MOVING things can burn.
 *
 * Everything here is called from inside `fire`'s own tick or hook, on the
 * server, synchronously.
 */
export interface EntityFuelSource {
  /** Registering plugin's name. Re-registration under the same name REPLACES. */
  readonly name: string;

  /**
   * Which of this source's individuals is standing on this cell and could
   * catch, or null for "nothing of mine".
   *
   * Called at IGNITION only. A source with many individuals is free to answer
   * with the first one it finds — a fire lights ONE thing, and which member of
   * a herd caught is not a question the player can ask.
   */
  entityAt(x: number, y: number): { id: number; fuel: EntityFuel } | null;

  /**
   * Where this individual is NOW, in fractional cell coordinates — or null once
   * it no longer exists.
   *
   * Called every tick for every burning individual, which is what makes this
   * the one method that must stay cheap. Null is not an error: it is how a
   * source says "something else already took this one", and the fire simply
   * stops (see ./entityBlaze.ts's endings) without consuming anything.
   */
  positionOf(id: number): { x: number; y: number } | null;

  /**
   * These burned to death. The source destroys them and broadcasts its own
   * change, exactly as a cell source fells its tree.
   *
   * Called ONLY for fires that ran their full course. One cut short — rained
   * out, or its subject removed by something else — does not call this.
   */
  onBurnedOut(ids: readonly number[]): void;

  /** Optional: these just caught. For a source that wants to react (panic, flee). */
  onIgnited?(ids: readonly number[]): void;
}

/** Registered sources, in registration order. */
const sources: EntityFuelSource[] = [];

/**
 * Declares a plugin's flammable individuals. Idempotent per source name: a
 * second registration under the same name REPLACES the first.
 */
export function registerEntityFuel(source: EntityFuelSource): void {
  const existing = sources.findIndex((candidate) => candidate.name === source.name);
  if (existing >= 0) sources[existing] = source;
  else sources.push(source);
}

/** Withdraws a source. Exists for tests and for symmetry with ./fuel.ts. */
export function unregisterEntityFuel(name: string): void {
  const index = sources.findIndex((candidate) => candidate.name === name);
  if (index >= 0) sources.splice(index, 1);
}

/** Every registered source, in order. Read-only view for the sim. */
export function entityFuelSources(): readonly EntityFuelSource[] {
  return sources;
}

/** Test seam: forgets every registration. */
export function resetEntityFuelRegistry(): void {
  sources.length = 0;
}

/** One source by name, or null — how a burning entity finds its owner again. */
export function entityFuelSource(name: string): EntityFuelSource | null {
  return sources.find((candidate) => candidate.name === name) ?? null;
}

/**
 * What individual is standing on this cell that could burn, and whose it is —
 * first non-null answer in registration order, exactly as ./fuel.ts resolves
 * cell fuel.
 */
export function entityFuelAt(
  x: number,
  y: number,
): { id: number; fuel: EntityFuel; source: EntityFuelSource } | null {
  for (const source of sources) {
    const found = source.entityAt(x, y);
    // A source answering with a nonsensical burn time is treated as having
    // nothing there rather than trusted — ./fuel.ts's rule, same reason: a
    // zero-length fire is already dead and would never clear.
    if (found !== null && found.fuel.burnSeconds > 0) {
      return { id: found.id, fuel: found.fuel, source };
    }
  }
  return null;
}
