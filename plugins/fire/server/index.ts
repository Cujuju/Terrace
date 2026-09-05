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
//   flora  : up to 4096 objects that never change → deltas + a 60 s keepalive
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
// (SPREAD_INTERVAL_SECONDS) — one rate multiplied by intensity, wind, slope,
// distance and wetness, with the firebreak falling out of it rather than being
// written into it.
//
// RAIN is where fires go. The same weather that throws the bolt puts the fire
// out (./weather-bridge.ts, and the suppression roll in onTick), which closes
// the loop rather than leaving fire as a thing only the player can end.
//
// THE PLAYER'S OWN TORCH is the other way a fire starts: a `fire:ignite`
// message, priced in mana, gated on the player's own unlocked view. It is what
// makes fire a TOOL rather than only a hazard.
//
// LIGHTNING is the other way fires start: weather picks the cell a bolt lands
// on, emits it, and this plugin rolls whether it caught (onWorldEvent below).
// Both causes arrive through `igniteAt`, which is the ONE place a fire is ever
// created — so the cap, the fuel lookup and the broadcast exist once and a new
// cause of fire cannot forget one of them.
//
// AND FIRE IS SOMETHING TO BE REACTED TO, not only a thing that reacts. Every
// ignition, from whatever cause, is announced as `fire:ignited` (../protocol.ts,
// and `inIgnitionBatch` below) so that the plugins that own the creatures in the
// world can startle what is standing near a new flame. Until that event existed
// this plugin emitted one line at the END of a wildfire and nothing else, and a
// herd would graze calmly beside a wall of flame (issue #184).
// ─────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE, type CellDiff } from '@terrace/shared';
// Type-only import of the plugin contract (fully erased at runtime), reaching
// into server/src exactly as every other plugin here does — core publishes no
// plugin-API entry point yet.
import type {
  PersistenceSlice,
  Player,
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  FIRE_BURNED_EVENT,
  FIRE_CELL_CAP,
  FIRE_CELLS_BURNED_OUT_EVENT,
  FIRE_CHANGES_MESSAGE,
  FIRE_ENTITY_CAP,
  FIRE_ENTITIES_MESSAGE,
  FIRE_FIRES_MESSAGE,
  FIRE_IGNITE_MESSAGE,
  FIRE_IGNITED_EVENT,
  FIRE_PLUGIN_NAME,
  parseIgnitePayload,
  fireEntityKey,
  packCells,
  packEntities,
  packFires,
  type FireCellState,
  type FireEntityState,
} from '../protocol.ts';
import { Blaze, type FuelCell } from './blaze.ts';
import { EntityBlaze } from './entityBlaze.ts';
import { clearEntityFuelRegistry, entityFuelAt, entityFuelSource } from './entityFuel.ts';
import { clearFuelRegistry, fuelAt, fuelSources } from './fuel.ts';
import { fireRandom, happensWithin } from './rng.ts';
import { resetSpreadSweep, SPREAD_INTERVAL_SECONDS, spreadOnce } from './spread.ts';
import { parseStruckCells } from './strike-event.ts';
import { chargeMana, loadManaBridge } from './mana-bridge.ts';
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
 * How many times a WALKING fire is re-anchored during its own life.
 *
 * WHY THE ENTITY SET NEEDS A CADENCE OF ITS OWN, AND WHY IT IS DERIVED
 * (bug, 2026-08-24: a burning grazer walked into view unburnt, then dropped
 * dead). A cell fire's visibility changes only when the PLAYER's view changes,
 * which is a discrete event this plugin is told about
 * (onChunkUnlockedForToken). A walking fire's visibility changes because THE
 * FIRE MOVED, and nothing tells anyone that — so the only repair it can have is
 * a re-send often enough that "you cannot see it yet" is never the last word for
 * long.
 *
 * FIRE_KEEPALIVE_SECONDS could not be that cadence, and the arithmetic is the
 * whole point: a creature burns for 8 s under a 10 s keepalive, so the repair
 * was scheduled for 2 s AFTER the animal was already dead and in the single-fire
 * case never arrived at all. Restating the keepalive as a smaller constant would
 * fix today's numbers and leave the next plugin free to register a 3 s burn and
 * silently reintroduce it.
 *
 * So the cadence is derived from the SHORTEST BURN ACTUALLY ALIGHT rather than
 * chosen: whatever a plugin declares, every walking fire is re-sent at least
 * this many times before it ends. FOUR is the smallest count that keeps a
 * repair on both sides of the halfway point of a burn — one before, one after —
 * and at the shipped 8 s creature burn it costs one small message every 2 s
 * while anything is alight, against a set capped at FIRE_ENTITY_CAP.
 */
const ENTITY_REPAIRS_PER_BURN = 4;

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
 * The things that are alight and WALKING — creatures, boats, anything whose
 * position is somebody else's business (./entityBlaze.ts). Kept beside `blaze`
 * rather than inside it because the two answer different questions; what they
 * share is the burn, and only the burn.
 */
const entityBlaze = new EntityBlaze();

/**
 * The live world, stashed at onWorldCreate so `igniteAt` can be called from
 * outside a hook — by the weather plugin's lightning, and later by the player's
 * own ignite intent. Null before the world exists, which doubles as the guard
 * for "something tried to light a fire before there was anywhere to put it".
 */
let currentWorld: WorldApi | null = null;

/** The admin panel's action key (PluginActionDeclaration). */
const IGNITE_ACTION = 'ignite';

/** Accumulated simulated seconds — this plugin's only clock. */
let simSeconds = 0;

/** Simulated time of the last full snapshot. */
let lastKeepaliveSeconds = 0;

/**
 * Simulated time of the last entity broadcast — a SEPARATE clock from the cell
 * keepalive above, and separate for a reason beyond its shorter period: it is
 * stamped inside `broadcastEntities` and nowhere else, so an idle tick can
 * never push it forward. The cell clock is re-armed while the world is quiet
 * (onTick's early-out), which is harmless for something that cannot move but
 * was fatal for something that can — it meant the first repair of a walking
 * fire was scheduled from the moment it was lit rather than from the last time
 * anyone was actually told about it.
 */
let lastEntityBroadcastSeconds = 0;

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
 * Most simulated seconds the spread step will ever owe.
 *
 * TWO INTERVALS, and the second one is the fix rather than slack (bug,
 * 2026-08-24): the debt has to be able to exceed one interval, or the remainder
 * of the step that just ran cannot survive to be carried into the next one, and
 * at any tick rate whose period does not sum exactly the fire loses that
 * remainder every single step. Bounded all the same, for the reason the old
 * one-interval clamp was written down: a server that stalls or resumes must not
 * bank an unbounded debt and then spread the fire across the world in one step.
 * One extra interval is all a carry can ever need.
 */
const MAX_SPREAD_DEBT_SECONDS = SPREAD_INTERVAL_SECONDS * 2;

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

/** Burning individuals restored from a snapshot, held until onWorldCreate. */
let restoredEntities: FireEntityState[] = [];

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
 * The whole burning-entity set, to everyone who can see any of it.
 *
 * VISIBILITY IS BY CURRENT POSITION, asked of the owner right now — a burning
 * animal that runs into a player's territory becomes visible to them at the
 * next send, and one that runs out stops being. An individual whose owner can
 * no longer place it is left out entirely rather than sent at a stale position.
 *
 * `skipEmpty: false`, for FIRE_SEND_EMPTY's reason exactly: this set SHRINKS,
 * and a client that is never told about the shrink keeps drawing a flame on an
 * animal that is no longer on fire.
 */
function broadcastEntities(world: WorldApi, onlyPlayerId: string | null = null): void {
  const positions = new Map<string, { x: number; y: number }>();
  for (const at of entityBlaze.positions()) {
    positions.set(fireEntityKey(at.sourceName, at.id), { x: at.x, y: at.y });
  }

  const placed = entityBlaze
    .entities()
    .filter((entity) => positions.has(fireEntityKey(entity.sourceName, entity.id)));

  world.broadcastVisible(
    FIRE_ENTITIES_MESSAGE,
    placed,
    (entity) => {
      const at = positions.get(fireEntityKey(entity.sourceName, entity.id))!;
      // Cell-space is fractional for a moving thing; visibility is asked per
      // CELL, so it is floored to the cell the creature is standing in.
      return { x: Math.floor(at.x), y: Math.floor(at.y) };
    },
    (visible) => packEntities(visible),
    onlyPlayerId === null ? FIRE_SEND_EMPTY : { skipEmpty: false, onlyPlayerId },
  );
  // A send to ONE player is a repair for that player, not for everybody, so it
  // must not reset the cadence everyone else is relying on.
  if (onlyPlayerId === null) lastEntityBroadcastSeconds = simSeconds;
}

/**
 * The entity set, to whoever holds this token — the walking half of
 * `refreshUnlockedChunk`.
 *
 * VISIBILITY-FILTERED PER PLAYER even though only one player is being written
 * to: the client REPLACES its whole set from this message (../protocol.ts), so
 * an unfiltered send would hand somebody every burning animal in the world.
 */
function refreshEntitiesForToken(world: WorldApi, token: string): void {
  for (const player of world.players()) {
    if (player.token === token) broadcastEntities(world, player.id);
  }
}

/**
 * How often the entity set is re-sent, in simulated seconds — derived from the
 * shortest burn currently alight (ENTITY_REPAIRS_PER_BURN).
 *
 * Never slower than the cell keepalive: a walking fire has strictly more ways
 * to go stale than a standing one, so it can never be the thing repaired least
 * often.
 */
function entityRepairIntervalSeconds(): number {
  const shortest = entityBlaze.shortestBurnSeconds();
  if (shortest === null) return FIRE_KEEPALIVE_SECONDS;
  return Math.min(FIRE_KEEPALIVE_SECONDS, shortest / ENTITY_REPAIRS_PER_BURN);
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
// ANNOUNCING THAT SOMETHING CAUGHT
//
// `fire:burned` says a wildfire is over. This says one began, and it is what
// lets any other plugin react to fire at all — before it, this plugin was wired
// as a source of one end-of-episode line and nothing else, so an animal could
// graze beside a wall of flame (issue #184).
//
// ONE EVENT PER BATCH, NOT PER IGNITION (../protocol.ts's FIRE_IGNITED_EVENT
// carries the reasoning). A batch is one entry into this plugin from outside:
// a tick, a torch message, a volley of bolts. `inIgnitionBatch` wraps each of
// them and flushes only as the OUTERMOST one unwinds, so the nested calls a
// torch makes (a cell and the animal standing on it) still produce exactly one
// event, and an ignition can never escape unannounced by taking a path nobody
// remembered to flush.
// ────────────────────────────────────────────────────────────────────────────

/** Nesting depth of `inIgnitionBatch`. The flush happens at 0. */
let ignitionBatchDepth = 0;

/**
 * Emits everything that caught since the last flush, if anything did.
 *
 * BOTH REGISTRIES INTO ONE LIST, cells first then individuals, which is a fixed
 * order rather than an incidental one: the consumers are sim code, and a list
 * whose order depended on which map happened to be drained first would make an
 * identical world tick differently on a replay (design § determinism).
 */
function announceIgnitions(world: WorldApi): void {
  const cells = blaze.takeIgnited();
  const entities = entityBlaze.takeIgnited();
  if (cells.length === 0 && entities.length === 0) return;

  const ignited: number[] = [];
  for (const at of cells) ignited.push(at.x, at.y);
  for (const at of entities) ignited.push(at.x, at.y);
  world.emitEvent(FIRE_IGNITED_EVENT, { ignited });
}

/**
 * Runs `body`, then announces whatever it set alight — once, however many
 * fires that was and however many nested ignite calls it took.
 *
 * The flush is in a `finally` so a throw partway through a tick still tells the
 * world about the fires that DID start before it: they are alight either way,
 * and a swallowed announcement would leave the world calmly grazing beside
 * them until the next batch happened to catch up.
 */
function inIgnitionBatch<T>(world: WorldApi, body: () => T): T {
  ignitionBatchDepth++;
  try {
    return body();
  } finally {
    ignitionBatchDepth--;
    if (ignitionBatchDepth === 0) announceIgnitions(world);
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

  return inIgnitionBatch(world, () => {
    const fire = blaze.ignite(x, y);
    if (fire === null) return false;

    broadcastChanges(world, [fire], []);
    return true;
  });
}

/**
 * Lights whatever MOVING thing is standing on this cell — the walking half of
 * `igniteAt` (./entityBlaze.ts). True when something caught.
 *
 * A separate entry point rather than a branch inside `igniteAt` because the two
 * have different callers and different meanings: a firebreak dug through a cell
 * puts out the cell's fire, and does nothing whatever to an animal that was
 * standing on it and has since run somewhere else.
 */
export function igniteEntityAt(x: number, y: number): boolean {
  const world = currentWorld;
  if (world === null) return false;

  return inIgnitionBatch(world, () => {
    const fire = entityBlaze.igniteAtCell(x, y);
    if (fire === null) return false;

    broadcastEntities(world);
    return true;
  });
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
  // THE EPISODE CLOSES WHERE THE SET EMPTIES, not where the tick happens to
  // look (bug, 2026-08-24). This path is called from outside onTick — a player
  // digging a firebreak arrives through onTerrainChanged — so when the trench
  // took the last burning cell, the tick that followed took its "nothing is
  // alight" early-out and returned above the end-of-episode check. No
  // `fire:burned` was ever emitted, the counter stayed open, and the NEXT
  // unrelated wildfire's cells were added to it and reported at the first
  // fire's origin. Beating a fire is the headline mechanic of this plugin; it
  // has to be the ending that most reliably gets its line.
  if (blaze.size === 0) endEpisode(world);
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
export {
  registerEntityFuel,
  unregisterEntityFuel,
  type EntityFuel,
  type EntityFuelSource,
} from './entityFuel.ts';

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
 * The same rain, on the things that are running around alight — asked at WHERE
 * EACH ONE IS NOW, not where it caught.
 *
 * Returns how many went out. A creature the rain saves is scorched and alive:
 * this is the extinguish path, so nothing is consumed and its owner is not
 * told, exactly as a rained-out tree is left standing.
 */
function suppressEntitiesWithRain(dt: number): number {
  const drenched: Array<{ sourceName: string; id: number }> = [];
  for (const at of entityBlaze.positions()) {
    const wetness = precipitationAt(Math.floor(at.x), Math.floor(at.y));
    if (wetness <= 0) continue;
    if (!happensWithin(RAIN_SUPPRESSION_RATE_PER_SECOND * wetness, dt)) continue;
    drenched.push({ sourceName: at.sourceName, id: at.id });
  }
  return entityBlaze.extinguish(drenched);
}

/**
 * Chance that a bolt landing on something flammable sets it alight.
 *
 * NOT 1, and the difference is the whole feel of the mechanic: most lightning
 * should be spectacle and some of it should be a disaster. A player who learns
 * that every bolt starts a fire stops watching storms and starts dreading them.
 *
 * THE ARITHMETIC IT LANDS AT, on a mature world: flora plants roughly one tree
 * per FLORA_CELLS_PER_TREE (4) eligible cells (retuned down twice, 2026-08-25,
 * owner asked for a visibly fuller forest), so a bolt aimed by height alone
 * (weather/server/lightning.ts) crosses treed ground more often than it used
 * to and LIGHTNING_IGNITION_CHANCE now starts fires proportionally more often —
 * an accepted knock-on of wanting denser woodland. Rare enough to be an event,
 * common enough that a long game sees several.
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
    // ONE ROLL, BOTH REGISTRIES. The roll is about the BOLT — whether this
    // strike started a fire at all — not about what happened to be standing
    // under it, so a bolt that lands on an animal in a wood lights both, and a
    // second roll would make being struck twice as survivable for a grazer as
    // for the tree it is sheltering under.
    igniteAt(cell.x, cell.y);
    igniteEntityAt(cell.x, cell.y);
  }
}

/**
 * What it costs a player to light a fire, in mana.
 *
 * Priced against what mana ALREADY buys, not invented: MANA_COST_PER_MIN_RADIUS_SCULPT
 * is what the smallest possible terrain edit costs, and a fire is worth several
 * of those — it is the cheapest way in the game to destroy a large number of
 * things, and a torch that cost less than moving one cell of dirt would make
 * every other tool pointless. 60 puts it at a few percent of MANA_CAPACITY: a
 * deliberate act, several times a session, never a reflex.
 *
 * It lives HERE and not in mana, which holds the ledger and no opinion about
 * prices (see mana's spendMana): fire owns what fire costs.
 */
export const IGNITE_MANA_COST = 60;

/**
 * A player asked to light a cell.
 *
 * THE ORDER IS LOAD-BEARING — every reason the fire could fail is checked
 * BEFORE the player is charged, so there is never a debit to undo:
 *
 *   1. VISIBILITY. A player may only light ground they have personally
 *      unlocked. Without this, the message is a way to set fire to a rival's
 *      territory from across a fogged world, and to probe what is out there by
 *      watching what catches.
 *   2. ALREADY ALIGHT. Lighting a fire that is already burning would be paying
 *      for nothing at all.
 *   3. THE CAP. FIRE_CELL_CAP is checked here rather than left to
 *      `Blaze.ignite`, because a world already burning at its ceiling is not
 *      the player's fault and must not cost them anything.
 *   4. FUEL. Bare rock and open water do not catch. Charging for a fire that
 *      could never start is the phantom-debit bug mana was already bitten by
 *      once (2026-08-19).
 *   5. PAYMENT, and only then the fire — which cannot now decline, because
 *      every reason it could has just been ruled out, synchronously, in this
 *      same tick. THAT is why there is no refund path: the way to never owe a
 *      refund is to never charge for something that can still fail.
 *
 * Silence is the answer to every refusal. There is no `fire:denied` message,
 * because the client predicts nothing about a fire it asked for: it draws only
 * what the server broadcasts, so "nothing caught" needs no correction — unlike
 * a sculpt, where the client has already moved the ground locally.
 */
function onIgniteRequest(world: WorldApi, player: Player, payload: unknown): void {
  const request = parseIgnitePayload(payload);
  if (request === null) return;
  if (request.x >= world.worldSize || request.y >= world.worldSize) return;
  if (!world.isCellVisibleTo(player.id, request.x, request.y)) return;

  // WHAT WOULD CATCH, decided in full BEFORE a single mana is spent — the same
  // no-refund rule as before, now over two registries. Both are asked, because
  // a torch put to a cell lights what is THERE: the wood, and the animal
  // standing in it. One payment either way; a player who happened to catch a
  // grazer under the tree they were aiming at has not bought anything extra,
  // they have set fire to the same patch of world.
  const cellCatches =
    !blaze.isBurning(request.x, request.y) &&
    blaze.size < FIRE_CELL_CAP &&
    fuelAt(request.x, request.y) !== null;

  const standing = entityFuelAt(request.x, request.y, (sourceName, id) =>
    entityBlaze.isBurning(sourceName, id),
  );
  const entityCatches = standing !== null && entityBlaze.size < FIRE_ENTITY_CAP;

  if (!cellCatches && !entityCatches) return;
  if (!chargeMana(world, player.id, IGNITE_MANA_COST)) return;

  // ONE BATCH FOR THE PAIR: the wood and the animal standing in it caught from
  // one click, at one place, and the world should hear about it once.
  inIgnitionBatch(world, () => {
    if (cellCatches) igniteAt(request.x, request.y);
    if (entityCatches) igniteEntityAt(request.x, request.y);
  });
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
  // VERSION 1, AND IT HAS ALWAYS BEEN 1 — see boats' slice for why the number
  // appears now: the host's envelope gives an unversioned format a version
  // without changing the stored shape. Every field below is read defensively,
  // which is what made living without one survivable until now.
  version: 1,
  save(): unknown {
    return { fires: blaze.entries(), entities: entityBlaze.entities() };
  },

  // `fromVersion` is unread: 1 is the only version, and the host parks anything
  // higher before this is called.
  load(data: unknown): void {
    restoredFires = [];
    restoredEntities = [];
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

    // A snapshot written before fire could burn anything that walks has no
    // `entities` key at all, and that is not a corrupt slice — it is an older
    // world, which restores with nothing alight and is exactly right.
    const entities = (data as { entities?: unknown }).entities;
    if (!Array.isArray(entities)) return;
    for (const entry of entities) {
      if (typeof entry !== 'object' || entry === null) continue;
      // A world saved before 2026-09-02 also carries a `fuelHeight` per entity;
      // it is ignored rather than rejected — the size now comes from the
      // client that draws the body (../protocol.ts's FireEntityState).
      const entity = entry as Partial<FireEntityState>;
      if (
        typeof entity.sourceName !== 'string' ||
        typeof entity.id !== 'number' ||
        typeof entity.ageSeconds !== 'number' ||
        typeof entity.burnSeconds !== 'number'
      ) {
        continue;
      }
      restoredEntities.push({
        sourceName: entity.sourceName,
        id: entity.id,
        ageSeconds: entity.ageSeconds,
        burnSeconds: entity.burnSeconds,
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
    entityBlaze.restore(restoredEntities);
    restoredEntities = [];

    // THE CROSS-PLUGIN DEPENDENCY PATTERN, read-direction (./weather-bridge.ts):
    // the host says who is running as weather in THIS world. On a world with no
    // weather plugin — or one where the operator switched it off — the air is
    // still and spread is isotropic.
    loadWeatherBridge(world);
    // The economy, on the same terms: on a world with no mana plugin running,
    // lighting a fire is free (./mana-bridge.ts).
    loadManaBridge(world);

    // ANNOUNCE WHAT WAS RESTORED, unconditionally — including "nothing"
    // (bug, 2026-08-24). This hook runs again on a live world when an operator
    // rolls back, and every client is still drawing whatever was burning at the
    // moment they were last told. Restoring a set is silent by design
    // (./blaze.ts's restore contract), the world-switch path re-announces per
    // player and the rollback path does not, and if the restored world happens
    // to be quiet then onTick's early-out means the keepalive that exists for
    // exactly this repair can never run. So the one send that costs a rolled-
    // back world two small messages is made here, where the set changed.
    broadcastSnapshot(world);
    broadcastEntities(world);
  },

  /**
   * THE REGISTRIES BELONG TO THE WORLD THAT FILLED THEM (issue #208).
   *
   * WHY FIRE CLEARS THEM AND NOT ONLY THE REGISTRANTS. `./fuel.ts` and
   * `./entityFuel.ts` hold their sources at MODULE scope, so without this a
   * registry is the one thing in the session that no close path could empty:
   * every source is pushed in from a sibling's `onWorldCreate`, and a sibling
   * that is not enabled for the next world never gets one to withdraw itself
   * in. Each bridge now withdraws its own registration too, which is the fix
   * that scales to a plugin this repo has not seen; this is the half that does
   * not depend on the registrant having been written correctly.
   *
   * SAFE TO CLEAR WHOLESALE because every registration in the repo is made
   * from an `onWorldCreate` and replayed there on every reopen and rollback
   * (each fire-bridge's `loadFireBridge`), so the next world rebuilds exactly
   * the set of sources that is actually running in it — which is the set fire
   * should have been asking all along.
   */
  onWorldClose(): void {
    clearFuelRegistry();
    clearEntityFuelRegistry();
  },

  /**
   * ONE BATCH PER TICK. A spreading front lights many cells and may light
   * several creatures in the same step, and every one of them is the same
   * moment of the same fire — see `inIgnitionBatch`.
   */
  onTick(world: WorldApi, dt: number): void {
    inIgnitionBatch(world, () => tick(world, dt));
  },

  // THE ADMIN PANEL'S DEBUG SPAWN (server plugins/types.ts,
  // PluginActionDeclaration): `igniteAt`, the one way a fire ever starts, so
  // a forced fire is a lightning strike's in everything but its cause.
  // Groups this plugin's cards in the admin panel; see TerracePlugin.archetype.
  archetype: 'terrain',
  actions: [
    {
      key: IGNITE_ACTION,
      label: 'Light a fire',
      description: 'Sets the cell you are looking at alight, if there is anything there to burn.',
    },
  ],

  onAction(_world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== IGNITE_ACTION) return { ok: false, detail: `no such action "${key}"` };
    if (igniteAt(site.x, site.y)) return { ok: true, detail: `(${site.x}, ${site.y}) is alight` };
    return {
      ok: false,
      detail:
        `nothing caught at (${site.x}, ${site.y}) — nothing flammable there (bare rock, water), ` +
        `already burning, or ${FIRE_CELL_CAP} fires are already burning`,
    };
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

  onWorldEvent(world: WorldApi, event: string, payload: unknown): void {
    // By-name subscription (server/src/plugins/types.ts's emitEvent doc
    // comment): the emitting plugin's name is the coupling, exactly like a wire
    // message namespace — never an import of its code. A world with no
    // thunderstorm plugin simply never sees this event, and nothing here fires.
    //
    // `thunderstorm`, not `weather`, since 2026-09-02: the weather plugin was
    // split and lightning moved to the kind that has it (#283). The payload is
    // unchanged, which is why only this string moved.
    if (event !== 'thunderstorm:strikes') return;
    const struck = parseStruckCells(payload);
    if (struck === null) return;
    // ONE BATCH FOR THE WHOLE VOLLEY — a squall lands several bolts in one
    // event and they are one weather moment, not eight.
    inIgnitionBatch(world, () => igniteStruckCells(struck));
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
    // The walking fires are sent to EVERYONE rather than to the joiner alone:
    // this set is broadcast whole, and it is small. Filtering it per recipient
    // would be a second code path for a message that is a handful of bytes.
    broadcastEntities(world);
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
    // The walking fires too: a chunk that comes into view may already have a
    // burning animal standing in it, and the cadence above is a repair, not a
    // reason to make a player wait for one.
    if (entityBlaze.size > 0) refreshEntitiesForToken(world, token);
  },

  messages: {
    [FIRE_IGNITE_MESSAGE]: onIgniteRequest,
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
  restoredEntities = [];
  blaze.clear();
  entityBlaze.clear();
  // Spread remembers where everything was one step ago and how much heat every
  // thing in reach of a flame has taken on (./spread.ts, ./heat.ts). After a
  // reset or a rollback both are memories of a world that no longer exists: the
  // segment from there to here is a path nothing walked, and a target that was
  // nearly alight there must not catch instantly here.
  resetSpreadSweep();
}


/**
 * THE SIM STEP, lifted out of the plugin object so that `onTick` is nothing
 * but the ignition batch this whole step has to run inside — see
 * `inIgnitionBatch`. Nothing else about it changed.
 */
function tick(world: WorldApi, dt: number): void {
  simSeconds += dt;

  // A world with nothing alight costs two comparisons per tick. Everything
  // below — the advance, the keepalive, the empty snapshot FIRE_SEND_EMPTY
  // exists for — is work that only a burning world pays for.
  //
  // BELT AND SUSPENDERS ON THE EPISODE: `extinguishAt` already closes it at
  // the moment it empties the set, and this catches any future path that
  // empties it without saying so. `endEpisode` is a no-op when nothing was
  // consumed, so a quiet world still pays only the comparisons.
  if (blaze.size === 0 && entityBlaze.size === 0) {
    if (episodeConsumed > 0) endEpisode(world);
    lastKeepaliveSeconds = simSeconds;
    // Spread does not run in a quiet world, so its memory of "where was
    // everything one step ago" would span the whole quiet stretch the next
    // time something catches. Dropping it here is what keeps that memory one
    // spread interval old, which is the only age its arithmetic is true for
    // (./spread.ts). The same call drops the accumulated heat, which is right
    // for the same reason: nothing was being heated during the quiet stretch.
    // A no-op once both are empty, so a quiet world still pays only the
    // comparisons.
    resetSpreadSweep();
    return;
  }

  const { burnedOut, stopped } = blaze.advance(dt);

  // CONSUME THE FUEL BEFORE ANYTHING SPREADS. This order is load-bearing, not
  // tidiness (found by a headless run, 2026-08-24): `advance` has just taken
  // the burned-out cells out of the burning set, so until their source is told
  // to destroy what was there, the registry still answers "there is a tree
  // here" for a cell that is now neither burning nor standing. Spreading first
  // let a neighbour RE-LIGHT the cell that had just burned to nothing — 47 of
  // 256 trees in a test wood burned twice, and every one of those second fires
  // reported another tree consumed that never existed.
  //
  // Each finished fire goes back to the plugin whose stuff it consumed; that
  // source destroys what was there and broadcasts its own change. This plugin
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
    // EVERY BURNED-OUT CELL, REGARDLESS OF SOURCE (issue #297), for the
    // consumers the per-source routing above cannot reach: a source's
    // `onBurnedOut` names only its OWN cells, but flora's scorch record is
    // keyed on the GROUND, so the cell a structure burned on needs scorching
    // even though structures owned the burn. AFTER every onBurnedOut call,
    // for the CONSUME-BEFORE-SPREAD block's own reason: the sources have
    // destroyed what was there first, so a listener reads the world as it is
    // now rather than as it was mid-tick. Skipped when nothing burned out —
    // this whole block only runs then. Order is `burnedOut`'s own insertion
    // order — the order `advance` retired the cells in — which is fixed, not
    // incidental (design § determinism).
    const burnedOutCells: FuelCell[] = [];
    for (const cells of burnedOut.values()) burnedOutCells.push(...cells);
    world.emitEvent(FIRE_CELLS_BURNED_OUT_EVENT, { cells: packCells(burnedOutCells) });
  }

  // THE WALKING FIRES, advanced on the same clock as the cells and routed the
  // same way: each source is told which of ITS individuals died of it and
  // destroys them itself, and this plugin touches nobody else's state.
  //
  // AFTER the cell burnouts above, for that block's own reason applied to
  // creatures: a source asked to destroy an animal has to be asked while it
  // still has it, and it must not be asked twice.
  const walking = entityBlaze.advance(dt);
  let entitiesChanged = walking.changed;
  if (walking.burnedOut.size > 0) {
    for (const [sourceName, ids] of walking.burnedOut) {
      const source = entityFuelSource(sourceName);
      if (source === null || ids.length === 0) continue;
      source.onBurnedOut(ids);
      // NOT counted into the wildfire episode: the episode is a story about
      // how much of the WORLD burned (chronicle's "a fire took forty trees"),
      // and folding animals into that count would make the sentence a lie
      // about trees. What burning livestock deserves is its own line, which
      // is a chronicle change, not a change to this counter.
    }
  }
  if (suppressEntitiesWithRain(dt) > 0) entitiesChanged = true;

  // SPREAD, on its own cadence. Accumulated rather than run every tick, and
  // capped at one interval so a stalled or resumed server cannot bank an
  // unbounded debt and then spread the fire across the world in one step —
  // flora's scanCredit is capped for the same reason.
  spreadDebtSeconds = Math.min(spreadDebtSeconds + dt, MAX_SPREAD_DEBT_SECONDS);
  let ignited: FireCellState[] = [];
  let drenched: FuelCell[] = [];
  while (spreadDebtSeconds >= SPREAD_INTERVAL_SECONDS) {
    // RAIN BEFORE SPREAD, so a fire the rain has just put out does not get to
    // throw one last spark on its way out. The two share a cadence because
    // they are two halves of one question — where is the fire a second from
    // now — and evaluating them on different clocks would let a fire spread
    // from a cell it was extinguished on.
    // THE INTERVAL, NOT THE DEBT, is what the rate functions are charged —
    // and the remainder is CARRIED rather than dropped (bug, 2026-08-24).
    // `dt` at the shipped 10 Hz is 0.1, which is not representable in binary:
    // ten of them sum to 0.9999999999999999, so the step fired on the
    // eleventh tick having covered 1.1 s, was charged 1.0 s, and threw the
    // rest away. Fires spread and rain suppressed ~10% slower than their
    // stated per-second rates, and by an amount that depended on TICK_HZ —
    // precisely what handing the elapsed interval to the rate arithmetic is
    // supposed to prevent.
    drenched = [...drenched, ...suppressWithRain(SPREAD_INTERVAL_SECONDS)];
    // BOTH REGISTRIES IN ONE STEP: a flame reaches whatever is near it, and
    // whether that is a cell or something walking is not the flame's business
    // (./spread.ts's header). A caught individual is a change to the entity
    // set exactly as a torched one is, so it rides the same broadcast.
    const spread = spreadOnce(world, blaze, entityBlaze, SPREAD_INTERVAL_SECONDS);
    ignited = [...ignited, ...spread.cells];
    if (spread.entities.length > 0) entitiesChanged = true;
    spreadDebtSeconds -= SPREAD_INTERVAL_SECONDS;
  }

  const ended = drenched.length > 0 ? [...stopped, ...drenched] : stopped;
  if (ignited.length > 0 || ended.length > 0) broadcastChanges(world, ignited, ended);
  // THE WHOLE SET on any change (../protocol.ts): a burning herd is small
  // enough that a delta would save bytes nobody is short of, and a full set
  // cannot leave a client drawing a flame on an animal that stopped burning.
  if (entitiesChanged) broadcastEntities(world);

  // The world just stopped burning: whatever that fire was, it is over.
  if (blaze.size === 0) endEpisode(world);

  if (simSeconds - lastKeepaliveSeconds >= FIRE_KEEPALIVE_SECONDS) {
    broadcastSnapshot(world);
  }

  // THE WALKING FIRES RE-ANCHOR ON THEIR OWN, FASTER CADENCE — see
  // ENTITY_REPAIRS_PER_BURN. They used to share the cell keepalive, which is
  // longer than a creature burns, so the one repair that could have told a
  // player about an animal that walked into their view was scheduled for
  // after the animal was dead.
  if (
    entityBlaze.size > 0 &&
    simSeconds - lastEntityBroadcastSeconds >= entityRepairIntervalSeconds()
  ) {
    broadcastEntities(world);
  }
}