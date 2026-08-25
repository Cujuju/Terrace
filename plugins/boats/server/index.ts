// boats — a coastal settlement's answer to a kraken.
//
// THE ARC docs/DESIGN.md parked on 2026-08-19 ("the mechanic waits for a
// fiction: boats fight the kraken, terrain does not"), settled with the owner
// on 2026-08-20. See protocol.ts for the fiction and every number in it.
//
// SHAPE OF THE TICK:
//   1. the kraken's position, if the monsters plugin announced one this tick;
//   2. shipyards build, boats sail, the fight resolves (./fleet.ts);
//   3. a rout leaves as a world event — this plugin never banishes anything
//      itself (see THE ROUT below);
//   4. broadcast, on the cadence.
//
// THE ROUT, AND WHY IT IS AN EVENT AND NOT A CALL. Making the kraken leave is
// the monsters plugin's business: it owns the cooldown the design record kept
// "whole for the boats arc", and it is the only thing that knows what a
// departure means for summoning. So a won fight emits `boats:defeated` and
// stops there. If monsters is not installed, the event falls on the floor and
// this plugin still works — the boats simply have nothing to fight, because
// nothing is emitting positions either.
//
// A NOTE ON WHAT THIS PLUGIN DOES NOT DO. It never sculpts, never denies an
// intent, and never unlocks a chunk. Its entire effect on the world is one
// event and one broadcast, which is what keeps a mechanic this stateful out of
// core's way.

import type {
  PersistenceSlice,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { BOATS_PLUGIN_NAME, BOATS_STATE_MESSAGE } from '../protocol.ts';
import {
  KRAKEN_KIND,
  parseMonsterSightings,
  parseVillageChanges,
} from './events.ts';
import {
  advanceFleet,
  boatPosition,
  boatStates,
  burnBoats,
  burnableBoatAt,
  forgetVillage,
  rememberVillage,
  resetFleet,
  type KrakenTarget,
} from './fleet.ts';
import { loadFireBridge, registerBoatsFuel } from './fire-bridge.ts';
import { loadBoats, saveBoats } from './persistence.ts';

/**
 * Ticks between broadcasts. 5 → 2 Hz at the shipped TICK_HZ of 10.
 *
 * TWICE MONSTERS' OWN RATE (BROADCAST_TICK_INTERVAL = 10, i.e. 1 Hz) and that
 * is deliberate rather than copied: a kraken lurks at 0.6 cells/s and a boat
 * sails at 1.5, so a boat covers two and a half times the ground between
 * frames and needs correspondingly more frequent fixes for a client to
 * interpolate it smoothly. The payload is small — at most
 * BOATS_PER_VILLAGE boats per coastal village, five numbers each — so the
 * extra rate costs little.
 */
export const BROADCAST_TICK_INTERVAL = 5;

const EVENT_STRUCTURES_CHANGES = 'structures:changes';
const EVENT_MONSTERS_POSITIONS = 'monsters:positions';

/** Event this plugin emits when a fleet drives a kraken off. */
export const DEFEATED_EVENT = 'defeated';

let tickCount = 0;

/**
 * The kraken's last announced position, and whether that announcement was for
 * THIS tick.
 *
 * A LATCH RATHER THAN A CACHE, and the distinction matters: `monsters:positions`
 * arrives inside the monsters plugin's own tick, which runs in load order
 * against this one. Holding the position across ticks would mean boats kept
 * fighting a kraken that had already departed (its plugin simply stops
 * announcing), so the latch is cleared every tick and an absent announcement
 * reads exactly as "there is no kraken", which is what it means.
 */
let krakenThisTick: KrakenTarget | null = null;

function simulate(world: WorldApi, dt: number): void {
  const kraken = krakenThisTick;
  krakenThisTick = null;

  const outcome = advanceFleet(world, kraken, dt);

  if (outcome.routed) {
    // Position included so a consumer can say WHERE it happened without
    // having to have been watching the fight.
    world.emitEvent(DEFEATED_EVENT, {
      kind: KRAKEN_KIND,
      x: kraken?.x ?? 0,
      y: kraken?.y ?? 0,
    });
  }

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;

  // FOG OF WAR: each player is sent only the boats over chunks they have
  // personally unlocked. Never skipEmpty — this is a full-state replace
  // message, so the empty list is itself how a client learns the boats it
  // could see have left its view. Monsters' own broadcast, unchanged.
  world.broadcastVisible(
    BOATS_STATE_MESSAGE,
    boatStates(),
    (boat) => ({ x: boat.x, y: boat.y }),
    (visible) => ({ boats: visible }),
  );
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveBoats();
  },
  load(data: unknown): void {
    loadBoats(data);
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Fire
//
// A boat is timber and pitch and it moves, so it registers into fire's ENTITY
// registry (plugins/fire/server/entityFuel.ts) alongside the animals and the
// peeps. It is also the only flammable thing in the game that is not standing
// on the ground, and that costs nothing: an entity flame is drawn at the pose
// its owner publishes, and this plugin's client draws hulls at the waterline.
// ────────────────────────────────────────────────────────────────────────────

/**
 * How long a burning boat stays afloat, in simulated seconds.
 *
 * Longer than a creature's 8 s and shorter than a building's 30: a hull is more
 * to consume than an animal and less than a town, and the number is chosen so
 * that a burning boat is a thing you WATCH — long enough for it to keep rowing,
 * for the fleet to scatter around it, and for the player to see it go down
 * where it went down.
 */
export const BOATS_BURN_SECONDS = 16;

/**
 * Flame size for a burning boat, in world units.
 *
 * A hull is 0.9 world units long (fleet.ts's BOAT_PERSONAL_SPACE_CELLS note)
 * with a mast above it; 1.2 makes the fire read from the shore, which is where
 * whoever lit it is standing.
 */
export const BOATS_FUEL_HEIGHT = 1.2;

/** These burned to the waterline. */
function boatsBurnedOut(ids: readonly number[]): void {
  burnBoats(ids);
}

export const plugin: TerracePlugin = {
  name: BOATS_PLUGIN_NAME,

  onWorldCreate(): void {
    // THE CROSS-PLUGIN DEPENDENCY PATTERN, write-direction (./fire-bridge.ts):
    // started, not awaited, buffered and replayed if fire has not resolved yet.
    loadFireBridge();
    registerBoatsFuel({
      name: BOATS_PLUGIN_NAME,
      entityAt: (x: number, y: number) => {
        const boat = burnableBoatAt(x, y);
        if (boat === null) return null;
        return {
          id: boat.id,
          fuel: { burnSeconds: BOATS_BURN_SECONDS, height: BOATS_FUEL_HEIGHT },
        };
      },
      positionOf: boatPosition,
      onBurnedOut: boatsBurnedOut,
    });
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onWorldEvent(_world: WorldApi, event: string, payload: unknown): void {
    if (event === EVENT_STRUCTURES_CHANGES) {
      const changes = parseVillageChanges(payload);
      // A malformed event updates NOTHING. Half-applying it would leave the
      // roster describing a coastline that never existed.
      if (changes === null) return;
      for (const cell of changes.gained) rememberVillage(cell.x, cell.y);
      for (const cell of changes.lost) forgetVillage(cell.x, cell.y);
      return;
    }

    if (event === EVENT_MONSTERS_POSITIONS) {
      const sightings = parseMonsterSightings(payload);
      if (sightings === null) return;
      // FIRST kraken, not nearest: only one kraken can exist at a time
      // (monsters' MAX_LIVING_MONSTERS_PER_KIND), so "first" and "the one"
      // are the same thing, and a nearest-search would imply a plurality the
      // emitter does not permit.
      const kraken = sightings.find((seen) => seen.kind === KRAKEN_KIND);
      krakenThisTick = kraken === undefined ? null : { x: kraken.x, y: kraken.y };
    }
  },

  persistence,
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetBoatsState(): void {
  tickCount = 0;
  krakenThisTick = null;
  resetFleet();
}
