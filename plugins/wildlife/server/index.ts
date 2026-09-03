// wildlife — ambient + reactive habitat fauna, as a plugin.
//
// Core knows nothing about creatures. This half owns the entire sim (habitat
// classification, population targets, wander, panic, persistence) and publishes
// it on one namespaced message; the client half under ../client draws it.
//
// It exercises a quadrant of the plugin contract that neither shipped example
// does — onTick as a *world* simulation rather than a per-player economy, plus
// onTerrainChanged as a reaction rather than an accumulator — which is the point
// of building it: if the API cannot carry a live entity sim, this is what fails.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, EVERY OTHER TICK.
//
// Every broadcast carries the ENTIRE entity list, not a delta. That is a
// deliberate v1 choice with three consequences worth stating plainly:
//
//   * self-healing — a dropped or reordered message costs one 200 ms frame of
//     staleness and nothing else; there is no diff stream to desynchronise;
//   * no join handshake — a joining client is caught up by the next broadcast,
//     so this plugin needs no onPlayerJoin snapshot path at all;
//   * bounded cost — BROADCAST_ENTITY_CEILING puts a hard ceiling on the
//     payload, so the bandwidth is a constant, not a function of how long the
//     world has been running.  Two independent caps make it up: the habitat
//     population's WILDLIFE_POPULATION_CAP and the sky's MAX_BIRDS_ALOFT.
//
// The price is bandwidth. Per creature the payload is six keys — id, species,
// x, y, heading, size — which msgpack encodes in roughly 58 B including the key
// strings (Colyseus re-sends keys on every message; there is no schema here).
//
// THE BUDGET, RECOMPUTED 2026-08-14 WITH BIRDS (BROADCAST_ENTITY_CEILING). Two
// independent subsystems put creatures in this message and each has its own hard
// ceiling; the total is what a full message actually weighs:
//
//   habitat population   WILDLIFE_POPULATION_CAP   850   (census.ts)
//   birds aloft          MAX_BIRDS_ALOFT            18   (flocks.ts: 2 × 9)
//                                                  ────
//                                                   868 entities
//
//   868 × 58 B                = 49.2 KB per message
//   every tick  (10 Hz)       = 491.6 KB/s ≈ 4.03 Mbit/s per client
//   every OTHER tick (5 Hz)   = 245.8 KB/s ≈ 2.01 Mbit/s per client   ← chosen
//   × ~10 players             ≈ 20.1 Mbit/s of server upstream
//
// 58 B is an upper bound for a bird — `bird` is the shortest species name of the
// five and its `size` is always the default class — so the real figure is a
// little under. Earlier recomputes, for the record: 5.2 KB / 210 kbit/s at the
// old cap of 100, then 7.8 KB / 312 kbit/s, then 8.7 KB / 348 kbit/s when `size`
// was added, then 9.7 KB / 390 kbit/s when birds joined the message.
//
// RECOMPUTED 2026-08-23 FOR THE CAP RAISE (150 → 850, census.ts). This is a
// 5.2× jump and it is the largest single cost increase this plugin has taken:
// ten players on a FULL world now cost 20 Mbit/s of upstream on wildlife alone,
// where the whole budget used to be under 4. The mitigating fact, which is the
// reason it was accepted rather than merely noticed, is that the ceiling is
// reached only on a fully-revealed half-land world and no world in existence is
// remotely that shape — every one is ocean with an island, where a full message
// carries a handful of creatures. What a self-hoster on domestic upstream would
// pay is therefore the ceiling, not the bill; if a world ever does approach it,
// the 5 Hz cadence and the per-entity encoding are the dials, in that order.
//
// FOG OF WAR (added issue #18, does not change the arithmetic above). "Every
// broadcast carries the ENTIRE entity list" is now per RECIPIENT, not one
// shared payload: each connected player's own list is the HABITAT population
// filtered to chunks they have personally unlocked (WorldApi.broadcastVisible),
// so the byte cost above is still exactly what it was — same entity count, same
// per-entity size — just addressed individually instead of broadcast once. The
// "no join handshake" bullet still holds for the same reason it always did:
// broadcastVisible re-reads world.players() and each one's own mask on every
// call, so a just-joined or just-crept player is caught up on the very next
// cycle (≤ 200 ms) with no extra code. Birds are exempt from this filter — see
// the cost note beside the broadcastVisible call in simulate() for why.
//
// 5 Hz is chosen because the extra 390 kbit/s buys nothing a player can see.
// The fastest HABITAT species cruises at 3 WORLD UNITS/s (the species table
// states cellsAcross(3) = 12 cells/s — these figures are in world units, and
// both are given so the two cannot be confused again), so between two 200 ms
// updates it covers 0.6 world units (2.4 cells) — well under one cell, and the
// client interpolates across the gap (client/interpolation.ts). Even a fleeing
// fish at ×3 covers 1.8 world units (7.2 cells), which interpolation still
// renders as smooth motion, and that 1.8-world-unit figure is the bound
// BIRD_CRUISE_SPEED_CELLS_PER_SECOND was chosen under (8 × 0.2 = 1.6 world
// units), so the fastest thing in the world still needs no cadence of its own. Halving the
// rate halves the steady-state cost of the most expensive thing this plugin
// does, and the remaining budget is what lets a self-hoster on a home connection
// run ~10 players. Positions are rounded to BROADCAST_POSITION_DECIMALS (1/100
// cell) on the way out — roughly 280× finer than the smallest creature (a fish
// is 0.7 world units, i.e. 2.8 cells, long).
// ─────────────────────────────────────────────────────────────────────────────

import { MAX_BRUSH_RADIUS, type CellDiff } from '@terrace/shared';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement the mana and reveal plugins use.
import type {
  PersistenceSlice,
  SliceLoadOutcome,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { WILDLIFE_ENTITIES_MESSAGE, WILDLIFE_PLUGIN_NAME } from '../protocol.ts';
import { WILDLIFE_POPULATION_CAP, type HabitatWorld } from './census.ts';
import { invalidateCensusIndex, markCensusCellsDirty } from './census-index.ts';
import { MAX_BIRDS_ALOFT, advanceFlocks, birdStates, resetFlocks } from './flocks.ts';
import {
  FLEE_DURATION_SECONDS,
  FLEE_SPEED_MULTIPLIER,
  advanceMovement,
  panicIndividuals,
  startleNear,
} from './movement.ts';
import { SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND } from './species.ts';
import { FIRE_IGNITED_EVENT_NAME, parseIgnitedPositions } from './fire-event.ts';
import { WILDLIFE_SLICE_VERSION, loadPopulation, savePopulation } from './persistence.ts';
import {
  advancePopulation,
  burnableEntityAt,
  flammableCreatures,
  despawnInvalidHabitat,
  entityPosition,
  entityStates,
  killEntities,
  resetPopulation,
} from './population.ts';
import { closeFireBridge, loadFireBridge, registerWildlifeFuel } from './fire-bridge.ts';

/**
 * Ticks between broadcasts. 2 → 5 Hz at the shipped TICK_HZ of 10. See the
 * bandwidth analysis in this file's header for why 2 and not 1.
 */
export const BROADCAST_TICK_INTERVAL = 2;

/**
 * Hard ceiling on entities in one broadcast: the standing habitat population
 * plus every bird that can be aloft at once.
 *
 * DERIVED, never written by hand — it is the number the bandwidth arithmetic in
 * this file's header multiplies by 58 B, and the two subsystems that feed it
 * (census.ts and flocks.ts) each cap themselves independently. Naming the sum
 * here is what stops "what does a full message cost" from having two answers
 * neither of which is the real one.
 */
export const BROADCAST_ENTITY_CEILING = WILDLIFE_POPULATION_CAP + MAX_BIRDS_ALOFT;

/**
 * How far a sculpt's disturbance is felt, in cells from the diff's centroid.
 *
 * Three times MAX_BRUSH_RADIUS. The brush itself reaches 4 cells and the
 * gradient relaxation spills a few more, so a single edit's changed cells fill
 * something like a 6–8 cell disc; 12 cells means the ring of creatures just
 * OUTSIDE the actual change reacts too. That is the intended reading — the noise
 * and shadow of someone reshaping the ground scares things off, rather than a
 * suspiciously exact geometric boundary at the edge of the diff.
 */
export const FLEE_RADIUS_CELLS = MAX_BRUSH_RADIUS * 3;

/**
 * How far a NEW FLAME is felt, in cells from where it appeared.
 *
 * DELIBERATELY NOT `FLEE_RADIUS_CELLS` ABOVE, which is a fact about a brush: it
 * is three times the sculpt tool's reach because that is roughly how far the
 * noise and shadow of somebody reshaping the ground carries. A wildfire is not
 * a sculpt, and sizing an animal's reaction to fire by the width of a tool the
 * fire has nothing to do with would be a coincidence pretending to be a reason.
 *
 * WHAT THIS IS INSTEAD: one panic burst. A startled creature runs at
 * FLEE_SPEED_MULTIPLIER for FLEE_DURATION_SECONDS and then calms, so the
 * distance it covers in a single flight is the one distance the reaction
 * actually has to work with. Setting the alarm to exactly that gives the
 * invariant worth having — EVERY ANIMAL THE ALARM REACHES CAN PUT THE WHOLE
 * ALARM RADIUS BEHIND IT BEFORE IT CALMS DOWN. A wider alarm would panic
 * animals that could not clear it, which reads as a herd sprinting for no
 * visible reason and stopping still inside the danger; a narrower one would
 * leave animals standing calmly within a run of the flames.
 *
 * Measured on the SLOWEST LAND SPECIES — the one that walks on the ground fire
 * burns and can put the least distance behind it (fish flee three times as far,
 * and are not going to be near a fire in the first place) — so the invariant
 * holds for every land animal rather than for the average one.
 *
 * IT IS DERIVED, NOT CITED (2026-09-02). This used to read
 * `SPECIES_PROFILES.grazer.cruiseSpeedCellsPerSecond` under a comment calling
 * the grazer "the slowest thing that walks", which was true of a table with one
 * land species in it and became false twice on the same day: the grazer's speed
 * was halved (owner: "Grazers move too fast") and the bison arrived slower
 * still. Neither edit would have failed to compile. The figure now comes from
 * SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND (./species.ts), which is a minimum
 * over the table, so the claim above is true by construction.
 *
 * At the shipped table that is the bison's 0.6 world units/s: 2.4 cells/s × 3 ×
 * 2.5 s = 18 cells, four and a half world units. It USED to be 48 cells, on the
 * grazer's pre-cut 1.6 — the alarm shrank because the animals it is sized
 * against got slower, which is exactly what it is supposed to do.
 *
 * It no longer coincides with FLEE_RADIUS_CELLS (48), and the two were never
 * related: that one is three times the sculpt brush's reach. The old note here
 * observed the coincidence in order to refuse to write one as the other; the
 * refusal is what kept this correct through the change.
 */
export const FIRE_STARTLE_RADIUS_CELLS = Math.round(
  SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND * FLEE_SPEED_MULTIPLIER * FLEE_DURATION_SECONDS,
);

/** Ticks since boot, for the broadcast cadence. */
let tickCount = 0;

/**
 * THE SIM STEP — CRITICAL PATH.
 *
 * Fixed order, once per host tick:
 *   1. population — natural turnover, the census (every
 *      HABITAT_CENSUS_INTERVAL_SECONDS) and a PROBABILISTIC spawn roll, so the
 *      world fills and recovers gradually and never stops changing;
 *   2. movement — every creature wanders or flees, steering around anything that
 *      is not its habitat and around locked territory;
 *   3. habitat sweep — anything now standing somewhere invalid despawns with a
 *      respawn credit. Movement cannot produce this on its own (it vetoes bad
 *      steps), so in practice this catches creatures the TERRAIN moved out from
 *      under. It runs anyway, unconditionally: it is at most
 *      WILDLIFE_POPULATION_CAP height lookups, and it is the invariant "no
 *      creature is ever outside its habitat" made true by construction rather
 *      than by trusting step 2;
 *   4. flocks — the transient sky: arrivals, flight, departures (flocks.ts).
 *      It runs AFTER the habitat sweep and shares no state with steps 1–3
 *      beyond the entity-id allocator, which is the whole point of the split;
 *   5. broadcast, on the cadence — habitat creatures and birds in one message,
 *      because the client's parser, interpolator and view reconciliation are all
 *      keyed by id and do not care which subsystem produced a row.
 *
 * Steps 1–4 are all driven by `dt`; nothing here reads a wall clock.
 */
function simulate(world: WorldApi, dt: number): void {
  advancePopulation(world, dt);
  advanceMovement(world, dt);
  despawnInvalidHabitat(world);
  advanceFlocks(world, dt);

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;

  // FOG OF WAR (issue #18): each connected player is sent only the HABITAT
  // population visible over their own unlocked chunks — never skipEmpty
  // (default false), because this is a FULL-STATE replace message and the
  // only way a client learns a creature left its view is that the next list
  // simply omits it (see WorldApi.broadcastVisible's doc comment).
  //
  // Birds are the one exemption, and deliberately NOT run through the
  // positionOf filter: flocks.ts reads neither heights nor the mask, so a
  // bird's course is terrain-independent exactly like weather's systems are
  // (../../weather/server/index.ts), AND its position legitimately starts
  // and ends OFF the map on the spawn ring — handing an off-map coordinate to
  // isCellVisibleTo would throw (it delegates to shared's chunkIndex, which
  // bounds-checks and throws by contract, same as isCellUnlocked always has).
  // Birds are computed once and spliced into every player's own payload
  // unfiltered, the same "ambient, leaks nothing about locked terrain"
  // reasoning weather documents for itself.
  const birds = birdStates();
  world.broadcastVisible(
    WILDLIFE_ENTITIES_MESSAGE,
    entityStates(world.worldSize),
    (entity) => ({ x: entity.x, y: entity.y }),
    (visibleHabitat) => ({ entities: [...visibleHabitat, ...birds] }),
  );
}

/**
 * THE REACTIVE PATH.
 *
 * Fired after any applied edit with the FULL server-side diff. Two effects:
 *
 *   * everything within FLEE_RADIUS_CELLS of the diff's centroid bolts directly
 *     away for FLEE_DURATION_SECONDS;
 *   * anything whose cell has stopped being its habitat — the lake that was just
 *     drained, the bay that was just filled in — despawns with a respawn credit,
 *     so that species reappears elsewhere after a delay instead of vanishing.
 *
 * The centroid is the mean of the changed cells. A diff is always a brush
 * footprint plus its relaxation spill, so it is a single connected blob and its
 * mean is inside it; there is no multi-modal case to worry about.
 *
 * Note this is called from inside the sculpt that caused it. It only reads
 * heights and writes plugin state — it never calls world.sculpt — so it cannot
 * feed the host's terrain-change cascade guard.
 */
function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (diff.length === 0) return;

  let sumX = 0;
  let sumY = 0;
  for (const cell of diff) {
    sumX += cell.x;
    sumY += cell.y;
  }
  startleNear(sumX / diff.length, sumY / diff.length, FLEE_RADIUS_CELLS);

  // THE THIRD EFFECT (issue #268): the habitat census is incremental now, and
  // this diff is the only notification that any cell's habitat class may have
  // moved. Recording it here — the same cell-exact list the flee centroid is
  // derived from — is what lets the 5 s census re-count these chunks instead
  // of the whole world.
  markCensusCellsDirty(diff);

  despawnInvalidHabitat(world);
}

/**
 * PERSISTENCE: THE HABITAT POPULATION ONLY. Birds are deliberately absent from
 * both halves.
 *
 * A flock is a crossing in progress — its entire state is "how far along a path
 * it will have finished in a minute or two", and resuming that after a restart
 * means restoring a journey nobody was watching. The spawner puts a fresh flock
 * in the sky within FLOCK_MEAN_SPAWN_INTERVAL_SECONDS anyway, so persisting them
 * would add a snapshot field, a validation branch and a version question to buy
 * a difference no player can observe. A restarted server has an empty sky for a
 * minute; that is what an empty sky looks like the rest of the time too.
 *
 * `load` clears the sky as well, and that is not tidiness: replacePopulation
 * resets the shared entity-id counter (population.ts), so any flock still aloft
 * would be holding ids the counter is about to hand out again.
 */
// ────────────────────────────────────────────────────────────────────────────
// Fire
//
// An animal is flammable, and unlike a tree it runs while it burns — so this
// plugin registers into fire's ENTITY registry (plugins/fire/server/
// entityFuel.ts), which asks it every tick where the creature has got to and
// tells it, at the end, which of its animals died of it.
// ────────────────────────────────────────────────────────────────────────────

/**
 * How long a burning animal lives, in simulated seconds.
 *
 * SHORT, and shorter than anything else that burns (a tree is 22 s, a home 30):
 * a creature on fire is a death, not a bonfire, and the number is how long the
 * player watches it run before it drops. Long enough to see it happen and to
 * see which way it ran — into the wood, into the water — because that run is
 * the whole reason this is an entity fire and not a cell one.
 */
export const WILDLIFE_BURN_SECONDS = 8;

/**
 * A fire finished on these: they burned to death.
 *
 * Nothing else to do — the next full-state broadcast (this plugin sends one
 * every other tick) simply does not contain them, which is exactly how every
 * other way of losing an animal already reads on the wire.
 */
function wildlifeBurnedOut(ids: readonly number[]): void {
  killEntities(ids);
}

/**
 * These just caught fire — the OWNER'S half of the reaction to fire, and the
 * counterpart of `reactToFire` below.
 *
 * TWO HOOKS, AND BOTH ARE NEEDED, because they answer different questions. The
 * `fire:ignited` world event says something SOMEWHERE caught and is how a
 * bystander learns to run; this callback says something OF THIS PLUGIN'S caught
 * and is how the creature itself learns it is alight. Trying to serve the
 * second from the first would mean matching an event position back against this
 * plugin's own animals and guessing which of them the fire meant — which is the
 * question fire has already answered, exactly, by calling this.
 *
 * The panic lasts the whole burn (movement.ts's `panicIndividuals`), so a
 * burning grazer bolts for as long as it is alive rather than calming down a
 * third of the way through its death.
 *
 * AND IT SPREADS THE FIRE, which is the point and not a side effect (owner,
 * 2026-08-26). A panicking animal at three times cruise speed sets light to
 * every cell it crosses (plugins/fire/server/spread.ts's
 * SELF_AND_NEIGHBOUR_OFFSETS), which is the drama the balance question deferred
 * on 2026-08-24 was about. It is settled: nothing here suppresses it, slows it
 * or shortens it.
 */
function wildlifeIgnited(ids: readonly number[]): void {
  panicIndividuals(ids, WILDLIFE_BURN_SECONDS);
}

/**
 * THE REACTIVE PATH, FIRE (issue #184): something, somewhere, caught — startle
 * whatever is standing near it.
 *
 * BY NAME, NEVER BY IMPORT (server/src/plugins/types.ts's emitEvent doc, and
 * ./fire-event.ts's header): fire's plugin name is the whole of the coupling,
 * exactly as a wire message namespace is, and a world with no fire plugin
 * simply never sees this event.
 *
 * EVERY IGNITION IN THE BATCH IS ITS OWN ALARM rather than one alarm at the
 * batch's centroid — the opposite of `reactToTerrain` above, deliberately. A
 * sculpt's diff is one connected blob and its mean is inside it; a tick's
 * ignitions are not one thing at all (a spreading front's far edge, a bolt
 * across the valley, an animal alight somewhere else entirely), and their mean
 * can easily be a place where nothing is burning. So each is applied in turn,
 * in the order fire listed them, which is fire's own fixed roll order.
 */
function reactToFire(payload: unknown): void {
  const ignited = parseIgnitedPositions(payload);
  if (ignited === null) return;

  for (const at of ignited) startleNear(at.x, at.y, FIRE_STARTLE_RADIUS_CELLS);
}

/**
 * The version a stored blob SAYS it was written under, or undefined when it
 * says nothing.
 *
 * WHY THIS PLUGIN STILL READS ITS OWN FIELD (see PersistenceSlice.load). The
 * host's `{ v, data }` envelope is authoritative for everything written since
 * it existed — but every byte written BEFORE it carries no envelope and reaches
 * `load` as version 1, and this plugin's own format was already past that.
 * Trusting the host's 1 over this field would run a version-1 migration over a
 * version-1 slice on the first boot after the envelope landed, which is the
 * one way this contract can destroy a world.
 */
function selfDescribedSliceVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { version?: unknown }).version;
  return Number.isSafeInteger(version) ? (version as number) : undefined;
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return savePopulation();
  },
  version: WILDLIFE_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    // REFUSE, DO NOT ERASE, a population from a newer build: loadPopulation
    // keeps no entities for an unknown version, and the next snapshot would
    // make "every animal in the world is gone" the saved truth.
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > WILDLIFE_SLICE_VERSION) {
      return 'refuse';
    }
    loadPopulation(data);
    resetFlocks();
    return undefined;
  },
};

export const plugin: TerracePlugin = {
  name: WILDLIFE_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    // THE TERRAIN UNDERFOOT MAY BE BRAND NEW. This hook is replayed on a
    // rollback (world/rollback.ts:204) right after `World.rewindTo` has
    // replaced every height WITHOUT a terrain diff — the one way the
    // incremental census's cached counts can go stale unannounced (see
    // census-index.ts's header, reason 3). Dropping the index costs one full
    // re-count on the next census and closes that hole.
    invalidateCensusIndex();

    // THE CROSS-PLUGIN DEPENDENCY PATTERN, write-direction (./fire-bridge.ts):
    // the host answers who is running as fire here, and the registration is
    // still buffered and replayed by the bridge. The world is taken only to
    // ask that question — every callback below answers from the population,
    // not from the map.
    loadFireBridge(world);
    registerWildlifeFuel({
      name: WILDLIFE_PLUGIN_NAME,
      entityAt: (x: number, y: number) => {
        const found = burnableEntityAt(x, y);
        if (found === null) return null;
        return {
          id: found.entity.id,
          fuel: { burnSeconds: WILDLIFE_BURN_SECONDS },
          distanceCells: found.distanceCells,
        };
      },
      positionOf: entityPosition,
      // What a nearby flame can reach — a grazer in a burning meadow catches,
      // and then runs (../server/entityBlaze.ts advances a fire that walks).
      flammable: function* () {
        for (const creature of flammableCreatures()) {
          yield {
            sourceName: WILDLIFE_PLUGIN_NAME,
            id: creature.id,
            fuel: { burnSeconds: WILDLIFE_BURN_SECONDS },
            x: creature.x,
            y: creature.y,
            radiusCells: creature.radiusCells,
          };
        }
      },
      onBurnedOut: wildlifeBurnedOut,
      onIgnited: wildlifeIgnited,
      // A creature's id survives a restore: ./persistence.ts saves the
      // population AND the id counter (nextEntityIdValue), so the animal that
      // was on fire is the animal that comes back on fire.
      idsSurviveRestore: true,
    });
  },

  /**
   * THE POPULATION BELONGS TO ITS WORLD (issue #208). The final snapshot has
   * already been written when this runs, so dropping everything here costs
   * nothing and closes two holes at once: the registration fire holds is
   * withdrawn, so a world reopened WITHOUT wildlife cannot be offered the last
   * one's creatures as fuel every spread step; and the population itself goes,
   * so a switch to a brand-new world — whose genesis slices are empty, which
   * means `persistence.load` never runs — cannot graze the previous world's
   * animals on ground they never stood on.
   *
   * WITHDRAWAL FIRST, then the state it described: either order works (fire's
   * registry is keyed by name and does not read the source to drop it), and
   * this one keeps the module from being briefly registered but empty.
   */
  onWorldClose(): void {
    closeFireBridge();
    resetWildlifeState();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onWorldEvent(_world: WorldApi, event: string, payload: unknown): void {
    if (event !== FIRE_IGNITED_EVENT_NAME) return;
    reactToFire(payload);
  },

  persistence,
};

/**
 * Drops all accumulated state so the next world starts from zero — called by
 * `onWorldClose` above, and by a suite that wants the same fresh start.
 */
export function resetWildlifeState(): void {
  tickCount = 0;
  invalidateCensusIndex();
  resetPopulation();
  resetFlocks();
}

// Re-exported so tests and any future HUD can reach the tuning numbers through
// the plugin's own entry point rather than by importing its internals.
export { FLEE_DURATION_SECONDS, MAX_BIRDS_ALOFT, WILDLIFE_POPULATION_CAP };
export type { HabitatWorld };
