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
// survives a restart (./persistence.ts — the forest and the scorch record;
// see crops.ts's header for what does not) — and publishes it on TEN namespaced messages (a snapshot and a
// delta per population); the client half under ../client draws all five.
//
// THE FIVE ARE INDEPENDENT POPULATIONS, not five views of one mechanism:
// different eligibility predicate, different cap, different growth model
// (stochastic-with-a-hazard for trees, purely deterministic for crops, grass
// and the fringe — see crops.ts, grass.ts and fringe.ts), different wire
// messages. Everywhere below that forest.ts's machinery is mirrored for the
// others, it is mirrored DELIBERATELY — they are meant to read as the same
// house pattern applied five times, not as one shared abstraction.
//
// THE FIFTH IS NOT LIKE THE OTHER FOUR (GH #195). Trees, crops, grass and the
// fringe are all answers to "what does this cell's terrain deserve", re-derived
// by a rolling survey. STUMPS are a RESIDUE: nothing about a cell's height says
// whether a tree burned on it, so the list is appended to by an event (a fire
// running its course — see THE FLAMMABLE PATH below) and emptied by a clock
// (./stumps.ts), with no survey, no cursor and no chunk budget anywhere in it.
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
  SliceLoadOutcome,
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
  FLORA_STUMP_MESSAGE,
  FLORA_STUMP_CHANGES_MESSAGE,
  packCropCells,
  packFringeCells,
  packGrassCells,
  packStumpCells,
  packTreeCells,
  grassKey,
  stumpKey,
  treeKey,
  type CropCell,
  type FringeCell,
  type FringeSpecies,
  type GrassCell,
  type StumpCell,
  type TreeCell,
} from '../protocol.ts';
import {
  FLORA_RNG_DEFAULT_SEED,
  FLORA_SURVEY_INTERVAL_SECONDS,
  Forest,
  createFloraRng,
  type FloraRng,
  type BarredGround,
  type OccupancyPredicate,
} from './forest.ts';
import { CropField, cropSurveyChunksPerTick } from './crops.ts';
import { GrassField, grassSurveyChunksPerTick, isMeadowCell } from './grass.ts';
import { FringeField, fringeSurveyChunksPerTick, type FringePlant } from './fringe.ts';
import { closeFireBridge, loadFireBridge, registerFloraFuel } from './fire-bridge.ts';
import { StumpField } from './stumps.ts';
import { ScorchField, type ScorchRemaining } from './scorch.ts';
import { FLORA_SLICE_VERSION, loadForestSlice, saveForest } from './persistence.ts';
import { StabilityMap } from './stability.ts';
import { bridgedStructures, loadStructuresBridge } from './structures-bridge.ts';
import { parseStructuresOccupation } from './structures-event.ts';
import {
  parseStormDamage,
  severityAt,
} from '../../../server/src/plugins/kit/rotatingStormDamage.ts';
import {
  CYCLONE_DAMAGE_EVENT_NAME,
  FLORA_WIND_CROP_FLATTEN_CHANCE_PER_SEVERITY_SECOND,
  FLORA_WIND_CROP_MIN_SEVERITY,
  FLORA_WIND_MIN_SEVERITY,
  FLORA_WIND_TREE_FELL_CHANCE_PER_SEVERITY_SECOND,
  windEffectChance,
} from './cyclone-event.ts';

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
 * The stumps a fire left behind (GH #195). A FIFTH object, and the first that
 * is not a survey at all: nothing about a cell's terrain says whether a tree
 * burned on it, so this list is appended to by an event and emptied by a clock
 * (./stumps.ts) rather than re-derived from the heightmap like the four above.
 */
const stumpField = new StumpField();

/**
 * The ground a fire has consumed the cover from (issue #290). A SIXTH object
 * and the second that is not a survey, for stumps' reason: nothing about a
 * cell's terrain says whether it burned. It is what makes a meadow FUEL THAT
 * RUNS OUT — see ./scorch.ts's header for the bug it closes and the live
 * measurement of it.
 */
const scorchField = new ScorchField();

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
 * Sim steps elapsed. NOT A CLOCK — `simSeconds` is the clock, and nothing may
 * read this as time. It is a monotonic STAMP, and its only job is to tell
 * structureOccupiedCells' snapshot that a new tick has begun.
 *
 * A counter rather than `simSeconds` itself, because a suite is free to tick
 * with dt = 0 (and `simulate` is called for its other effects when it does):
 * a stamp that did not move would hand back a snapshot from before whatever the
 * test had just founded.
 */
let simTick = 0;

/**
 * The stamp `structureOccupiedCells`' snapshot was taken under, or
 * STRUCTURE_SNAPSHOT_UNSET when there is no snapshot yet.
 */
const STRUCTURE_SNAPSHOT_UNSET = -1;
let structureSnapshotTick = STRUCTURE_SNAPSHOT_UNSET;
const structureSnapshot = new Set<number>();

/**
 * Every cell a building currently occupies, as grass keys — rebuilt AT MOST
 * ONCE PER SIM TICK and handed back unchanged for the rest of it.
 *
 * WHY A SNAPSHOT AT ALL, when the other two occupancy terms answer straight out
 * of their own collections: `bridgedStructures()` has no membership query. It
 * returns a freshly built ARRAY of up to STRUCTURES_CAP (512) records
 * (plugins/structures/server/index.ts's standingStructures walks its whole live
 * Map), so asking it per cell would allocate that array per cell. The Set is
 * the membership index structures does not publish.
 *
 * ONE TICK OF STALENESS IS THE CONTRACT, and it is the freshness the callers
 * already had: the surveys used to rebuild this per call, twice per tick, and
 * they read it from inside the very tick that stamps it. Fire's ignitions land
 * between flora's ticks and so may see a building founded up to one tick (0.1 s
 * at TICK_HZ 10) ago as absent — against a grass survey whose own answer is up
 * to GRASS_SURVEY_INTERVAL_SECONDS (5 s) old, which is what a player would
 * actually notice.
 */
function structureOccupiedCells(): ReadonlySet<number> {
  if (structureSnapshotTick !== simTick) {
    structureSnapshot.clear();
    for (const cell of bridgedStructures()) structureSnapshot.add(grassKey(cell.x, cell.y));
    structureSnapshotTick = simTick;
  }
  return structureSnapshot;
}

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

/**
 * The scorch record restored from a snapshot, held until onWorldCreate for
 * restoredCells' reason — and one more: the remainders are dated from the sim
 * clock at the moment they are installed, and that clock has not started when
 * load() runs.
 */
let restoredScorch: readonly ScorchRemaining[] = [];

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

// ────────────────────────────────────────────────────────────────────────────
// Stumps wire (GH #195) — the fifth population's own message pair, on the wire
// shape the other four already use. Same fog-of-war rule, and FLORA_SKIP_EMPTY
// is safe here for the same reason it is safe for a tree: a stump never moves
// once it is left, so one invisible to a player now was equally invisible at
// every earlier moment it could have been announced.
//
// The delta's two halves are `left` and `rotted` rather than a grown/felled
// pair, because for this population they are genuinely different events with
// different causes — a fire finishing, and a clock running out — and naming
// them after the mechanism is what stops the decay tick reading as a fell.
// ────────────────────────────────────────────────────────────────────────────

/** A stump's own cell — what `WorldApi.broadcastVisible` gates visibility by. */
function stumpPosition(cell: StumpCell): { x: number; y: number } {
  return { x: cell.x, y: cell.y };
}

function broadcastStumps(world: WorldApi): void {
  world.broadcastVisible(
    FLORA_STUMP_MESSAGE,
    stumpField.cells(),
    stumpPosition,
    (visible) => ({ stumps: packStumpCells(visible) }),
    FLORA_SKIP_EMPTY,
  );
}

/** One cell tagged with which half of a `flora:stumpChanges` delta it belongs to. */
interface TaggedStumpChange {
  readonly kind: 'left' | 'rotted';
  readonly cell: StumpCell;
}

function broadcastStumpChanges(
  world: WorldApi,
  left: readonly StumpCell[],
  rotted: readonly StumpCell[],
): void {
  if (left.length === 0 && rotted.length === 0) return;

  const tagged: TaggedStumpChange[] = [
    ...left.map((cell): TaggedStumpChange => ({ kind: 'left', cell })),
    ...rotted.map((cell): TaggedStumpChange => ({ kind: 'rotted', cell })),
  ];
  world.broadcastVisible(
    FLORA_STUMP_CHANGES_MESSAGE,
    tagged,
    (change) => stumpPosition(change.cell),
    (visible) => ({
      left: packStumpCells(visible.filter((c) => c.kind === 'left').map((c) => c.cell)),
      rotted: packStumpCells(visible.filter((c) => c.kind === 'rotted').map((c) => c.cell)),
    }),
    FLORA_SKIP_EMPTY,
  );
}

/**
 * refreshUnlockedChunkFringe, restated for the stumps (issue #18's mechanism).
 *
 * Sent as a `left` delta and not a `flora:stumps` snapshot for
 * refreshUnlockedChunk's reason: the snapshot REPLACES the client's whole list,
 * which would erase every other chunk's scars. `left` is additive, and "this
 * stump, which already existed, is now yours to see" is exactly what it means —
 * the stump's rot deadline lives only on the server, so nothing about the
 * client's copy depends on when it learned about it.
 */
function refreshUnlockedChunkStumps(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: StumpCell[] = [];
  for (const cell of stumpField.cells()) {
    if (cell.x >= x0 && cell.x < x0 + CHUNK_SIZE && cell.y >= y0 && cell.y < y0 + CHUNK_SIZE) {
      inChunk.push(cell);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { left: packStumpCells(inChunk), rotted: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, FLORA_STUMP_CHANGES_MESSAGE, payload);
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
 * The cells a structure occupies RIGHT NOW — AND the cells a stump still holds
 * (GH #195) — as an OccupancyPredicate closure over a freshly built Set of
 * flora's own tree keys (protocol.ts's treeKey — NOT structures'
 * STRUCTURES_CELL_KEY_STRIDE, a different plugin's private encoding this one
 * must never assume matches its own).
 *
 * A STUMP HOLDS ITS CELL UNTIL IT ROTS, and that is the whole reason stumps
 * appear in a predicate named for structures rather than in a decoration list
 * the surveys never see. Fire leaves the ground undisturbed, so it resets no
 * stability clock (floraBurnedOut) — without this term the very next survey
 * after a burn could plant a full-grown tree directly on top of its own stump,
 * which is both absurd to look at and the exact thing FLORA_STUMP_ROT_SECONDS
 * is timed against (stumps.ts derives it from FLORA_STABILITY_SECONDS so that
 * the scar outlives the regrowth clock rather than racing it).
 *
 * Rebuilt on every call rather than cached: `bridgedStructures()` returns at
 * most STRUCTURES_CAP (512) cells and the stump list is capped at
 * FLORA_STUMP_CAP (4096), so building the Set costs at most ~4600 inserts —
 * still negligible against a sweep that visits 5 200 cells per tick — and a
 * fresh read means a structure founded (or a tree burned) THIS tick is
 * excluded from the very next chunk scanned, not from whichever sweep happens
 * to start next.
 */
function occupiedCells(): OccupancyPredicate {
  const occupied = new Set<number>();
  for (const cell of bridgedStructures()) occupied.add(treeKey(cell.x, cell.y));
  for (const cell of stumpField.cells()) occupied.add(treeKey(cell.x, cell.y));
  return (x: number, y: number): boolean => occupied.has(treeKey(x, y));
}

/**
 * What the two GROUND-COVER populations — the meadow and the fringe — yield to:
 * buildings, crops AND stumps, but NOT trees (owner, 2026-08-24: grass grows
 * under trees).
 *
 * A STUMP IS HERE AND A TREE IS NOT, which is not a contradiction: grass under
 * a tree is a meadow with a tree in it, and grass around a stump is a burn scar
 * with the burn hidden. Fire scorches the tuft on the cell it takes the tree
 * from (floraBurnedOut), and without this term the very next grass survey — at
 * most 5 s later — would put it straight back and swallow the stump, which
 * stands 0.15 world units against a blade's 0.125. So the bare cell lasts
 * exactly as long as the stump does, and the meadow closing back over it is
 * what "the world healed" looks like.
 *
 * ONE PREDICATE FOR ALL THREE ASKERS, not one per field — the meadow survey,
 * the fringe survey and, since issue #289, the FUEL answer (floraFuelAt, via
 * grass.ts's isMeadowCell). The two populations can never share a cell (their
 * height windows are disjoint), so what would be gained by splitting it is two
 * identical answers written twice; and a fuel answer that disagreed with the
 * survey about what a building covers is the exact drift #289 exists to close.
 * If the fringe ever needs a rule of its own, it gets its own function then —
 * what it must not do is start life as a copy of this one. Built on top of the
 * structure occupancy the other two surveys already use, so "a building was
 * founded this tick" reaches all of them identically — the difference is only
 * the extra crop term.
 *
 * QUERIED PER CELL, NOT SNAPSHOT PER CALL — changed for #289. Until then this
 * built a fresh Set of every occupied cell and closed over it, which was right
 * when the only callers were two sweeps per tick. `floraFuelAt` asks from
 * FIRE's tick, once per ignition (plugins/fire/server/blaze.ts's `ignite`),
 * and a Set rebuild there would allocate up to STRUCTURES_CAP (512) cell
 * objects per spark. Two of the three terms already answer in O(1) from their
 * own collections, so only the structures term needs help — see
 * structureOccupiedCells below. Per cell this is now three lookups instead of
 * one, against a per-tick rebuild of ~6656 inserts saved twice over: the same
 * order of work for the sweeps, and O(1) for fire.
 */
function groundCoverOccupied(x: number, y: number): boolean {
  const key = grassKey(x, y);
  return structureOccupiedCells().has(key) || cropField.has(x, y) || stumpField.has(x, y);
}

/**
 * THE ONE PLACE THE SCORCH RECORD MEETS AN OCCUPANCY (issue #297): ground a
 * survey may not put anything new on is ground that is occupied OR burned
 * inside the window (forest.ts's BarredGround). Every survey and the fuel
 * answer get their bar from here, over whichever occupancy is theirs, so no
 * population can consult the one and forget the other — the drift that had
 * crops re-sowing a burned field while the fire stood at its edge.
 */
function barredGround(isOccupied: OccupancyPredicate): BarredGround {
  return (x, y) => isOccupied(x, y) || scorchField.has(x, y);
}

/**
 * The ground-cover bar, built once: `barredGround(groundCoverOccupied)` with no
 * per-call closure, because `floraFuelAt` asks it from fire's tick once per
 * ignition (groundCoverOccupied's "queried per cell" note).
 */
const groundCoverBarred: BarredGround = barredGround(groundCoverOccupied);

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
  // Before the stability guard below, not after: the stamp must advance on
  // every step this plugin is ticked, or a world whose stability map is not up
  // yet would serve one snapshot forever.
  simTick++;
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
    const treeOccupied = occupiedCells();
    const { grown, felled } = forest.advanceSurvey(
      world,
      stability,
      simSeconds,
      rng,
      budget,
      treeOccupied,
      barredGround(treeOccupied),
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
    const outcome = cropField.advance(world, barredGround(occupiedCells()), cropBudget);
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
    const outcome = grassField.advance(world, groundCoverBarred, grassBudget);
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
    const outcome = fringeField.advance(world, groundCoverBarred, fringeBudget);
    if (outcome !== null) broadcastFringeChanges(world, outcome.sprouted, outcome.withered);
  }

  // THE DECAY TICK (GH #195) — the one population advanced by a clock instead
  // of by a sweep, so it is checked every tick rather than on a chunk budget.
  // It costs one Map iteration bounded by FLORA_STUMP_CAP and returns nothing
  // at all on the overwhelming majority of ticks (stumps.ts's advanceDecay);
  // on a world with no stumps standing it is a single size check.
  const rotted = stumpField.advanceDecay(simSeconds);
  if (rotted.length > 0) broadcastStumpChanges(world, [], rotted);

  // THE OTHER CLOCK (issue #290) — burned ground counting as meadow again. On
  // the SAME mechanism as the decay tick above rather than a timer of its own,
  // for the same reason: `simSeconds` is this plugin's only clock, so a suite
  // advances every population by ticking. It broadcasts nothing (./scorch.ts's
  // header) — the grass survey re-plants the tufts and announces them itself —
  // and it costs one comparison on a world with nothing burning, because the
  // record doubles as its own expiry queue.
  scorchField.advanceRegrowth(simSeconds);

  if (simSeconds - lastKeepaliveSeconds >= FLORA_KEEPALIVE_SECONDS) {
    broadcastForest(world);
    broadcastCrops(world);
    broadcastGrass(world);
    broadcastFringe(world);
    broadcastStumps(world);
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
  const clearedStumps: StumpCell[] = [];
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
    // A stump on a dug cell goes with it. The ground it was rooted in has just
    // moved, and unlike the four living populations there is no survey that
    // would ever put it back — which is the point: the player cleared it.
    const clearedStump = stumpField.reactToEdit(cell.x, cell.y);
    if (clearedStump !== null) clearedStumps.push(clearedStump);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  broadcastGrassChanges(world, [], uprooted);
  broadcastFringeChanges(world, [], strippedFringe);
  broadcastStumpChanges(world, [], clearedStumps);
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

  // The one thing that can invalidate structureOccupiedCells' snapshot WITHOUT
  // a tick having passed. Belt and suspenders next to that snapshot's own
  // per-tick stamp: this event is the moment the answer actually changes, and
  // on a world whose sim is paused it is the only moment there is.
  structureSnapshotTick = STRUCTURE_SNAPSHOT_UNSET;

  const felled: TreeCell[] = [];
  const withered: CropCell[] = [];
  const uprooted: GrassCell[] = [];
  const strippedFringe: FringeCell[] = [];
  const clearedStumps: StumpCell[] = [];
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
    // The building's floor goes over the stump too — a settlement clears the
    // burnt ground it is founded on. occupiedCells() already refuses to plant
    // a TREE on a stump, so this is the other half of the same rule for the
    // one thing that does not consult it.
    const clearedStump = stumpField.reactToEdit(x, y);
    if (clearedStump !== null) clearedStumps.push(clearedStump);
  };
  for (const cell of occupation.seeded) clearCell(cell.x, cell.y);
  for (const cell of occupation.upgraded) clearCell(cell.x, cell.y);

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  broadcastGrassChanges(world, [], uprooted);
  broadcastFringeChanges(world, [], strippedFringe);
  broadcastStumpChanges(world, [], clearedStumps);
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
 * ─────────────────────────────────────────────────────────────────────────
 * THE DENSITY HALF OF EVERYTHING BELOW IS SUPERSEDED (issue #289, 2026-09-01).
 *
 * The sweep is kept because its BURN-TIME axis and its site-bond mechanism are
 * still the reasoning behind the 22 s above, and because it is the measured
 * record of how this bed behaves. What no longer applies is its DENSITY axis as
 * a lever anyone can pull. Every "density" row below is the fraction of green
 * cells that were FUEL, and until #289 that fraction was the tuft roll's —
 * GRASS_CELLS_PER_TUFT = 1.78, a density of 0.5625, which is why the pair
 * (0.5625, 22 s) was chosen. Since #289 the roll decides only what is DRAWN and
 * every unoccupied green cell is fuel, so the shipped meadow IS the density-1.0
 * row and nothing short of re-authoring the green band can move it there.
 *
 * WHAT THAT MEANS FOR THIS NUMBER, read off the table: at density 1.0 the bed
 * runs away at 6 s and burns 13-19 cells at 4 s. 22 s is therefore far past the
 * runaway threshold rather than at the cheapest point on it, which is the
 * owner's call of 2026-08-29 carried through — "a burning meadow should run" —
 * with more margin than it had. Anyone tuning grass fire from here has ONE
 * lever, this constant, and the row to read is density 1.0. Re-measure before
 * moving it; the table's density column can no longer be used to trade against.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A MEADOW FIRE DOES NOT RUN, AND BOTH EARLIER DRAFTS OF THIS COMMENT NAMED
 * THE WRONG REASON. The first said this burn time was the brake; the second
 * (2026-08-25) said the brake was the meadow's SPARSENESS — grass is thinned to
 * FLORA_GRASS_SHARE_OF_256/256 ≈ 0.398, just under the ~0.407 site-percolation
 * threshold of the eight-neighbour lattice this spread uses, so the meadow was
 * said to have no spanning cluster at ANY burn time. Re-measured 2026-08-28 on
 * the same 256² bed, 20 trials per point, sweeping DENSITY as well as burn
 * time (issue #170), and that is not what the bed does:
 *
 *     mean cells burned, still air / full gale
 *     density      2s     3s     4s     6s     10s      22s
 *     0.398      1/1    2/1    1/2    2/4     5/5    39/18
 *     0.410      2/1    2/2    2/3    3/4     6/6    31/35
 *     0.500      1/1    2/2    2/3    4/3   10/27  1458/999
 *     0.750      2/2    2/3    4/5   27/27  20965/7324   runaway
 *     1.000      2/2    4/8  13/19  21014/8825  runaway   runaway
 *
 * Crossing 0.407 changes NOTHING at grass's 3 s (0.398 and 0.410 are the same
 * bed to within trial noise), and a SOLID bed — density 1.0, the worst case
 * this fuel can present — still dies at 4 cells. The 0.407 figure is the
 * threshold of PURE site percolation, which assumes every occupied neighbour
 * catches; this spread is site-BOND percolation, and the bond term is the
 * binding one. One burning cell hands a neighbour, over its whole life:
 *
 *     burn        3s     6s     10s     22s
 *     p(cardinal) 0.150  0.308  0.461   0.749
 *     p(diagonal) 0.107  0.227  0.351   0.619
 *
 * (BASE_SPREAD_RATE_PER_SECOND compounded over the ticks fireIntensity keeps
 * the cell above SPREAD_MIN_INTENSITY — 2 of 3 at this burn time.) With ~5
 * not-yet-burnt neighbours per front cell, mean offspring at 3 s is ≈ 5 × 0.13
 * ≈ 0.65 even at density 1.0: SUBCRITICAL AT EVERY DENSITY, which is exactly
 * what the sweep shows. The pure-site 0.407 only becomes the real threshold as
 * p(bond) → 1, i.e. at a TREE's 22 s — which is why the burn-22 row is the one
 * that looked like it confirmed the percolation story.
 *
 * SO NEITHER LEVER WORKS ALONE. Density is subcritical at 3 s however far it is
 * pushed, and burn time at 0.398 only reaches 39 cells at 22 s. The pair has
 * to move together, and the minimum that runs away, from a finer sweep
 * (still air, 256², 20 trials, runaway = alive at the 1200-step cap):
 *
 *     burn   min density   runaway   mean cells burned
 *     22s    0.50          6/20      1 342
 *     22s    0.5625        19/20     15 087
 *     10s    0.75          16/20     22 699
 *     8s     0.875         8/20      38 938
 *     ≤6s    none, even at 0.875
 *
 * OWNER'S CALL, 2026-08-29: a burning meadow should run. Set to the cheapest
 * pair the table offered — 0.5625 density (GRASS_CELLS_PER_TUFT = 1.78,
 * ../protocol.ts) and 22 s here, 3 → 22. A gale makes it LESS likely to run
 * (the front goes one way and burns out behind itself), and the rig's bed is
 * flat, dry and all grass, so a real meadow broken by trees, water and rain
 * runs somewhat less readily than the table says. This is the firestorm the old
 * "grass is not fuel" comment feared, chosen deliberately.
 *
 * THE PAIR IS NOW A SINGLE NUMBER, per the superseded note at the top: #289
 * moved the shipped bed from the 0.5625 row to the 1.000 row, and 22 s stayed.
 * The half of this paragraph that still binds is the last three sentences —
 * gale, rig, deliberate.
 */
export const FLORA_GRASS_BURN_SECONDS = 22;

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
 * CONSEQUENCE and wrong about whether the consequence was wanted: it called
 * grass a CONTINUOUS bed and warned that a torch in a meadow would then have a
 * path to the horizon. That is now the intended behaviour, deliberately chosen
 * twice over — see FLORA_GRASS_BURN_SECONDS.
 *
 * THE MEADOW IS FUEL, NOT THE TUFTS (issue #289, owner 2026-09-01: "make meadow
 * regions count as fuel on every cell with the tuft roll deciding only what is
 * drawn"). Until then this asked `grassField.has`, the set of cells with a
 * BLADE RENDERED on them, which the thinning roll (`grassCoversCell`,
 * ../protocol.ts) keeps only ~56% of. So ~44% of every meadow was a hole in the
 * fuel bed, scattered at the roll's own hash frequency — a fire crossing a
 * meadow had to hop them and spread in splotches, which is what the eye
 * actually reported (issue #288). The roll is a DRAWING decision and was never
 * meant to be a physical one; the physical question is "is this ground meadow",
 * and ../server/grass.ts's `isMeadowCell` is the single statement of it that
 * this and the survey both ask. What a tuft still decides is what the client
 * DRAWS, and therefore which cells a burn has a `withered` delta to send for
 * (floraBurnedOut). This line used to say a tuft decided what a burn SCORCHES;
 * since issue #290 it decides nothing of the kind — the burn record is keyed
 * on the ground, tuft or no tuft.
 *
 * AND THE MEADOW IS FUEL THAT RUNS OUT (issues #290, #297). `isMeadowCell`
 * refuses barred ground, and the bar this passes it (`groundCoverBarred`)
 * includes ground that burned inside the last FLORA_SCORCH_REGROW_SECONDS
 * (./scorch.ts), which is what stops this function handing the same cell back
 * as fuel a few seconds after it finished burning. #289 removed the old
 * consumption without noticing it was one: while the fuel answer read
 * `grassField`, floraBurnedOut's tuft removal WAS the bed being eaten. The
 * replacement is in the bar every survey receives rather than here, so no
 * survey — grass, crops, fringe or forest — can go on planting ground this
 * refuses to burn, and none can plant what this would then burn again.
 *
 * THE ORDER IS TALLEST FIRST, and here it carries meaning rather than being
 * arbitrary: grass GROWS UNDER TREES (../server/grass.ts), so a cell really can
 * hold both, and the answer has to be the tree — it is the taller flame, the
 * longer burn, and the thing a player would say was on fire. Trees before crops
 * remains the case that cannot arise, since flora will not plant a crop under a
 * tree. Crops before grass is now a case that DOES arise and is decided here
 * rather than by the occupancy term: `groundCoverOccupied` counts a crop cell
 * as occupied, so the meadow test would refuse it anyway — but the crop branch
 * above has already answered by then, with the taller flame and the shorter
 * burn a field of grain deserves.
 *
 * NO WORLD, NO GRASS. `fuelWorld` is null before onWorldCreate and after close,
 * and the meadow test needs a heightmap. Trees and crops still answer from
 * their own collections, which is the honest degradation: this plugin knows
 * what it planted without a world, and cannot tell green ground from rock
 * without one.
 */
function floraFuelAt(x: number, y: number): { burnSeconds: number; height: number } | null {
  if (forest.has(x, y)) {
    return { burnSeconds: FLORA_TREE_BURN_SECONDS, height: FLORA_TREE_FUEL_HEIGHT };
  }
  if (cropField.has(x, y)) {
    return { burnSeconds: FLORA_CROP_BURN_SECONDS, height: FLORA_CROP_FUEL_HEIGHT };
  }
  const world = fuelWorld;
  if (world !== null && isMeadowCell(world, groundCoverBarred, x, y)) {
    return { burnSeconds: FLORA_GRASS_BURN_SECONDS, height: FLORA_GRASS_FUEL_HEIGHT };
  }
  return null;
}

/**
 * A fire finished here: whatever was standing is gone, AND the meadow bed under
 * it is spent until it regrows (issue #290).
 *
 * Called ONLY for fires that ran their full course — a fire cut short by rain
 * or by a dug firebreak never reaches this (plugins/fire/server/blaze.ts's
 * three endings), and the tree it was burning survives, scorched but standing.
 *
 * Stability is NOT reset, for onStructuresChanges' reason: fire changes no
 * height, so the ground was never disturbed. A burned-out cell is as stable as
 * it was, and flora's ordinary survey recolonizes it on the usual schedule —
 * but not immediately, because of the stump this leaves.
 *
 * THE ONLY PLACE A STUMP IS EVER CREATED (GH #195), and only where a TREE
 * actually fell: `forest.fell` returning true is the proof that something with
 * a trunk stood here, so a burn that consumed only grass or only a crop leaves
 * nothing behind. ../protocol.ts's stump section holds the argument for why
 * this is the one removal path of four that leaves a residue.
 */
function floraBurnedOut(cells: readonly { readonly x: number; readonly y: number }[]): void {
  removeStanding(cells, 'fire');
}

/**
 * WHAT TOOK THE PLANT DOWN. The removal below is the same either way; these are
 * the two lines it differs by, and naming the cause is what keeps them from
 * being a boolean nobody can read at the call site.
 *
 * `fire` — the tuft under the plant went with it, and the ground is SCORCHED:
 * a burn bars every survey from this cell for FLORA_SCORCH_REGROW_SECONDS.
 *
 * `wind` — neither. A cyclone snaps a trunk and lays a field over; it does not
 * take the grass, and it leaves ground that is perfectly able to grow the next
 * thing. The forest coming back on its ordinary survey is what makes a storm
 * something the world heals from, and stamping the scorch record here would
 * silently give the wind a fire's burn scar (./scorch.ts, ./cyclone-event.ts).
 */
type FloraRemovalCause = 'fire' | 'wind';

/**
 * THE ONE REMOVAL PATH for anything of this plugin's that is taken down where
 * it stands — extracted from floraBurnedOut for issue #299, unchanged in what
 * it does for a fire.
 *
 * It is one function rather than two because everything a burn does to the
 * BOARD, a cyclone does identically: the trunk goes, the stump is left, the
 * grain withers, and each of the four wires carries the loss. The two lines
 * that are genuinely about fire are gated on `cause` above, at the point where
 * they happen, so a third caller cannot arrive and quietly inherit a burn's
 * side effects.
 *
 * THE ONLY PLACE A STUMP IS EVER CREATED (GH #195) is still here, and still
 * only where a TREE actually fell: `forest.fell` returning true is the proof
 * that something with a trunk stood here. A wind-felled tree leaves the same
 * stump a burned one does, on the same clock — the residue is the tree's, not
 * the fire's.
 */
function removeStanding(
  cells: readonly { readonly x: number; readonly y: number }[],
  cause: FloraRemovalCause,
): void {
  const world = fuelWorld;
  if (world === null) return;

  const felled: TreeCell[] = [];
  const withered: CropCell[] = [];
  const scorched: GrassCell[] = [];
  const stumps: StumpCell[] = [];
  for (const cell of cells) {
    if (forest.fell(cell.x, cell.y)) {
      felled.push({ x: cell.x, y: cell.y });
      const stump = stumpField.leave(cell.x, cell.y, simSeconds);
      if (stump !== null) stumps.push(stump);
    }
    const witheredCell = cropField.reactToEdit(cell.x, cell.y);
    if (witheredCell !== null) withered.push(witheredCell);
    // ALL THREE ARE ASKED, not just the one that answered `floraFuelAt`: grass
    // shares its cell with a tree, so a burn that consumed the tree took the
    // tuft under it with it. Asking only the tallest would leave grass standing
    // in the middle of a burn scar.
    //
    // AND MOST BURNT MEADOW CELLS HAVE NO TUFT TO TAKE (issue #289): the whole
    // meadow is fuel, the thinning roll draws ~56% of it, so `reactToEdit`
    // answers null on the rest and nothing is broadcast for them. That is the
    // correct outcome and not a gap — the mark a fire leaves on bare meadow is
    // the client's burn scar (plugins/fire/client/scar.ts), which keys on the
    // FIRE and never asks flora whether a blade stood there.
    //
    // FIRE ONLY (issue #299). Wind is the other way round: a cyclone that
    // snapped the trunk above did not take the tuft at its foot, and a meadow
    // left standing under a flattened wood is what a real storm leaves.
    if (cause === 'fire') {
      const scorchedCell = grassField.reactToEdit(cell.x, cell.y);
      if (scorchedCell !== null) scorched.push(scorchedCell);
    }

    // THE FUEL BEING CONSUMED (issue #290) — the line whose absence made a
    // meadow fire eternal. It is keyed on the GROUND, not on the tuft removal
    // above: since #289 the whole meadow is fuel and only ~56% of it has a
    // blade on it, so recording only the cells `reactToEdit` answered for
    // would leave ~44% of every burn scar as fuel the moment it burned out.
    //
    // UNCONDITIONAL since #297. The first version stamped only meadow ground,
    // so a burned crop cell was never recorded: the withered crop stopped
    // counting as occupied, the meadow test handed the cell back as grass
    // fuel a tick later, and the crop survey re-sowed it inside 5 s. A fire
    // finished here, whatever stood here; the ground remembers that. Stamping
    // a tree cell a second time (grass under it burned earlier) restarts the
    // clock, which is the refresh the old meadow-ground carve-out existed for.
    //
    // FIRE ONLY (issue #299), for the reason FloraRemovalCause states: the
    // scorch record is a record of BURNING, and it is what bars every survey
    // from a cell. Stamping it for wind would stop the wood the storm just
    // flattened from growing back for as long as a burn scar lasts, which is
    // the difference between a storm and a fire.
    if (cause === 'fire') scorchField.scorch(cell.x, cell.y, simSeconds);
  }

  broadcastChanges(world, [], felled);
  broadcastCropChanges(world, [], withered);
  if (scorched.length > 0) broadcastGrassChanges(world, [], scorched);
  broadcastStumpChanges(world, stumps, []);
}

/**
 * A CYCLONE PASSED OVER (issue #299): the wind fells trees and lays crops flat
 * inside the storm's disc.
 *
 * THE WHOLE DISC, NOT THE EVENT'S SAMPLE. The emitter's `cells` list is a
 * bounded sample "for consumers with no spatial index"
 * (server/src/plugins/kit/rotatingStorms.ts, where it says so), and this plugin
 * owns one: the standing forest and the crop field are the index, and both are
 * capped (FLORA_TREE_CAP 4096, FLORA_CROP_CAP 2048), so answering exactly costs
 * one distance test per plant per second of storm — against a survey that
 * already visits thousands of cells every tick. Reacting to twelve sampled
 * cells instead would fell perhaps one tree a minute out of a disc of forty
 * thousand cells, which is not a hurricane.
 *
 * ONE ROLL PER PLANT PER EVENT, on this plugin's OWN seeded generator (`rng`,
 * the one whose state persists with the forest), so a world replayed from the
 * same seed loses the same trees. Never Math.random: the whole point of a
 * single persisted sequence is that a storm is part of the history a save can
 * reproduce. The forest's own map iterates in insertion order, so the order the
 * rolls are drawn in is fixed too.
 *
 * TREES AND CROPS ARE ROLLED SEPARATELY, each against its own bar and its own
 * rate (./cyclone-event.ts) — grain goes over in wind a trunk stands up to. The
 * two lists are then removed through the ONE removal path, which is safe
 * because flora never plants a crop under a tree: a cell is in at most one of
 * them, so a plant is never rolled for on another population's terms.
 */
function reactToCycloneDamage(payload: unknown): void {
  if (fuelWorld === null) return;
  const damage = parseStormDamage(payload);
  // A malformed event changes NOTHING, on the rule every consumer here keeps:
  // half-applying it would fell trees under a storm that was never described.
  if (damage === null) return;

  const taken: TreeCell[] = [];

  for (const tree of forest.cells()) {
    const severity = severityAt(damage, tree.x, tree.y);
    if (severity < FLORA_WIND_MIN_SEVERITY) continue;
    const chance = windEffectChance(
      severity,
      damage.durationSeconds,
      FLORA_WIND_TREE_FELL_CHANCE_PER_SEVERITY_SECOND,
    );
    if (rng.next() < chance) taken.push({ x: tree.x, y: tree.y });
  }

  for (const crop of cropField.cells()) {
    const severity = severityAt(damage, crop.x, crop.y);
    if (severity < FLORA_WIND_CROP_MIN_SEVERITY) continue;
    const chance = windEffectChance(
      severity,
      damage.durationSeconds,
      FLORA_WIND_CROP_FLATTEN_CHANCE_PER_SEVERITY_SECOND,
    );
    if (rng.next() < chance) taken.push({ x: crop.x, y: crop.y });
  }

  if (taken.length === 0) return;
  removeStanding(taken, 'wind');
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
    return saveForest(forest, rng, scorchField, simSeconds);
  },
  version: FLORA_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    // REFUSE, DO NOT ERASE, a forest from a newer build. loadForestSlice
    // answers an unknown version with the EMPTY forest, and the next snapshot
    // would then write that empty forest over every tree in the world — as
    // destructive as structures demolishing the town. The host parks it.
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > FLORA_SLICE_VERSION) {
      return 'refuse';
    }
    const restored = loadForestSlice(data);
    restoredCells = restored.cells;
    restoredScorch = restored.scorch;
    rng = createFloraRng(restored.rngState);
    return undefined;
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

    // The scorch record, dated from now (issue #297). Cells outside this world
    // are dropped here rather than by a survey, because no survey ever visits
    // them: the record is only ever asked about a cell, never walked.
    scorchField.restore(
      restoredScorch.filter((entry) => entry.x < world.worldSize && entry.y < world.worldSize),
      simSeconds,
    );
    restoredScorch = [];

    // THE CROSS-PLUGIN DEPENDENCY PATTERN (structures-bridge.ts): one
    // synchronous question to the host — who is running as structures in this
    // world? A world where the answer is "nobody", because the folder is gone
    // or the operator switched it off, degrades to an empty occupied set, and
    // every occupiedCells() query simply sees no buildings.
    loadStructuresBridge(world);

    // The same pattern, pointing the other way (./fire-bridge.ts's header):
    // flora TELLS fire what of its own can burn. Resolved through the host, so
    // the forest is flammable exactly when fire is running in this world — and
    // is not when the operator has switched fire off. The registration is
    // still buffered and replayed by the bridge.
    fuelWorld = world;
    loadFireBridge(world);
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
    // The stumps, empty at boot for a STRONGER reason than the three above: no
    // survey will ever populate them either, because a stump is the record of
    // an event and nothing is persisted (../protocol.ts's stump section). The
    // first stump of a session is left by the first fire of that session.
    broadcastStumps(world);
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
    // The registration fire holds is withdrawn by the bridge that made it
    // (issue #208): a source left standing is asked for fuel every spread
    // step of the NEXT world, whether or not this plugin is in it.
    closeFireBridge();
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
    // The same rule, a second emitter (issue #299): a cyclone's wind damage.
    // The name is in ./cyclone-event.ts beside the numbers that answer it.
    if (event === CYCLONE_DAMAGE_EVENT_NAME) reactToCycloneDamage(payload);
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

    // The stumps, same join-time treatment. Ordinarily empty, and empty costs
    // nothing to send under FLORA_SKIP_EMPTY — but a player joining a world
    // that is on fire, or that burned in the last FLORA_STUMP_ROT_SECONDS,
    // must see the scars rather than wait out a keepalive for them.
    world.broadcastVisible(
      FLORA_STUMP_MESSAGE,
      stumpField.cells(),
      stumpPosition,
      (visible) => ({ stumps: packStumpCells(visible) }),
      { ...FLORA_SKIP_EMPTY, onlyPlayerId: player.id },
    );
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
    refreshUnlockedChunkCrops(world, token, cx, cy);
    refreshUnlockedChunkGrass(world, token, cx, cy);
    refreshUnlockedChunkFringe(world, token, cx, cy);
    refreshUnlockedChunkStumps(world, token, cx, cy);
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

/** The standing stumps (GH #195), in no particular order. */
export function standingStumps(): readonly StumpCell[] {
  return stumpField.cells();
}

/** The live stump field, for suites that need to assert on its own clock. */
export function currentStumpField(): StumpField {
  return stumpField;
}

/** Drops all accumulated state so a suite can start from zero. */
export function resetFloraState(): void {
  stability = null;
  fuelWorld = null;
  forest.replaceAll([]);
  cropField.clear();
  grassField.clear();
  fringeField.clear();
  stumpField.clear();
  scorchField.clear();
  rng = createFloraRng(FLORA_RNG_DEFAULT_SEED);
  simSeconds = 0;
  simTick = 0;
  // Dropped, not merely emptied: the stamp has to say "no snapshot" so that the
  // reset tick 0 rebuilds rather than reusing the previous world's buildings.
  structureSnapshotTick = STRUCTURE_SNAPSHOT_UNSET;
  structureSnapshot.clear();
  lastKeepaliveSeconds = 0;
  scanCredit = 0;
  cropScanCredit = 0;
  grassScanCredit = 0;
  fringeScanCredit = 0;
  restoredCells = [];
}
