// hydro — the player pours water.
//
// Core knows nothing about water on the ground, and this plugin knows nothing
// about fire or about terrain. It owns exactly one mechanic: a small set of
// cells that are WET, each wet by an amount that is a pure function of how long
// ago it was poured (../protocol.ts). Everything the water DOES is done by
// somebody else, reached through a bridge:
//
//   THE DOUSE   hydro joins weather's sky-kind union (./weather-bridge.ts), so
//               poured water is a wetting kind of sky. fire's own suppression
//               roll then puts fires out through `precipitationAt`, unedited
//               and unaware that a fifth kind exists.
//   THE SLIDE   a patch that has soaked long enough asks mudslides to collapse
//               its cell (./mudslides-bridge.ts). mudslides decides whether the
//               ground is steep enough and mudslides moves it, through its own
//               guarded `WorldApi.sculpt`. THIS PLUGIN MOVES NO TERRAIN.
//
// ─────────────────────────────────────────────────────────────────────────────
// SOAK, THEN SLIDE — not pour, then slide.
//
// The delay is the feature, not a limitation of it. A hillside that lets go on
// the frame the bucket lands turns the tool into a landslide button with a
// water-coloured icon; a hillside that lets go HYDRO_SLIDE_SOAK_SECONDS later
// reads as the water having gone into the ground, which is what the player
// actually did. It is also what makes the two halves of the tool one tool: the
// same patch that is putting a fire out for those seconds is what is loosening
// the hill under it.
//
// ─────────────────────────────────────────────────────────────────────────────
// A PATCH IS SENT ONCE, NOT STREAMED (../protocol.ts). The client runs its age
// forward on its own clock, and the keepalive re-anchors it — which is the
// whole reason this feature costs a few hundred bytes.
//
// FOG OF WAR. Every send is per recipient (WorldApi.broadcastVisible), and like
// fire this plugin CANNOT use `skipEmpty` on its snapshot: water DRIES, so an
// empty snapshot is a correction and not silence. See HYDRO_SEND_EMPTY.

import { SEA_LEVEL } from '@terrace/shared';
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
  HYDRO_CHANGES_MESSAGE,
  HYDRO_PATCHES_MESSAGE,
  HYDRO_PATCH_CAP,
  HYDRO_PATCH_RADIUS_CELLS,
  HYDRO_PATCH_SECONDS,
  HYDRO_PLUGIN_NAME,
  HYDRO_POUR_MESSAGE,
  hydroWetness,
  packCells,
  packPatches,
  parsePourPayload,
  type HydroPatchState,
} from '../protocol.ts';
import { Puddles, type DriedCell, type StoredPatch } from './patches.ts';
import { chargeMana, clearManaBridge, loadManaBridge } from './mana-bridge.ts';
import {
  clearMudslidesBridge,
  loadMudslidesBridge,
  requestSlide,
} from './mudslides-bridge.ts';
import {
  loadWeatherBridge,
  registerWithHub,
  unregisterFromHub,
  type SkyCell,
} from './weather-bridge.ts';

/**
 * How many times a patch is re-anchored during its own life.
 *
 * FOUR, which is fire's ENTITY_REPAIRS_PER_BURN and its argument: a repair
 * cadence longer than the thing it repairs never repairs anything, and four is
 * the smallest count that puts a re-anchor on both sides of the halfway point
 * of a patch's life — one while it is still at full strength, one while it is
 * drying.
 */
const HYDRO_REPAIRS_PER_PATCH = 4;

/**
 * Simulated seconds between unsolicited re-broadcasts of the whole wet set.
 *
 * DERIVED rather than chosen, so it cannot drift from the life it exists to
 * bound: ten seconds at the shipped HYDRO_PATCH_SECONDS of 40. It re-anchors
 * the CLIENT'S CLOCK — a patch's age advances locally between messages
 * (../protocol.ts) — so drift is bounded by this rather than by a whole
 * patch's worth. It costs a hundred bytes per client only while there is water
 * somewhere in the world; on a dry world `broadcastVisible` is never called at
 * all (see the guard in `tick`).
 */
export const HYDRO_KEEPALIVE_SECONDS = HYDRO_PATCH_SECONDS / HYDRO_REPAIRS_PER_PATCH;

/**
 * `skipEmpty: false` — the snapshot always sends, empty or not.
 *
 * fire's FIRE_SEND_EMPTY, for its reason exactly: this set SHRINKS. If a client
 * holds a patch and the next snapshot it would receive is empty, "send nothing"
 * leaves that water on their screen forever, and the keepalive — the very
 * mechanism meant to repair that — becomes the thing that hides it.
 */
const HYDRO_SEND_EMPTY = { skipEmpty: false } as const;

/**
 * The DELTA may skip empties, unlike the snapshot above: a delta names cells
 * that changed, so a recipient whose subset of it is empty saw none of those
 * cells change and has nothing to correct. It is only the SNAPSHOT's emptiness
 * that is load-bearing.
 */
const HYDRO_SKIP_EMPTY = { skipEmpty: true } as const;

/**
 * What it costs a player to pour water, in mana.
 *
 * PRICED AGAINST WHAT THE ACT IS WORTH IN THE GAME, which is the argument fire
 * makes for IGNITE_MANA_COST (60) and not the number: a price says what a thing
 * is worth, not what another plugin happens to charge. Three constraints fix
 * this one, against mana's own published figures (plugins/mana/server/index.ts:
 * the smallest sculpt a player can make costs 6, the largest costs 222, and a
 * full pool is 666):
 *
 *   * BELOW A TORCH. Starting a fire and putting one out must not cost the
 *     same. A torch lights an entire front for one payment and the fire spreads
 *     itself for free; water spreads nowhere, so a symmetric price would make
 *     arson strictly cheaper than firefighting and the player who did not start
 *     the fire would pay the arsonist's price, repeatedly, to end it.
 *   * FAR ABOVE THE SMALLEST SCULPT. A pour reaches HYDRO_PATCH_RADIUS_CELLS
 *     and, on a rim, asks mudslides to move more ground than the largest brush
 *     a player owns (222) — for free, with no brush and at any range they can
 *     see. Water priced near a point stamp would be the cheapest earth-moving
 *     tool in the game by two orders of magnitude, and every other tool would
 *     stop being worth holding.
 *   * WHAT A FULL POOL BUYS. 666 / 40 = 16 pours, which is more than the
 *     HYDRO_PATCH_CAP of 12 — so a player who has been saving can lay their
 *     whole firebreak in one go and still have something left, and one who has
 *     been sculpting cannot.
 *
 * It lives HERE and not in mana, which holds the ledger and no opinion about
 * prices: hydro owns what hydro costs.
 */
export const POUR_MANA_COST = 40;

/**
 * How long a patch must have been wetting its cell before it asks mudslides to
 * bring that cell down, in simulated seconds — hydro's own saturation.
 *
 * SIX, and every bound on it is a ratio rather than a taste:
 *
 *   * IT MUST BE REACHED. A patch holds full strength for
 *     HYDRO_PATCH_SECONDS × (1 − HYDRO_DRYING_FRACTION) = 18 s, so at 6 s a
 *     single pour always gets there with room to spare, and no player has to
 *     learn to pour twice.
 *   * IT MUST BE SEEN. The click and the collapse have to read as cause and
 *     effect, which means far enough apart to be two events and close enough
 *     together that the player has not moved on. Six seconds is about the time
 *     it takes to line up the next pour.
 *   * IT IS DELIBERATELY NOT MUDSLIDES' OWN MUDSLIDE_SATURATION_SECONDS (90).
 *     That figure is how long a hillside takes to saturate under a storm that
 *     was never aimed at it — ambient weather, sampled across a whole world. A
 *     player pouring a bucket at one cell IS aiming, and making them hold the
 *     cursor there for a minute and a half would not be a slower version of the
 *     same feature; it would be no feature.
 *
 * ONE QUESTION PER PATCH. `Puddles.takeSoakedCells` marks a patch asked as it
 * hands it over, so a pour on gentle ground asks once and is water thereafter —
 * see ./patches.ts's `askedForSlide`.
 */
export const HYDRO_SLIDE_SOAK_SECONDS = 6;

// NOTE ON THE OTHER THRESHOLD — HOW STEEP IS STEEP ENOUGH. There is no hydro
// constant for it, on purpose. mudslides' `slopeAt` already answers it with two
// thresholds that are fractions of the steepest gradient the terrain sim can
// hold (MUDSLIDE_RIM_DROP and MUDSLIDE_TRIGGER_DROP, plugins/mudslides/
// protocol.ts), and `startSlide` refuses on ground that fails either. A number
// here would be a second opinion about the same word, and the two would drift
// the first time either side was re-tuned. See ./mudslides-bridge.ts.

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching every other plugin here:
// the host constructs one plugin instance per server process.

const puddles = new Puddles();

/** Accumulated simulated seconds — this plugin's only clock. */
let simSeconds = 0;

/** Simulated time of the last full snapshot. */
let lastKeepaliveSeconds = 0;

/**
 * Patches restored from a snapshot, held until onWorldCreate.
 *
 * The host restores persistence BEFORE it creates the world, so load() runs
 * when there is no world to validate against — fire parks its fires the same
 * way and for the same reason.
 */
let restoredPatches: StoredPatch[] = [];

// ────────────────────────────────────────────────────────────────────────────
// Wire
// ────────────────────────────────────────────────────────────────────────────

/** A patch's own cell — what broadcastVisible gates visibility by. */
function patchPosition(patch: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return { x: patch.x, y: patch.y };
}

function broadcastSnapshot(world: WorldApi, onlyPlayerId: string | null = null): void {
  world.broadcastVisible(
    HYDRO_PATCHES_MESSAGE,
    puddles.patches(),
    patchPosition,
    (visible) => ({ patches: packPatches(visible) }),
    onlyPlayerId === null ? HYDRO_SEND_EMPTY : { skipEmpty: false, onlyPlayerId },
  );
  // A send to ONE player is a repair for that player, not for everybody, so it
  // must not reset the cadence everyone else is relying on.
  if (onlyPlayerId === null) lastKeepaliveSeconds = simSeconds;
}

/**
 * One entry of a `hydro:changes` delta. The two halves carry different payloads
 * (a whole patch vs. a bare cell), so they are tagged rather than merged —
 * fire's TaggedFireChange, for its reason: one `broadcastVisible` pass has to
 * visibility-test both halves together.
 */
type TaggedPatchChange =
  | { readonly kind: 'poured'; readonly patch: HydroPatchState }
  | { readonly kind: 'dried'; readonly cell: DriedCell };

function broadcastChanges(
  world: WorldApi,
  poured: readonly HydroPatchState[],
  dried: readonly DriedCell[],
): void {
  if (poured.length === 0 && dried.length === 0) return;

  const tagged: TaggedPatchChange[] = [
    ...poured.map((patch): TaggedPatchChange => ({ kind: 'poured', patch })),
    ...dried.map((cell): TaggedPatchChange => ({ kind: 'dried', cell })),
  ];
  world.broadcastVisible(
    HYDRO_CHANGES_MESSAGE,
    tagged,
    (change) =>
      change.kind === 'poured' ? patchPosition(change.patch) : patchPosition(change.cell),
    (visible) => ({
      poured: packPatches(
        visible
          .filter((c): c is Extract<TaggedPatchChange, { kind: 'poured' }> => c.kind === 'poured')
          .map((c) => c.patch),
      ),
      dried: packCells(
        visible
          .filter((c): c is Extract<TaggedPatchChange, { kind: 'dried' }> => c.kind === 'dried')
          .map((c) => c.cell),
      ),
    }),
    HYDRO_SKIP_EMPTY,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// The sky-kind entry — what makes poured water weather (./weather-bridge.ts)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Every patch as a disc in the sky, for the consumers that want the masses
 * themselves rather than a wetness (weather's `livingSystems`).
 *
 * A PUDDLE IS A DISC LIKE ANY OTHER, and its intensity is the wetness at its
 * CENTRE — the falloff to its rim is HYDRO_PATCH_RADIUS_CELLS's business and
 * the same for every patch, which is exactly the shape a SkyCell describes.
 */
function skyCells(): readonly SkyCell[] {
  return puddles.patches().map((patch) => ({
    x: patch.x,
    y: patch.y,
    radius: HYDRO_PATCH_RADIUS_CELLS,
    intensity: hydroWetness(patch.ageSeconds),
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// The player's own bucket
// ────────────────────────────────────────────────────────────────────────────

/**
 * A player asked to pour water on a cell.
 *
 * THE ORDER IS LOAD-BEARING — every reason the pour could fail is checked
 * BEFORE the player is charged, so there is never a debit to undo. It is
 * fire's `onIgniteRequest` order, with its own fourth test:
 *
 *   1. BOUNDS. A cell outside the world is not a cell.
 *   2. VISIBILITY. A player may only pour on ground they have personally
 *      unlocked. Without this the message is a way to collapse a rival's
 *      hillside from across a fogged world, and to probe what is out there by
 *      watching what slides.
 *   3. THE CAP. Checked here as well as in `Puddles.pour` — a world already at
 *      HYDRO_PATCH_CAP evicts its driest patch rather than refusing, so this is
 *      not a refusal path but the place the fact is stated; see below.
 *   4. CAN THIS GROUND TAKE WATER. Two ways it cannot: it is already water (at
 *      or below SEA_LEVEL — pouring a bucket into the sea is the clearest case
 *      of paying for nothing there is), or it is already at full strength
 *      (`Puddles.canTakeWater`, which is fire's "already alight" test).
 *   5. PAYMENT, and only then the water — which cannot now decline, because
 *      every reason it could has just been ruled out, synchronously, in this
 *      same tick. THAT is why there is no refund path: the way to never owe a
 *      refund is to never charge for something that can still fail.
 *
 * ON THE CAP, AND WHY IT IS NOT A REFUSAL. HYDRO_PATCH_CAP is a budget for the
 * ground shader, not a game rule (../protocol.ts), so a player at the ceiling
 * loses their OLDEST puddle rather than their pour. The pour therefore cannot
 * fail on the cap and the payment stays honest — what they bought is water on
 * the cell they clicked, which is what they got.
 *
 * Silence is the answer to every refusal. There is no `hydro:denied` message,
 * because the client predicts nothing about a pour: it draws only what the
 * server broadcasts, so "nothing landed" needs no correction.
 */
function onPourRequest(world: WorldApi, player: Player, payload: unknown): void {
  const request = parsePourPayload(payload);
  if (request === null) return;
  if (request.x >= world.worldSize || request.y >= world.worldSize) return;
  if (!world.isCellVisibleTo(player.id, request.x, request.y)) return;

  if (world.heightAt(request.x, request.y) <= SEA_LEVEL) return;
  if (!puddles.canTakeWater(request.x, request.y)) return;

  if (!chargeMana(world, player.id, POUR_MANA_COST)) return;

  const poured = puddles.pour(request.x, request.y);
  // Unreachable — `canTakeWater` above is `pour`'s only refusal — but the pour
  // is the thing the player has just paid for, so it is checked rather than
  // asserted: a future refusal added to `pour` must not become a silent debit.
  if (poured === null) return;

  broadcastChanges(
    world,
    [poured.patch],
    poured.evicted === null ? [] : [poured.evicted],
  );
}

/**
 * Asks mudslides to collapse every patch that has soaked long enough.
 *
 * ONE ASK PER PATCH, drained rather than read (./patches.ts's
 * `takeSoakedCells`), so a patch on ground mudslides will not have asks once
 * and is water for the rest of its life. A refusal — no mudslides plugin,
 * gentle ground, or the world already at MAX_ACTIVE_SLIDES — is silent, for
 * `onPourRequest`'s reason: the client predicted nothing.
 */
function askForSlides(world: WorldApi): void {
  for (const cell of puddles.takeSoakedCells(HYDRO_SLIDE_SOAK_SECONDS)) {
    if (requestSlide(world, cell.x, cell.y)) {
      console.info(`[hydro] water at (${cell.x}, ${cell.y}) brought the hillside down`);
    }
  }
}

/**
 * THE SIM STEP.
 *
 * A dry world costs one comparison per tick. Everything below — the ageing, the
 * slide question, the keepalive that HYDRO_SEND_EMPTY exists for — is work only
 * a wet world pays for.
 */
function tick(world: WorldApi, dt: number): void {
  simSeconds += dt;

  if (puddles.size === 0) {
    lastKeepaliveSeconds = simSeconds;
    return;
  }

  const dried = puddles.advance(dt);
  if (dried.length > 0) broadcastChanges(world, [], dried);

  // AFTER the ageing, so a patch's soak is measured against the age the client
  // has just been told about rather than one tick behind it.
  askForSlides(world);

  if (simSeconds - lastKeepaliveSeconds >= HYDRO_KEEPALIVE_SECONDS) {
    broadcastSnapshot(world);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

/**
 * Water survives a restart, ages and all.
 *
 * Dropping it was rejected once the consequence was written down: a snapshot
 * taken while a firebreak was holding would restore the world with the fire
 * intact and the water gone, so a server restart would become a way to burn
 * down ground somebody had just saved. Persisting the AGE (rather than
 * restarting the patch) matters in the other direction for the same reason: a
 * restart must not hand a nearly-dry patch a fresh full life, and must not
 * re-arm the slide question a patch has already asked.
 */
const persistence: PersistenceSlice = {
  version: 1,
  save(): unknown {
    return { patches: puddles.entries() };
  },

  // `fromVersion` is unread: 1 is the only version, and the host parks anything
  // higher before this is called.
  load(data: unknown): void {
    restoredPatches = [];
    if (typeof data !== 'object' || data === null) return;
    const patches = (data as { patches?: unknown }).patches;
    if (!Array.isArray(patches)) return;

    for (const entry of patches) {
      if (typeof entry !== 'object' || entry === null) continue;
      const patch = entry as Partial<StoredPatch>;
      if (
        typeof patch.x !== 'number' ||
        typeof patch.y !== 'number' ||
        typeof patch.ageSeconds !== 'number'
      ) {
        continue;
      }
      restoredPatches.push({
        x: patch.x,
        y: patch.y,
        ageSeconds: patch.ageSeconds,
        // A patch stored by a build that could not yet ask for a slide restores
        // as UNASKED, which is right: it never asked.
        askedForSlide: patch.askedForSlide === true,
      });
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

export const plugin: TerracePlugin = {
  name: HYDRO_PLUGIN_NAME,

  // Groups this plugin's cards in the admin panel; see TerracePlugin.archetype.
  // `terrain` rather than a weather archetype, and the two consumers say why:
  // what a pour does is put fires out and move ground, which is fire's and
  // mudslides' own archetype.
  archetype: 'terrain',

  onWorldCreate(world: WorldApi): void {
    simSeconds = 0;
    lastKeepaliveSeconds = 0;
    // REPLACES rather than adds — the rollback contract (types.ts's
    // PersistenceSlice). A load()/onWorldCreate() pair may run again on a live
    // world, and water that survived that would be counted twice.
    puddles.restore(restoredPatches);
    restoredPatches = [];

    // THE CROSS-PLUGIN DEPENDENCY PATTERN, all three directions. The host says
    // who is running as each of these in THIS world; each bridge's header has
    // the degraded behaviour when one of them is not.
    loadWeatherBridge(world);
    loadMudslidesBridge(world);
    loadManaBridge(world);

    // JOINING THE SKY IS WHAT MAKES THE WATER DO ANYTHING (./weather-bridge.ts).
    // Registered here rather than at module scope because the registration
    // belongs to the world: the hub replaces by name, so the replay a reopen or
    // a rollback causes leaves exactly one entry.
    registerWithHub({
      name: HYDRO_PLUGIN_NAME,
      cells: skyCells,
      wetnessAt: (x, y) => puddles.wetnessAt(x, y),
    });

    // ANNOUNCE WHAT WAS RESTORED, unconditionally — including "nothing", which
    // is fire's rule and its bug (2026-08-24). This hook runs again on a live
    // world when an operator rolls back, and every client is still drawing
    // whatever was wet when they were last told. Restoring a set is silent by
    // design, and if the restored world happens to be dry then `tick`'s
    // early-out means the keepalive that exists for exactly this repair can
    // never run.
    broadcastSnapshot(world);
  },

  onWorldClose(): void {
    // The registration and the sibling views belong to the world that made
    // them: a module-scope view must not outlive its world (the 2026-08-25
    // revocation rule), and a sky kind whose patches have been forgotten would
    // go on answering `precipitationAt` for the next world.
    unregisterFromHub();
    clearMudslidesBridge();
    clearManaBridge();
    puddles.clear();
    simSeconds = 0;
    lastKeepaliveSeconds = 0;
  },

  onTick(world: WorldApi, dt: number): void {
    tick(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // The joining player alone, not a world-wide re-broadcast: everyone else's
    // set is already current.
    broadcastSnapshot(world, player.id);
  },

  messages: {
    [HYDRO_POUR_MESSAGE]: onPourRequest,
  },

  persistence,
};

/** Test seam: forgets the world and every patch. Never called by the server. */
export function resetHydroState(): void {
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  restoredPatches = [];
  puddles.clear();
}

/**
 * How wet a cell is from poured water alone, in [0, 1].
 *
 * Exported so a sibling can duck-type it — the entry point IS this plugin's
 * compatibility surface. Nothing does yet: the consumers that matter reach the
 * same answer through weather's union (./weather-bridge.ts), which is the
 * direction that does not have to learn hydro's name.
 */
export function wetnessAt(x: number, y: number): number {
  return puddles.wetnessAt(x, y);
}

/** The cap, re-exported so a HUD or a sibling reaches it through the API. */
export { HYDRO_PATCH_CAP };
