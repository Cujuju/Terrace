// day & night — a slow, server-authoritative clock, as a plugin.
//
// Core knows nothing about day and night. This half owns the ONE piece of
// state the feature has (how far through the cycle the world is) and
// publishes it on a namespaced message; the client half under ../client turns
// that single number into a sky. See protocol.ts's header for the card this
// implements and what is explicitly deferred.
//
// SERVER-AUTHORITATIVE, ON PURPOSE (design record: "clients send intents,
// never heights" — the same "the server decides" stance extended to time of
// day). Every player standing in the same world must see the same sky at the
// same moment, and a client's own wall clock cannot be trusted for that: two
// browsers' clocks disagree, a tab can be backgrounded and its timers throttled
// or paused entirely, and a server restart must not let a stale client compute
// a phase from a `Date.now()` that predates the reset. So the phase lives here,
// advances with the tick like every other piece of simulated state, and the
// client only ever interpolates between what THIS file already decided.
//
// It reads nothing from the world (no heights, no players, no other plugin's
// state) and writes nothing to it: this is ambience, and ambience that could
// desync from "what the terrain actually looks like" would be worse than none.
//
// PERSISTENCE: NONE, DELIBERATELY — the birds precedent (docs/DESIGN.md,
// "Persistence: none, deliberately") applied to the same shape of thing weather
// already applies it to. A restarted server starts a fresh cycle at phase 0
// (dawn), which is exactly what a fresh boot looks like the rest of the time
// too; persisting one float costs a snapshot field and a schema-version
// question to buy a difference no player can observe (a restart mid-cycle is
// rare against a 1 440 s period, and "the sun jumped back to dawn" is a
// smaller tell than "the whole terrain regenerated" would be if that were ever
// what a restart meant).

import type {
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
// Type-only import of the plugin contract (fully erased at runtime) — the same
// arrangement weather, mana, reveal, relics and monsters use; core publishes
// no plugin-API entry point yet.
import {
  DAY_LENGTH_SECONDS,
  DAYNIGHT_CLOCK_MESSAGE,
  DAYNIGHT_PLUGIN_NAME,
  roundBroadcastPhase,
  wrapPhase,
} from '../protocol.ts';
import { dayOfSimMillis, worldAgeDays } from '@terrace/shared';

/**
 * Real seconds between broadcasts.
 *
 * BANDWIDTH IS TRIVIAL AND NOT WHAT PICKS THIS NUMBER: the payload is one key,
 * `phase` — msgpack encodes it as ~7 B for the key string plus a 9 B float64
 * (not exactly representable in binary, same reasoning as weather's
 * BROADCAST_POSITION_DECIMALS) plus a 1 B map header, ≈17 B, plus ~20 B of
 * message-type and Colyseus framing ≈ 37 B per broadcast. At this interval
 * that is 37 B ⁄ 5 s ≈ 7.4 B/s per client — under half of weather's already-
 * negligible clear-sky idle cost (20 B/s).
 *
 * WHAT PICKS IT is the interpolation window it hands the client (client/
 * interpolation.ts): 5 s against a 1 440 s cycle is 0.35 % of a lap, so even
 * the FASTEST-changing moment of the sky (the dawn/dusk crossing — see
 * plugins/daynight/client/sky.ts) moves an imperceptible amount within one
 * broadcast gap, and the client's interpolator only ever has to smooth a step
 * that small. Twice weather's own 1 s cadence in absolute terms, but weather
 * picked 1 Hz to keep pace with a system that can move 2 cells/s (its own
 * header); this clock's "motion" is a fixed, tiny, known rate, so it needs far
 * less frequent correction — 5 s is comfortably above the "one broadcast a
 * second" weather needed and still an order of magnitude below anything a
 * player could perceive as choppy.
 */
export const DAYNIGHT_BROADCAST_INTERVAL_SECONDS = 5;

/**
 * Slack absorbed when comparing the accumulator to the interval, in seconds.
 *
 * IEEE-754 summation of a repeating `dt` is not exact: at the shipped tick
 * period (0.1 s, TICK_HZ 10), summing it 50 times — exactly one broadcast
 * interval's worth — lands on 4.999999999999998, a hair BELOW 5, which
 * without this slack would silently delay every broadcast by one whole tick.
 * 1e-9 s (one nanosecond) is nine orders of magnitude above the ~2e-15
 * relative error a few thousand additions of numbers this size actually
 * accumulate (verified for this file's own test suite, which runs the clock
 * for tens of thousands of ticks), so it comfortably absorbs the drift
 * without ever letting a broadcast fire meaningfully early — a nanosecond of
 * slack is undetectable at a five-second cadence.
 */
const BROADCAST_INTERVAL_EPSILON_SECONDS = 1e-9;

/** Seconds of sim time accumulated since this world booted. */
const MILLISECONDS_PER_SECOND = 1000;

let elapsedSeconds = 0;
/** Seconds since the last broadcast; see DAYNIGHT_BROADCAST_INTERVAL_SECONDS. */
let sinceBroadcast = 0;

/** The clock's current reading, in [0, 1) — 0 is dawn. */
export function currentPhase(): number {
  return wrapPhase(elapsedSeconds / DAY_LENGTH_SECONDS);
}

/**
 * THE SIM STEP. Advances the clock by the tick's own `dt`, then broadcasts on
 * its own cadence.
 *
 * `sinceBroadcast` is decremented by the interval rather than reset to 0, so a
 * `dt` that does not divide the interval evenly never accumulates drift over a
 * long-running world — any fractional remainder simply carries into the next
 * window instead of being discarded. `dt` is the server's FIXED tick period
 * (TerracePlugin.onTick's own contract), never a variable frame delta, so this
 * cannot run away in a single call the way a rAF-driven accumulator could.
 */
function simulate(world: WorldApi, dt: number): void {
  // THE SKY READS THE WORLD CLOCK (2026-08-23), so a restarted server resumes
  // the evening it was stopped in instead of snapping back to dawn — this
  // plugin's own accumulator was never persisted, which nobody noticed until
  // the calendar had to agree with it. `sinceBroadcast` below stays local: it
  // is a fan-out cadence, not a time of day, and it SHOULD restart at boot.
  elapsedSeconds = world.simMillis / MILLISECONDS_PER_SECOND;
  sinceBroadcast += dt;
  if (sinceBroadcast < DAYNIGHT_BROADCAST_INTERVAL_SECONDS - BROADCAST_INTERVAL_EPSILON_SECONDS) {
    return;
  }
  sinceBroadcast -= DAYNIGHT_BROADCAST_INTERVAL_SECONDS;

  // THE DAY RIDES THE SAME MESSAGE AS THE PHASE (owner ask, 2026-08-24: the
  // header should show the day, not just the time). It costs two integers on a
  // message that already goes out every five seconds, and it keeps the whole
  // clock — where the sun is AND which day it is — one broadcast, which is
  // what this plugin's protocol header means by "full state, not a delta".
  //
  // DERIVED HERE, NEVER ON THE CLIENT, for the reason this file's own header
  // gives for owning the phase: a client's wall clock cannot be trusted to say
  // what time it is in a world, and shared/src/calendar.ts's
  // simMillisAtRealTime would let it try.
  //
  // BOTH NUMBERS COME FROM THE SHARED HELPERS rather than from division here,
  // so the day the header names and the day a saga heading names turn over at
  // the same instant — see worldAgeDays' own comment on whole-day subtraction.
  world.broadcast(DAYNIGHT_CLOCK_MESSAGE, {
    phase: roundBroadcastPhase(currentPhase()),
    day: worldAgeDays(world.simMillis, world.genesisMillis),
    genesisDay: dayOfSimMillis(world.genesisMillis),
  });
}

export const plugin: TerracePlugin = {
  name: DAYNIGHT_PLUGIN_NAME,

  onWorldCreate(): void {
    // A fresh clock on every boot — see the PERSISTENCE header above. Reset
    // here rather than at module load so a host that creates two worlds in one
    // process does not have them share a clock.
    elapsedSeconds = 0;
    sinceBroadcast = 0;
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetDayNightState(): void {
  elapsedSeconds = 0;
  sinceBroadcast = 0;
}
