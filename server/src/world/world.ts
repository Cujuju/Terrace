// The World — the single authoritative world object owned by the process
// (design §3.2, glossary §7). It owns exactly three things: the heightmap, the
// unlocked-chunk mask, and the connected players.
//
// It knows NOTHING about Colyseus. Outgoing traffic goes through a MessageSink,
// which the room installs. That is what makes "a rooms layer could be added
// later without rework" true, and it is what lets the whole intent pipeline be
// unit-tested with no network.

import {
  applySculpt,
  BAND_HEIGHT,
  buildFreshwaterMap,
  CHUNK_SIZE,
  NEIGHBOURHOOD_CELLS,
  cellX,
  cellY,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  clearColumns,
  RiverNetworkIndex,
  createChunkMask,
  createHeightmap,
  heightAt,
  isChunkUnlocked,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  SEA_LEVEL,
  setColumn,
  simMillisAtRealTime,
  SpringIndex,
  unlockChunk,
  type CellDiff,
  type ChunkPayload,
  type FreshwaterMap,
  type Heightmap,
  type RiverNetwork,
  type SculptOptions,
  type ServerMessage,
  type Span,
} from '@terrace/shared';
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../config.ts';
import { NULL_SINK, type MessageSink } from '../net/message-sink.ts';
import type { Player } from '../player.ts';
import {
  FRESH_SEABED_HEIGHT,
  buildFreshGenesisTerrain,
  carveFallbackAbyss,
  drawGenesisSeed,
  freshGenesisHeightAt,
} from './genesis.ts';
import { applyInitialUnlock } from './initial-unlock.ts';
import { chunkPayloadOf, collectUnlockedChunkPayloads } from './mask-filter.ts';
import { generateWorldName } from './world-name.ts';

/**
 * The second layer of the difficulty guarantee, behind loadConfig's validation.
 *
 * WorldApi.difficulty promises plugins an integer in [MIN_WORLD_DIFFICULTY,
 * MAX_WORLD_DIFFICULTY], and plugins interpolate against it — a NaN or an
 * out-of-band value would silently become a NaN or an absurd derived rate deep
 * inside somebody else's economy, which is exactly the class of failure mana
 * already guards its own inputs against. The env path cannot produce one, so
 * this exists for the OTHER callers (tests, a future world-gen plugin, a
 * supervisor building a World directly) and costs one comparison at genesis.
 */
function normalizeDifficulty(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WORLD_DIFFICULTY;
  const rounded = Math.round(value);
  if (rounded < MIN_WORLD_DIFFICULTY) return MIN_WORLD_DIFFICULTY;
  if (rounded > MAX_WORLD_DIFFICULTY) return MAX_WORLD_DIFFICULTY;
  return rounded;
}

/**
 * Minimum real time between full river-network recomputes, in milliseconds
 * (mechanics card 27 — Rivers & Springs — see docs/DESIGN.md's "Decisions
 * made 2026-08-19" entry for the full cost argument this constant closes).
 *
 * A recompute re-traces only the rivers whose terrain moved (RiverNetworkIndex,
 * issue #226 — it used to retrace all 24, measured at 11.33 ms on a sculpted
 * 2048² world, dominated by basin filling). Cheap, but not free — the spring
 * refresh still runs in front of it — and a held brush emits
 * an intent every ~120 ms (SCULPT_REPEAT_INTERVAL_MS, client/src/config.ts)
 * PER PLAYER while a sim plugin (mudslides, storm surge, volcanoes) sculpts
 * on every 10 Hz tick with nobody touching anything: a naive per-sculpt
 * recompute would scale the server's CPU with (sculpt rate), not with a fixed
 * budget.
 *
 * IT USED TO BE MUCH WORSE, and the fixes for that are elsewhere. Until issue
 * #235 the recompute also rescanned all size² cells for springs (~48 ms on a
 * 2048² world), and until #226 it re-traced every river whether or not
 * anything under it had moved, so this throttle was the ONLY thing standing
 * between a sculpting plugin and a fifth of a core. Both are now incremental
 * (SpringIndex and RiverNetworkIndex, shared/src/rivers.ts) and this constant
 * is back to being what it says it is: a cadence, not a dam.
 *
 * Throttling to a fixed wall-clock cadence instead decouples the cost from
 * both player count and sculpt rate: however many players are sculpting,
 * however fast, the world pays for at most one recompute every
 * RIVER_RECOMPUTE_INTERVAL_MS. 250 ms (4 Hz) is chosen so a held stroke still
 * sees its river update roughly every other click — responsive enough for
 * "sculpting a river's course" to read as immediate — while remaining a full
 * order of magnitude cheaper than a per-intent recompute at the ~8/s a held
 * brush can reach.
 *
 * WALL-CLOCK, NOT TICK-DRIVEN, AND DELIBERATELY SO: unlike terrain math
 * itself, this is a performance cache with no gameplay or determinism stake
 * — the authoritative heightmap is unaffected by when a consumer last asked
 * for its derived river network, and the client recomputes independently, on
 * its own cadence, from its own copy of the terrain (see
 * client/src/render/riverRig.ts). `Date.now()` is therefore the right clock,
 * not the fixed simulated tick `dt` (tick.ts) that terrain SIMULATION uses to
 * stay reproducible.
 */
export const RIVER_RECOMPUTE_INTERVAL_MS = 250;

/** Milliseconds in a second — the world clock's unit conversion. */
const MILLISECONDS_PER_SECOND = 1000;

export class World {
  readonly map: Heightmap;
  readonly mask: Uint8Array;

  /**
   * This world's difficulty rating: 1 = warm/forgiving, 100 = punishing
   * (WORLD_DIFFICULTY, decided 2026-08-14 — see config.ts and docs/DESIGN.md).
   *
   * The World holds it and NOTHING HERE READS IT. It is a neutral scalar core
   * publishes to plugins through WorldApi.difficulty; every mechanic derived
   * from it lives in a plugin. Kept on the World rather than threaded from the
   * config at each call site because "difficulty" is a property of the world a
   * plugin is looking at, and the WorldApi is the only thing plugins are given.
   *
   * Deployment configuration, NOT snapshot state: it is deliberately absent from
   * the snapshot, so a host who re-rates their world by editing the environment
   * gets the new rating on the next boot rather than a value frozen at genesis.
   */
  readonly difficulty: number;

  /**
   * How much simulated time this world has lived, in MILLISECONDS — the world
   * CLOCK, and the only one there is.
   *
   * WHY CORE OWNS IT (2026-08-23). Until now there was no clock anywhere in
   * core, so every plugin that needed elapsed time kept its own accumulator:
   * day/night's `elapsedSeconds`, the chronicle's `simMillis`, structures'
   * `simSeconds`. Only the chronicle persisted its one, so THE SKY RESET TO
   * DAWN ON EVERY RESTART and no two plugins could agree what time it was.
   * That was survivable while each clock was private bookkeeping.
   *
   * The weekday calendar (shared/src/calendar.ts) ended it: a player told it is
   * Monday must be able to look at the sky and agree, and three independent
   * clocks cannot deliver that. One clock, owned by the world, published to
   * plugins through WorldApi and persisted with the heightmap.
   *
   * SNAPSHOT STATE, like the name and unlike the difficulty: how old a world is
   * is a fact ABOUT that world, not a deployment setting, and a world that
   * forgot its age on every boot would restart its week every time.
   *
   * MILLISECONDS AS AN INTEGER, never accumulated float seconds: summing a
   * float `dt` drifts measurably over a few thousand ticks (the chronicle's own
   * clock comment worked this out first), and a drifting clock moves day
   * boundaries — which for the calendar means Monday itself wanders.
   */
  simMillis = 0;

  /**
   * The world clock at this world's GENESIS, or null on a world that has never
   * been anchored to real time.
   *
   * WHAT IT IS FOR. Since the clock became a function of real time
   * (shared/src/calendar.ts, WORLD_EPOCH_REAL_MILLIS) `simMillis` is a fact
   * about the universe rather than about this world: every world alive right
   * now reads the same number. The one thing it can no longer answer is HOW OLD
   * THIS WORLD IS, which is the number a saga heading counts ("Day 57") and the
   * only number a player has ever been shown. That is what this stamp restores:
   * age is `simMillis - genesisMillis`, and `worldAgeDays` turns it into days.
   *
   * SNAPSHOT STATE, and the most permanent kind there is — a world's birthday
   * never changes, so unlike the clock it is written once and read back
   * forever. A snapshot that predates it carries the world's AGE in its
   * `sim_millis` column instead, which `anchorClockToRealTime` converts.
   *
   * NULL, NOT ZERO, while unanchored: zero is a legitimate genesis (a world
   * born at the epoch), so it cannot double as "unknown". A world that is never
   * anchored — every test world — reports genesis 0 through the getter below,
   * which makes its age equal to its clock and reproduces exactly the
   * tick-counting behaviour the clock had before it met real time.
   */
  private genesisMillisValue: number | null = null;

  /**
   * When this world began, on the world clock. Zero on an unanchored world:
   * see the field above.
   */
  get genesisMillis(): number {
    return this.genesisMillisValue ?? 0;
  }

  /**
   * Sets the clock to what real time says it is, and stamps the world's
   * genesis if it does not have one yet.
   *
   * CALLED ONCE PER SESSION, at the boot seam in session.ts, and never during
   * a tick. That division is the whole design: real time decides where the
   * clock STARTS, `advanceClock` carries it forward from there, so the sim
   * loop stays integer-only and free of any dependency on the wall clock (the
   * determinism rule in CLAUDE.md), while a restart still lands the world at
   * the hour and weekday real time says it should be. The cost, stated: a
   * process whose sim stalls or is suspended runs behind real time until its
   * next boot, and nothing corrects that mid-session.
   *
   * THE GENESIS CASES, all three handled by one subtraction:
   *   - a brand-new world has no accumulated clock, so genesis is now;
   *   - a snapshot written before this change stored its AGE in `simMillis`,
   *     so genesis is now minus that age — which keeps its saga's day
   *     numbering continuous across the upgrade instead of restarting it;
   *   - a snapshot written since carries its own genesis, and nothing here
   *     touches it.
   */
  anchorClockToRealTime(realMillis: number = Date.now()): void {
    const accumulatedAge = this.simMillis;
    this.simMillis = simMillisAtRealTime(realMillis);
    if (this.genesisMillisValue === null) {
      this.genesisMillisValue = Math.max(0, this.simMillis - accumulatedAge);
    }
  }

  /**
   * What this world is CALLED — minted once at genesis by world-name.ts and
   * then persisted with the heightmap, so every restart and every player sees
   * the same name.
   *
   * SNAPSHOT STATE, and the opposite of `difficulty` in that respect. A name is
   * the world's identity: a host who restarts their server must get the same
   * world back, name included, which is precisely what a snapshot is for.
   * Difficulty is deployment configuration a host re-rates by editing their
   * environment, so it deliberately is NOT stored. The two live side by side
   * here and are persisted differently on purpose.
   */
  private worldName: string;

  /** What this world is CALLED. See the doc comment above; set by rename(). */
  get name(): string {
    return this.worldName;
  }

  /**
   * Renames the world (world management, 2026-08-22).
   *
   * MARKS THE WORLD DIRTY, which is the entire mechanism by which the new name
   * reaches disk: the name is snapshot state, so the next snapshot carries it
   * and every future boot reads it back. Nothing else is touched — the id a
   * world's FILE is named by never changes, so renaming can never move,
   * collide with, or overwrite another world's file.
   *
   * A world's name was `readonly` until world management existed, on the
   * reasoning that identity is minted once at genesis. That is still true of
   * MINTING: no code path mints a second name for a world that has one. What
   * changed is that a human may now correct the label, which is a different
   * act from the world becoming a different world.
   */
  rename(next: string): void {
    if (next === this.worldName) return;
    this.worldName = next;
    this.changedSinceSnapshot = true;
  }

  private sink: MessageSink = NULL_SINK;
  private readonly playersById = new Map<string, Player>();

  /**
   * Per-token unlock masks (issue #17 — per-player territory). `mask` above
   * stays the SIMULATION/union mask (wildlife census, flora, monsters — every
   * existing consumer keeps reading it, unchanged); this is the NEW per-token
   * layer a chunk unlock actually happens against. Keyed by Player.token, not
   * by connection id, so a reconnect with the same token finds its own mask
   * again under a brand-new sessionId. Lazily populated — a token nobody has
   * granted anything to simply has no entry, which reads identically to an
   * all-locked createChunkMask() without allocating one.
   */
  private readonly masksByToken = new Map<string, Uint8Array>();

  /**
   * Set whenever terrain or mask changes; cleared when a snapshot is written.
   * The snapshot scheduler writes ONLY when this is true (design open question
   * 4, decided: "snapshot every SNAPSHOT_INTERVAL_S only if the world changed"),
   * so an idle server does no disk I/O at all.
   */
  private changedSinceSnapshot = false;

  /**
   * The last computed river network, and when it was computed — the cache
   * `riverNetwork()` serves from, refreshed at most every
   * RIVER_RECOMPUTE_INTERVAL_MS (see that constant's doc comment for the
   * cost argument). `null` cache with `Number.NEGATIVE_INFINITY` staleness
   * means "never computed" — a fresh world's or a just-restored world's
   * first read always recomputes rather than serving a stale empty network.
   */
  private riverNetworkCache: RiverNetwork | null = null;
  private riverNetworkComputedAtMs = Number.NEGATIVE_INFINITY;
  /** Set on every terrain-changing sculpt; cleared once a recompute runs. */
  private riverNetworkStale = true;

  /**
   * The per-cell freshwater transpose of `riverNetworkCache`, and the exact
   * network object it was built from.
   *
   * INVALIDATED BY IDENTITY, NOT BY A SECOND STALENESS FLAG. `riverNetwork()`
   * already guarantees that two calls with no intervening recompute return the
   * SAME object (its doc comment), so "is my transpose current?" is answerable
   * as `cachedFor === riverNetwork()` — one reference compare. A parallel
   * `freshwaterStale` boolean would be a second copy of the recompute
   * condition (sculpt flag + throttle window), and the two copies are exactly
   * the kind of pair that drifts: any future change to when the network
   * refreshes would silently leave the transpose behind. This way the
   * transpose cannot outlive the network it describes.
   */
  private freshwaterCache: FreshwaterMap | null = null;
  private freshwaterCacheNetwork: RiverNetwork | null = null;

  /**
   * `isCellUnlocked` as a value, allocated ONCE per world.
   *
   * The river layer takes the activity predicate as a callback and calls it
   * per cell; a fresh `(x, y) => this.isCellUnlocked(x, y)` at each call site
   * would hand the engine a new function identity every time, which is both a
   * per-refresh allocation and — more to the point — a hidden invitation for
   * two call sites to disagree about what "active" means. One field, one
   * answer: `SpringIndex` and every recompute share it.
   */
  private readonly isCellUnlockedHere = (x: number, y: number): boolean => this.isCellUnlocked(x, y);

  /**
   * The incrementally maintained spring-candidate set behind `riverNetwork()`
   * (issue #235).
   *
   * WHAT IT REPLACES. Every refresh used to rescan all `size²` cells for local
   * maxima — ~48 ms on a 2048² world, whatever had actually changed — so a sim
   * plugin sculpting every tick made the world pay that four times a second
   * (RIVER_RECOMPUTE_INTERVAL_MS) with no player involved. The index costs the
   * CHANGE instead: a sculpt re-tests its own diff's neighbourhood and nothing
   * else.
   *
   * THIS CLASS IS THE INDEX'S ONLY INFORMANT, and deliberately so — an index
   * is only as correct as what it is told, and `World` is the one object that
   * owns both the heightmap and the unlock mask. Every mutation of either is a
   * method here (`applySculpt`, `unlockChunk`, `grantChunkToToken`,
   * `rewindTo`), each of which notifies it; no plugin and no call site is in a
   * position to forget, because none of them can reach the state directly.
   */
  private readonly springIndex: SpringIndex;

  /**
   * The rivers themselves, cached per spring and re-traced only where the
   * terrain a trace read has moved (issue #226) — the other half of #235's
   * split, and informed by this class on exactly the same three seams as
   * `springIndex` above (`applySculpt`, `noteChunkBecameActive`, `rewindTo`).
   */
  private readonly riverIndex: RiverNetworkIndex;

  private constructor(
    map: Heightmap,
    mask: Uint8Array,
    difficulty: number,
    name: string,
    simMillis = 0,
  ) {
    this.map = map;
    this.mask = mask;
    this.difficulty = difficulty;
    this.worldName = name;
    this.simMillis = simMillis;
    // After `this.map`, necessarily: the index holds the heightmap it indexes.
    // Costs nothing here — it scans lazily, on the first `springs()` (see
    // SpringIndex), so a world whose rivers are never read never pays.
    this.springIndex = new SpringIndex(this.map, this.isCellUnlockedHere);
    this.riverIndex = new RiverNetworkIndex(this.map, this.isCellUnlockedHere);
  }

  /**
   * Advances the world clock by one tick's worth of time.
   *
   * ROUNDED PER TICK rather than accumulated as a float: exact for any
   * millisecond-representable tick rate, and integers add without error. A
   * negative or non-finite `dt` is ignored rather than trusted — the clock only
   * ever moves forward, and a NaN here would poison every day boundary in the
   * world for the rest of its life.
   *
   * DOES NOT mark the world dirty. A clock that dirtied the world every tick
   * would defeat the snapshot scheduler's "write only what changed" rule and
   * rewrite the whole heightmap every few seconds; the clock rides along with
   * whatever else caused a save, and the worst case is that a world nobody
   * touches reloads a few minutes younger than it was.
   */
  advanceClock(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.simMillis += Math.round(dt * MILLISECONDS_PER_SECOND);
  }

  /**
   * A brand-new world: AN OCEAN WITH ISLANDS IN IT, drawn edge to edge from
   * one seed and different every time. The provisional starter region is
   * unlocked as before (see initial-unlock.ts). Used when no snapshot exists.
   * Every constant, every guarantee pass and the order they run in are
   * documented at the top of genesis.ts.
   *
   * The terrain is generated HERE, on the server, and deliberately not in
   * `createHeightmap`: shared/ is the determinism contract that client and
   * server both run, and world GENESIS is not part of it. The client never
   * generates terrain — it receives chunks — so a zero-filled allocator stays
   * the honest shared primitive and "what a new world looks like" stays a
   * server policy that a future world-gen plugin can replace.
   *
   * `seed` defaults to a fresh random draw (`drawGenesisSeed`) — the one
   * intentionally non-deterministic moment in genesis. A caller that supplies
   * its own seed (tests, chiefly) gets a fully reproducible world: genesis is
   * a pure function of `(size, seed)` from that point on, so the same pair
   * always produces the same heightmap, byte for byte.
   *
   * CONSEQUENCES, ALL INTENDED AND ALL REAL:
   *
   *   1. Raising land costs band-steps, and how many varies by seed and by
   *      place: a shallow cell is one sculpt from dry (at DEFAULT_SCULPT_AMOUNT
   *      = one band per intent), the abyss is a dozen.
   *   2. The starter square HAS LAND from 2026-08-25 — at least
   *      GENESIS_MIN_STARTER_ISLANDS islands, guaranteed — where before it was
   *      all water by construction. Land beyond it is up to the seed, and a
   *      reveal plugin may uncover an island, a mountain range or more open
   *      sea, decided at genesis and not before.
   *   3. Every generated world still contains water at least as deep as
   *      `FRESH_SEABED_HEIGHT` (`FRESH_SEABED_BANDS_BELOW_SEA` bands down) —
   *      guaranteed by the habitat pass at every size config.ts will boot — and
   *      checked again, loudly, right after generation, the same "fail at boot
   *      rather than serve a broken world" idiom `applyInitialUnlock` uses.
   *
   * Only this path generates. `restore` rebuilds whatever a snapshot holds, so
   * existing worlds are untouched.
   *
   * Not a cosmetic mismatch worth chasing on the client: the client boots its
   * local heightmap at band 0 and shows a flat sea until the first chunk
   * arrives, so for the one pre-connect frame it draws a shoreline where the
   * server has a coast and (now) varied terrain beyond it. The first
   * `chunkUnlock` overwrites it. Left alone on purpose — the fix belongs in
   * the client's boot state.
   */
  static createFresh(
    size: number,
    difficulty: number = DEFAULT_WORLD_DIFFICULTY,
    name: string = generateWorldName(),
    seed: number = drawGenesisSeed(),
  ): World {
    const map = createHeightmap(size);
    const terrain = buildFreshGenesisTerrain(size, seed);

    // Row-major, ascending, matching every other sweep over the grid. Order is
    // irrelevant to the result here (each cell is a pure function of its own
    // coordinates plus the prebuilt `terrain`, never of iteration order) and
    // kept conventional so it stays that way.
    let deepestHeight = MAX_HEIGHT;
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const height = freshGenesisHeightAt(terrain, x, y);
        map.cells[row + x] = height;
        if (height < deepestHeight) deepestHeight = height;
      }
    }

    // Every fresh world must contain water at least as deep as the wildlife
    // plugin's deep-water threshold (see FRESH_SEABED_DEPTH_BELOW_SEA in
    // genesis.ts) or the original bug — whales with nowhere to live — comes
    // back. Proven true by construction at every size config.ts will boot: the
    // habitat pass's deep target is only clamped below MIN_WORLD_SIZE.
    //
    // BELOW that size a direct World.createFresh call (a test, in practice) can
    // still reach a world whose starter square is too small to hold both
    // habitat minima, and the proportional clamp can round the deep target to
    // nothing. Rather than leave such a world unbootable, fall back to carving
    // the guarantee in directly.
    if (deepestHeight > FRESH_SEABED_HEIGHT) {
      deepestHeight = carveFallbackAbyss(map, size);
    }

    // Should be unreachable — carveFallbackAbyss always sets one cell to
    // exactly FRESH_SEABED_HEIGHT — but fail loudly rather than silently ship
    // a world with no deep water, the same idiom applyInitialUnlock uses for
    // its own boot-time sanity check just below.
    if (deepestHeight > FRESH_SEABED_HEIGHT) {
      throw new Error(
        `fresh genesis produced no water at or below FRESH_SEABED_HEIGHT ` +
          `(deepest cell was ${deepestHeight}) — deep-water guarantee violated`,
      );
    }

    const world = new World(
      map,
      createChunkMask(size),
      normalizeDifficulty(difficulty),
      name,
    );
    applyInitialUnlock(world);
    // The starter unlock is part of world creation, not a mutation of an
    // existing world: the first snapshot will be written by the normal dirty
    // path anyway, so start clean and let real edits mark it.
    world.changedSinceSnapshot = false;
    return world;
  }

  /**
   * Rebuilds a world from a snapshot. Both buffers are validated against the
   * configured size — a mismatch means the DB was written by a differently
   * configured server, and silently continuing would produce a corrupt world.
   * (PER-CELL height validity — `isValidHeight`, issue #13 — is already
   * guaranteed by the time `cells` reaches here: SnapshotStore.loadLatest
   * throws on a corrupt cell at decode, before any caller of it, `restore`
   * included, ever sees the array. This function's own checks are narrower
   * on purpose — they only cover what SnapshotStore cannot know, namely
   * whether the snapshot fits the world THIS process is configured for.)
   *
   * The union mask and every per-token mask are length-checked against this
   * world's chunk count below (see the `expectedMask`/`tokenMask.length`
   * checks) — that check belongs here, not in SnapshotStore, because only
   * `createChunkMask` knows the expected byte length for a given world size.
   *
   * `difficulty` comes from the CURRENT environment, never from the snapshot:
   * it is deployment configuration, so re-rating a world is an env edit plus a
   * restart, and an old snapshot never overrides today's setting.
   *
   * `name` comes from the SNAPSHOT, which is the opposite rule and the right
   * one: the name is what this world is, so it must come back exactly as it was
   * stored. `null` means the snapshot predates world names (or was written by a
   * build that stored none), and the world is named here, once — see
   * mintedName below for why that also marks the world dirty.
   *
   * `tokenMasks` is per-token unlock state (issue #17), keyed by the same
   * token a reconnecting client resends. LEGACY RESTORE, STATED LOUDLY: a
   * snapshot written before issue #17 has no such rows at all, so this
   * defaults to an empty map — the union `mask` above still carries every
   * chunk that was ever unlocked (unchanged, since it was always the ONLY
   * mask), but every per-token mask starts from nothing. Concretely: every
   * player who reconnects to an upgraded server re-creeps their own view of
   * territory the world already contains, even land they had personally
   * opened before the upgrade. This is the exact, owner-accepted legacy
   * behaviour from issue #17 decision 4 — not a bug to chase.
   *
   * A per-token entry whose mask byte length does not match this world's
   * chunk count (corruption, a hand-edited DB, a foreign world's row) is
   * DROPPED rather than thrown on: unlike the heightmap/union-mask length
   * checks above — where a mismatch means the whole snapshot belongs to a
   * differently-sized world and continuing would misalign every row — one
   * bad per-token row only costs ONE player their remembered creep, which is
   * exactly the same "re-creep, nothing else breaks" outcome as a legacy
   * snapshot, so degrading it is honest rather than a special case.
   */
  static restore(
    size: number,
    cells: Int16Array,
    mask: Uint8Array,
    difficulty: number = DEFAULT_WORLD_DIFFICULTY,
    name: string | null = null,
    tokenMasks: ReadonlyMap<string, Uint8Array> = new Map(),
    // A snapshot written before the clock existed has none; such a world simply
    // starts its calendar now, which costs at most one extra Monday.
    simMillis = 0,
    // Null on any snapshot written before the world clock was anchored to real
    // time: `anchorClockToRealTime` reconstructs it from `simMillis`, which on
    // such a snapshot is the world's age. See genesisMillisValue.
    genesisMillis: number | null = null,
    // The span side table (layered columns), keyed by cell index — see
    // WorldSnapshot.columnSpans. An EMPTY map (the default, and what every
    // pre-spans snapshot reads back as) restores a fully one-span world, which
    // is today's behaviour and must not regress. Each entry is expected to be
    // canonical and in-range for THIS size: the persistence path guarantees it
    // at decode (SnapshotStore.hydrate cross-checks every entry against the
    // restored heights), so like `cells` above this parameter arrives trusted
    // rather than re-validated here.
    columnSpans: ReadonlyMap<number, Span[]> = new Map(),
  ): World {
    const map = createHeightmap(size);
    if (cells.length !== map.cells.length) {
      throw new RangeError(
        `snapshot heightmap has ${cells.length} cells, world size ${size} needs ${map.cells.length}`,
      );
    }
    const expectedMask = createChunkMask(size);
    if (mask.length !== expectedMask.length) {
      throw new RangeError(
        `snapshot mask has ${mask.length} bytes, world size ${size} needs ${expectedMask.length}`,
      );
    }
    map.cells.set(cells);
    // Layered columns go back AFTER the heights, and clearColumns runs FIRST:
    // that ordering is what keeps "absent from the table means one span" true
    // for a restore too — the heights define the one-span baseline, then each
    // stored entry lays its layers back over exactly its own cell. setColumn
    // rewrites `cells[i]` to each entry's topmost ceiling; that is a no-op by
    // construction here because hydrate has already verified the two agree,
    // so the restored walkable surface is bit-identical to the stored one.
    clearColumns(map);
    for (const [i, spans] of columnSpans) {
      setColumn(map, cellX(size, i), cellY(size, i), spans);
    }
    expectedMask.set(mask);

    // A stored name is used verbatim; a missing or blank one is minted now.
    const stored = name?.trim() ?? '';
    const mintedName = stored === '' ? generateWorldName() : null;
    const world = new World(
      map,
      expectedMask,
      normalizeDifficulty(difficulty),
      mintedName ?? stored,
      Number.isInteger(simMillis) && simMillis >= 0 ? simMillis : 0,
    );
    // Same defensive parse as the clock above: a corrupt or hand-edited column
    // leaves the world unanchored rather than dated to a nonsense birthday.
    if (genesisMillis !== null && Number.isInteger(genesisMillis) && genesisMillis >= 0) {
      world.genesisMillisValue = genesisMillis;
    }

    for (const [token, tokenMask] of tokenMasks) {
      if (tokenMask.length !== expectedMask.length) continue; // see doc comment: degrade, don't throw
      const copy = createChunkMask(size);
      copy.set(tokenMask);
      world.masksByToken.set(token, copy);
    }

    // THE NAME MUST REACH DISK, and `dirty` is the only mechanism that gets it
    // there: the snapshot scheduler writes ONLY a changed world, so an existing
    // world nobody sculpts would otherwise be re-named on every single boot and
    // never persist any of those names. Marking it changed here is not a
    // workaround for that rule — it is the rule applied honestly, because the
    // world in memory genuinely differs from the one on disk.
    if (mintedName !== null) world.changedSinceSnapshot = true;
    return world;
  }

  get size(): number {
    return this.map.size;
  }

  get chunksPerEdge(): number {
    return chunksPerEdge(this.map.size);
  }

  /** True when terrain or mask changed since the last successful snapshot. */
  get dirty(): boolean {
    return this.changedSinceSnapshot;
  }

  /**
   * Called once a snapshot of this world has been handed to the writer.
   *
   * "HANDED TO", NOT "LANDED ON DISK" (issue #273). The off-thread write path
   * clears the flag at handoff, because what the flag tracks is whether the
   * CURRENT world state differs from the last one anybody undertook to store —
   * waiting for the commit would let a sculpt that arrived during the write
   * be swallowed by the acknowledgement of a snapshot taken before it.
   */
  markSnapshotted(): void {
    this.changedSinceSnapshot = false;
  }

  /**
   * Called when a snapshot that had been handed off FAILED to reach disk.
   *
   * Puts the world back in the state the synchronous path would have left it
   * in — dirty, so the next cadence tick tries again. Without this a full disk
   * would produce one logged error and then an hour of silence, because the
   * world would look saved.
   */
  markSnapshotFailed(): void {
    this.changedSinceSnapshot = true;
  }

  /**
   * Replaces this LIVE world's terrain and territory with a stored snapshot's
   * — the world-rollback path (2026-08-21). `restore` builds a new World at
   * boot; this one rewinds the World every plugin, the room and the tick loop
   * are already holding a reference to, which is why it mutates in place
   * instead of returning a replacement.
   *
   * WHAT IT DOES NOT DO, and both omissions are deliberate:
   *
   *  - It does not touch `name` or `difficulty`. Every snapshot in one
   *    database is one world; a rollback moves that world back in time, it
   *    does not swap it for another, so its identity is not in play. (Were a
   *    stored name ever to differ, the LIVE name is the honest one — see the
   *    field's doc comment on why the name is fixed for a world's life.)
   *  - It does not notify anybody. The caller owns the ordering of "write the
   *    safety snapshot, rewind, restore plugin state, re-announce to clients",
   *    and that sequence is stated once, in world/rollback.ts. A world that
   *    broadcast from in here would broadcast BEFORE the plugins holding the
   *    other half of the world's state had been rewound.
   *
   * Throws (leaving the world untouched) if the snapshot describes a
   * differently-sized world: every stored index would shift, exactly as at
   * boot. Both length checks run BEFORE the first write for that reason — a
   * half-applied rewind is the one outcome with no way back.
   */
  rewindTo(
    cells: Int16Array,
    mask: Uint8Array,
    tokenMasks: ReadonlyMap<string, Uint8Array> = new Map(),
    // The restore point's layered columns, keyed by cell index (see
    // World.restore for the trusted-input precondition). An EMPTY map — every
    // pre-spans restore point, and any world that never carved — must still
    // rewind to a fully one-span world, which is exactly what the
    // clearColumns-first ordering below guarantees.
    columnSpans: ReadonlyMap<number, Span[]> = new Map(),
  ): void {
    if (cells.length !== this.map.cells.length) {
      throw new RangeError(
        `restore point holds ${cells.length} cells, this ${this.size}² world needs ` +
          `${this.map.cells.length}`,
      );
    }
    if (mask.length !== this.mask.length) {
      throw new RangeError(
        `restore point holds a ${mask.length}-byte mask, this ${this.size}² world needs ` +
          `${this.mask.length}`,
      );
    }

    this.map.cells.set(cells);
    // A restore point carries heights PLUS its own span table, so the rewind
    // lays both back down. clearColumns FIRST, always: it returns the live map
    // to the one-span case everywhere, erasing whatever spans the state being
    // undone had accumulated, and only then does each stored entry re-layer
    // its own cell. Absent-from-the-table therefore still means one span after
    // a rewind — the same contract `restore` keeps at boot, kept by the same
    // ordering rather than by luck. setColumn rewriting `cells[i]` is a no-op
    // here because hydrate verified every entry's top ceiling against the very
    // heights being restored.
    clearColumns(this.map);
    for (const [i, spans] of columnSpans) {
      setColumn(this.map, cellX(this.size, i), cellY(this.size, i), spans);
    }
    this.mask.set(mask);

    // Per-token masks are REPLACED, not merged. A merge would keep territory
    // that was only ever unlocked after the restore point — i.e. it would
    // leave a player standing on ground this world no longer says they have,
    // which is precisely the inconsistency the rollback is undoing. A row
    // sized for another world is dropped rather than thrown on, the same
    // degrade-don't-brick rule `restore` applies and for the same reason.
    this.masksByToken.clear();
    for (const [token, tokenMask] of tokenMasks) {
      if (tokenMask.length !== this.mask.length) continue;
      const copy = createChunkMask(this.size);
      copy.set(tokenMask);
      this.masksByToken.set(token, copy);
    }

    // Every derived cache now describes terrain that no longer exists.
    // Invalidated by hand here rather than by calling the sculpt path's
    // invalidation, because a rewind is not a sculpt: there is no diff to
    // report and no throttle window worth honouring — the next reader must
    // recompute, immediately, however recently the last recompute ran. Hence
    // NEGATIVE_INFINITY rather than merely setting the stale flag.
    this.riverNetworkCache = null;
    this.riverNetworkComputedAtMs = Number.NEGATIVE_INFINITY;
    this.riverNetworkStale = true;
    // A rewind reports no diff, so the spring index has no way to learn what
    // moved — every cell and every mask bit may have. Stale is the honest
    // answer, and it costs nothing until the next reader asks.
    this.springIndex.markStale();
    this.riverIndex.markStale();
    this.freshwaterCache = null;
    this.freshwaterCacheNetwork = null;

    // The world in memory now differs from whatever was last written, and the
    // caller is about to write it — but marking it here keeps the invariant
    // true even if that write fails, so the scheduler retries instead of
    // leaving a rewound world with nothing on disk that matches it.
    this.changedSinceSnapshot = true;
  }

  /** Installs the network sink (room create) or removes it (room dispose). */
  setSink(sink: MessageSink): void {
    this.sink = sink;
  }

  /**
   * Sends a core protocol message to everyone. The Colyseus message type is the
   * payload's own `type` literal and the payload is the whole protocol object —
   * so what goes on the wire is exactly a `ServerMessage` from
   * shared/src/protocol.ts, with no server-only re-shaping to drift from.
   */
  broadcast(message: ServerMessage): void {
    this.sink.broadcast(message.type, message);
  }

  /** Same contract as broadcast(), to a single player. */
  sendTo(playerId: string, message: ServerMessage): void {
    this.sink.sendTo(playerId, message.type, message);
  }

  /** Plugin-namespaced traffic; the namespace is applied by the WorldApi. */
  broadcastRaw(type: string, payload: unknown): void {
    this.sink.broadcast(type, payload);
  }

  sendRawTo(playerId: string, type: string, payload: unknown): void {
    this.sink.sendTo(playerId, type, payload);
  }

  heightAt(x: number, y: number): number {
    return heightAt(this.map, x, y);
  }

  isChunkUnlocked(cx: number, cy: number): boolean {
    return isChunkUnlocked(this.mask, chunkIndex(this.map.size, cx, cy));
  }

  /**
   * ANTI-CHEAT: the check the intent pipeline runs on a brush centre. Callers
   * must have bounds-checked (x,y) first — chunkIndexOfCell throws otherwise.
   *
   * DELIBERATELY STILL THE UNION MASK after issue #17. Per-player masks
   * (below) gate what STREAMS to a given player, not what they may aim a
   * brush at: once a chunk is unlocked for anyone, the server itself no
   * longer treats its terrain as secret, so a second player sculpting there
   * is shared-world behaviour, not a leak. Making sculpt permission — or the
   * ongoing terrainDiff broadcast in sculpt-service.ts, which also still
   * filters against this same union mask — per-player as well is the
   * fog-of-war follow-up flagged in the issue, not this change: see
   * isChunkVisibleTo/isCellVisibleTo below for the primitive that follow-up
   * will need.
   */
  isCellUnlocked(x: number, y: number): boolean {
    return isChunkUnlocked(this.mask, chunkIndexOfCell(this.map.size, x, y));
  }

  /**
   * Flips a chunk's mask bit and streams it to every client.
   *
   * Returns false when the chunk was already unlocked, so callers (a reveal
   * plugin, typically) can unlock idempotently without re-sending 512 B of
   * heights. Streaming here — rather than at the call site — guarantees that a
   * chunk becoming visible and clients learning about it cannot drift apart.
   *
   * GLOBAL / BROADCAST unlock — flips the bit for every player at once. Kept
   * for genesis (initial-unlock.ts) and any future plugin that genuinely wants
   * "unlocked for the whole world"; per-player policy (the reveal plugin,
   * since issue #17) uses unlockChunkForToken below instead.
   */
  unlockChunk(cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    if (isChunkUnlocked(this.mask, index)) return false;

    unlockChunk(this.mask, index);
    this.changedSinceSnapshot = true;
    this.noteChunkBecameActive(cx, cy);
    this.broadcast({ type: 'chunkUnlock', chunks: [chunkPayloadOf(this, cx, cy)] });
    return true;
  }

  /**
   * A chunk just joined the UNION mask — the one place that fact reaches the
   * derived river caches.
   *
   * WHY THIS EXISTS AT ALL (a bug fixed alongside issue #235). Unlocking never
   * touched `riverNetworkStale`, so a newly revealed chunk's springs stayed
   * invisible until the next SCULPT happened to invalidate the cache — on a
   * world nobody was sculpting, indefinitely. The activity predicate is an
   * input to the network exactly as the heightmap is, so it invalidates
   * exactly as a sculpt does.
   *
   * The region is the chunk's own cells; `noteRegionChanged` widens it by
   * SPRING_CANDIDACY_REACH_CELLS itself, which is what re-tests the cells just
   * OUTSIDE the chunk that were passing vacuously while their neighbour was
   * dark.
   */
  private noteChunkBecameActive(cx: number, cy: number): void {
    const minX = cx * CHUNK_SIZE;
    const minY = cy * CHUNK_SIZE;
    this.springIndex.noteRegionChanged(minX, minY, minX + CHUNK_SIZE - 1, minY + CHUNK_SIZE - 1);
    this.riverIndex.noteRegionChanged(minX, minY, minX + CHUNK_SIZE - 1, minY + CHUNK_SIZE - 1);
    this.riverNetworkStale = true;
  }

  /** Lazily allocates and returns ONE token's own mask. Never returns the shared union `mask`. */
  private maskForToken(token: string): Uint8Array {
    let tokenMask = this.masksByToken.get(token);
    if (tokenMask === undefined) {
      tokenMask = createChunkMask(this.map.size);
      this.masksByToken.set(token, tokenMask);
    }
    return tokenMask;
  }

  /**
   * Flips a chunk's bit in ONE TOKEN'S mask, and ORs it into the union/
   * simulation mask too (issue #17 decision: "the union mask ORs in any chunk
   * when its first token earns it" — idempotent no matter which token gets
   * there first, or whether several already have). NEVER SENDS ANYTHING —
   * see unlockChunkForToken and seedChunkForToken below, the two callers that
   * layer messaging policy on top of this shared mutation. Returns false when
   * already unlocked FOR THIS TOKEN specifically (a chunk long since union-
   * unlocked by some other token still returns true here).
   */
  private grantChunkToToken(token: string, cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    const tokenMask = this.maskForToken(token);
    if (isChunkUnlocked(tokenMask, index)) return false;

    unlockChunk(tokenMask, index);
    this.changedSinceSnapshot = true;
    const wasUnionLocked = !isChunkUnlocked(this.mask, index);
    unlockChunk(this.mask, index); // union — see isChunkUnlocked's doc comment.
    // Only when the UNION mask actually moved: the river layer is scoped to
    // the union (riverNetwork's doc comment), so a second token earning a
    // chunk somebody else already opened changes nothing it can see.
    if (wasUnionLocked) this.noteChunkBecameActive(cx, cy);
    return true;
  }

  /**
   * SILENT per-token unlock: mutates masks only, streams nothing. The one
   * caller is the join-time starter-square seed (initial-unlock.ts's
   * applyInitialUnlockForToken): every newly seen token must start with the
   * same home square, but that seed has to land BEFORE the join snapshot is
   * built, not arrive afterward as a chunkUnlock message — the client is not
   * sized to receive one until the snapshot has told it worldSize (see the
   * ordering contract in terrace-room.ts). Idempotent per token: a RETURNING
   * token already has these bits set, so every call after the first is a
   * costless no-op.
   */
  seedChunkForToken(token: string, cx: number, cy: number): boolean {
    return this.grantChunkToToken(token, cx, cy);
  }

  /**
   * THE PER-PLAYER CREEP PRIMITIVE (design doc §reveal/frontier-pressure,
   * issue #17). Unlocks a chunk FOR ONE TOKEN and streams it ONLY to that
   * token's own live session(s) via sendTo — never a broadcast, because an
   * unrelated player must not learn the chunk exists (issue #17 decision 2:
   * "one adventurous player must not expose the world to everyone"). A token
   * can be open in more than one browser tab; every live session presenting
   * it is "the player who earned it", which is why this filters players() by
   * token rather than targeting a single connection id.
   *
   * Returns false when already unlocked for this token, so a policy plugin
   * (reveal) can call this unconditionally for every touched cell without a
   * separate read check first.
   */
  unlockChunkForToken(token: string, cx: number, cy: number): boolean {
    if (!this.grantChunkToToken(token, cx, cy)) return false;

    const message: ServerMessage = {
      type: 'chunkUnlock',
      chunks: [chunkPayloadOf(this, cx, cy)],
    };
    for (const player of this.players()) {
      if (player.token === token) this.sendTo(player.id, message);
    }
    return true;
  }

  /** Per-token read. Mirrors isChunkUnlocked, but against ONE token's mask rather than the union. */
  isChunkUnlockedForToken(token: string, cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    const tokenMask = this.masksByToken.get(token);
    return tokenMask !== undefined && isChunkUnlocked(tokenMask, index);
  }

  /**
   * Whether the CONNECTED PLAYER identified by `playerId` has personally
   * unlocked the chunk at (cx, cy) — answered from THEIR OWN token mask,
   * never the union. Added for the fog-of-war follow-up named in issue #17's
   * accepted residual (global entity broadcasts — wildlife/flora/monsters/
   * structures — still reference positions over chunks a player hasn't
   * unlocked): that follow-up needs exactly this primitive, plus the token
   * each connected Player already carries via players() (also issue #17).
   * NOTHING IN CORE CALLS THIS YET — no broadcast is filtered by it today;
   * it exists so the next change is a caller, not another contract change.
   *
   * A playerId with no connected Player (already left, or never existed)
   * answers false — nobody has unlocked anything for a session that is not
   * here, which is also the safe default for a query about to gate what
   * reaches a wire.
   */
  isChunkVisibleTo(playerId: string, cx: number, cy: number): boolean {
    const player = this.getPlayer(playerId);
    return player !== undefined && this.isChunkUnlockedForToken(player.token, cx, cy);
  }

  /** Cell-granularity isChunkVisibleTo — see its doc comment for the fog-of-war context. */
  isCellVisibleTo(playerId: string, x: number, y: number): boolean {
    return this.isChunkVisibleTo(
      playerId,
      Math.floor(x / CHUNK_SIZE),
      Math.floor(y / CHUNK_SIZE),
    );
  }

  /**
   * Every chunk unlocked for ONE TOKEN — the entire terrain content of that
   * token's join snapshot (issue #17 decision 2: "join snapshot sends only
   * the joining token's chunks"). An unseen token (nothing granted yet, e.g.
   * a query that races ahead of applyInitialUnlockForToken) returns an empty
   * list, exactly like a freshly allocated mask would.
   */
  chunkPayloadsForToken(token: string): ChunkPayload[] {
    const tokenMask = this.masksByToken.get(token) ?? createChunkMask(this.map.size);
    return collectUnlockedChunkPayloads({ map: this.map, mask: tokenMask });
  }

  /**
   * Every per-token mask, for the snapshot writer (index.ts) to persist
   * alongside the union `mask`. Returns the LIVE maps, not copies — safe
   * because the only caller reads them synchronously within one
   * SnapshotStore.saveSnapshot call, the same trust level `mask` and
   * `map.cells` are already handed out at just below.
   */
  tokenMasks(): ReadonlyMap<string, Uint8Array> {
    return this.masksByToken;
  }

  /**
   * The heightmap as the snapshot writer stores it: one Int16 per cell — the
   * TOPMOST CEILING of each column — LIVE (not a copy; same trust level as
   * `tokenMasks` above). No longer throws on a layered column: the full span
   * picture travels beside these heights in `spansForPersistence` below, so a
   * carved world persists instead of killing its own snapshot write. See
   * columns.ts and codec.ts.
   */
  heightsForPersistence(): Int16Array {
    return this.map.cells;
  }

  /**
   * The span side table as the snapshot writer stores it: every column holding
   * more than one solid span, keyed by cell index — LIVE, not a copy, read
   * synchronously inside one SnapshotStore.saveSnapshot call, the same trust
   * level `heightsForPersistence` above hands out at. An empty table (the
   * common world) encodes to a zero-length blob and costs nothing; see
   * codec.ts for the on-disk format and its determinism argument.
   */
  spansForPersistence(): ReadonlyMap<number, Int16Array> {
    return this.map.columnSpans;
  }

  /**
   * Applies an authoritative sculpt from the shared math (never re-implemented
   * here — design §3.3). `options` selects the brush tool and edge profile;
   * omitting it means smooth+soft, the shared library's compatibility default
   * (LIBRARY_DEFAULT_SCULPT_OPTIONS). Player intents never omit it: the intent
   * pipeline resolves them through `sculptOptionsOf` first.
   *
   * Returns the FULL diff, including cells inside locked chunks that the
   * relaxation legitimately touched (with the stamp tool there is no relaxation
   * and so no spill at all). Filtering for the wire happens in mask-filter.ts;
   * this method deliberately does not broadcast, so that the one place which
   * does (sculpt-service.ts) is the only place to audit.
   */
  applySculpt(
    x: number,
    y: number,
    radius: number,
    amount: number,
    options?: SculptOptions,
  ): CellDiff[] {
    const diff = applySculpt(this.map, x, y, radius, amount, options);
    if (diff.length > 0) {
      this.changedSinceSnapshot = true;
      // The diff is the WHOLE set of cells whose height moved, spill included
      // (see this method's contract above), which is exactly what the spring
      // index needs to stay exact — hence feeding it here, off the one return
      // value, rather than re-deriving a brush footprint that would have to
      // track every future edge profile.
      this.springIndex.noteCellsChanged(diff);
      // The same diff, to the same standard: a river whose course (or the ring
      // it reads around it) the sculpt touched is dropped; every other river's
      // trace survives to be handed back unchanged.
      this.riverIndex.noteCellsChanged(diff);
      this.riverNetworkStale = true;
    }
    return diff;
  }

  /**
   * This world's current river network (mechanics card 27 — springs, rivers,
   * pooling basins — and card 40 — the waterfalls riding on top of them),
   * derived fresh from `this.map` and cached behind RIVER_RECOMPUTE_INTERVAL_
   * MS (see that constant's doc comment for why a throttle exists at all).
   *
   * SCOPED TO THE UNLOCKED (union-mask) AREA, exactly like the wildlife
   * plugin's habitat census (plugins/wildlife/server/census.ts): nobody can
   * see a river over land nobody has revealed. The scoping is a RULE, not a
   * cost bound — `isCellUnlockedHere` is asked per cell, so scoping alone
   * never made the pass cheaper than the world is big. What bounds the cost
   * is the two indexes: `springIndex` re-tests only the candidacy of what
   * changed (issue #235) and `riverIndex` re-traces only the rivers that
   * change could have moved (issue #226); the one O(size²) pass left is the
   * spring index's first build, paid once per world.
   *
   * A CACHE, NOT AUTHORITATIVE STATE: nothing here is persisted, nothing
   * here is on the wire (see the plugin surface in world-api.ts and
   * docs/DESIGN.md's "what is on the wire" note) — it is a pure function of
   * `this.map` recomputed on demand, exactly like `client/src/world.ts`
   * recomputes its own copy from the client's mirror. Two calls with no
   * intervening sculpt, whether or not the throttle window has passed,
   * return the SAME object (not merely an equal one) — plugins that read it
   * more than once per tick (mana's `regenerate`, `manaRegenFor`) never pay
   * for a second computation or see it change mid-tick. Since #226 a
   * recompute that finds nothing to re-trace returns the same object too, so
   * a sculpt away from every watercourse no longer forces the freshwater
   * transpose below to rebuild either.
   */
  riverNetwork(): RiverNetwork {
    const now = Date.now();
    if (
      this.riverNetworkCache === null ||
      (this.riverNetworkStale && now - this.riverNetworkComputedAtMs >= RIVER_RECOMPUTE_INTERVAL_MS)
    ) {
      this.riverNetworkCache = this.riverIndex.networkFrom(this.springIndex.springs());
      this.riverNetworkComputedAtMs = now;
      this.riverNetworkStale = false;
    }
    return this.riverNetworkCache;
  }

  /**
   * This world's rivers and lakes as a PER-CELL lookup — the freshwater axis
   * of `shared/`'s traversal profiles (shared/src/traversal.ts), which is what
   * makes "terrestrial monsters may cross the rivers but not the lakes"
   * (owner, 2026-08-20) an actual rule in the running game rather than one the
   * profile type is merely able to express.
   *
   * DERIVED FROM `riverNetwork()`, NEVER FROM `this.map` DIRECTLY, so there is
   * exactly one place in the process that decides where the rivers are. It
   * inherits that method's scoping (unlocked territory only) and its throttle
   * for free: a mover asks about a cell no one has revealed and gets `none`,
   * which is the same answer it would have got before rivers existed.
   *
   * COST. The build is one pass over the network's emitted points — the same
   * order `computeRiverNetwork` produced them in, so it is as deterministic as
   * the network is — and it happens at most once per network recompute, not
   * once per query. That ratio is the whole reason the transpose exists;
   * freshwater.ts's header has the arithmetic (`isWalkableCell` runs up to
   * eight times per A* expansion against a 4096-node budget).
   *
   * A METHOD, matching its sibling `riverNetwork()`, and NOT named to match
   * `TerrainSampler.freshwater` — because a `World` is not a `TerrainSampler`
   * and cannot become one by accident: it publishes `size`, where the
   * interface asks for `worldSize`, so the compiler refuses the assignment
   * outright. `WorldApi` is the sampler-shaped view (it renames `size` to
   * `worldSize` along with everything else), and its `freshwater` getter is
   * therefore the ONLY route by which this map reaches `shared/`'s
   * predicates — which is what makes that one getter the thing to check when
   * asking whether the axis is live.
   */
  freshwaterMap(): FreshwaterMap {
    const network = this.riverNetwork();
    if (this.freshwaterCache === null || this.freshwaterCacheNetwork !== network) {
      this.freshwaterCache = buildFreshwaterMap(network, this.size);
      this.freshwaterCacheNetwork = network;
    }
    return this.freshwaterCache;
  }

  addPlayer(player: Player): void {
    this.playersById.set(player.id, player);
  }

  removePlayer(playerId: string): Player | undefined {
    const player = this.playersById.get(playerId);
    this.playersById.delete(playerId);
    return player;
  }

  getPlayer(playerId: string): Player | undefined {
    return this.playersById.get(playerId);
  }

  /** Snapshot of the connected players; safe for plugins to hold briefly. */
  players(): readonly Player[] {
    return Array.from(this.playersById.values());
  }
}
