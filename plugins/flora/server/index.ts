// flora — trees grow on green ground that has been left alone (owner,
// 2026-08-14: "I would like to see trees spawn in the green layers when they've
// been stable for a short period of time").
//
// Core knows nothing about vegetation. This half owns the whole mechanic —
// what counts as green (./bands.ts), what counts as left alone (./stability.ts),
// how fast a meadow fills in (./forest.ts), and what survives a restart
// (./persistence.ts) — and publishes it on two namespaced messages; the client
// half under ../client draws it.
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
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO PATHS.
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
// Both paths write to the same two structures and emit the same delta message,
// so a client applies "the ground moved, four trees fell" and "five trees grew"
// through one code path.
// ─────────────────────────────────────────────────────────────────────────────

import type { CellDiff } from '@terrace/shared';
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
  FLORA_FOREST_MESSAGE,
  FLORA_PLUGIN_NAME,
  packTreeCells,
  type TreeCell,
} from '../protocol.ts';
import {
  FLORA_RNG_DEFAULT_SEED,
  FLORA_SURVEY_INTERVAL_SECONDS,
  Forest,
  createFloraRng,
  type FloraRng,
} from './forest.ts';
import { loadForestSlice, saveForest } from './persistence.ts';
import { StabilityMap } from './stability.ts';

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

function forestPayload(): { trees: number[] } {
  return { trees: packTreeCells(forest.cells()) };
}

function broadcastForest(world: WorldApi): void {
  world.broadcast(FLORA_FOREST_MESSAGE, forestPayload());
  lastKeepaliveSeconds = simSeconds;
}

/**
 * Sends one delta. Silent when nothing changed — the common case by far, since
 * most surveys of a settled world grow nothing, and a message saying so would be
 * this plugin's entire steady-state bandwidth spent on nothing.
 */
function broadcastChanges(
  world: WorldApi,
  grown: readonly TreeCell[],
  felled: readonly TreeCell[],
): void {
  if (grown.length === 0 && felled.length === 0) return;
  world.broadcast(FLORA_CHANGES_MESSAGE, {
    grown: packTreeCells(grown),
    felled: packTreeCells(felled),
  });
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
 * THE SIM STEP. Fixed order, once per host tick:
 *
 *   1. advance the clock — everything else reads simSeconds, nothing reads a
 *      wall clock, so a test advances time by ticking;
 *   2. advance the rolling survey by this tick's share of the world. It returns
 *      a result only on the tick that completes a sweep, which is the tick that
 *      culls and grows (forest.ts);
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
    const { grown, felled } = forest.advanceSurvey(world, stability, simSeconds, rng, budget);
    broadcastChanges(world, grown, felled);
  }

  if (simSeconds - lastKeepaliveSeconds >= FLORA_KEEPALIVE_SECONDS) broadcastForest(world);
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
  for (const cell of diff) {
    stability.markChanged(cell.x, cell.y, simSeconds);
    if (forest.fell(cell.x, cell.y)) felled.push({ x: cell.x, y: cell.y });
  }

  broadcastChanges(world, [], felled);
}

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

    // No players are connected at world create, so this is not how anyone gets
    // their first forest (onPlayerJoin is). It is here so that a client which is
    // somehow already listening is not left empty for up to a keepalive.
    broadcastForest(world);
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // The room sends the core join snapshot before this hook, so the client is
    // already sized and listening. The whole forest goes directly to that one
    // player rather than being left to the keepalive: a joining player must
    // never look at a bare world for up to FLORA_KEEPALIVE_SECONDS, and
    // broadcasting it to everyone would re-send 18 KB to every existing client
    // every time somebody connects.
    world.sendTo(player.id, FLORA_FOREST_MESSAGE, forestPayload());
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

/** Drops all accumulated state so a suite can start from zero. */
export function resetFloraState(): void {
  stability = null;
  forest.replaceAll([]);
  rng = createFloraRng(FLORA_RNG_DEFAULT_SEED);
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  scanCredit = 0;
  restoredCells = [];
}
