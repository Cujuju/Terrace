// fire — things burn.
//
// Core knows nothing about combustion, and this plugin knows nothing about
// trees. It owns exactly one mechanic: a set of cells that are alight, each
// consuming fuel some OTHER plugin declared (./fuel.ts), each ending in one of
// the three ways ./blaze.ts's header sets out. What burns, and what is left
// when it has burned, belongs to whoever registered the fuel.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THIS PLUGIN SITS NEXT TO THE OTHER TWO THAT PLACE THINGS ON CELLS.
//
//   flora  : up to 3000 objects that never change → deltas + a 60 s keepalive
//   fire   : up to 400 objects with a KNOWN FUTURE → deltas + a 10 s keepalive
//   wildlife: 150 objects that move unpredictably → full state, twice a second
//
// The middle row is the whole design. A fire is not static like a tree, but it
// is not unpredictable like an animal either: from the moment it is lit, its
// entire remaining behaviour is determined (../protocol.ts). So it is sent once,
// like a tree, and the receiver runs it forward like an animation. The keepalive
// is SHORTER than flora's for one reason — a repair cadence longer than the
// thing it repairs never repairs anything, and a fire's whole life is measured
// in tens of seconds. See FIRE_KEEPALIVE_SECONDS.
//
// FOG OF WAR. Every send is per recipient (WorldApi.broadcastVisible), and
// unlike flora this plugin CANNOT use `skipEmpty` on its extinguish path — see
// FIRE_SEND_EMPTY below, which is the one place fire's wire genuinely differs
// from the static-content pattern it otherwise copies.
//
// SPREAD lives in ./spread.ts and runs on its own slower cadence
// (SPREAD_INTERVAL_SECONDS) — one product of one rate and three multipliers,
// with the firebreak falling out of it rather than being written into it.
//
// RAIN is where fires go. The same weather that throws the bolt puts the fire
// out (./weather-bridge.ts, and the suppression roll in onTick), which closes
// the loop rather than leaving fire as a thing only the player can end.
//
// LIGHTNING is where fires come from today: weather picks the cell a bolt lands
// on, emits it, and this plugin rolls whether it caught (onWorldEvent below).
//
// WHAT IS NOT HERE YET, deliberately: rain suppression and the player's own
// ignite intent. `igniteAt` is the seam both arrive through.
// ─────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE, type CellDiff } from '@terrace/shared';
// Type-only import of the plugin contract (fully erased at runtime), reaching
// into server/src exactly as every other plugin here does — core publishes no
// plugin-API entry point yet.
import type {
  PersistenceSlice,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  FIRE_BURNED_EVENT,
  FIRE_CHANGES_MESSAGE,
  FIRE_FIRES_MESSAGE,
  FIRE_PLUGIN_NAME,
  packCells,
  packFires,
  type FireCellState,
} from '../protocol.ts';
import { Blaze, type FuelCell } from './blaze.ts';
import { fuelSources } from './fuel.ts';
import { fireRandom, happensWithin } from './rng.ts';
import { SPREAD_INTERVAL_SECONDS, spreadOnce } from './spread.ts';
import { parseStruckCells } from './strike-event.ts';
import { loadWeatherBridge, precipitationAt } from './weather-bridge.ts';

/**
 * Simulated seconds between unsolicited re-broadcasts of the whole burning set.
 *
 * A SIXTH of flora's 60 s, and the ratio is the argument: a keepalive exists to
 * bound how long a client can stay wrong, so it has to be shorter than the life
 * of the thing it is correcting or it can only ever repair fires that are
 * already over. The shortest fuel in the game is a crop (a few seconds); a tree
 * is tens. 10 s re-anchors every tree fire at least once mid-burn, and costs
 * 4.4 KB per client only in the worst case where 400 cells are alight at once —
 * on a world where nothing is burning it costs nothing at all, because
 * `broadcastVisible` is never called (see the guard in onTick).
 *
 * It also re-anchors the CLIENT'S CLOCK. A fire's age advances locally between
 * messages (../protocol.ts), so client and server drift by whatever their frame
 * clocks disagree about; this bounds that drift at 10 s of it rather than a
 * whole burn's worth.
 */
export const FIRE_KEEPALIVE_SECONDS = 10;

/**
 * `skipEmpty: false` — fire's ONE deliberate departure from flora's wire.
 *
 * flora may skip a recipient whose own subset is empty because a tree never
 * moves once planted, so an empty send could never correct anything (see
 * FLORA_SKIP_EMPTY). A fire is different in exactly the way that matters: it
 * ENDS. If a client holds a fire and the next snapshot it would receive is
 * empty, "send nothing" leaves that fire burning on their screen forever, and
 * the keepalive — the very mechanism meant to repair that — becomes the thing
 * that hides it.
 *
 * So the snapshot always sends, empty or not. The cost is one empty message per
 * client per 10 s, and it is only paid at all while SOMETHING is burning
 * somewhere in the world (onTick's guard); a peaceful world sends nothing.
 */
const FIRE_SEND_EMPTY = { skipEmpty: false } as const;

/**
 * The DELTA may skip empties, unlike the snapshot above: a delta names cells
 * that changed, so a recipient whose subset of it is empty saw none of those
 * cells change and has nothing to correct. This is flora's rule, and it holds
 * here for the same reason — it is only the SNAPSHOT's emptiness that is
 * load-bearing.
 */
const FIRE_SKIP_EMPTY = { skipEmpty: true } as const;

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching every other plugin here:
// the host constructs one plugin instance per server process.

const blaze = new Blaze();

/**
 * The live world, stashed at onWorldCreate so `igniteAt` can be called from
 * outside a hook — by the weather plugin's lightning, and later by the player's
 * own ignite intent. Null before the world exists, which doubles as the guard
 * for "something tried to light a fire before there was anywhere to put it".
 */
let currentWorld: WorldApi | null = null;

/** Accumulated simulated seconds — this plugin's only clock. */
let simSeconds = 0;

/** Simulated time of the last full snapshot. */
let lastKeepaliveSeconds = 0;

/**
 * THE EPISODE. Cells consumed since the world last stopped burning, and where
 * the first of them was.
 *
 * A wildfire is not an event the sim has — the sim has hundreds of cells each
 * finishing on their own second. But it is the only unit anything OUTSIDE this
 * plugin cares about: "a fire took forty trees above the lake" is a line in the
 * chronicle, and "cell (91, 40) finished burning" is not. So the episode is
 * accumulated here and emitted once, when the last fire goes out.
 *
 * BOUNDED BY CONSTRUCTION: it counts, it does not collect. The origin is one
 * cell and the total is one integer, so a fire that burns for an hour costs the
 * same memory as one that burns for a second.
 */
let episodeConsumed = 0;
let episodeOrigin: FuelCell | null = null;

/**
 * Simulated seconds owed to the spread step, carried between ticks.
 *
 * Spread runs on a slower cadence than the tick (SPREAD_INTERVAL_SECONDS), and
 * it is handed the WHOLE elapsed interval rather than one tick's dt — the rate
 * arithmetic in ./spread.ts is expressed per second, so the two must agree
 * about how much time a step covers or the game's balance silently follows the
 * server's tick rate.
 */
let spreadDebtSeconds = 0;

/**
 * Fires restored from a snapshot, held until onWorldCreate.
 *
 * The host restores persistence BEFORE it creates the world, so load() runs
 * when there is no world to validate against — flora parks its trees the same
 * way and for the same reason.
 */
let restoredFires: Array<FireCellState & { readonly sourceName: string }> = [];

// ────────────────────────────────────────────────────────────────────────────
// Wire
// ────────────────────────────────────────────────────────────────────────────

/** A fire's own cell — what broadcastVisible gates visibility by. */
function firePosition(fire: { readonly x: number; readonly y: number }): { x: number; y: number } {
  return { x: fire.x, y: fire.y };
}

function broadcastSnapshot(world: WorldApi): void {
  world.broadcastVisible(
    FIRE_FIRES_MESSAGE,
    blaze.fires(),
    firePosition,
    (visible) => ({ fires: packFires(visible) }),
    FIRE_SEND_EMPTY,
  );
  lastKeepaliveSeconds = simSeconds;
}

/**
 * One entry of a `fire:changes` delta. The two halves carry different payloads
 * (a whole fire vs. a bare cell), so they are tagged rather than merged — the
 * same shape flora's TaggedTreeChange uses, for the same reason: one
 * `broadcastVisible` pass has to visibility-test both halves together.
 */
type TaggedFireChange =
  | { readonly kind: 'ignited'; readonly fire: FireCellState }
  | { readonly kind: 'extinguished'; readonly cell: FuelCell };

function broadcastChanges(
  world: WorldApi,
  ignited: readonly FireCellState[],
  extinguished: readonly FuelCell[],
): void {
  if (ignited.length === 0 && extinguished.length === 0) return;

  const tagged: TaggedFireChange[] = [
    ...ignited.map((fire): TaggedFireChange => ({ kind: 'ignited', fire })),
    ...extinguished.map((cell): TaggedFireChange => ({ kind: 'extinguished', cell })),
  ];
  world.broadcastVisible(
    FIRE_CHANGES_MESSAGE,
    tagged,
    (change) => (change.kind === 'ignited' ? firePosition(change.fire) : firePosition(change.cell)),
    (visible) => ({
      ignited: packFires(
        visible.filter((c): c is Extract<TaggedFireChange, { kind: 'ignited' }> => c.kind === 'ignited').map((c) => c.fire),
      ),
      extinguished: packCells(
        visible
          .filter((c): c is Extract<TaggedFireChange, { kind: 'extinguished' }> => c.kind === 'extinguished')
          .map((c) => c.cell),
      ),
    }),
    FIRE_SKIP_EMPTY,
  );
}

/**
 * THE TARGETED-REFRESH PATH (issue #18): a player who has just unlocked a chunk
 * is sent the fires already burning inside it, rather than waiting up to a
 * keepalive.
 *
 * It matters MORE here than it does for flora, where the same hook exists to
 * avoid a minute of missing trees. A fire may not survive a keepalive at all —
 * a player could creep into a chunk, watch it burn from ignition to ash, and be
 * told about it only after it was over.
 */
function refreshUnlockedChunk(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk = blaze
    .fires()
    .filter((fire) => fire.x >= x0 && fire.x < x0 + CHUNK_SIZE && fire.y >= y0 && fire.y < y0 + CHUNK_SIZE);
  if (inChunk.length === 0) return;

  const payload = { ignited: packFires(inChunk), extinguished: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FIRE_CHANGES_MESSAGE, payload);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The public server-side surface — how anything in the world starts a fire.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tries to light the cell (x, y). Returns true if something caught.
 *
 * THE ONE WAY A FIRE EVER STARTS. Lightning, a player's torch and any future
 * cause all arrive here, so the cap, the fuel lookup and the broadcast exist in
 * exactly one place and a new cause of fire cannot forget one of them.
 *
 * False is the ordinary answer, not an error: bare rock, water, a cell already
 * alight, or a world already burning at the cap all give it. See Blaze.ignite.
 */
export function igniteAt(x: number, y: number): boolean {
  const world = currentWorld;
  if (world === null) return false;

  const fire = blaze.ignite(x, y);
  if (fire === null) return false;

  broadcastChanges(world, [fire], []);
  return true;
}

/**
 * Puts out these cells without consuming their fuel — the "we saved it" path
 * (blaze.ts's header). Exported for the rain suppression that is coming, and
 * used already by onTerrainChanged below.
 */
export function extinguishAt(cells: Iterable<{ readonly x: number; readonly y: number }>): number {
  const world = currentWorld;
  if (world === null) return 0;

  const stopped = blaze.extinguish(cells);
  if (stopped.length === 0) return 0;

  broadcastChanges(world, [], stopped);
  return stopped.length;
}

/** Every cell currently alight. For plugins that need to ask (wildlife fleeing). */
export function burningCells(): FireCellState[] {
  return blaze.fires();
}

// Re-exported so a registrant imports ONE module: a flammable plugin's bridge
// duck-types this entry point, and asking it to reach into ./fuel.ts as well
// would make the bridge's shape depend on this plugin's internal file layout.
export { registerFuel, unregisterFuel, type CellFuel, type FuelSource } from './fuel.ts';

/**
 * Emits the finished wildfire, if anything actually burned.
 *
 * Called when the burning set empties, whatever emptied it — burned out, rained
 * out, or dug out. A fire the player beat still gets its line: the world does
 * not distinguish, and "twelve trees were lost before the rain came" is exactly
 * the sort of thing worth recording.
 *
 * Emitted as a world EVENT and not broadcast to clients: nothing on screen
 * changes when a fire ends (every cell's own extinguish delta already went out),
 * and the audience for this is other server plugins — the chronicle, today.
 */
function endEpisode(world: WorldApi): void {
  const origin = episodeOrigin;
  const consumed = episodeConsumed;
  episodeOrigin = null;
  episodeConsumed = 0;
  if (origin === null || consumed === 0) return;

  world.emitEvent(FIRE_BURNED_EVENT, { consumed, x: origin.x, y: origin.y });
}

/**
 * Chance per second that a fire under FULL-intensity rain is put out.
 *
 * Sized against the burn it has to interrupt: a tree burns for 22 s, so at
 * 0.25/s a fire caught in a downpour is out within about four seconds and has
 * essentially no chance of surviving a squall's passage. Rain is meant to be the
 * decisive answer to fire — it is the one the player cannot cause, so it is
 * allowed to be strong — while WET_SPREAD_PENALTY keeps even that short of a
 * guarantee at the edges of a system where intensity is low.
 */
export const RAIN_SUPPRESSION_RATE_PER_SECOND = 0.25;

/**
 * Rolls rain against every fire and returns the ones it put out.
 *
 * The fuel SURVIVES (blaze.ts's three endings): a tree the rain saved is still a
 * tree, scorched. That distinction is the whole reason extinguish and burn-out
 * are separate paths.
 */
function suppressWithRain(dt: number): FuelCell[] {
  const drenched: FuelCell[] = [];
  for (const fire of blaze.fires()) {
    const wetness = precipitationAt(fire.x, fire.y);
    if (wetness <= 0) continue;
    if (!happensWithin(RAIN_SUPPRESSION_RATE_PER_SECOND * wetness, dt)) continue;
    drenched.push({ x: fire.x, y: fire.y });
  }
  return blaze.extinguish(drenched);
}

/**
 * Chance that a bolt landing on something flammable sets it alight.
 *
 * NOT 1, and the difference is the whole feel of the mechanic: most lightning
 * should be spectacle and some of it should be a disaster. A player who learns
 * that every bolt starts a fire stops watching storms and starts dreading them.
 *
 * THE ARITHMETIC IT LANDS AT, on a mature world: flora plants roughly one tree
 * per FLORA_CELLS_PER_TREE (12) eligible cells, so a bolt aimed by height alone
 * (weather/server/lightning.ts) lands on fuel maybe one time in twelve; at 0.35
 * that is ~3% of bolts starting a fire, and a storm throwing a dozen bolts over
 * its life starts one about a third of the time it crosses woodland. Rare
 * enough to be an event, common enough that a long game sees several.
 */
export const LIGHTNING_IGNITION_CHANCE = 0.35;

/**
 * A bolt landed on each of these cells. Rolls each one independently.
 *
 * The struck cell is the only candidate — no searching a neighbourhood for
 * something more flammable. A bolt hit a cell; either something there caught or
 * it did not. Widening the search would make the strike's DRAWN position a lie
 * about where the fire started, which is the exact defect moving strike
 * selection to the server was meant to fix.
 */
function igniteStruckCells(cells: readonly { readonly x: number; readonly y: number }[]): void {
  for (const cell of cells) {
    if (fireRandom() >= LIGHTNING_IGNITION_CHANCE) continue;
    igniteAt(cell.x, cell.y);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fires survive a restart, ages and all.
 *
 * The alternative — dropping them — was rejected once the consequence was
 * written down: a snapshot taken mid-fire would restore the world with its
 * trees intact and the fire gone, so a server restart would become the way to
 * save a burning forest. Persisting the age (rather than restarting the burn)
 * matters for the same reason in the other direction: a restart must not hand
 * a nearly-spent fire a fresh full life.
 */
const persistence: PersistenceSlice = {
  save(): unknown {
    return { fires: blaze.entries() };
  },

  load(data: unknown): void {
    restoredFires = [];
    if (typeof data !== 'object' || data === null) return;
    const fires = (data as { fires?: unknown }).fires;
    if (!Array.isArray(fires)) return;

    for (const entry of fires) {
      if (typeof entry !== 'object' || entry === null) continue;
      const fire = entry as Partial<FireCellState & { sourceName: string }>;
      if (
        typeof fire.x !== 'number' ||
        typeof fire.y !== 'number' ||
        typeof fire.fuelHeight !== 'number' ||
        typeof fire.ageSeconds !== 'number' ||
        typeof fire.burnSeconds !== 'number' ||
        typeof fire.sourceName !== 'string'
      ) {
        continue;
      }
      restoredFires.push({
        x: fire.x,
        y: fire.y,
        fuelHeight: fire.fuelHeight,
        ageSeconds: fire.ageSeconds,
        burnSeconds: fire.burnSeconds,
        sourceName: fire.sourceName,
      });
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

export const plugin: TerracePlugin = {
  name: FIRE_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    currentWorld = world;
    simSeconds = 0;
    lastKeepaliveSeconds = 0;
    // REPLACES rather than adds — the rollback contract (types.ts's
    // PersistenceSlice). A load()/onWorldCreate() pair may run again on a live
    // world, and a fire that survived that would be burning twice.
    spreadDebtSeconds = 0;
    episodeConsumed = 0;
    episodeOrigin = null;
    blaze.restore(restoredFires);
    restoredFires = [];

    // THE CROSS-PLUGIN DEPENDENCY PATTERN, read-direction (./weather-bridge.ts):
    // started, not awaited. Until it resolves — and forever, on a world with no
    // weather plugin — the air is still and spread is isotropic.
    loadWeatherBridge();
  },

  onTick(world: WorldApi, dt: number): void {
    simSeconds += dt;

    // A world with nothing alight costs one comparison per tick. Everything
    // below — the advance, the keepalive, the empty snapshot FIRE_SEND_EMPTY
    // exists for — is work that only a burning world pays for.
    if (blaze.size === 0) {
      lastKeepaliveSeconds = simSeconds;
      return;
    }

    const { burnedOut, stopped } = blaze.advance(dt);

    // SPREAD, on its own cadence. Accumulated rather than run every tick, and
    // capped at one interval so a stalled or resumed server cannot bank an
    // unbounded debt and then spread the fire across the world in one step —
    // flora's scanCredit is capped for the same reason.
    spreadDebtSeconds = Math.min(spreadDebtSeconds + dt, SPREAD_INTERVAL_SECONDS);
    let ignited: FireCellState[] = [];
    let drenched: FuelCell[] = [];
    if (spreadDebtSeconds >= SPREAD_INTERVAL_SECONDS) {
      // RAIN BEFORE SPREAD, so a fire the rain has just put out does not get to
      // throw one last spark on its way out. The two share a cadence because
      // they are two halves of one question — where is the fire a second from
      // now — and evaluating them on different clocks would let a fire spread
      // from a cell it was extinguished on.
      drenched = suppressWithRain(spreadDebtSeconds);
      ignited = spreadOnce(world, blaze, spreadDebtSeconds);
      spreadDebtSeconds = 0;
    }

    // Route each finished fire back to the plugin whose stuff it consumed. The
    // source destroys what was there and broadcasts its own change; this plugin
    // never touches another plugin's state.
    if (burnedOut.size > 0) {
      for (const source of fuelSources()) {
        const cells = burnedOut.get(source.name);
        if (cells === undefined || cells.length === 0) continue;
        source.onBurnedOut(cells);
        // The episode counts what was actually CONSUMED, not what stopped
        // burning: a fire the rain saved took nothing, and a chronicle line
        // claiming otherwise would be a lie about a forest that is still there.
        episodeConsumed += cells.length;
        episodeOrigin ??= cells[0]!;
      }
    }

    const ended = drenched.length > 0 ? [...stopped, ...drenched] : stopped;
    if (ignited.length > 0 || ended.length > 0) broadcastChanges(world, ignited, ended);

    // The world just stopped burning: whatever that fire was, it is over.
    if (blaze.size === 0) endEpisode(world);

    if (simSeconds - lastKeepaliveSeconds >= FIRE_KEEPALIVE_SECONDS) broadcastSnapshot(world);
  },

  /**
   * THE FIREBREAK, in its first and crudest form: moving the ground under a
   * fire puts it out.
   *
   * That is not a placeholder for the real spread rules — it is the same rule
   * they will be built on. A player who digs a trench through a burning stand
   * is doing the thing the mechanic is for, and it works today, before spread
   * exists, because "the ground this fire stands on changed" is knowable from
   * the diff alone.
   *
   * The fuel is NOT consumed (blaze.ts's three endings): a tree that was on
   * fire when the player dug it out was destroyed by the digging, and flora
   * fells it on this same diff through its own onTerrainChanged.
   */
  onTerrainChanged(_world: WorldApi, diff: readonly CellDiff[]): void {
    if (blaze.size === 0 || diff.length === 0) return;
    extinguishAt(diff);
  },

  onWorldEvent(_world: WorldApi, event: string, payload: unknown): void {
    // By-name subscription (server/src/plugins/types.ts's emitEvent doc
    // comment): weather's plugin name is the coupling, exactly like a wire
    // message namespace — never an import of weather's code. A world with no
    // weather plugin simply never sees this event, and nothing here fires.
    if (event !== 'weather:strikes') return;
    const struck = parseStruckCells(payload);
    if (struck === null) return;
    igniteStruckCells(struck);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // The joining player alone, not a world-wide re-broadcast: everyone else's
    // set is already current.
    world.broadcastVisible(
      FIRE_FIRES_MESSAGE,
      blaze.fires(),
      firePosition,
      (visible) => ({ fires: packFires(visible) }),
      { skipEmpty: false, onlyPlayerId: player.id },
    );
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
  },

  persistence,
};

/** Test seam: forgets the world and every fire. Never called by the server. */
export function resetFireState(): void {
  currentWorld = null;
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  spreadDebtSeconds = 0;
  episodeConsumed = 0;
  episodeOrigin = null;
  restoredFires = [];
  blaze.clear();
}
