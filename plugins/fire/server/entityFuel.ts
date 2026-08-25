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
   * catch, or null for "nothing of mine" — THE NEAREST ONE, with how far away
   * it is.
   *
   * Called at IGNITION only.
   *
   * WHY DISTANCE IS PART OF THE ANSWER AND NOT AN IMPLEMENTATION DETAIL (bug,
   * owner-observed 2026-08-24: a torch put to a boat burned the boat beside
   * it). This interface used to say a source "is free to answer with the first
   * one it finds", which is sound only while every source's reach is the single
   * cell that was aimed at. Sources do not agree on that: a creature is a point
   * and answers for half a cell, a boat is several cells of hull and answers for
   * two. As soon as one answer covers more than the cell, "first" is no longer
   * "the one the player aimed at", and a registry with no distance in hand
   * cannot tell that it has been handed the wrong thing — nor can it choose
   * between two sources that both claim the cell.
   *
   * So the distance comes back with the id, in cells, measured from the cell
   * that was aimed at. `nearestWithinReach` from `@terrace/shared` computes
   * exactly this and is what every source here uses: it is the reason a new
   * flammable plugin cannot re-introduce the bug by writing the obvious loop.
   */
  entityAt(x: number, y: number): { id: number; fuel: EntityFuel; distanceCells: number } | null;

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
 * THE NEAREST across every source, not the first source that claims the cell.
 *
 * WHY NOT ./fuel.ts's FIRST-SOURCE-WINS. That rule is sound for cells because
 * cell sources are mutually exclusive (one thing grows on a cell) and every one
 * of them matches at exactly one cell, so "first" and "nearest" are the same
 * answer. Entity sources are neither: a boat answers for two cells around
 * itself and a peep for half of one, so a boat berthed two cells off a beach
 * used to claim the beach cell a settler was standing dead centre of — and
 * which of them burned was decided by the alphabetical order of the plugin
 * FOLDERS (`boats` before `pilgrims`). Ordering that loop deterministically
 * fixes nothing; the distance is what the question actually turns on.
 *
 * `alreadyBurning` is asked before a candidate is offered, so a source's
 * nearest individual being alight cannot mask everything else on the cell — a
 * boat burns for 16 s, and without this its whole reach was dead ground for
 * that whole time and the peep under the cursor could not be lit at all.
 */
export function entityFuelAt(
  x: number,
  y: number,
  alreadyBurning?: (sourceName: string, id: number) => boolean,
): { id: number; fuel: EntityFuel; source: EntityFuelSource } | null {
  let best: { id: number; fuel: EntityFuel; source: EntityFuelSource } | null = null;
  let bestDistance = Infinity;

  for (const source of sources) {
    const found = source.entityAt(x, y);
    if (found === null) continue;
    // A source answering with a nonsensical burn time is treated as having
    // nothing there rather than trusted — ./fuel.ts's rule, same reason: a
    // zero-length fire is already dead and would never clear.
    if (found.fuel.burnSeconds <= 0) continue;
    // A distance that is not a number is a source that has not implemented this
    // contract; it is dropped rather than ranked as 0 and allowed to win
    // everything.
    if (!Number.isFinite(found.distanceCells)) continue;
    if (alreadyBurning?.(source.name, found.id) === true) continue;
    // STRICTLY nearer to win: ties keep registration order, which is stable
    // (./index.ts's load order) — `nearestWithinReach`'s rule, same reason.
    if (found.distanceCells >= bestDistance) continue;
    best = { id: found.id, fuel: found.fuel, source };
    bestDistance = found.distanceCells;
  }

  return best;
}
