// saucers — flying-saucer dogfights, as a plugin (owner, 2026-09-04).
//
// Core knows nothing about saucers and must not: ships that arrive from
// nowhere, shoot each other down and leave burning craters is as gamey as a
// mechanic gets, and the design record's rule ("nothing gamey in core") puts the
// whole thing here. It reads the world through `heightAt`, `isCellUnlocked` and
// `worldSize`, writes exactly ONE sculpt per wreck, and reaches the fire
// plugin and the structures plugin only through the host's sibling lookup.
//
// SHAPE OF THE TICK:
//   1. if nothing is flying, roll one arrival against the difficulty curve;
//   2. otherwise advance the encounter one step (./encounter.ts);
//   3. on impact, emit `saucers:crashed` for whoever wants it;
//   4. tell the clients, fog-of-war filtered — but only while something is
//      happening.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE, EVERY TICK, BUT ONLY WHILE AN ENCOUNTER IS ALIVE.
//
// CADENCE — 10 Hz, every tick, which is the fastest cadence any plugin in this
// repo has asked for, and the reason is speed. A saucer covers 34 world units a
// second; at tornado's 5 Hz that is nearly seven units between messages against
// a hull four cells across — the saucer would jump more than its own length
// every push, which no interpolation can hide. At 10 Hz it moves 3.4 units per
// message, which the client's interpolator (kit/interpolator.ts) walks smoothly.
//
// BANDWIDTH — and this is why the fastest cadence in the repo is also nearly the
// cheapest. At the roster ceiling (nine, since the 1-3 revision) saucers of nine keys each plus at
// most MAX_LASER_BOLTS bolts of three (81, now bursts overlap in flight) is ~3 kB of msgpack per message, so
// ~30 kB/s ≈ 240 kbit/s per client WHILE A FIGHT IS ON — and a typical roster
// is a third of that. Wildlife runs at ~210 kbit/s continuously, so this is
// about one existing plugin's steady cost, for twenty-odd seconds every few
// minutes.
//
// AND ZERO WHEN NOTHING IS FLYING. `broadcastPending` (tornado's pattern, and
// the same 2026-08-28 bug it was written for) is what makes the last message of
// an encounter the EMPTY payload and the next message nothing at all: an idle
// world pays one null check per tick, not a fan-out to every player ten times a
// second saying "still nothing".
//
// FOG-OF-WAR FILTERED, and here the reasoning is stronger than tornado's. A
// front's position says nothing about locked terrain, and a tornado's says it
// only walks on land; a saucer's crash cell is a cell whose HEIGHT HAS JUST
// CHANGED, so telling a player where it is telling them about ground they have
// not revealed.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO PERSISTENCE SLICE AT ALL, deliberately. An encounter is transient: it lives
// twenty-odd seconds, and a world reopened mid-fight simply has no fight in it.
// What SURVIVES a restart is what the encounter left behind — the crater,
// because terrain persists, and the fire, because fire persists — which is
// exactly the right division. A slice here would exist only to resume a
// twenty-second animation across a restart nobody watches.

import type {
  Player,
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { interpolateByDifficulty } from '../../../server/src/plugins/kit/difficultyCurve.ts';
import {
  MAX_LASER_BOLTS,
  SAUCERS_CRASHED_EVENT,
  SAUCERS_PLUGIN_NAME,
  SAUCERS_STATE_MESSAGE,
  type CrashState,
  type LaserBolt,
  type SaucerState,
  roundBroadcastPosition,
} from '../protocol.ts';
import {
  advanceEncounter,
  encounterBolts,
  encounterCrashes,
  encounterSaucers,
  forceEncounterNear,
  hasEncounter,
  resetEncounter,
  trySpawnEncounter,
  type EncounterKind,
  type EncounterStart,
} from './encounter.ts';
import { clearFireBridge, loadFireBridge, resetFireBridge } from './fire-bridge.ts';
import {
  clearStructuresBridge,
  loadStructuresBridge,
  resetStructuresBridge,
} from './structures-bridge.ts';
import { resetEncounterSeeds, rollEncounter } from './rng.ts';
import { ADMIN_SEARCH_RADIUS_CELLS } from './site.ts';

/**
 * Mean seconds between encounters at the two ends of WorldApi.difficulty, before
 * anything scales them.
 *
 * TWO ANCHORS AND A LERP, which is WorldApi.difficulty's own instruction and the
 * shape mana established. FIVE MINUTES on the gentlest world and THREE on the
 * harshest (owner, 2026-09-04: "spawn dog fights every three to five minutes"
 * — the first cut's twenty-to-four made the event too rare to tune by eye).
 * Difficulty still decides where in the owner's band a world sits, and the band
 * is narrow because the owner named it, not the curve.
 */
export const ENCOUNTER_MEAN_INTERVAL_AT_EASIEST_SECONDS = 300;
export const ENCOUNTER_MEAN_INTERVAL_AT_HARDEST_SECONDS = 180;

/**
 * A FLY-BY's arrival, on its own roll and the same curve. ASSUMPTION (owner
 * gave no cadence, 2026-09-04): twice as often as a dogfight — a fly-by is
 * over in five seconds and leaves nothing behind, so it can afford to be the
 * more familiar sight and make the fight the rarer one. Halve or double here
 * if the sky reads as too busy or too empty.
 */
export const FLYBY_MEAN_INTERVAL_AT_EASIEST_SECONDS = ENCOUNTER_MEAN_INTERVAL_AT_EASIEST_SECONDS / 2;
export const FLYBY_MEAN_INTERVAL_AT_HARDEST_SECONDS = ENCOUNTER_MEAN_INTERVAL_AT_HARDEST_SECONDS / 2;

/** Mean seconds between encounters on a world of this difficulty. */
export function meanEncounterIntervalSeconds(difficulty: number): number {
  return interpolateByDifficulty(
    ENCOUNTER_MEAN_INTERVAL_AT_EASIEST_SECONDS,
    ENCOUNTER_MEAN_INTERVAL_AT_HARDEST_SECONDS,
    difficulty,
  );
}

export function meanFlybyIntervalSeconds(difficulty: number): number {
  return interpolateByDifficulty(
    FLYBY_MEAN_INTERVAL_AT_EASIEST_SECONDS,
    FLYBY_MEAN_INTERVAL_AT_HARDEST_SECONDS,
    difficulty,
  );
}

/**
 * Ticks between broadcasts. 1 → 10 Hz at the shipped TICK_HZ of 10. See this
 * file's header for why the fastest cadence here is also nearly the cheapest.
 */
export const BROADCAST_TICK_INTERVAL = 1;

/** Events this plugin emits. Namespaced `saucers:` by the host. */
export { SAUCERS_CRASHED_EVENT };

/** Re-exported so a sibling or a harness reaches the ceiling through the API. */
export { MAX_LASER_BOLTS };

let tickCount = 0;

/**
 * A tick changed what clients should see, and it has not been sent yet.
 *
 * IT IS ALSO THE IDLE GATE. `advanceEncounter` reports `changed` only while
 * something is flying, so a world with an empty sky sets this flag on exactly
 * one tick — the one the encounter ENDED on, which carries the empty payload —
 * and then never again until the next arrival. Without it the plugin would
 * either fan out ten empty messages a second forever, or (the 2026-08-28 tornado
 * bug this pattern was written for) never send the empty one at all and leave
 * two saucers frozen in the sky.
 */
let broadcastPending = false;

/**
 * One item on the fog-of-war fan-out, tagged with which list it belongs to.
 *
 * `broadcastVisible` filters a FLAT list of items by each recipient's own mask
 * and hands the survivors to `buildPayload`; a message with more than one item
 * CATEGORY therefore tags each item and re-partitions inside the builder. That
 * is the documented pattern (server/src/plugins/types.ts, broadcastVisible) and
 * flora/structures are the existing users of it.
 *
 * WHY EVERY CATEGORY IS FILTERED AND NOT JUST THE SAUCERS: a bolt is drawn
 * between two hulls, so one whose endpoints a recipient cannot see is a line to
 * nowhere (the wire parse drops it anyway — ../protocol.ts), and a CRASH is
 * the most sensitive item of the three, being a statement about ground whose
 * height has just changed.
 */
type VisibleItem =
  | { readonly kind: 'saucer'; readonly saucer: SaucerState; readonly x: number; readonly y: number }
  | { readonly kind: 'bolt'; readonly bolt: LaserBolt; readonly x: number; readonly y: number }
  | { readonly kind: 'crash'; readonly crash: CrashState; readonly x: number; readonly y: number };

/**
 * Everything happening right now, at wire precision, as one flat tagged list.
 *
 * SAUCER POSITIONS ARE UNBOUNDED (`roundBroadcastPosition`), NOT CLAMPED TO THE
 * MAP — the opposite of what monsters does, and the difference is that a saucer
 * is legitimately off the map for part of its life. It starts its run-in
 * ENTRY_DISTANCE_CELLS outside the world and the winner exits past the far edge;
 * wildlife's birds are the existing precedent, and `roundBroadcastCell`'s own
 * doc comment names that case. Clamping here would pile both saucers up against
 * x = 0 for the whole approach instead of letting them fly in over the horizon.
 *
 * OFF THE MAP IS VISIBLE TO NOBODY, and core is what says so: `broadcastVisible`
 * filters an item whose cell lies outside the world out of every recipient's
 * subset and never throws (#291). That IS the run-in effect — the pair appear as
 * they cross the edge of the world — so it is relied on deliberately rather than
 * worked around.
 *
 * THE CRASHES ARE THE EXCEPTION and need no bounding at all: their cells came
 * from site.ts, which only ever returns cells inside the world.
 */
function visibleItems(): VisibleItem[] {
  const items: VisibleItem[] = [];
  const saucers = encounterSaucers();

  for (const saucer of saucers) {
    const x = roundBroadcastPosition(saucer.x);
    const y = roundBroadcastPosition(saucer.y);
    items.push({
      kind: 'saucer',
      saucer: {
        id: saucer.id,
        variant: saucer.variant,
        x,
        y,
        alt: roundBroadcastPosition(saucer.alt),
        heading: roundBroadcastPosition(saucer.heading),
        speed: roundBroadcastPosition(saucer.speed),
        phase: saucer.phase,
        hp: saucer.hp,
      },
      x,
      y,
    });
  }

  for (const bolt of encounterBolts()) {
    // A BOLT'S VISIBILITY IS ITS SHOOTER'S. It has no cell of its own — it is a
    // line between two hulls — so the honest gate is "can you see who fired it",
    // and the parse drops it anyway if the recipient cannot also see the target.
    const shooter = saucers.find((saucer) => saucer.id === bolt.from);
    if (shooter === undefined) continue;
    items.push({
      kind: 'bolt',
      bolt: { from: bolt.from, to: bolt.to, age: roundBroadcastPosition(bolt.age) },
      x: roundBroadcastPosition(shooter.x),
      y: roundBroadcastPosition(shooter.y),
    });
  }

  for (const crash of encounterCrashes()) {
    items.push({
      kind: 'crash',
      crash: { id: crash.id, x: crash.x, y: crash.y, age: roundBroadcastPosition(crash.age) },
      x: crash.x,
      y: crash.y,
    });
  }

  return items;
}

/**
 * Sends the visible state to one player (a join) or to everyone (the cadence).
 *
 * `skipEmpty: false` — a FULL-STATE REPLACE message, so a recipient whose
 * filtered subset is empty must still be sent the empty payload. That is the
 * only way a client learns the saucers it could see are gone; omitting the send
 * would leave its last non-empty payload flying forever.
 */
function broadcastState(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    SAUCERS_STATE_MESSAGE,
    visibleItems(),
    (item) => ({ x: item.x, y: item.y }),
    (visible) => {
      const saucers: SaucerState[] = [];
      const lasers: LaserBolt[] = [];
      const crashes: CrashState[] = [];
      for (const item of visible) {
        if (item.kind === 'saucer') saucers.push(item.saucer);
        else if (item.kind === 'bolt') lasers.push(item.bolt);
        else crashes.push(item.crash);
      }
      return { saucers, lasers, crashes };
    },
    { skipEmpty: false, onlyPlayerId },
  );
}

/**
 * Rolls this tick's arrival. Nothing happens while an encounter is already
 * flying — the singleton is enforced in ./encounter.ts, and this check only
 * saves the roll.
 */
function rollArrival(world: WorldApi, dt: number): void {
  if (hasEncounter()) return;
  // Two independent rolls, dogfight first: on the tick both come up, the
  // fight takes the slot and the fly-by is simply not this tick's.
  if (rollEncounter(1 / meanEncounterIntervalSeconds(world.difficulty), dt)) {
    logArrival(trySpawnEncounter(world, 'dogfight'));
  }
  if (hasEncounter()) return;
  if (rollEncounter(1 / meanFlybyIntervalSeconds(world.difficulty), dt)) {
    logArrival(trySpawnEncounter(world, 'flyby'));
  }
}

/**
 * Null is the ordinary answer on a world with nowhere legal to fly (all
 * ocean, all fog, all town) — the roll simply produced nothing. Not logged:
 * on such a world it would be a line every few minutes saying the same thing.
 */
function logArrival(started: EncounterStart | null): void {
  if (started === null) return;
  console.info(
    `[${SAUCERS_PLUGIN_NAME}] ${describeStart(started)} came in over the map ` +
      `(encounter seed 0x${(started.seed >>> 0).toString(16)})`,
  );
}

function describeStart(started: EncounterStart): string {
  return started.kind === 'flyby'
    ? `a fly-by of ${started.saucers} saucers`
    : `${started.saucers} saucers in ${started.factions} factions`;
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  rollArrival(world, dt);

  const tick = advanceEncounter(world, dt);
  for (const crash of tick.crashed) {
    // THE CHRONICLE'S EAR, and anyone else's. Emitted on the tick of impact,
    // once per wreck, with the cell the crater is centred on — validated
    // structurally by whoever consumes it, as every world event is.
    world.emitEvent(SAUCERS_CRASHED_EVENT, { x: crash.x, y: crash.y });
    console.info(`[${SAUCERS_PLUGIN_NAME}] a saucer went down at (${crash.x}, ${crash.y})`);
  }

  if (tick.changed) broadcastPending = true;
  if (tickCount % BROADCAST_TICK_INTERVAL === 0 && broadcastPending) {
    broadcastPending = false;
    broadcastState(world);
  }
}

/** Everything this plugin holds that belongs to ONE world. */
function resetSessionState(): void {
  tickCount = 0;
  broadcastPending = false;
  resetEncounter();
  clearFireBridge();
  clearStructuresBridge();
}

/** The action keys ARE the encounter kinds; anything else is not an action. */
function actionKind(key: string): EncounterKind | null {
  return key === 'dogfight' || key === 'flyby' ? key : null;
}

export const plugin: TerracePlugin = {
  name: SAUCERS_PLUGIN_NAME,

  /**
   * THE ADMIN PANEL'S DOGFIGHT (server plugins/types.ts,
   * PluginActionDeclaration).
   *
   * THIS IS WHAT "GATED THE WAY MONSTERS GATES ITS ADMIN SUMMON" MEANS, and it
   * is NOT a client message. The brief asked for a client→server
   * `saucers:summon`; monsters does not have one — its debug spawns are
   * `actions` + `onAction` (plugins/monsters/server/index.ts, and see
   * PluginActionDeclaration's own doc comment for why: a plugin message would
   * give the power to every player, whereas a declaration lets core gate it
   * behind the world-admin key). Implementing the brief's literal message would
   * have let any connected client crater someone else's land on demand.
   */
  // Groups this plugin's cards in the admin panel; see TerracePlugin.archetype.
  archetype: 'visitors',
  actions: [
    {
      key: 'dogfight',
      label: 'Start a saucer dogfight',
      description:
        'Rival saucer factions come in over the nearest open land to where you are looking, ' +
        'fight, and every one shot down leaves a burning crater.',
    },
    {
      key: 'flyby',
      label: 'Start a saucer fly-by',
      description:
        'A formation of saucers passes over the nearest open land to where you are looking ' +
        'and leaves. No fight, no craters.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    const kind = actionKind(key);
    if (kind === null) return { ok: false, detail: `no such action "${key}"` };
    if (hasEncounter()) return { ok: false, detail: 'saucers are already in the sky' };

    const started = forceEncounterNear(world, kind, site);
    if (started === null) {
      return {
        ok: false,
        detail:
          `no open, unlocked land clear of towns within ${ADMIN_SEARCH_RADIUS_CELLS} cells of ` +
          `(${site.x}, ${site.y}) big enough for an arena`,
      };
    }
    // Clients are told NOW rather than on the next tick — PluginActionDeclaration's
    // own instruction, since an action runs between ticks.
    broadcastPending = false;
    broadcastState(world);
    return {
      ok: true,
      detail:
        `${describeStart(started)} coming in over ` +
        `(${started.site.centreX}, ${started.site.centreY})`,
    };
  },

  onWorldCreate(world: WorldApi): void {
    // Everything here is SESSION-scoped and there is no persistence slice to
    // preserve, so this is a clean reset — which is also what makes the hook
    // safe to replay on a rollback (PersistenceSlice's re-runnable rule).
    resetSessionState();
    resetEncounterSeeds();
    loadFireBridge(world);
    loadStructuresBridge(world);

    console.info(
      `[${SAUCERS_PLUGIN_NAME}] difficulty ${world.difficulty} → a dogfight every ~${Math.round(
        meanEncounterIntervalSeconds(world.difficulty) / 60,
      )} min, a fly-by every ~${Math.round(meanFlybyIntervalSeconds(world.difficulty) / 60)} min`,
    );
  },

  onWorldClose(): void {
    // The plugin holds no WorldApi at module scope, but the bridges hold sibling
    // modules resolved FOR THIS WORLD, and its encounter belongs to it — leaving
    // either standing would hand the next world this one's dogfight.
    resetSessionState();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // A joining client is caught up within 100 ms by the next broadcast anyway —
    // IF one is due. Mid-encounter that is true; between encounters nothing is
    // sent at all (see broadcastPending), so without this a client that joined
    // during the quiet would never receive the empty payload that initialises
    // its own view. One message, once, per join.
    broadcastState(world, player.id);
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetSaucersState(): void {
  resetSessionState();
  resetEncounterSeeds();
  resetFireBridge();
  resetStructuresBridge();
}
