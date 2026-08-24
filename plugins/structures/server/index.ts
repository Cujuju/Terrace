// structures — man-made settlements as Conway's Game of Life (classic
// B3/S23), run over the world's buildable ground. A structure exists exactly
// where a live cell exists; its tier is how long it has survived AND how
// crowded its neighbourhood is (tiers.ts). Terrain is the board's walls
// (suitability.ts). The whole mechanic lives in ./life.ts; this file is the
// plugin wiring — the clock, the wire, and the persistence slice.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO PATHS.
//
// THE CA is polled: every CA_GENERATION_INTERVAL_SECONDS the whole board
// steps (amortised across ticks, life.ts's GenerationSurvey) — every birth,
// death and tier change in the plugin's steady state happens here, plus an
// occasional seed pattern to keep a quiet WORLD from staying quiet forever,
// and an occasional stir event (owner decision 2026-08-19) to keep an already
// settled BOARD from freezing into still lifes forever — see life.ts's
// attemptSeed and attemptStir doc comments respectively.
//
// DEMOLITION is reactive: onTerrainChanged carries the full server-side
// diff, so an edit under a live cell kills it in the same call that applied
// the edit — before the terrain diff reaches any client. A live cell whose
// NEIGHBOUR was edited (which can silently break its own buildability — see
// life.ts's header) is left for the next generation to notice; that lag is
// named and accepted there.
//
// Both paths write to the same board and emit the same delta message, so a
// client applies "the ground moved, three buildings fell" and "a block
// aged into a hut" through one code path.
//
// FOG OF WAR (added issue #18). Every send — the CA's own delta, the join
// snapshot, the keepalive — is now per RECIPIENT: a player is sent only the
// structures inside chunks they have personally unlocked (WorldApi.
// broadcastVisible), and a recipient whose own subset is empty is sent
// nothing at all rather than an empty message (STRUCTURES_SKIP_EMPTY is safe
// for the same reason flora's identical flag is — see its doc comment). The
// one gap a 60 s keepalive cannot close fast enough — a player creeping into
// a chunk that already has buildings standing in it — gets its own targeted
// push instead of waiting: see onChunkUnlockedForToken / refreshUnlockedChunk
// below, flora's identical mechanism applied to this plugin's own wire shape.
// ─────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE, dayOfSimMillis, type CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  STRUCTURES_ALL_MESSAGE,
  STRUCTURES_CHANGES_MESSAGE,
  STRUCTURES_PLUGIN_NAME,
  cellOfKey,
  packCells,
  packStructureCells,
  structureKey,
  type StructureCell,
} from '../protocol.ts';
import {
  shouldSeed,
  CA_STIR_PROBABILITY_PER_GENERATION,
  GenerationSurvey,
  attemptSeed,
  attemptStir,
  generationChunksPerTick,
  type LiveCellRecord,
} from './life.ts';
import { resetBlessings } from './blessings.ts';
import { loadStructures, saveStructures } from './persistence.ts';
import { STRUCTURES_RNG_DEFAULT_SEED, createStructuresRng, type StructuresRng } from './rng.ts';
import { isBuildableCell } from './suitability.ts';

/**
 * Simulated seconds between unsolicited full re-broadcasts.
 *
 * A REPAIR cadence, not a sync mechanism — flora's identical role, at the
 * same 60 s: a delta stream cannot notice it has drifted, so a periodic full
 * snapshot bounds any such divergence at one minute.
 */
export const STRUCTURES_KEEPALIVE_SECONDS = 60;

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching every other plugin's
// shape here. No world-readiness null-guard is needed anymore — the current
// plugin contract hands every hook its own WorldApi directly (issue #15), so
// there is no "did onWorldCreate run yet" stash to check.

/** The board: cellKey → {age, tier}. Swapped wholesale on every generation. */
let live: Map<number, LiveCellRecord> = new Map();

/** Completed generations since the world began — persisted, diagnostic. */
let generation = 0;
/**
 * World-day settlers last arrived on; -1 for never. Persisted.
 *
 * THE CALENDAR ITSELF IS NOT THIS PLUGIN'S (2026-08-23): the day comes from
 * `WorldApi.simMillis`, the one world clock, so structures' Monday IS the sky's
 * Monday. This plugin briefly kept its own persisted millisecond clock for the
 * same job; it was correct in isolation and wrong the moment you compared it to
 * the sunrise, which is the whole reason the clock moved to core.
 *
 * `simSeconds` below stays — it is a float accumulator for cadences measured in
 * seconds (the keepalive), where drift is invisible. What a plugin must not do
 * is derive a DAY from one of those.
 */
let lastSeedDay = -1;
let restoredLastSeedDay = -1;

let survey = new GenerationSurvey();
let rng: StructuresRng = createStructuresRng(STRUCTURES_RNG_DEFAULT_SEED);

/** Accumulated simulated seconds — the only clock this plugin has. */
let simSeconds = 0;
let lastKeepaliveSeconds = 0;

/** Fractional chunks owed to the CA sweep, carried between ticks. */
let scanCredit = 0;

/** Restored from a snapshot, held until onWorldCreate — flora's identical seam. */
let restoredLive: Map<number, LiveCellRecord> = new Map();
let restoredGeneration = 0;

// ────────────────────────────────────────────────────────────────────────────
// Wire
// ────────────────────────────────────────────────────────────────────────────

function liveCells(): StructureCell[] {
  const cells: StructureCell[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    cells.push({ x: cell.x, y: cell.y, tier: record.tier });
  }
  return cells;
}

/** A structure cell's own position — what `WorldApi.broadcastVisible` gates visibility by. */
function structurePosition(cell: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return { x: cell.x, y: cell.y };
}

/**
 * FOG OF WAR (issue #18). Every broadcastVisible call this plugin makes
 * passes `skipEmpty: true` — safe for the identical reason flora's own
 * FLORA_SKIP_EMPTY is: per-player masks only ever GROW (issue #17), so a
 * structure invisible to a player right now was equally invisible to them
 * whenever it last changed. See WorldApi.broadcastVisible's doc comment for
 * the general rule.
 */
const STRUCTURES_SKIP_EMPTY = { skipEmpty: true } as const;

function broadcastAll(world: WorldApi): void {
  world.broadcastVisible(
    STRUCTURES_ALL_MESSAGE,
    liveCells(),
    structurePosition,
    (visible) => ({ structures: packStructureCells(visible) }),
    STRUCTURES_SKIP_EMPTY,
  );
  lastKeepaliveSeconds = simSeconds;
}

/** One cell tagged with which of `structures:changes`' three lists it belongs to. */
interface TaggedStructureChange {
  readonly kind: 'founded' | 'upgraded' | 'demolished';
  readonly x: number;
  readonly y: number;
  /** Only meaningful for founded/upgraded; demolished carries no tier on the wire. */
  readonly tier: number;
}

/**
 * Sends one delta. Silent when nothing changed anywhere — the common case by
 * far between generations. Per RECIPIENT, silence is more common still:
 * broadcastVisible additionally skips any player whose own subset of THIS
 * delta is empty (STRUCTURES_SKIP_EMPTY) — the ordinary case for a change
 * happening in someone else's territory.
 */
function broadcastChanges(
  world: WorldApi,
  founded: readonly StructureCell[],
  upgraded: readonly StructureCell[],
  demolished: ReadonlyArray<{ x: number; y: number }>,
): void {
  if (founded.length === 0 && upgraded.length === 0 && demolished.length === 0) return;

  const tagged: TaggedStructureChange[] = [
    ...founded.map((c): TaggedStructureChange => ({ kind: 'founded', x: c.x, y: c.y, tier: c.tier })),
    ...upgraded.map((c): TaggedStructureChange => ({ kind: 'upgraded', x: c.x, y: c.y, tier: c.tier })),
    ...demolished.map((c): TaggedStructureChange => ({ kind: 'demolished', x: c.x, y: c.y, tier: 0 })),
  ];
  world.broadcastVisible(
    STRUCTURES_CHANGES_MESSAGE,
    tagged,
    structurePosition,
    (visible) => ({
      founded: packStructureCells(visible.filter((c) => c.kind === 'founded')),
      upgraded: packStructureCells(visible.filter((c) => c.kind === 'upgraded')),
      demolished: packCells(visible.filter((c) => c.kind === 'demolished')),
    }),
    STRUCTURES_SKIP_EMPTY,
  );
}

/**
 * THE TARGETED-REFRESH PATH (issue #18) — flora's identical mechanism
 * (server/index.ts's refreshUnlockedChunk), for the same reason: the 60 s
 * keepalive is a REPAIR cadence, far too slow for "a player just earned a
 * chunk that already has buildings in it" to feel instant. Fired once per
 * successful per-token unlock. Sent as a `founded` DELTA, not a
 * `structures:all` snapshot — the client's ALL-message handler REPLACES its
 * whole board (see ../client/index.ts), which would wipe out every other
 * chunk this player already knows about, whereas `founded` is additive.
 */
function refreshUnlockedChunk(world: WorldApi, token: string, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const inChunk: StructureCell[] = [];
  for (const cell of liveCells()) {
    if (cell.x >= x0 && cell.x < x0 + CHUNK_SIZE && cell.y >= y0 && cell.y < y0 + CHUNK_SIZE) {
      inChunk.push(cell);
    }
  }
  if (inChunk.length === 0) return;

  const payload = { founded: packStructureCells(inChunk), upgraded: [], demolished: [] };
  for (const player of world.players()) {
    if (player.token === token) world.sendTo(player.id, STRUCTURES_CHANGES_MESSAGE, payload);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The two paths
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE SIM STEP. Fixed order, once per host tick:
 *
 *   1. advance the clock;
 *   2. advance the CA sweep by this tick's share of the board. On the tick
 *      that completes it: swap in the new generation, maybe seed a fresh
 *      pattern AND/OR stir a few sparks next to an existing settlement onto
 *      the RESULT (so a just-placed seed or spark is evaluated by B3/S23
 *      starting next generation, never the one that just ran — life.ts's
 *      attemptSeed and attemptStir doc comments), and broadcast everything
 *      that changed;
 *   3. keepalive, on its own independent cadence.
 */
function simulate(world: WorldApi, dt: number): void {
  simSeconds += dt;

  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  scanCredit = Math.min(scanCredit + generationChunksPerTick(world, dt), totalChunks);
  const budget = Math.floor(scanCredit);
  if (budget > 0) {
    scanCredit -= budget;
    const outcome = survey.advance(world, live, budget);
    if (outcome !== null) {
      live = outcome.nextLive;
      generation++;

      // SETTLERS COME ON MONDAY, AND ONLY TO AN EMPTY WORLD — see life.ts's
      // shouldSeed for the rule and why the old per-generation coin flip went.
      // `lastSeedDay` advances on the ATTEMPT, not on success: a Monday whose
      // one attempt found nowhere to build is still a Monday that has had its
      // turn, and re-trying it every generation for the rest of the day is
      // precisely the ninety-six-times-a-week behaviour the rule replaces.
      let seeded: StructureCell[] = [];
      const today = dayOfSimMillis(world.simMillis);
      if (shouldSeed(live, today, lastSeedDay)) {
        lastSeedDay = today;
        const placement = attemptSeed(world, live, rng);
        if (placement !== null) {
          for (const cell of placement) live.set(structureKey(cell.x, cell.y), { age: 0, tier: 0 });
          seeded = placement;
        }
      }

      // Independent roll from seeding, same "AFTER the swap" reasoning: a
      // spark ignited here is a birth the CA hasn't evaluated yet, so it is
      // deferred to next generation like a fresh seed is (see attemptStir's
      // doc comment). Rolled every generation regardless of whether seeding
      // fired above — the two events are unrelated and independently timed.
      let stirred: StructureCell[] = [];
      if (rng.next() < CA_STIR_PROBABILITY_PER_GENERATION) {
        const sparks = attemptStir(world, live, rng);
        if (sparks !== null) {
          for (const cell of sparks) live.set(structureKey(cell.x, cell.y), { age: 0, tier: 0 });
          stirred = sparks;
        }
      }

      broadcastChanges(world, [...outcome.born, ...seeded, ...stirred], outcome.upgraded, outcome.died);

      // THE CHRONICLE'S EAR (2026-08-19): the same generation facts, as a
      // server-side world event. `seeded` (a new settlement) and the tier/loss
      // lists are what a historian can use; routine births and stir sparks
      // are churn, deliberately not part of the event's meaning — consumers
      // get `seeded`, `upgraded`, `died`, nothing else. Emitted only when
      // something happened, so a quiet generation costs no fan-out.
      if (seeded.length > 0 || outcome.upgraded.length > 0 || outcome.died.length > 0) {
        world.emitEvent('changes', {
          cause: 'generation',
          seeded,
          upgraded: outcome.upgraded,
          died: outcome.died,
        });
      }
    }
  }

  if (simSeconds - lastKeepaliveSeconds >= STRUCTURES_KEEPALIVE_SECONDS) broadcastAll(world);
}

/**
 * THE REACTIVE PATH. Fired after any applied edit with the FULL server-side
 * diff. A live cell standing exactly on a changed cell is killed immediately
 * — see life.ts's header for why this covers only the direct hit, and why
 * the (rarer) neighbour-invalidation case is left to the next generation.
 */
function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (diff.length === 0) return;

  const demolished: Array<{ x: number; y: number }> = [];
  for (const cell of diff) {
    if (live.delete(structureKey(cell.x, cell.y))) {
      demolished.push({ x: cell.x, y: cell.y });
    }
  }
  broadcastChanges(world, [], [], demolished);

  // The chronicle's ear, sculpt side: an edit-caused loss is a different
  // STORY than a generation's (a hand, not fate), so the cause travels.
  if (demolished.length > 0) world.emitEvent('changes', { cause: 'sculpt', died: demolished });
}

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

const persistence: PersistenceSlice = {
  save(): unknown {
    return saveStructures(live, generation, rng, lastSeedDay);
  },
  load(data: unknown): void {
    const restored = loadStructures(data);
    restoredLive = restored.live;
    restoredGeneration = restored.generation;
    restoredLastSeedDay = restored.lastSeedDay;
    rng = createStructuresRng(restored.rngState);
  },
};

export const plugin: TerracePlugin = {
  name: STRUCTURES_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    // Any snapshot has already been restored by the time this runs, so the
    // board here is either empty (fresh world) or the persisted one. Cells
    // outside this world (a snapshot restored onto a smaller WORLD_SIZE) are
    // now pruned immediately below (isBuildableCell already rejects an
    // out-of-bounds cell), rather than surviving in `live` until the next
    // generation's own rescan would have dropped them — a stricter, earlier
    // cut of the SAME case the footprint prune below exists for.
    //
    // FOOTPRINT-FIT PRUNE, ON LOAD (owner directive 2026-08-20). A structure
    // persisted from BEFORE suitability.ts's hasClearFootprint shipped may
    // stand on ground that no longer passes isBuildableCell's now-stricter
    // check — founded back when only the four orthogonal neighbours were
    // surveyed, it can be straddling a diagonal terrace edge or a corner of
    // water. PRUNE, not grandfather: the whole point of this rule is that a
    // structure must never render hanging off its own ground, and
    // grandfathering would leave exactly that defect standing, silently, for
    // as long as the world lives — worst in the self-hosted worlds most
    // likely to predate the fix, which is precisely who this change protects.
    // Filtered HERE, before restoredLive ever becomes `live`, rather than
    // left for the next CA generation's own full-board rescan to drop it
    // (life.ts's header: every generation already recomputes buildability
    // from scratch) — that path is correct but not instant: it would still
    // broadcast the violator, unfiltered, to broadcastAll below and to any
    // player joining before the next generation completes (up to
    // CA_GENERATION_INTERVAL_SECONDS = 15s later), which is the exact
    // user-visible defect this rule exists to close, not an acceptable
    // residual. One pass over the restored board — at most STRUCTURES_CAP
    // cells — costs nothing measurable at boot, run once, never again.
    live = new Map();
    for (const [key, record] of restoredLive) {
      const cell = cellOfKey(key);
      if (isBuildableCell(world, cell.x, cell.y)) live.set(key, record);
    }
    generation = restoredGeneration;
    lastSeedDay = restoredLastSeedDay;
    restoredLive = new Map();
    restoredGeneration = 0;
    restoredLastSeedDay = -1;

    // No players are connected yet — this is only so a client already
    // listening at boot is not left empty for up to a keepalive.
    broadcastAll(world);
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    // FOG OF WAR (issue #18): filtered to the structures inside THIS player's
    // own unlocked view (onlyPlayerId), same skipEmpty rule as every other
    // send in this plugin — a player who has just joined and unlocked
    // nothing of their own yet is sent nothing, which is exactly what their
    // client already renders by default.
    world.broadcastVisible(
      STRUCTURES_ALL_MESSAGE,
      liveCells(),
      structurePosition,
      (visible) => ({ structures: packStructureCells(visible) }),
      { ...STRUCTURES_SKIP_EMPTY, onlyPlayerId: player.id },
    );
  },

  onChunkUnlockedForToken(world: WorldApi, token: string, cx: number, cy: number): void {
    refreshUnlockedChunk(world, token, cx, cy);
  },

  persistence,
};

// ────────────────────────────────────────────────────────────────────────────
// Test seams
// ────────────────────────────────────────────────────────────────────────────

// THE PILGRIMS-FACING SURFACE (owner decision 2026-08-19). The pilgrims
// plugin duck-types both of these off this module through the relics→mana
// dynamic-import bridge pattern: `standingStructures` to find the towns near
// a settled monster, `setBlessedStructureCells` to prosper the ones on an
// active route. Re-exported here so the bridge has ONE module to load.
export { setBlessedStructureCells } from './blessings.ts';

/**
 * A standing town as bridge consumers see it: the wire cell plus how long it
 * has STOOD — `age` is life.ts's generations-survived counter (resets on
 * birth), the CA's own measure of "has been here some while". Deliberately
 * NOT on the client wire: packStructureCells packs x/y/tier explicitly, so
 * this field costs the broadcast nothing.
 */
export interface StandingStructure extends StructureCell {
  readonly age: number;
}

export function standingStructures(): StandingStructure[] {
  const cells: StandingStructure[] = [];
  for (const [key, record] of live) {
    const cell = cellOfKey(key);
    cells.push({ x: cell.x, y: cell.y, tier: record.tier, age: record.age });
  }
  return cells;
}

/** The live board's raw records (age AND tier), for suites asserting on the CA's own state. */
export function currentLive(): ReadonlyMap<number, LiveCellRecord> {
  return live;
}

export function currentGeneration(): number {
  return generation;
}

export function resetStructuresState(): void {
  live = new Map();
  generation = 0;
  survey = new GenerationSurvey();
  resetBlessings();
  rng = createStructuresRng(STRUCTURES_RNG_DEFAULT_SEED);
  simSeconds = 0;
  lastKeepaliveSeconds = 0;
  scanCredit = 0;
  restoredLive = new Map();
  restoredGeneration = 0;
}
