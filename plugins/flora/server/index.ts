// flora — trees grow on green ground that has been left alone (owner,
// 2026-08-14: "I would like to see trees spawn in the green layers when they've
// been stable for a short period of time"), and (card 28, 2026-08-19,
// "Terrace Farming") crops grow on flat ground next to water.
//
// Core knows nothing about vegetation. This half owns the whole mechanic —
// what counts as green (./bands.ts), what counts as left alone (./stability.ts),
// how fast a meadow fills in (./forest.ts), what counts as farmland
// (@terrace/shared's farmland.ts — the predicate is shared terrain math, not
// this plugin's) and where crops currently stand (./crops.ts), and what
// survives a restart (./persistence.ts — crops themselves do not; see
// crops.ts's header) — and publishes it on FOUR namespaced messages (two
// per population); the client half under ../client draws both.
//
// TREES AND CROPS ARE TWO INDEPENDENT POPULATIONS, not two views of one
// mechanism: different eligibility predicate, different cap, different
// growth model (stochastic-with-a-hazard for trees, purely deterministic for
// crops — see crops.ts), different wire messages. Everywhere below that
// forest.ts's machinery is mirrored for crops.ts, it is mirrored
// DELIBERATELY — the two are meant to read as the same house pattern applied
// twice, not as one shared abstraction.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PLUGIN IS, NEXT TO THE OTHER TWO THAT DRAW THINGS IN THE WORLD.
//
//   wildlife : entities that MOVE      → full state, every other tick, no join
//                                        handshake, self-healing, 390 kbit/s
//   relics   : five objects that DON'T → full list on every change plus a 15 s
//                                        keepalive; five items is small enough
//                                        that a delta would be pure ceremony
//   flora    : up to 3000 objects that DON'T → deltas, plus a snapshot on join
//                                        and a 60 s keepalive; ≈2.7 kbit/s
//
// The middle column is the whole argument. A forest is big enough that resending
// it is expensive and static enough that resending it is pointless, which is
// precisely the combination terrain itself is synced under. The full bandwidth
// arithmetic, and the failure mode deltas buy, are in ../protocol.ts.
//
// FOG OF WAR (added issue #18). Every send in "join, keepalive, delta" above is
// now per RECIPIENT: a player is sent only the trees inside chunks they have
// personally unlocked (WorldApi.broadcastVisible), and a recipient whose own
// subset is empty is sent nothing at all rather than an empty message — see
// FLORA_SKIP_EMPTY's doc comment for why that is always safe for content that
// never moves once placed. The one gap a 60 s keepalive cannot close fast
// enough — a player creeping into a chunk that already has standing trees —
// gets its own targeted push instead of waiting: see onChunkUnlockedForToken /
// refreshUnlockedChunk below.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE PATHS.
//
// GROWTH is polled: every FLORA_SURVEY_INTERVAL_SECONDS a survey walks the
// unlocked world, works out how many trees the stable green area deserves, and
// sprouts a stochastic few of them (forest.ts).
//
// FELLING is reactive: onTerrainChanged carries the full server-side diff, so a
// sculpt fells every tree it touched in the same call that applied the edit —
// before the terrain diff reaches any client. A player never sees a tree
// standing in the hole they just dug, not even for one frame.
//
// STRUCTURE OCCUPANCY (added 2026-08-19, owner: "if buildings are going to
// spawn over trees, then the trees need to de-spawn") is BOTH reactive and
// polled, because no single one of structures' own events names every way a
// cell can become occupied (see ./structures-event.ts's header). onWorldEvent
// fells a tree the instant its cell is named `seeded` or `upgraded` in
// structures' `changes` event; the SAME survey that drives growth above also
// treats every currently-occupied cell (./structures-bridge.ts) as
// unplantable, which is what actually guarantees "buildings always win" for
// the causes the event does not name (an ordinary birth, a stir spark) and
// for a building that was already standing over a tree before this feature
// shipped — see forest.ts's OccupancyPredicate and Forest.cull. Structure
// DEATH does not replant: it simply stops appearing in the occupied set, and
// flora's own growth recolonizes the cell on its own schedule, same as any
// other bare patch of stable green ground.
//
// All three paths write to the same two structures and emit the same delta
// message, so a client applies "the ground moved, four trees fell", "a
// building rose, one tree fell" and "five trees grew" through one code path.
// ─────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE, type CellDiff } from '@terrace/shared';
// Type-only import of the plugin contract (fully erased at runtime). It reaches
// into server/src because core publishes no plugin-API entry point yet — the
// same arrangement mana, reveal, relics and wildlife use.
import type {
  PersistenceSlice,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  FLORA_CHANGES_MESSAGE,
  FLORA_CROPS_MESSAGE,
  FLORA_CROP_CHANGES_MESSAGE,
  FLORA_FOREST_MESSAGE,
  FLORA_PLUGIN_NAME,
  packCropCells,
  packTreeCells,
  treeKey,
  type CropCell,
  type TreeCell,
} from '../protocol.ts';
import {
  FLORA_RNG_DEFAULT_SEED,
  FLORA_SURVEY_INTERVAL_SECONDS,
  Forest,
  createFloraRng,
  type FloraRng,
  type OccupancyPredicate,
} from './forest.ts';
import { CropField, cropSurveyChunksPerTick } from './crops.ts';
import { loadFireBridge, registerFloraFuel } from './fire-bridge.ts';
import { loadForestSlice, saveForest } from './persistence.ts';
import { StabilityMap } from './stability.ts';
import { bridgedStructures, loadStructuresBridge } from './structures-bridge.ts';
import { parseStructuresOccupation } from './structures-event.ts';

/**
 * Simulated seconds between unsolicited full-forest re-broadcasts.
 *
 * This is a REPAIR cadence, not a sync mechanism: every client is given the
 * whole forest when it joins and is kept current by deltas. It exists because a
 * delta stream has no way to notice it has drifted — a reconnect that straddles
 * a message would otherwise leave a client with a phantom tree until the next
 * time that cell happened to change, which could be never.
 *
 * 60 s bounds any such divergence at one minute for 18 KB (protocol.ts), i.e.
 * ~2.4 kbit/s per client — 0.6% of what wildlife already spends, and the honest
 * price of choosing deltas at all.
 */
export const FLORA_KEEPALIVE_SECONDS = 60;

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching the shape of every other
// plugin here (the host constructs one plugin instance per server process).

const forest = new Forest();

/**
 * The crop field (card 28, "Terrace Farming"). A SEPARATE object from
 * `forest`, not a second list inside it: crops have their own cap, their own
 * survey cadence and no stochastic growth at all — see crops.ts's header.
 */
const cropField = new CropField();

/**
 * Null until onWorldCreate: the record is sized from the world edge, which is
 * not known before then. Every path that touches it therefore checks — which
 * doubles as the guard for "a hook fired before the world existed".
 */
let stability: StabilityMap | null = null;

let rng: FloraRng = createFloraRng(FLORA_RNG_DEFAULT_SEED);

/** Accumulated simulated seconds — the only clock this plugin has. */
let simSeconds = 0;

/**
 * Simulated time of the last keepalive. The SURVEY needs no equivalent: its
 * cadence is the rolling sweep's own progress through the world, not a timer
 * (see chunkBudgetFor).
 */
let lastKeepaliveSeconds = 0;

/**
 * Fractional chunks owed to the rolling sweep, carried between ticks. See
 * chunksPerTick for why this is not just "N chunks per tick".
 */
let scanCredit = 0;

/**
 * Fractional chunks owed to the crop survey, carried between ticks —
 * crops.ts's own rolling sweep, independent of the tree survey's
 * `scanCredit` above (two unrelated mechanisms, two unrelated budgets, the
 * same "restated, not shared" rule the two survey intervals themselves
 * keep — see crops.ts's CROP_SURVEY_INTERVAL_SECONDS comment).
 */
let cropScanCredit = 0;

/**
 * Trees restored from a snapshot, held until onWorldCreate.
 *
 * The host restores persistence BEFORE it creates the world, so load() runs when
 * this plugin still has no world to validate against. Parking the cells here and
 * installing them in onWorldCreate keeps the ordering explicit instead of
 * relying on a Forest that would have to tolerate being written to first.
 */
let restoredCells: readonly TreeCell[] = [];

// ────────────────────────────────────────────────────────────────────────────
// Wire
// ────────────────────────────────────────────────────────────────────────────

/** A tree's own cell — what `WorldApi.broadcastVisible` gates visibility by. */
function treePosition(cell: TreeCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

/**
 * FOG OF WAR (issue #18). Every broadcastVisible call this plugin makes
 * passes `skipEmpty: true`, and this is why that is always safe here, not
 * just convenient: per-player masks only ever GROW (issue #17 — a chunk
 * unlock is never undone), so a tree invisible to some player right now was
 * EQUALLY invisible to them at every earlier moment this same tree's state
 * could have been announced. There is no "it used to be visible and now
 * is not" case for a thing that never moves once planted, so an empty send
 * would never have corrected anything a fuller send could — see
 * WorldApi.broadcastVisible's own doc comment for the general rule.
 */
const FLORA_SKIP_EMPTY = { skipEmpty: true } as const;

function broadcastForest(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_FOREST_MESSAGE,
    forest.cells(),
    treePosition,
    (visible) => ({ trees: packTreeCells(visible) }),
    FLORA_SKIP_EMPTY,
  );
  lastKeepaliveSeconds = simSeconds;
}

/** One cell tagged with which half of a `flora:changes` delta it belongs to. */
interface TaggedTreeChange {
  readonly kind: 'grown' | 'felled';
  readonly cell: TreeCell;
}

/**
 * Sends one delta. Silent when nothing changed anywhere — the common case by
 * far, since most surveys of a settled world grow nothing, and a message
 * saying so would be this plugin's entire steady-state bandwidth spent on
 * nothing. Per RECIPIENT, silence is more common still: `broadcastVisible`
 * additionally skips any player whose own subset of THIS delta is empty
 * (FLORA_SKIP_EMPTY) — the ordinary case for a change happening in someone
 * else's territory.
 */
function broadcastChanges(
  world: WorldApi,
  grown: readonly TreeCell[],
  felled: readonly TreeCell[],
): void {
  if (grown.length === 0 && felled.length === 0) return;

  const tagged: TaggedTreeChange[] = [
    ...grown.map((cell): TaggedTreeChange => ({ kind: 'grown', cell })),
    ...felled.map((cell): TaggedTreeChange => ({ kind: 'felled', cell })),
  ];
  world.broadcastVisible(
    FLORA_CHANGES_MESSAGE,
    tagged,
    (change) => treePosition(change.cell),
    (visible) => ({
      grown: packTreeCells(visible.filter((c) => c.kind === 'grown').map((c) => c.cell)),
      felled: packTreeCells(visible.filter((c) => c.kind === 'felled').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Crops wire (card 28) — Forest's own wire functions above, restated for the
// crop field. Same fog-of-war rule, same skipEmpty justification (a crop
// never moves once it stands, so an invisible crop was equally invisible at
// every earlier moment it could have been announced — FLORA_SKIP_EMPTY's own
// doc comment, unchanged by having a second population to apply it to).
// ────────────────────────────────────────────────────────────────────────────

/** A crop's own cell — what `WorldApi.broadcastVisible` gates visibility by. */
function cropPosition(cell: CropCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

function broadcastCrops(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_CROPS_MESSAGE,
    cropField.cells(),
    cropPosition,
    (visible) => ({ crops: packCropCells(visible) }),
    FLORA_SKIP_EMPTY,
  );
}

/** One cell tagged with which half of a `flora:cropChanges` delta it belongs to. */
interface TaggedCropChange {
  readonly kind: 'sprouted' | 'withered';
  readonly cell: CropCell;
}

function broadcastCropChanges(
  world: WorldApi,
  sprouted: readonly CropCell[],
  withered: readonly CropCell[],
): void {
  if (sprouted.length === 0 && withered.length === 0) return;

  const tagged: TaggedCropChange[] = [
    ...sprouted.map((cell): TaggedCropChange => ({ kind: 'sprouted', cell })),
    ...withered.map((cell): TaggedCropChange => ({ kind: 'withered', cell })),
  ];
  world.broadcastVisible(
    FLORA_CROP_CHANGES_MESSAGE,
    tagged,
    (change) => cropPosition(change.cell),
    (visible) => ({
      sprouted: packCropCells(visible.filter((c) => c.kind === 'sprouted').map((c) => c.cell)),
      withered: packCropCells(visible.filter((c) => c.kind === 'withered').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

/**
 * THE TARGETED-REFRESH PATH for crops, mirroring refreshUnlockedChunk below
 * exactly (issue #18's mechanism, applied to the second static population).
 */
function refreshUnlockedChunkCrops(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: CropCell[] = [];
  for (const crop of cropField.cells()) {
    if (crop.x >= x0 && crop.x < x0 + CHUNK_SIZE && crop.y >= y0 && crop.y < y0 + CHUNK_SIZE) {
      inChunk.push(crop);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { sprouted: packCropCells(inChunk), withered: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_CROP_CHANGES_MESSAGE, payload);
  }
}

/**
 * THE TARGETED-REFRESH PATH (issue #18). `broadcastForest`'s keepalive is a
 * 60 s REPAIR cadence (see FLORA_KEEPALIVE_SECONDS), not a sync mechanism —
 * far too slow for "a player just earned a chunk that already has trees in
 * it" to feel instant. Fired once per successful per-token unlock
 * (WorldApi.unlockChunkForToken / TerracePlugin.onChunkUnlockedForToken), so
 * a chunk with nothing standing in it costs one bounding-box scan and no
 * message at all.
 *
 * Sent as a GROWTH DELTA, not a `flora:forest` snapshot: the client's forest
 * handler REPLACES its whole tree map on that message type (see
 * ../client/index.ts), which would wipe out every other chunk this player
 * already knows about. `flora:changes`' `grown` list is additive, exactly
 * what "these trees, which already existed, are now yours to see" means.
 */
function refreshUnlockedChunk(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: TreeCell[] = [];
  for (const tree of forest.cells()) {
    if (tree.x >= x0 && tree.x < x0 + CHUNK_SIZE && tree.y >= y0 && tree.y < y0 + CHUNK_SIZE) {
      inChunk.push(tree);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { grown: packTreeCells(inChunk), felled: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_CHANGES_MESSAGE, payload);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The two paths
// ────────────────────────────────────────────────────────────────────────────

/**
 * Chunks to scan per tick so that one sweep takes exactly one survey interval,
 * as a FRACTION — 0.32 on a 64² world at 10 Hz, 20.5 on a 512² one.
 *
 * DERIVED, never tuned by hand: the work is fixed (every chunk must be visited)
 * and the deadline is fixed (FLORA_SURVEY_INTERVAL_SECONDS), so the per-tick
 * budget is their quotient. A hand-written constant would make the survey
 * interval a function of world size instead of an interval.
 *
 * At the shipped TICK_HZ of 10 this is 1024 chunks / 50 ticks ≈ 20.5 chunks
 * (~5 200 cells) per tick on a 512² world — measured at 0.59 ms mean, 0.90 ms
 * worst per tick with every cell of that world eligible, which is the worst case
 * this plugin has.
 *
 * FRACTIONAL, and that is the load-bearing part. Rounding up to whole chunks
 * would make every world smaller than one chunk per tick sweep as fast as it
 * possibly could — a 64² world would complete a sweep every 1.6 s rather than
 * every 5 s, and since FLORA_MEAN_SPROUT_WAIT_SECONDS is expressed per survey
 * interval, its forest would grow three times faster than the constants say.
 * The caller accumulates this into a credit and spends whole chunks out of it,
 * so the sweep period is the same on every world size. (Measured, 2026-08-14:
 * with the rounded-up version a 64² test world grew 28 trees where the
 * arithmetic called for 8.)
 */
function chunksPerTick(world: WorldApi, dt: number): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerSurvey = Math.max(1, Math.round(FLORA_SURVEY_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerSurvey;
}

/**
 * The cells a structure occupies RIGHT NOW, as an OccupancyPredicate closure
 * over a freshly built Set of flora's own tree keys (protocol.ts's treeKey —
 * NOT structures' STRUCTURES_CELL_KEY_STRIDE, a different plugin's private
 * encoding this one must never assume matches its own).
 *
 * Rebuilt on every call rather than cached: `bridgedStructures()` returns at
 * most STRUCTURES_CAP (512) cells, so building the Set costs at most 512
 * inserts — negligible against the survey work it gates — and a fresh read
 * means a structure founded THIS tick is excluded from the very next chunk
 * scanned, not from whichever sweep happens to start next.
 */
function occupiedCells(): OccupancyPredicate {
  const occupied = new Set<number>();
  for (const cell of bridgedStructures()) occupied.add(treeKey(cell.x, cell.y));
  return (x: number, y: number): boolean => occupied.has(treeKey(x, y));
}

/**
 * THE SIM STEP. Fixed order, once per host tick:
 *
 *   1. advance the clock — everything else reads simSeconds, nothing reads a
 *      wall clock, so a test advances time by ticking;
 *   2. advance the rolling survey by this tick's share of the world. It returns
 *      a result only on the tick that completes a sweep, which is the tick that
 *      culls and grows (forest.ts) — now against the LATEST structure
 *      occupancy too, so buildings always win even where the world-event
 *      handler below never fired (see the module header's THREE PATHS note);
 *   3. keepalive, on its own cadence and independent of 2, because the thing it
 *      repairs (a client that missed a delta) has nothing to do with whether
 *      anything grew.
 */
function simulate(world: WorldApi, dt: number): void {
  simSeconds += dt;
  if (stability === null) return;

  // Whole chunks are spent out of a fractional credit (see chunksPerTick). The
  // credit is capped at one full sweep so that a stalled or resumed server
  // cannot bank an unbounded burst and then scan the whole world in one tick —
  // the exact stall this design exists to avoid.
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  scanCredit = Math.min(scanCredit + chunksPerTick(world, dt), totalChunks);
  const budget = Math.floor(scanCredit);
  if (budget > 0) {
    scanCredit -= budget;
    const { grown, felled } = forest.advanceSurvey(
      world,
      stability,
      simSeconds,
      rng,
      budget,
      occupiedCells(),
    );
    broadcastChanges(world, grown, felled);
  }

  // The crop survey (card 28) — its OWN independent budget/cursor
  // (cropScanCredit), because it is a different sweep on a different
  // interval (crops.ts's CROP_SURVEY_INTERVAL_SECONDS) over a different
  // predicate. Reuses the SAME occupiedCells() closure forest's own survey
  // just built above: "buildings always win" applies identically to crops
  // (crops.ts's scanChunk), so a structure founded this tick is excluded
  // from both surveys' very next chunk, not just the tree survey's.
  cropScanCredit = Math.min(cropScanCredit + cropSurveyChunksPerTick(world, dt), totalChunks);
  const cropBudget = Math.floor(cropScanCredit);
  if (cropBudget > 0) {
    cropScanCredit -= cropBudget;
    const outcome = cropField.advance(world, occupiedCells(), cropBudget);
    if (outcome !== null) broadcastCropChanges(world, outcome.sprouted, outcome.withered);
  }

  if (simSeconds - lastKeepaliveSeconds >= FLORA_KEEPALIVE_SECONDS) {
    broadcastForest(world);
    broadcastCrops(world);
  }
}

/**
 * THE REACTIVE PATH — CRITICAL, and the reason this plugin needs no polling for
 * removal at all.
 *
 * Fired after any applied edit with the FULL server-side diff (a player's
 * sculpt, another plugin's terraform, a relic cast — they all arrive here). Two
 * effects per changed cell, in this order:
 *
 *   * its stability clock is reset, so the ground has to be left alone all over
 *     again before anything will grow there;
 *   * any tree standing on it is felled, and the removal is broadcast.
 *
 * "Any height change" is the rule, not "a change that left the green bands",
 * deliberately: a tree whose ground rose or fell by even one unit is standing on
 * ground that was just dug up, and the player's mental model is that digging
 * kills what was growing there. It also makes the rule stateless — no comparison
 * against a previous band, nothing to get wrong when relaxation moves a cell
 * twice within one edit.
 *
 * Note this runs INSIDE the sculpt that caused it. It only reads heights and
 * writes plugin state — it never calls world.sculpt — so it cannot feed the
 * host's terrain-change cascade guard.
 */
function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (stability === null || diff.length === 0) return;

  const felled: TreeCell[] = [];
  const withered: CropCell[] = [];
  for (const cell of diff) {
    stability.markChanged(cell.x, cell.y, simSeconds);
    if (forest.fell(cell.x, cell.y)) felled.push({ x: cell.x, y: cell.y });
    // Card 28's own instant-reaction half: a crop standing on the EDITED
    // cell withers immediately, mirroring the tree rule directly above.
    // farmland.ts's flatness/water-adjacency test also depends on a cell's
    // NEIGHBOURS, which this diff-driven pass does not re-check — see
    // crops.ts's CropField.reactToEdit doc comment for why that lag is a
    // named, accepted residual rather than a gap.
    const witheredCell = cropField.reactToEdit(cell.x, cell.y);
    if (witheredCell !== null) withered.push(witheredCell);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
}

/**
 * THE EVENT-DRIVEN PATH (added 2026-08-19, owner: "if buildings are going to
 * spawn over trees, then the trees need to de-spawn"). Fired synchronously
 * from structures' own `world.emitEvent('changes', …)` (WorldApi's
 * cross-plugin event primitive) the moment a cell is named `seeded` or
 * `upgraded` — i.e. the two causes structures' own event bothers to name
 * (see ./structures-event.ts's header for why that is narrower than "every
 * new building" and why that narrowness is safe). Buildings always win: no
 * height change is involved, so onTerrainChanged above never sees this, and
 * without this handler a tree would keep standing inside a settlement for up
 * to one survey interval.
 *
 * Deliberately does nothing with `died`: structure death does not replant.
 * The cell simply stops appearing in occupiedCells() (server/index.ts's
 * simulate), and flora's own growth recolonizes it on the ordinary survey
 * schedule — no special-cased "the building died, plant something" code is
 * needed or wanted.
 *
 * Stability is NOT reset for a felled cell here, unlike reactToTerrain: a
 * structure's arrival changes no height, so the ground was never disturbed —
 * only occupied. If the structure later dies, the cell is exactly as stable
 * as it already was.
 */
function onStructuresChanges(world: WorldApi, payload: unknown): void {
  const occupation = parseStructuresOccupation(payload);
  if (occupation === null) return;

  const felled: TreeCell[] = [];
  const withered: CropCell[] = [];
  for (const cell of occupation.seeded) {
    if (forest.fell(cell.x, cell.y)) felled.push({ x: cell.x, y: cell.y });
    const witheredCell = cropField.reactToEdit(cell.x, cell.y);
    if (witheredCell !== null) withered.push(witheredCell);
  }
  for (const cell of occupation.upgraded) {
    if (forest.fell(cell.x, cell.y)) felled.push({ x: cell.x, y: cell.y });
    const witheredCell = cropField.reactToEdit(cell.x, cell.y);
    if (witheredCell !== null) withered.push(witheredCell);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
}

// ────────────────────────────────────────────────────────────────────────────
// THE FLAMMABLE PATH — what flora contributes to the world's fire (./fire-
// bridge.ts, and plugins/fire/server/fuel.ts's header for the contract).
//
// Nothing here starts, spreads or draws a fire. This plugin says only what it
// owns that can burn, how long it burns for, and what to destroy when it has —
// which is the whole of flora's involvement in the mechanic.
// ────────────────────────────────────────────────────────────────────────────

/**
 * How long a tree burns, in simulated seconds.
 *
 * Long enough to be an event you can react to — the player watching a stand
 * catch has time to dig a break before the next tree goes up — and short enough
 * that a fire is over within a minute rather than becoming the world's
 * permanent weather. It is also the number FIRE_KEEPALIVE_SECONDS (10 s) is
 * sized against: a tree fire is re-anchored on every client at least twice
 * during its life.
 */
export const FLORA_TREE_BURN_SECONDS = 22;

/**
 * How long a crop burns. A FLASH, not a burn: dry standing grain goes up in
 * seconds and leaves nothing, which is the whole difference between losing a
 * field and losing a wood.
 */
export const FLORA_CROP_BURN_SECONDS = 4;

/**
 * Flame size for a tree, in world units — the drawn height of a full-grown one
 * at scale 1 (TRUNK_HEIGHT + CONIFER_CROWN_HEIGHT in ../client/models.ts, ≈1.5).
 *
 * Restated rather than imported: that constant lives in a THREE-dependent
 * client module the server must not load. It is a render-facing number in both
 * places, so a drift between them costs a flame slightly the wrong size — the
 * reason it is not worth pulling a client module (or a shared one) into the
 * server to fix.
 */
export const FLORA_TREE_FUEL_HEIGHT = 1.5;

/**
 * Flame size for a crop. A quarter of a tree's: knee-high standing grain, so a
 * burning field reads as a running line of low flame rather than as a forest
 * fire in miniature.
 */
export const FLORA_CROP_FUEL_HEIGHT = 0.35;

/**
 * What burns at this cell. Trees are checked before crops for no deeper reason
 * than that a cell cannot hold both — flora plants only one thing per cell.
 */
function floraFuelAt(x: number, y: number): { burnSeconds: number; height: number } | null {
  if (forest.has(x, y)) {
    return { burnSeconds: FLORA_TREE_BURN_SECONDS, height: FLORA_TREE_FUEL_HEIGHT };
  }
  if (cropField.has(x, y)) {
    return { burnSeconds: FLORA_CROP_BURN_SECONDS, height: FLORA_CROP_FUEL_HEIGHT };
  }
  return null;
}

/**
 * A fire finished here: whatever was standing is gone.
 *
 * Called ONLY for fires that ran their full course — a fire cut short by rain
 * or by a dug firebreak never reaches this (plugins/fire/server/blaze.ts's
 * three endings), and the tree it was burning survives, scorched but standing.
 *
 * Stability is NOT reset, for onStructuresChanges' reason: fire changes no
 * height, so the ground was never disturbed. A burned-out cell is as stable as
 * it was, and flora's ordinary survey recolonizes it on the usual schedule.
 */
function floraBurnedOut(cells: readonly { readonly x: number; readonly y: number }[]): void {
  const world = fuelWorld;
  if (world === null) return;

  const felled: TreeCell[] = [];
  const withered: CropCell[] = [];
  for (const cell of cells) {
    if (forest.fell(cell.x, cell.y)) felled.push({ x: cell.x, y: cell.y });
    const witheredCell = cropField.reactToEdit(cell.x, cell.y);
    if (witheredCell !== null) withered.push(witheredCell);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
}

/**
 * The live world, stashed for floraBurnedOut — which is called from fire's tick
 * rather than from one of this plugin's own hooks, and so is handed no world of
 * its own.
 */
let fuelWorld: WorldApi | null = null;

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveForest(forest, rng);
  },
  load(data: unknown): void {
    const restored = loadForestSlice(data);
    restoredCells = restored.cells;
    rng = createFloraRng(restored.rngState);
  },
};

export const plugin: TerracePlugin = {
  name: FLORA_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    stability = new StabilityMap(world.worldSize);

    // Any snapshot has already been restored by the time this runs, so the trees
    // here are either none (fresh world) or the persisted ones. Cells outside
    // this world — a snapshot restored onto a smaller WORLD_SIZE — are dropped
    // by the first survey's cull sweep, which tests them against the real world.
    forest.replaceAll(restoredCells);
    restoredCells = [];

    // THE CROSS-PLUGIN DEPENDENCY PATTERN (structures-bridge.ts): started, not
    // awaited — this hook is synchronous, and the bridge resolves (or degrades
    // to "no structures") in the background while the rest of this plugin keeps
    // working. Every occupiedCells() query until then simply sees an empty
    // occupied set, same as a world with no structures plugin installed at all.
    void loadStructuresBridge();

    // The same pattern, pointing the other way (./fire-bridge.ts's header):
    // flora TELLS fire what of its own can burn. Started here and not awaited;
    // the registration is buffered and replayed if fire has not resolved yet,
    // so the forest is flammable from the moment fire exists rather than from
    // whenever the import happens to land.
    fuelWorld = world;
    loadFireBridge();
    registerFloraFuel({
      name: FLORA_PLUGIN_NAME,
      fuelAt: floraFuelAt,
      onBurnedOut: floraBurnedOut,
    });

    // No players are connected at world create, so this is not how anyone gets
    // their first forest (onPlayerJoin is). It is here so that a client which is
    // somehow already listening is not left empty for up to a keepalive.
    broadcastForest(world);
    // The crop field itself starts empty here (crops.ts's header: nothing is
    // persisted, the first survey — up to CROP_SURVEY_INTERVAL_SECONDS away —
    // populates it fresh from this world's own heightmap), so this call is
    // inert at boot; kept for symmetry with broadcastForest and to cover a
    // future restart-without-reconnect path cleanly.
    broadcastCrops(world);
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onWorldEvent(world: WorldApi, event: string, payload: unknown): void {
    // By-name subscription (see server/src/plugins/types.ts's emitEvent doc
    // comment): structures' plugin name is the coupling, exactly like a wire
    // message namespace — never an import of structures' code.
    if (event === 'structures:changes') onStructuresChanges(world, payload);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // The room sends the core join snapshot before this hook, so the client is
    // already sized and listening. The forest goes directly to that one
    // player rather than being left to the keepalive: a joining player must
    // never look at a bare world for up to FLORA_KEEPALIVE_SECONDS, and
    // broadcasting it to everyone would re-send 18 KB to every existing client
    // every time somebody connects.
    //
    // FOG OF WAR (issue #18): filtered to the trees inside THIS player's own
    // unlocked view (onlyPlayerId), same skipEmpty rule as every other send
    // in this plugin (FLORA_SKIP_EMPTY) — a player who has just joined and
    // unlocked nothing of their own yet is sent nothing, which is exactly
    // what their client already renders by default.
    world.broadcastVisible(
      FLORA_FOREST_MESSAGE,
      forest.cells(),
      treePosition,
      (visible) => ({ trees: packTreeCells(visible) }),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );

    // Card 28's crops, same join-time treatment as the forest immediately
    // above — a joining player must see standing crops without waiting out
    // a keepalive either.
    world.broadcastVisible(
      FLORA_CROPS_MESSAGE,
      cropField.cells(),
      cropPosition,
      (visible) => ({ crops: packCropCells(visible) }),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
    refreshUnlockedChunkCrops(world, token, cx, cy);
  },

  persistence,
};

// ────────────────────────────────────────────────────────────────────────────
// Test seams
// ────────────────────────────────────────────────────────────────────────────

/** The standing trees, in planting order. */
export function standingTrees(): readonly TreeCell[] {
  return forest.cells();
}

/** The live forest, for suites that need to assert on its own maths. */
export function currentForest(): Forest {
  return forest;
}

/** The live stability record, or null before a world exists. */
export function currentStability(): StabilityMap | null {
  return stability;
}

/** The standing crops (card 28), in no particular order. */
export function standingCrops(): readonly CropCell[] {
  return cropField.cells();
}

/** The live crop field, for suites that need to assert on its own maths. */
export function currentCropField(): CropField {
  return cropField;
}

/** Drops all accumulated state so a suite can start from zero. */
export function resetFloraState(): void {
  stability = null;
  fuelWorld = null;
  forest.replaceAll([]);
  cropField.clear();
  rng = createFloraRng(FLORA_RNG_DEFAULT_SEED);
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  scanCredit = 0;
  cropScanCredit = 0;
  restoredCells = [];
}
