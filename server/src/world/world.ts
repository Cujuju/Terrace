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
  CHUNK_SIZE,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  heightAt,
  isChunkUnlocked,
  SEA_LEVEL,
  unlockChunk,
  type CellDiff,
  type Heightmap,
  type SculptOptions,
  type ServerMessage,
} from '@terrace/shared';
import { NULL_SINK, type MessageSink } from '../net/message-sink.ts';
import type { Player } from '../player.ts';
import { applyInitialUnlock, initialUnlockFootprint } from './initial-unlock.ts';
import { chunkPayloadOf } from './mask-filter.ts';

// ─────────────────────────────────────────────────────────────────────────────
// FRESH-WORLD GENESIS (decided 2026-08-14 with the owner — see docs/DESIGN.md)
//
// A brand-new world is an OCEAN WITH A COAST, not a flat sheet at sea level.
//
// THE DEFECT THIS FIXES. `createHeightmap` allocates an all-zero grid and
// SEA_LEVEL is 0, so every cell of a fresh world used to sit EXACTLY at the
// waterline: the sea had zero depth everywhere, and anything classifying water
// by depth had nothing to classify. The wildlife plugin's deep-water habitat
// begins DEEP_WATER_BANDS_BELOW_SEA (3) bands down, so whales and deep-sea
// creatures had literally nowhere to exist until a player hand-dug a trench.
//
// THE PROFILE. Three concentric terraces, by Chebyshev (square-ring) distance
// from the starter region's own centre, so the shelf is concentric with the
// unlocked square rather than merely near it:
//
//        ┌──────────── deep, FRESH_SEABED_BANDS_BELOW_SEA ─────────────┐
//        │      ┌──── slope ring, FRESH_SLOPE_BANDS_BELOW_SEA ────┐    │
//        │      │        ┌── shelf, FRESH_SHELF_BANDS_BELOW_SEA ──┐    │
//        │      │        │           (world centre)               │    │
//
// Both boundaries are one clean band step. That is deliberate: this is a
// TERRACED game whose default brush is a stamp that cuts sheer faces, so a
// genesis coast that steps rather than ramps is the house style, and every
// height in it is a band floor that the terraced renderer draws exactly.
//
// RESIDUAL, NAMED. A one-band step is BAND_HEIGHT (64) against a gradient limit
// of MAX_STEP (32), so the two ring boundaries do NOT satisfy the relaxation
// invariant at genesis. Nothing enforces that invariant at rest — the stamp
// tool violates it on purpose every time it builds a spire — but a `smooth`
// sculpt whose relaxation reaches a boundary WILL slump it once, producing a
// larger-than-usual diff. That is the smooth tool doing exactly its job on a
// terrace edge, it is bounded by SMOOTH_PASS_LIMIT, and it happens at most once
// per stretch of coast. Accepted rather than papered over with a ramp.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Depth of the open-ocean floor, in terrace bands below sea level.
 *
 * The fix above is only correct if the fresh abyss REACHES the plugin's deep
 * threshold, so this is chosen to satisfy:
 *
 *     FRESH_SEABED_BANDS_BELOW_SEA >= DEEP_WATER_BANDS_BELOW_SEA
 *
 * Core cannot import that plugin constant — plugins depend on core, never the
 * reverse — so the relation is asserted from the plugin side instead
 * (plugins/wildlife/test/wildlife.test.ts). If either number moves, that test
 * fails rather than the ocean silently going shallow again.
 *
 * Three is also the SHALLOWEST depth that satisfies the relation, which is what
 * we want: every extra band is one more sculpt a player must spend to raise
 * land out there.
 */
export const FRESH_SEABED_BANDS_BELOW_SEA = 3;

/**
 * Depth of the coastal shelf at the very centre of a fresh world.
 *
 * One band — the shallowest water that is still water. Two things follow, and
 * both are the reason it is 1 rather than 2:
 *   * it is SHALLOW habitat (above the deep threshold), so coastal species have
 *     somewhere to be on day one;
 *   * it is a single band below the surface, so a player's first island costs
 *     two sculpts at DEFAULT_SCULPT_AMOUNT (one band per intent) — early
 *     land-raising stays as cheap as it was before the ocean existed, as long
 *     as it is done where the game starts you.
 */
export const FRESH_SHELF_BANDS_BELOW_SEA = 1;

/**
 * Depth of the ring between shelf and open sea. Exactly one band of each, so
 * the coast reads as a descending staircase rather than a single cliff into the
 * abyss. Still shallow habitat: the deep threshold is three bands down.
 */
export const FRESH_SLOPE_BANDS_BELOW_SEA = 2;

/**
 * Width of the slope ring, in cells. One chunk — the smallest unit of terrain
 * that streams as a whole, so the ring is never a sliver split across a chunk
 * boundary, and at 16 cells it is wide enough to be a place rather than a line.
 */
export const FRESH_SLOPE_WIDTH_CELLS = CHUNK_SIZE;

/**
 * How much smaller the shelf is than the starter unlock square, as a divisor of
 * its span in chunks.
 *
 * Four, and this number is load-bearing rather than aesthetic. The census that
 * drives wildlife only counts UNLOCKED cells, so the starter square's ~16 384
 * cells are the entire habitat budget of day one and this divisor is what
 * splits it between coastal and open-sea species. At 4 (shelf 2×2 chunks, plus
 * a one-chunk ring) the split is 4 096 shallow / 12 288 deep, which is the
 * coarsest setting that still buys 2 whales — a whale needs 5 000 cells of open
 * sea, so a larger shelf would eat the deep habitat this whole change exists to
 * create, and a smaller one leaves no coast for fish. Retune it and the day-one
 * ecosystem changes; the numbers it produces are asserted in
 * plugins/wildlife/test/wildlife.test.ts.
 */
export const FRESH_SHELF_SPAN_DIVISOR = 4;

/** Band depth → height. Genesis heights are exact band floors by construction. */
function heightAtBandsBelowSea(bands: number): number {
  return SEA_LEVEL - bands * BAND_HEIGHT;
}

/**
 * The open-ocean floor height. Well inside MIN_HEIGHT (-1024 = 16 bands), so
 * the full sculpt range below the floor is still available for deeper trenches.
 */
export const FRESH_SEABED_HEIGHT = heightAtBandsBelowSea(FRESH_SEABED_BANDS_BELOW_SEA);

/** The coastal shelf height. */
export const FRESH_SHELF_HEIGHT = heightAtBandsBelowSea(FRESH_SHELF_BANDS_BELOW_SEA);

/** The slope-ring height. */
export const FRESH_SLOPE_HEIGHT = heightAtBandsBelowSea(FRESH_SLOPE_BANDS_BELOW_SEA);

/** The shelf's cell-space bounds, both axes, inclusive. */
export interface FreshGenesisProfile {
  readonly shelfMinCell: number;
  readonly shelfMaxCell: number;
  /** Cells of slope ring outside the shelf box, on every side. */
  readonly slopeWidthCells: number;
}

/**
 * Where the genesis terraces sit, derived from the starter unlock square rather
 * than from a restatement of its geometry (initialUnlockFootprint is the one
 * definition of that square — see initial-unlock.ts).
 *
 * The shelf is a centred square of `spanChunks / FRESH_SHELF_SPAN_DIVISOR`
 * chunks, never smaller than one chunk, centred INSIDE the unlock square by the
 * same floor-the-remainder rule the unlock square itself uses. Pure integer
 * arithmetic on chunk counts, so it is reproducible and testable and there is no
 * RNG anywhere in world genesis.
 */
export function freshGenesisProfile(size: number): FreshGenesisProfile {
  const { startChunk, spanChunks } = initialUnlockFootprint(size);
  const shelfSpanChunks = Math.max(1, Math.floor(spanChunks / FRESH_SHELF_SPAN_DIVISOR));
  const shelfStartChunk = startChunk + Math.floor((spanChunks - shelfSpanChunks) / 2);

  const shelfMinCell = shelfStartChunk * CHUNK_SIZE;
  return {
    shelfMinCell,
    shelfMaxCell: shelfMinCell + shelfSpanChunks * CHUNK_SIZE - 1,
    slopeWidthCells: FRESH_SLOPE_WIDTH_CELLS,
  };
}

/**
 * Chebyshev distance from a cell to the shelf box: 0 inside it, otherwise how
 * many cells outside its nearest edge the cell lies. A square ring metric, not
 * a circular one, because the region it is measured against is a square — a
 * Euclidean radius would put the shelf's own corners in the slope band.
 */
function cellsOutsideShelf(profile: FreshGenesisProfile, x: number, y: number): number {
  const dx = Math.max(profile.shelfMinCell - x, x - profile.shelfMaxCell, 0);
  const dy = Math.max(profile.shelfMinCell - y, y - profile.shelfMaxCell, 0);
  return dx > dy ? dx : dy;
}

/**
 * Genesis height of one cell. Exported so tests can state the profile's shape
 * without re-deriving its geometry, and so a future world-gen plugin has an
 * obvious seam to replace.
 */
export function freshGenesisHeightAt(profile: FreshGenesisProfile, x: number, y: number): number {
  const outside = cellsOutsideShelf(profile, x, y);
  if (outside === 0) return FRESH_SHELF_HEIGHT;
  return outside <= profile.slopeWidthCells ? FRESH_SLOPE_HEIGHT : FRESH_SEABED_HEIGHT;
}

export class World {
  readonly map: Heightmap;
  readonly mask: Uint8Array;

  private sink: MessageSink = NULL_SINK;
  private readonly playersById = new Map<string, Player>();

  /**
   * Set whenever terrain or mask changes; cleared when a snapshot is written.
   * The snapshot scheduler writes ONLY when this is true (design open question
   * 4, decided: "snapshot every SNAPSHOT_INTERVAL_S only if the world changed"),
   * so an idle server does no disk I/O at all.
   */
  private changedSinceSnapshot = false;

  private constructor(map: Heightmap, mask: Uint8Array) {
    this.map = map;
    this.mask = mask;
  }

  /**
   * A brand-new world: an OCEAN WITH A COAST — a shallow shelf at the centre,
   * a slope ring around it, open sea everywhere beyond — with the provisional
   * starter region unlocked (see initial-unlock.ts). Used when no snapshot
   * exists. The profile and every constant in it are documented at the top of
   * this file.
   *
   * The terrain is generated HERE, on the server, and deliberately not in
   * `createHeightmap`: shared/ is the determinism contract that client and
   * server both run, and world GENESIS is not part of it. The client never
   * generates terrain — it receives chunks — so a zero-filled allocator stays
   * the honest shared primitive and "what a new world looks like" stays a
   * server policy that a future world-gen plugin can replace.
   *
   * CONSEQUENCES, ALL INTENDED AND ALL REAL:
   *
   *   1. Raising land now costs band-steps that it did not before: two sculpts
   *      to break the surface on the starter shelf (at DEFAULT_SCULPT_AMOUNT =
   *      one band per intent), four out in the open sea. The ocean is a volume
   *      with a bottom, and how far down that bottom is now varies by place.
   *   2. A fresh world has NO LAND. Land-habitat species have nowhere to be
   *      until a player raises an island; water species have somewhere from the
   *      first tick, coastal AND open-sea both.
   *   3. Genesis is one-time and deterministic — integer band arithmetic over a
   *      Chebyshev distance, no RNG — so the same size always produces the same
   *      world and tests can assert it cell by cell.
   *
   * Only this path generates. `restore` rebuilds whatever a snapshot holds, so
   * existing worlds are untouched.
   *
   * Not a cosmetic mismatch worth chasing on the client: the client boots its
   * local heightmap at band 0 and shows a flat sea until the first chunk
   * arrives, so for the one pre-connect frame it draws a shoreline where the
   * server has a coast and an abyss. The first `chunkUnlock` overwrites it.
   * Left alone on purpose — the fix belongs in the client's boot state.
   */
  static createFresh(size: number): World {
    const map = createHeightmap(size);
    const profile = freshGenesisProfile(size);

    // Row-major, ascending, matching every other sweep over the grid. Order is
    // irrelevant to the result here (each cell is a pure function of its own
    // coordinates) and kept conventional so it stays that way.
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        map.cells[row + x] = freshGenesisHeightAt(profile, x, y);
      }
    }

    const world = new World(map, createChunkMask(size));
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
   */
  static restore(size: number, cells: Int16Array, mask: Uint8Array): World {
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
    expectedMask.set(mask);
    return new World(map, expectedMask);
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

  /** Called by the snapshot store after a snapshot is committed. */
  markSnapshotted(): void {
    this.changedSinceSnapshot = false;
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
   */
  unlockChunk(cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    if (isChunkUnlocked(this.mask, index)) return false;

    unlockChunk(this.mask, index);
    this.changedSinceSnapshot = true;
    this.broadcast({ type: 'chunkUnlock', chunks: [chunkPayloadOf(this, cx, cy)] });
    return true;
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
    if (diff.length > 0) this.changedSinceSnapshot = true;
    return diff;
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
