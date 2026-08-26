// flora — trees grow on green ground that has been left alone (owner,
// 2026-08-14: "I would like to see trees spawn in the green layers when they've
// been stable for a short period of time"), (card 28, 2026-08-19, "Terrace
// Farming") crops grow on flat ground next to water, and (owner, 2026-08-24)
// grass covers the green bands abundantly.
//
// Core knows nothing about vegetation. This half owns the whole mechanic —
// what counts as green (./bands.ts), what counts as left alone (./stability.ts),
// how fast a meadow fills in (./forest.ts), what counts as farmland
// (@terrace/shared's farmland.ts — the predicate is shared terrain math, not
// this plugin's), where crops currently stand (./crops.ts) and where grass
// currently stands (./grass.ts), and what
// survives a restart (./persistence.ts — neither crops nor grass do; see
// crops.ts's header) — and publishes it on SIX namespaced messages (a
// snapshot and a delta per population); the client half under ../client draws
// all three.
//
// TREES, CROPS AND GRASS ARE THREE INDEPENDENT POPULATIONS, not three views of
// one mechanism: different eligibility predicate, different cap, different
// growth model (stochastic-with-a-hazard for trees, purely deterministic for
// crops and grass — see crops.ts and grass.ts), different wire messages.
// Everywhere below that forest.ts's machinery is mirrored for crops.ts and
// grass.ts, it is mirrored DELIBERATELY — the three are meant to read as the
// same house pattern applied three times, not as one shared abstraction.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PLUGIN IS, NEXT TO THE OTHER TWO THAT DRAW THINGS IN THE WORLD.
//
//   wildlife : entities that MOVE      → full state, every other tick, no join
//                                        handshake, self-healing, 390 kbit/s
//   relics   : five objects that DON'T → full list on every change plus a 15 s
//                                        keepalive; five items is small enough
//                                        that a delta would be pure ceremony
//   flora    : up to 4096 objects that DON'T → deltas, plus a snapshot on join
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
  FLORA_GRASS_MESSAGE,
  FLORA_GRASS_CHANGES_MESSAGE,
  FLORA_FRINGE_MESSAGE,
  FLORA_FRINGE_CHANGES_MESSAGE,
  packCropCells,
  packFringeCells,
  packGrassCells,
  packTreeCells,
  grassKey,
  treeKey,
  type CropCell,
  type FringeCell,
  type FringeSpecies,
  type GrassCell,
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
import { GrassField, grassSurveyChunksPerTick } from './grass.ts';
import { FringeField, fringeSurveyChunksPerTick, type FringePlant } from './fringe.ts';
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
 * The meadow (owner, 2026-08-24). A THIRD independent object, not a second
 * list inside either of the two above: its own predicate, its own cap, its own
 * survey — see grass.ts's header for why it is a separate class rather than a
 * configured CropField.
 */
const grassField = new GrassField();

/**
 * The fringe (GH #192, #194) — reeds at the waterline and heather on the rock.
 * A FOURTH independent object for the same reason the third is: its own
 * predicate, its own cap, its own survey. What it is NOT is a fifth: the two
 * species share one field, which ../protocol.ts's fringe section argues at
 * length.
 */
const fringeField = new FringeField();

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
 * Fractional chunks owed to the grass survey — the third independent budget,
 * for the third independent sweep (grass.ts's
 * GRASS_SURVEY_INTERVAL_SECONDS), on the same "restated, not shared" rule the
 * other two keep.
 */
let grassScanCredit = 0;

/**
 * Fractional chunks owed to the fringe survey — the fourth independent budget,
 * for the fourth independent sweep (fringe.ts's
 * FRINGE_SURVEY_INTERVAL_SECONDS), on the same "restated, not shared" rule the
 * other three keep.
 */
let fringeScanCredit = 0;

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

// ────────────────────────────────────────────────────────────────────────────
// Grass wire (owner, 2026-08-24) — the crop wire above, restated for the
// meadow. Same fog-of-war rule and the same skipEmpty justification: a tuft
// never moves once it stands, so a tuft invisible to a player now was equally
// invisible at every earlier moment it could have been announced.
// ────────────────────────────────────────────────────────────────────────────

/** A tuft's own cell — what `WorldApi.broadcastVisible` gates visibility by. */
function grassPosition(cell: GrassCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

function broadcastGrass(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_GRASS_MESSAGE,
    grassField.cells(),
    grassPosition,
    (visible) => ({ grass: packGrassCells(visible) }),
    FLORA_SKIP_EMPTY,
  );
}

/** One cell tagged with which half of a `flora:grassChanges` delta it belongs to. */
interface TaggedGrassChange {
  readonly kind: 'sprouted' | 'withered';
  readonly cell: GrassCell;
}

function broadcastGrassChanges(
  world: WorldApi,
  sprouted: readonly GrassCell[],
  withered: readonly GrassCell[],
): void {
  if (sprouted.length === 0 && withered.length === 0) return;

  const tagged: TaggedGrassChange[] = [
    ...sprouted.map((cell): TaggedGrassChange => ({ kind: 'sprouted', cell })),
    ...withered.map((cell): TaggedGrassChange => ({ kind: 'withered', cell })),
  ];
  world.broadcastVisible(
    FLORA_GRASS_CHANGES_MESSAGE,
    tagged,
    (change) => grassPosition(change.cell),
    (visible) => ({
      sprouted: packGrassCells(visible.filter((c) => c.kind === 'sprouted').map((c) => c.cell)),
      withered: packGrassCells(visible.filter((c) => c.kind === 'withered').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

/** refreshUnlockedChunkCrops, restated for the meadow (issue #18's mechanism). */
function refreshUnlockedChunkGrass(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: GrassCell[] = [];
  for (const tuft of grassField.cells()) {
    if (tuft.x >= x0 && tuft.x < x0 + CHUNK_SIZE && tuft.y >= y0 && tuft.y < y0 + CHUNK_SIZE) {
      inChunk.push(tuft);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { sprouted: packGrassCells(inChunk), withered: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_GRASS_CHANGES_MESSAGE, payload);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Fringe wire (GH #192, #194) — the grass wire above, restated a third time.
// Same fog-of-war rule and the same skipEmpty justification: a reed never moves
// once it stands, so one invisible to a player now was equally invisible at
// every earlier moment it could have been announced.
// ────────────────────────────────────────────────────────────────────────────

/** A plant's own cell — what `WorldApi.broadcastVisible` gates visibility by. */
function fringePosition(cell: FringeCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

/**
 * The two per-species lists one payload carries, built from whatever subset of
 * the plants a given player can actually see.
 *
 * ONE HELPER FOR EVERY SEND, because there are four of them (keepalive, join,
 * chunk unlock, survey delta) and the split is the one thing they must all
 * agree on. A per-callsite `filter(p => p.species === 'reed')` in four places is
 * exactly the duplication that lets the fifth callsite get it wrong.
 */
function packBySpecies(plants: readonly FringePlant[]): {
  reeds: number[];
  heather: number[];
} {
  const reeds: FringeCell[] = [];
  const heather: FringeCell[] = [];
  for (const plant of plants) {
    (plant.species === 'reed' ? reeds : heather).push(plant.cell);
  }
  return { reeds: packFringeCells(reeds), heather: packFringeCells(heather) };
}

function broadcastFringe(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_FRINGE_MESSAGE,
    fringeField.plants(),
    (plant) => fringePosition(plant.cell),
    (visible) => packBySpecies(visible),
    FLORA_SKIP_EMPTY,
  );
}

/**
 * One change, tagged with which half of a `flora:fringeChanges` delta it belongs
 * to. A sprout carries its species; a wither does not need one (../protocol.ts's
 * FloraFringeChangesPayload says why), so the field is nullable rather than two
 * separate tagged types.
 */
interface TaggedFringeChange {
  readonly kind: 'sprouted' | 'withered';
  readonly cell: FringeCell;
  readonly species: FringeSpecies | null;
}

function broadcastFringeChanges(
  world: WorldApi,
  sprouted: readonly FringePlant[],
  withered: readonly FringeCell[],
): void {
  if (sprouted.length === 0 && withered.length === 0) return;

  const tagged: TaggedFringeChange[] = [
    ...sprouted.map(
      (plant): TaggedFringeChange => ({
        kind: 'sprouted',
        cell: plant.cell,
        species: plant.species,
      }),
    ),
    ...withered.map((cell): TaggedFringeChange => ({ kind: 'withered', cell, species: null })),
  ];
  world.broadcastVisible(
    FLORA_FRINGE_CHANGES_MESSAGE,
    tagged,
    (change) => fringePosition(change.cell),
    (visible) => ({
      ...packBySpecies(
        visible.flatMap((c): FringePlant[] =>
          c.kind === 'sprouted' && c.species !== null
            ? [{ cell: c.cell, species: c.species }]
            : [],
        ),
      ),
      withered: packFringeCells(visible.filter((c) => c.kind === 'withered').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

/** refreshUnlockedChunkGrass, restated for the fringe (issue #18's mechanism). */
function refreshUnlockedChunkFringe(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: FringePlant[] = [];
  for (const plant of fringeField.plants()) {
    const { x, y } = plant.cell;
    if (x >= x0 && x < x0 + CHUNK_SIZE && y >= y0 && y < y0 + CHUNK_SIZE) inChunk.push(plant);
  }
  if (inChunk.length === 0) return;

  const payload = { ...packBySpecies(inChunk), withered: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_FRINGE_CHANGES_MESSAGE, payload);
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
 * What the two GROUND-COVER populations — the meadow and the fringe — yield to:
 * buildings AND crops, but NOT trees (owner, 2026-08-24: grass grows under
 * trees).
 *
 * ONE PREDICATE FOR BOTH, not one per field. The two populations can never
 * share a cell (their height windows are disjoint), so what would be gained by
 * splitting it is two identical Sets built twice per tick. If the fringe ever
 * needs a rule of its own, it gets its own function then — what it must not do
 * is start life as a copy of this one. Built on top of the structure occupancy the other
 * two surveys already use, so "a building was founded this tick" reaches all
 * three sweeps identically — the difference is only the extra crop term.
 *
 * Rebuilt per call for occupiedCells' own reason, with one extra bound: the
 * crop field is capped at FLORA_CROP_CAP (2048), so this Set costs at most
 * ~2560 inserts against a sweep that visits tens of thousands of cells.
 */
function groundCoverOccupiedCells(): OccupancyPredicate {
  const occupied = new Set<number>();
  for (const cell of bridgedStructures()) occupied.add(grassKey(cell.x, cell.y));
  for (const cell of cropField.cells()) occupied.add(grassKey(cell.x, cell.y));
  return (x: number, y: number): boolean => occupied.has(grassKey(x, y));
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

  // The grass survey — again its own budget and cursor, over its own
  // predicate (grass.ts). It runs AFTER the crop survey in the same tick on
  // purpose: grassOccupiedCells reads the crop field, so the meadow it stages
  // is the one that yields to the crops that exist right now rather than to
  // last tick's.
  grassScanCredit = Math.min(grassScanCredit + grassSurveyChunksPerTick(world, dt), totalChunks);
  const grassBudget = Math.floor(grassScanCredit);
  if (grassBudget > 0) {
    grassScanCredit -= grassBudget;
    const outcome = grassField.advance(world, groundCoverOccupiedCells(), grassBudget);
    if (outcome !== null) broadcastGrassChanges(world, outcome.sprouted, outcome.withered);
  }

  // The fringe survey (GH #192, #194) — the fourth budget and cursor, over the
  // fourth predicate (fringe.ts). It runs after the crop survey for the grass
  // survey's own reason: it shares that predicate, so the ground it stages is
  // the ground that yields to the crops which exist right now.
  fringeScanCredit = Math.min(fringeScanCredit + fringeSurveyChunksPerTick(world, dt), totalChunks);
  const fringeBudget = Math.floor(fringeScanCredit);
  if (fringeBudget > 0) {
    fringeScanCredit -= fringeBudget;
    const outcome = fringeField.advance(world, groundCoverOccupiedCells(), fringeBudget);
    if (outcome !== null) broadcastFringeChanges(world, outcome.sprouted, outcome.withered);
  }

  if (simSeconds - lastKeepaliveSeconds >= FLORA_KEEPALIVE_SECONDS) {
    broadcastForest(world);
    broadcastCrops(world);
    broadcastGrass(world);
    broadcastFringe(world);
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
  const uprooted: GrassCell[] = [];
  const strippedFringe: FringeCell[] = [];
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
    // Grass on a dug cell goes with it, same rule and same reasoning. The
    // next survey puts it back if the new height is still green — which is
    // the honest outcome: you turned the ground over, and it grew back.
    const uprootedCell = grassField.reactToEdit(cell.x, cell.y);
    if (uprootedCell !== null) uprooted.push(uprootedCell);
    // The fringe goes with the dug cell too, same rule. Its own NEIGHBOUR
    // residual — a reed whose water was drained several cells away — is named
    // in fringe.ts's reactToEdit and is not something this pass can see.
    const strippedCell = fringeField.reactToEdit(cell.x, cell.y);
    if (strippedCell !== null) strippedFringe.push(strippedCell);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  broadcastGrassChanges(world, [], uprooted);
  broadcastFringeChanges(world, [], strippedFringe);
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
  const uprooted: GrassCell[] = [];
  const strippedFringe: FringeCell[] = [];
  const clearCell = (x: number, y: number): void => {
    if (forest.fell(x, y)) felled.push({ x, y });
    const witheredCell = cropField.reactToEdit(x, y);
    if (witheredCell !== null) withered.push(witheredCell);
    // A building has a floor, so the grass under it goes too — the one place
    // grass is NOT exempt from occupancy the way it is from trees.
    const uprootedCell = grassField.reactToEdit(x, y);
    if (uprootedCell !== null) uprooted.push(uprootedCell);
    // A building has a floor over the fringe too — the same one place it is not
    // exempt from occupancy.
    const strippedCell = fringeField.reactToEdit(x, y);
    if (strippedCell !== null) strippedFringe.push(strippedCell);
  };
  for (const cell of occupation.seeded) clearCell(cell.x, cell.y);
  for (const cell of occupation.upgraded) clearCell(cell.x, cell.y);

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  broadcastGrassChanges(world, [], uprooted);
  broadcastFringeChanges(world, [], strippedFringe);
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
 * How long a tuft of grass burns. A FLASH, shorter than a crop's — a tuft is
 * less than a stand of grain, and the ordering grass < crop < tree is the whole
 * of the reasoning. 3 s buys it ~2.5 spread rolls (see below), which is enough
 * to hand the fire to a neighbouring tuft or to the tree it grows under.
 *
 * THIS NUMBER IS NOT THE MEADOW'S BRAKE, and an earlier draft of this comment
 * said it was. Measured 2026-08-25 on a 256² bed, 20 trials per point: what
 * bounds a grass fire is the meadow's own SPARSENESS, not its burn time. Grass
 * is thinned to FLORA_GRASS_SHARE_OF_256/256 ≈ 0.398 of eligible cells, which
 * sits just under the ~0.407 site-percolation threshold of the eight-neighbour
 * lattice this spread uses — so a meadow has no spanning cluster and a fire in
 * one cannot cross it, at ANY burn time:
 *
 *     burn      2s    3s    4s    6s   10s   22s
 *     cells      1     2     2     3     4    26   (mean, still air)
 *     cells      1     2     2     3     5    29   (mean, full gale)
 *
 * A SOLID bed of the same fuel runs away above 5 s (tens of thousands of cells,
 * never self-extinguishing), which is the firestorm the old "grass is not fuel"
 * comment feared — it is unreachable at the shipped thinning, and that is why
 * grass could be registered at all.
 *
 * SO THE LEVER IS DENSITY, NOT THIS. If a meadow fire should run, the number to
 * change is GRASS_CELLS_PER_TUFT (../protocol.ts) — and crossing 0.407 flips
 * the world from local scorches to unstoppable ones with very little in
 * between, so it wants measuring rather than nudging.
 */
export const FLORA_GRASS_BURN_SECONDS = 3;

/**
 * Flame size for grass. Ankle-high — well under a crop's knee-high 0.35, so a
 * grass fire reads as a bright line running through the meadow rather than as a
 * field of small bonfires.
 */
export const FLORA_GRASS_FUEL_HEIGHT = 0.15;

/**
 * What burns at this cell.
 *
 * GRASS IS FUEL AS OF 2026-08-25 (owner: "fire should spread across wheat,
 * grass, boats, buildings — anything that gets close enough"). This comment
 * used to say the opposite, and the reasoning it gave was sound about the
 * CONSEQUENCE and wrong about whether the consequence was wanted: grass is a
 * CONTINUOUS bed and warned that a torch in a meadow would then have a path to
 * the horizon. Measured (FLORA_GRASS_BURN_SECONDS's table), it does not: the
 * thinning puts grass just under the lattice's percolation threshold, so a
 * meadow fire stays a local scorch and the firestorm was never reachable. What
 * the old comment got right is that the consequence would be structural if the
 * meadow were denser — which is why the density, not the burn time, is the
 * number that carries the warning now.
 *
 * THE ORDER IS TALLEST FIRST, and here it carries meaning rather than being
 * arbitrary: grass GROWS UNDER TREES (../server/grass.ts), so a cell really can
 * hold both, and the answer has to be the tree — it is the taller flame, the
 * longer burn, and the thing a player would say was on fire. Trees before crops
 * remains the case that cannot arise, since flora will not plant a crop under a
 * tree.
 */
function floraFuelAt(x: number, y: number): { burnSeconds: number; height: number } | null {
  if (forest.has(x, y)) {
    return { burnSeconds: FLORA_TREE_BURN_SECONDS, height: FLORA_TREE_FUEL_HEIGHT };
  }
  if (cropField.has(x, y)) {
    return { burnSeconds: FLORA_CROP_BURN_SECONDS, height: FLORA_CROP_FUEL_HEIGHT };
  }
  if (grassField.has(x, y)) {
    return { burnSeconds: FLORA_GRASS_BURN_SECONDS, height: FLORA_GRASS_FUEL_HEIGHT };
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
  const scorched: GrassCell[] = [];
  for (const cell of cells) {
    if (forest.fell(cell.x, cell.y)) felled.push({ x: cell.x, y: cell.y });
    const witheredCell = cropField.reactToEdit(cell.x, cell.y);
    if (witheredCell !== null) withered.push(witheredCell);
    // ALL THREE ARE ASKED, not just the one that answered `floraFuelAt`: grass
    // shares its cell with a tree, so a burn that consumed the tree took the
    // tuft under it with it. Asking only the tallest would leave grass standing
    // in the middle of a burn scar.
    const scorchedCell = grassField.reactToEdit(cell.x, cell.y);
    if (scorchedCell !== null) scorched.push(scorchedCell);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  if (scorched.length > 0) broadcastGrassChanges(world, [], scorched);
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
    // The fringe, likewise empty at boot and sent for the same symmetry.
    broadcastFringe(world);
    // The meadow is empty here for crops.ts's own reason — nothing is
    // persisted, the first survey populates it from this world's heightmap —
    // so this is inert at boot and kept for the same symmetry.
    broadcastGrass(world);
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  /**
   * THE FOREST BELONGS TO ITS WORLD (issue #167). The final snapshot has
   * already been written when this runs, so dropping everything here costs
   * nothing and closes two holes at once: the WorldApi this module stashes for
   * fire's callbacks (`fuelWorld`) stops pinning a closed world's heightmap,
   * and a world reopened WITHOUT this plugin cannot leave the last one's trees
   * standing in a module the next session never re-enters.
   */
  onWorldClose(): void {
    resetFloraState();
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

    // The meadow, same join-time treatment. This is the largest of the three
    // sends by an order of magnitude (protocol.ts's grass arithmetic), and
    // fog of war is what keeps it proportional: a joining player is sent the
    // grass on the ground they have actually unlocked, not the world's.
    world.broadcastVisible(
      FLORA_GRASS_MESSAGE,
      grassField.cells(),
      grassPosition,
      (visible) => ({ grass: packGrassCells(visible) }),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );

    // The fringe, same join-time treatment. Smaller than the meadow by the
    // ratio of their caps (protocol.ts's fringe arithmetic), and gated by the
    // same fog of war.
    world.broadcastVisible(
      FLORA_FRINGE_MESSAGE,
      fringeField.plants(),
      (plant) => fringePosition(plant.cell),
      (visible) => packBySpecies(visible),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
    refreshUnlockedChunkCrops(world, token, cx, cy);
    refreshUnlockedChunkGrass(world, token, cx, cy);
    refreshUnlockedChunkFringe(world, token, cx, cy);
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

/** The standing grass tufts, in no particular order. */
export function standingGrass(): readonly GrassCell[] {
  return grassField.cells();
}

/** The live meadow, for suites that need to assert on its own maths. */
export function currentGrassField(): GrassField {
  return grassField;
}

/** The standing fringe plants, in no particular order. */
export function standingFringe(): readonly FringeCell[] {
  return fringeField.cells();
}

/** The live fringe, for suites that need to assert on its own maths. */
export function currentFringeField(): FringeField {
  return fringeField;
}

/** Drops all accumulated state so a suite can start from zero. */
export function resetFloraState(): void {
  stability = null;
  fuelWorld = null;
  forest.replaceAll([]);
  cropField.clear();
  grassField.clear();
  fringeField.clear();
  rng = createFloraRng(FLORA_RNG_DEFAULT_SEED);
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  scanCredit = 0;
  cropScanCredit = 0;
  grassScanCredit = 0;
  fringeScanCredit = 0;
  restoredCells = [];
}
