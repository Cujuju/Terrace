// What it takes to catch: heat accumulated over time, not a coin flipped every
// step.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE COIN WAS WRONG.
//
// Spread used to ask `happensWithin(rate, dt)` once per (source, target) pair
// per step: an independent, MEMORYLESS roll. Memoryless means a target that has
// sat beside a flame for twenty seconds is in exactly the state it was in when
// the flame arrived, so the time two EQUALLY EXPOSED neighbours take to catch
// is exponential with a coefficient of variation of 1 — at the shipped rate,
// about twelve seconds apart. A fire therefore did not advance as a front; it
// threw isolated spots, and the burn region was a percolation cluster rather
// than an edge that walks (issue #288, owner in-world).
//
// A flame does not flip a coin at a neighbour. It HEATS it, and the neighbour
// catches when it has taken enough. That is what this file models, and it is
// one sentence of physics rather than a tuning of the old number.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL.
//
//   heat += rate x exposure-seconds        (summed over every source, every step)
//   ignites when heat >= threshold         (drawn ONCE, on first exposure)
//
// `rate` is the SAME product ./spread.ts always computed and `exposure-seconds`
// is the same dt that used to be handed to the roll, so every term of the
// mechanic — wind, slope, distance, intensity, wet — keeps the meaning and the
// units it had. What changed is only what the product is spent on.
//
// UNITS FALL OUT UNCHANGED, which is the check that the two models are the same
// mechanic. A rate is "per second" and a threshold is drawn with mean 1, so the
// mean time to catch at a constant rate is 1/rate seconds — exactly the mean
// wait of the exponential it replaces. Contact is still the interval it is
// named for: CONTACT_SPREAD_RATE_PER_SECOND (6.67/s) x CONTACT_IGNITION_SECONDS
// (0.15 s) = 1 unit of heat, one mean threshold.
//
// SUMMING OVER SOURCES IS A CHANGE, and a wanted one: a target with two burning
// neighbours is heated twice as fast, where two independent rolls only gave it
// two chances to be lucky. A cell in the middle of a front now catches sooner
// than a cell on its wing, which is what makes the front a front.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY ONE LEDGER FOR BOTH REGISTRIES.
//
// The old roll had two call sites — cells and individuals — and nothing tied
// them together, so a change to one could silently leave the other on the old
// model. Heat has to be REMEMBERED between steps, which makes forgetting one
// side worse than an inconsistency: it would be a leak or a fire that never
// spreads. So there is exactly one ledger, and both paths reach it through the
// same `absorb`. A cell is keyed by its packed `fireKey` (a number) and an
// individual by its `fireEntityKey` (a string); the two key spaces cannot
// collide, so one map holds both without either path knowing about the other.

import { erlangSample } from '@terrace/shared';

import { fireRandom } from './rng.ts';

/**
 * A target's identity in the ledger: a cell's packed `fireKey` or an
 * individual's `fireEntityKey`. Numbers and strings never collide as Map keys,
 * so the two spaces share one map safely — see the header.
 */
export type HeatTargetKey = number | string;

/**
 * The mean heat a target must take on before it catches.
 *
 * ONE by definition, not by tuning: it is what makes a rate of r per second
 * mean "catches in 1/r seconds on average", which is the promise every constant
 * in ./spread.ts is written against. The tunable quantity is the RATE; this is
 * the unit the rate is quoted in.
 */
const IGNITION_THRESHOLD_MEAN_HEAT = 1;

/**
 * How TIGHTLY grouped the thresholds of equally exposed targets are — the shape
 * k of the Gamma (Erlang) they are drawn from. The spread of ignition times at
 * a constant rate is 1/√k of the mean.
 *
 * k = 1 IS EXACTLY THE OLD MODEL. A Gamma of shape 1 is the exponential, and an
 * exponential threshold accumulated at a constant rate fires with precisely the
 * memoryless per-step probability `happensWithin` used to compute. That is the
 * calibration point: this constant alone decides how far the new model is from
 * the old one, and at 1 it is not merely close but identical in distribution.
 *
 * WHY 8. The spread of ignition times has to sit between two bounds a player
 * can see. Below them: a spread much smaller than SPREAD_INTERVAL_SECONDS (1 s)
 * would quantise the front to the step — every equally exposed neighbour
 * catching on the SAME step, which reads as a machine, not a fire. Above them:
 * a spread near half the mean wait is the percolation the issue is about. At
 * k = 8 the coefficient of variation is 1/√8 ≈ 0.35, so at the base rate's
 * ~7-second mean wait the ignition times of a row of equal neighbours are
 * scattered over roughly ±2.5 s — several steps wide, and a small fraction of
 * the wait. A front with a ragged edge, which is what a fire looks like.
 */
export const IGNITION_THRESHOLD_SHAPE = 8;

/** One target's progress towards catching. */
interface HeatEntry {
  /** Heat taken on so far, in threshold units. */
  heat: number;
  /** What it takes, drawn once when the target was first exposed. */
  readonly threshold: number;
  /** The step number that last added to it — see `endStep`. */
  step: number;
}

/**
 * Every flammable thing currently being heated, and how far along it is.
 *
 * BOUNDED BY THE FRONT, not by the burn. `endStep` drops every entry no source
 * heated during the step just finished, so the ledger holds only what is in
 * reach of something alight right now — a set proportional to the fire's
 * PERIMETER, which is the same bound ./spread.ts's own cost has. A target that
 * catches, burns out, is rained on to a zero rate, or simply walks away is
 * dropped by that one rule, with no path needing to know it exists. The
 * alternative — deleting on each of those events at the site where it happens —
 * is four call sites that can each be forgotten, to save one pass over a map
 * that the step has already walked eight times per burning cell.
 *
 * THE COST OF BEING DROPPED IS THE HEAT, deliberately. Something that leaves a
 * flame's reach and comes back starts cold, which is what cooling is: a fire
 * that cannot reach a thing continuously does not light it. There is no
 * separate cooling term because there is no interval over which one would act —
 * an entry either was heated this step or is gone.
 */
export class HeatLedger {
  private readonly entries = new Map<HeatTargetKey, HeatEntry>();
  /** Which step is being accumulated; only ever compared for equality. */
  private step = 0;

  /**
   * Adds `rate x seconds` of heat to one target and says whether that is enough
   * for it to catch — if anything will have it (see below).
   *
   * THE ONE WAY A TARGET CATCHES, for cells and individuals both. A caller that
   * has computed a rate has nothing else to ask.
   *
   * Returns false — without recording anything — for a non-positive rate or a
   * non-positive or non-finite exposure, which is the same guard `rollEvent`
   * applies: a target no flame is actually heating must not be given a ledger
   * entry, or a fire's memory would grow with everything it has ever been near.
   *
   * ABSORBING DOES NOT SPEND THE HEAT. True means "this target has taken
   * enough"; it does NOT mean the target caught, because whether a fire is
   * actually created is a question only ./blaze.ts can answer (it may be at
   * FIRE_CELL_CAP, or the fuel may be gone). The entry is therefore KEPT here
   * and forgotten by `consume` on the step something really was lit — see that
   * method for why the two must not be one call.
   *
   * A target that keeps crossing without catching keeps crossing with MORE
   * heat each step, which is exactly the queue `../server/spread.ts` orders by:
   * the accumulation is the memory the whole file exists to give it, and
   * throwing it away because a ceiling happened to be full would reinstate the
   * memoryless lottery described at the top of this file for every ignition
   * attempt made while that ceiling binds.
   */
  absorb(key: HeatTargetKey, ratePerSecond: number, seconds: number): boolean {
    if (!(ratePerSecond > 0) || !(seconds > 0) || !Number.isFinite(seconds)) return false;

    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {
        heat: 0,
        threshold: erlangSample(fireRandom, IGNITION_THRESHOLD_SHAPE, IGNITION_THRESHOLD_MEAN_HEAT),
        step: this.step,
      };
      this.entries.set(key, entry);
    }

    entry.heat += ratePerSecond * seconds;
    entry.step = this.step;
    return entry.heat >= entry.threshold;
  }

  /**
   * How far past its threshold a target has gone, in threshold units — zero for
   * one that has not crossed, or that this ledger has never heard of.
   *
   * THE RANKING `../server/spread.ts` USES WHEN SLOTS ARE SCARCE, and the
   * reason it is an EXCESS rather than a ratio `heat / threshold`. Both order
   * the same set; they differ in what they divide by. In the step a target
   * crosses, its overshoot is at most the heat it took that step — the sum of
   * its sources' rates times dt — so the excess is a direct reading of HOW HARD
   * THE FRONT IS HEATING IT, which is what "the leading edge first" means. The
   * ratio divides that reading by the target's own threshold, a random draw
   * (IGNITION_THRESHOLD_SHAPE), so it is the same signal with noise mixed in.
   *
   * And because a crossed entry is kept, the excess of a target left waiting
   * grows every step it stays beside a flame — so the ordering is "hottest, and
   * among equals longest-waiting", which is what keeps a queue from starving.
   */
  excessHeat(key: HeatTargetKey): number {
    const entry = this.entries.get(key);
    if (entry === undefined) return 0;
    return Math.max(0, entry.heat - entry.threshold);
  }

  /**
   * Forgets one target because it really did catch — the other half of
   * `absorb`, and the ONLY thing that spends accumulated heat.
   *
   * SEPARATE FROM `absorb` BECAUSE ONLY THE CALLER KNOWS. Folding the delete
   * into `absorb`'s true branch was the original shape and it is the defect
   * this pair exists to remove: `absorb` cannot see ./blaze.ts's answer, so it
   * charged every target that reached its threshold and left the refused ones
   * to start again from zero.
   *
   * Deleted rather than zeroed, so a thing that burns out and becomes fuel
   * again starts from a freshly drawn threshold instead of inheriting the one
   * it already spent.
   */
  consume(key: HeatTargetKey): void {
    this.entries.delete(key);
  }

  /**
   * Closes the step: forgets every target nothing heated during it, and opens
   * the next one.
   *
   * Called once at the end of a spread step, after every source has been
   * offered to every target — see the class comment for why this single sweep
   * is the whole of the lifetime rule.
   */
  endStep(): void {
    for (const [key, entry] of this.entries) {
      if (entry.step !== this.step) this.entries.delete(key);
    }
    this.step++;
  }

  /**
   * Forgets everything, for the same reasons `resetSpreadSweep` forgets the
   * previous sample: after a reset, a rollback, or a stretch with nothing
   * alight, the accumulated heat is a memory of a world that no longer exists,
   * and a target that was nearly alight in it must not catch instantly in the
   * next one.
   */
  clear(): void {
    this.entries.clear();
  }

  /** How many targets are being heated. For assertions about the bound above. */
  get size(): number {
    return this.entries.size;
  }
}
